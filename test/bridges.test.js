"use strict";
// npm test   (node --test)
// The terminal bridges. Superset and tmux pass the same tests: what a read
// returns, what typed text arrives as, and which bytes each key becomes. Each
// runs against a stand-in program; tmux also against a real tmux server on a
// private socket in a temp folder (skipped when tmux isn't installed). Nothing
// here touches the real tmux server, its default socket, or Superset.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const { execFileSync, spawn } = require("child_process");
const { createBridges, KEYS, tmuxSocket, tmuxLiteral, tmuxPieces, TMUX_BINS } = require("../src/bridges");
const { startTimeOf, stillRunning } = require("../src/proc");

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airpocket-bridges-"));
const ME = { pid: process.pid, started: startTimeOf(process.pid) };

// What each key must reach the program as, whichever bridge carries it.
const KEY_BYTES = { up: ESC + "[A", down: ESC + "[B", right: ESC + "[C", left: ESC + "[D", tab: TAB, stab: ESC + "[Z",
                    esc: ESC, enter: CR, 3: "3" };
// Text that trips the careless: tmux ends a command at a trailing ";", a shell would expand the rest.
const TRICKY = "a;b $(id) `id` #{pane_id} ~ -l -- \\; end;";

// A real socket, as tmux would leave one, for the stand-in tmux.
const SOCK = path.join(dir, "fake.sock");
const sockServer = net.createServer();
const sockReady = new Promise((r) => sockServer.listen(SOCK, r));

// ---- stand-ins -------------------------------------------------------------------

// Superset: `terminals send --text T [--no-submit]` types T, then Enter unless --no-submit.
function fakeSuperset(term) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "terminals" && args[1] === "read") return JSON.stringify({ terminalId: "t", text: term.screen });
    if (args[0] === "terminals" && args[1] === "send") {
      term.got += args[args.indexOf("--text") + 1] + (args.includes("--no-submit") ? "" : CR);
      return "{}";
    }
    throw new Error("unexpected superset call");
  };
  return { run, calls };
}

// tmux, as it reads one argument (cmd_parse_from_arguments): a trailing ";" ends
// the command and is dropped, a trailing "\;" is a ";".
function tmuxReads(a) {
  if (!a.endsWith(";")) return a;
  const s = a.slice(0, -1);
  if (s.endsWith("\\")) return s.slice(0, -1) + ";";
  throw new Error("the text ended the tmux command early");
}
const TMUX_KEYS = { Up: ESC + "[A", Down: ESC + "[B", Right: ESC + "[C", Left: ESC + "[D", Tab: TAB, BTab: ESC + "[Z", Escape: ESC, Enter: CR };
const SERVER = 4242;                       // the stand-in tmux server's pid
// tmux: send-keys -l -- T types T; send-keys <Key> presses one key by its tmux name;
// an argument that is ";" alone separates commands; one call carries 16 KB at most.
function fakeTmux(term, sock = SOCK, pane = "%3", server = SERVER) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    assert.deepEqual(args.slice(0, 3), ["-u", "-S", sock], "always the recorded socket, UTF-8 on");
    if (args.reduce((n, a) => n + Buffer.byteLength(a) + 1, 0) > 16000) throw new Error("command too long");
    const cmds = [[]];
    for (const a of args.slice(3)) { if (a === ";") cmds.push([]); else cmds[cmds.length - 1].push(a); }
    let out = "";
    for (const [cmd, ...rest] of cmds) {
      if (cmd === "capture-pane") { assert.deepEqual(rest, ["-p", "-t", pane]); out += term.screen + "\n"; continue; }
      if (cmd === "display-message") {
        assert.deepEqual(rest.slice(0, 3), ["-p", "-t", pane]);
        out += rest[3].replace("#{pid}", String(server)).replace("#{pane_in_mode}", term.inMode ? "1" : "0") + "\n";
        continue;
      }
      if (cmd !== "send-keys") throw new Error("unexpected tmux call " + cmd);
      assert.deepEqual(rest.slice(0, 2), ["-t", pane], "the pane on record");
      if (rest[2] === "-l") { assert.equal(rest[3], "--"); assert.equal(rest.length, 5); term.got += tmuxReads(rest[4]); continue; }
      assert.equal(rest.length, 3, "one key per call");
      if (!Object.hasOwn(TMUX_KEYS, rest[2])) throw new Error("unknown key " + rest[2]);
      term.got += TMUX_KEYS[rest[2]];
    }
    return out;
  };
  return { run, calls };
}

// ---- the same tests for every bridge ------------------------------------------------

/**
 * setup() -> { bridge, screen: RegExp a read must match, received(n): the bytes
 * that reached the program once there are at least n (or a timeout), reset() }.
 */
function contract(label, setup, opts = {}) {
  let t;
  const get = async () => (t = t || (await setup()));
  const expect = async (want, msg) => {
    const got = await t.received(Buffer.byteLength(want));
    assert.equal(got, want, msg);
    await t.reset();
  };
  test(`${label}: a read returns the screen as text`, opts, async () => {
    await get();
    assert.match(await t.bridge.read(), t.screen);
  });
  test(`${label}: text arrives exactly as typed, Enter only when asked`, opts, async () => {
    await get();
    await t.bridge.type("hi there", false);
    await expect("hi there", "no Enter without submit");
    await t.bridge.type(TRICKY, false);
    await expect(TRICKY, "no shell, no tmux command parsing, no key names");
    await t.bridge.type("go", true);
    await expect("go" + CR, "text, then Enter");
    await t.bridge.type("", true);
    await expect(CR, "Enter alone");
  });
  test(`${label}: a long message in a wide script arrives whole`, opts, async () => {
    await get();
    const long = "漢".repeat(7999) + ";";            // 24 KB of UTF-8, more than tmux takes in one command
    await t.bridge.type(long, false);
    await expect(long, "every character, in order");
  });
  test(`${label}: every key on the allow-list reaches the program as its bytes`, opts, async () => {
    await get();
    for (const [name, bytes] of Object.entries(KEY_BYTES)) {
      await t.bridge.press(KEYS[name]);
      await expect(bytes, name);
    }
  });
  test(`${label}: typing is allowed while its agent runs`, opts, async () => {
    await get();
    const w = await t.bridges.writable(t.record);
    assert.equal(w.bridge && w.bridge.name, t.bridge.name, JSON.stringify(w));
  });
}

contract("superset (stand-in)", async () => {
  const term = { got: "", screen: "hello from superset ❯" };
  const fake = fakeSuperset(term);
  const bridges = createBridges({ superset: fake.run, hasTmux: () => false });
  const record = { workspace: "ws-1", terminal: "term-1", ...ME };
  return { bridges, record, bridge: bridges.of(record), screen: /hello from superset ❯/,
           received: async () => term.got, reset: () => { term.got = ""; } };
});

contract("tmux (stand-in)", async () => {
  await sockReady;
  const term = { got: "", screen: "hello from tmux ❯" };
  const fake = fakeTmux(term);
  const bridges = createBridges({ tmux: fake.run, hasTmux: () => true, gap: () => 0 });
  const record = { pane: "%3", tmux: SOCK, tmux_pid: SERVER, ...ME };
  return { bridges, record, bridge: bridges.of(record), screen: /hello from tmux ❯/,
           received: async () => term.got, reset: () => { term.got = ""; } };
});

// ---- a real tmux, on a private socket --------------------------------------------------

const TMUX = TMUX_BINS.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
const real = { skip: TMUX ? false : "tmux isn't installed" };
const RSOCK = path.join(dir, "real.sock");
const LOG = path.join(dir, "rx.log"), PIDFILE = path.join(dir, "agent.pid"), AFTER = path.join(dir, "after.log");
// The "agent": a raw-mode program that logs every byte it gets. When it exits, the
// pane falls back to cat, the way a real terminal falls back to a shell.
const AGENT = path.join(dir, "agent.js");
fs.writeFileSync(AGENT, [
  "const fs = require('fs');",
  "fs.writeFileSync(process.argv[3], String(process.pid));",
  "process.stdin.setRawMode(true);",
  "process.stdout.write('READY \\u276f airpocket\\n');",
  "process.stdin.on('data', (b) => fs.appendFileSync(process.argv[2], b.toString('hex')));",
].join("\n"));
const TMUX_ENV = { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", HOME: dir };
const tmuxHere = (...args) => execFileSync(TMUX, ["-u", "-S", RSOCK, ...args], { env: TMUX_ENV, encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v || Date.now() > end) return v; await sleep(40); }
}
const q = (s) => "'" + s + "'";
let realRecord = null;
// The tmux server first, while its socket is still there to reach it; then the folder.
test.after(() => {
  if (TMUX && fs.existsSync(RSOCK)) { try { tmuxHere("kill-server"); } catch {} }
  sockServer.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

contract("tmux (real, private socket)", async () => {
  fs.writeFileSync(LOG, "");
  tmuxHere("-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "20", "/bin/sh", "-c",
    `${q(process.execPath)} ${q(AGENT)} ${q(LOG)} ${q(PIDFILE)}; exec /bin/cat > ${q(AFTER)}`);
  const pane = tmuxHere("list-panes", "-F", "#{pane_id}").trim();
  const pid = Number(await until(() => { try { return fs.readFileSync(PIDFILE, "utf8"); } catch { return ""; } }));
  assert.ok(pid > 1, "the agent started");
  realRecord = { pane, tmux: RSOCK, tmux_pid: Number(tmuxHere("display-message", "-p", "#{pid}").trim()), pid, started: startTimeOf(pid) };
  const bridges = createBridges({});                 // the real runner: tmux by its absolute path
  const bridge = bridges.of(realRecord);
  assert.equal(bridge && bridge.name, "tmux");
  await until(() => /READY/.test(tmuxHere("capture-pane", "-p", "-t", pane)));
  const bytes = () => Buffer.from(fs.readFileSync(LOG, "utf8"), "hex").toString("utf8");
  return { bridges, record: realRecord, bridge, screen: /READY ❯ airpocket/,
           received: async (n) => (await until(() => Buffer.byteLength(bytes()) >= n && bytes()), bytes()),
           reset: () => fs.writeFileSync(LOG, "") };
}, real);

test("tmux (real): a pane in copy mode is left alone", real, async () => {
  assert.ok(realRecord, "the real tmux contract ran first");
  const bridges = createBridges({});
  tmuxHere("copy-mode", "-t", realRecord.pane);
  const w = await bridges.writable(realRecord);
  assert.equal(w.error, "not_ready");
  assert.match(w.message, /copy mode/);
  tmuxHere("send-keys", "-t", realRecord.pane, "-X", "cancel");
  assert.ok((await bridges.writable(realRecord)).bridge, "usable again once copy mode is over");
});

test("tmux (real): once the agent exits, nothing is typed into what's left", real, async () => {
  assert.ok(realRecord, "the real tmux contract ran first");
  const bridges = createBridges({});
  process.kill(realRecord.pid, "SIGTERM");
  await until(() => !stillRunning(realRecord.pid, realRecord.started));
  const w = await bridges.writable(realRecord);
  assert.equal(w.error, "ended", JSON.stringify(w));
  assert.match(w.message, /exited/);
  // The pane is still there, now running cat in place of the agent: the phone may still look, never type.
  assert.ok(bridges.of(realRecord), "the pane can still be read");
  await sleep(200);
  assert.equal(fs.existsSync(AFTER) ? fs.readFileSync(AFTER, "utf8") : "", "", "nothing reached the program left behind");
});

test("tmux (real): after the server restarts, the old pane id is someone else's: not read, not typed into", real, async () => {
  assert.ok(realRecord, "the real tmux contract ran first");
  tmuxHere("kill-server");
  await until(() => { try { tmuxHere("list-sessions"); return false; } catch { return true; } });
  tmuxHere("-f", "/dev/null", "new-session", "-d", "-x", "80", "-y", "10", "/bin/sh", "-c", "echo SOMEONE ELSE; exec /bin/cat");
  const [pane, server] = tmuxHere("display-message", "-p", "#{pane_id} #{pid}").trim().split(" ");
  assert.equal(pane, realRecord.pane, "tmux hands out the same pane id again");
  assert.notEqual(Number(server), realRecord.tmux_pid);
  const bridges = createBridges({});
  const old = bridges.of(realRecord);
  await assert.rejects(old.read(), /gone/, "the old session's screen is not this pane's");
  assert.equal((await bridges.writable(realRecord)).error, "ended");
  assert.equal((await bridges.writable({ ...realRecord, pid: ME.pid, started: ME.started })).error, "unreachable", "even with a live agent");
  await until(() => /SOMEONE ELSE/.test(tmuxHere("capture-pane", "-p", "-t", pane)));
  assert.match(await bridges.of({ ...realRecord, tmux_pid: Number(server) }).read(), /SOMEONE ELSE/, "the new server's own record reads fine");
});

// ---- choosing a bridge ------------------------------------------------------------------

test("a bridge comes from the record: Superset ids, or a tmux pane on a usable socket; tmux wins", async () => {
  await sockReady;
  const b = createBridges({ superset: async () => "", tmux: async () => "", hasTmux: () => true });
  const at = { tmux: SOCK, tmux_pid: SERVER };
  assert.equal(b.of({ workspace: "ws-1", terminal: "term-1" }).name, "superset");
  assert.equal(b.of({ pane: "%3", ...at }).name, "tmux");
  assert.equal(b.of({ pane: "%3", ...at, workspace: "ws-1", terminal: "term-1" }).name, "tmux", "the pane is exact; Superset shows the tmux client");
  assert.equal(b.of({ pane: "%3", tmux: SOCK }), null, "no server pid on record: which server the pane was on is unknown");
  assert.equal(b.of({ pane: "%3", tmux: SOCK, tmux_pid: "4242" }), null);
  assert.equal(b.of({}), null, "neither: read-only");
  assert.equal(b.of(null), null);
  assert.equal(b.of({ workspace: "ws-1" }), null, "half a Superset address is none");
  assert.equal(b.of({ workspace: "ws 1", terminal: "term-1" }), null);
  for (const pane of ["3", "%", "%3;", "%x", "%3 ", "{last}", "=%3"]) {
    assert.equal(b.of({ pane, ...at }), null, "pane " + pane);
  }
  assert.equal(b.of({ pane: "%x", ...at, workspace: "ws-1", terminal: "term-1" }).name, "superset", "a bad pane falls back to Superset");
  const none = createBridges({ tmux: async () => "", hasTmux: () => false });
  assert.equal(none.of({ pane: "%3", ...at }), null, "tmux not installed");
});

test("tmux sockets: absolute, a socket itself, and this user's", async () => {
  await sockReady;
  const uid = process.getuid();
  assert.equal(tmuxSocket(SOCK, uid), SOCK);
  assert.equal(tmuxSocket(path.relative(process.cwd(), SOCK), uid), "", "relative");
  assert.equal(tmuxSocket(SOCK, uid + 1), "", "someone else's");
  const file = path.join(dir, "plain-file");
  fs.writeFileSync(file, "");
  assert.equal(tmuxSocket(file, uid), "", "a plain file");
  assert.equal(tmuxSocket(dir, uid), "", "a folder");
  const link = path.join(dir, "link.sock");
  fs.symlinkSync(SOCK, link);
  assert.equal(tmuxSocket(link, uid), "", "a link to a socket");
  assert.equal(tmuxSocket(path.join(dir, "missing.sock"), uid), "", "missing");
  for (const v of [undefined, null, 5, "", {}]) assert.equal(tmuxSocket(v, uid), "");
  const other = createBridges({ tmux: async () => "", hasTmux: () => true, uid: uid + 1 });
  assert.equal(other.of({ pane: "%3", tmux: SOCK, tmux_pid: SERVER }), null, "the bridge uses the same check");
});

test("tmux argv: the socket and pane on record, text literal after --, Enter as its own call", async () => {
  await sockReady;
  const term = { got: "", screen: "" };
  const fake = fakeTmux(term);
  const order = [];
  const b = createBridges({ tmux: async (args) => { order.push(args.slice(3).join(" ")); return fake.run(args); }, hasTmux: () => true,
                            gap: (text) => { order.push("gap " + text.length); return 0; } });
  const bridge = b.of({ pane: "%3", tmux: SOCK, tmux_pid: SERVER });
  await bridge.type("-n hi", true);
  assert.deepEqual(fake.calls, [["-u", "-S", SOCK, "send-keys", "-t", "%3", "-l", "--", "-n hi"], ["-u", "-S", SOCK, "send-keys", "-t", "%3", "Enter"]]);
  assert.deepEqual(order, ["send-keys -t %3 -l -- -n hi", "gap 5", "send-keys -t %3 Enter"], "text lands before its Enter");
  for (const t of ["x;", "x\\;", ";", "a;b", "\\", "plain"]) assert.equal(tmuxReads(tmuxLiteral(t)), t, JSON.stringify(t));
  fake.calls.length = 0;
  await bridge.press(KEYS["7"]);
  assert.deepEqual(fake.calls, [["-u", "-S", SOCK, "send-keys", "-t", "%3", "-l", "--", "7"]], "digits go in as text, not as key names");
  for (const k of Object.values(KEYS)) assert.ok(k.tmux === null || Object.hasOwn(TMUX_KEYS, k.tmux), "every key has a tmux name or is text");

  // Long text goes in pieces of 4 KB at most, cut between characters (an emoji is two UTF-16 units, one character).
  for (const text of ["漢".repeat(3000), "a".repeat(10000), "😀".repeat(3000), "ş;".repeat(2000), "x"]) {
    const p = tmuxPieces(text);
    assert.equal(p.join(""), text);
    assert.ok(p.every((x) => x && Buffer.byteLength(x) <= 4096), "each piece fits");
    assert.ok(p.every((x) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(x)), "no character cut in half");
  }
  assert.deepEqual(tmuxPieces(""), []);
  fake.calls.length = 0;
  await bridge.type("漢".repeat(3000), false);
  assert.equal(fake.calls.length, 3, "9000 bytes: three pieces");
});

test("tmux reads: the server pid and the screen in one call, and nothing from another server", async () => {
  await sockReady;
  const term = { got: "", screen: "the agent's screen" };
  const fake = fakeTmux(term);
  const b = createBridges({ tmux: fake.run, hasTmux: () => true });
  assert.equal(await b.of({ pane: "%3", tmux: SOCK, tmux_pid: SERVER }).read(), "the agent's screen\n");
  assert.deepEqual(fake.calls, [["-u", "-S", SOCK, "display-message", "-p", "-t", "%3", "#{pid}", ";", "capture-pane", "-p", "-t", "%3"]]);
  const old = { pane: "%3", tmux: SOCK, tmux_pid: SERVER + 1, ...ME };
  await assert.rejects(b.of(old).read(), /gone/, "a restarted server's pane is someone else's");
  assert.equal((await b.writable(old)).error, "unreachable");
  assert.equal(term.got, "");
});

test("what a session allows: which bridge, and no typing without a known, running agent", async () => {
  const b = createBridges({ superset: async () => "", hasTmux: () => false });
  const sup = { workspace: "ws-1", terminal: "term-1", ...ME };
  assert.deepEqual(b.caps(sup, true), { bridge: "superset", read: true, send: true, keys: true, controls: true, why: "" });
  const ended = b.caps(sup, false);
  assert.equal(ended.send || ended.keys || ended.controls, false);
  assert.equal(ended.read, true, "an ended session's terminal can still be looked at");
  assert.match(ended.why, /exited/);
  assert.match(b.caps({ workspace: "ws-1", terminal: "term-1", pid: ME.pid }, true).why, /which process/, "no start time on record");
  assert.equal(b.caps({ workspace: "ws-1", terminal: "term-1", pid: ME.pid }, true).send, false);
  const none = b.caps({ ...ME }, true);
  assert.deepEqual([none.bridge, none.read, none.send], [null, false, false]);
  assert.match(none.why, /Superset or tmux/);
});

test("writable: refused without a bridge, for a gone or reused pid, or when ps can't tell", async () => {
  const term = { got: "", screen: "" };
  const fake = fakeSuperset(term);
  const b = createBridges({ superset: fake.run, hasTmux: () => false });
  const at = (x) => ({ workspace: "ws-1", terminal: "term-1", ...x });
  assert.equal((await b.writable({ ...ME })).error, "no_route");
  assert.ok((await b.writable(at(ME))).bridge);
  assert.equal((await b.writable(at({ pid: ME.pid, started: ME.started - 60 }))).error, "ended", "the pid now belongs to another process");
  assert.equal((await b.writable(at({ pid: ME.pid }))).error, "ended", "no start time on record");
  assert.equal((await b.writable(at({ started: ME.started }))).error, "ended", "no pid on record");
  const child = spawn(process.execPath, ["-e", ""]);
  const gone = { pid: child.pid, started: startTimeOf(child.pid) };
  await new Promise((r) => child.on("exit", r));
  await until(() => !stillRunning(gone.pid, gone.started));
  assert.equal((await b.writable(at(gone))).error, "ended", "the agent exited");
  assert.equal(fake.calls.length, 0, "no check typed anything");

  // The fresh check itself: a start time that can't be read proves nothing, so it's a no.
  assert.equal(stillRunning(ME.pid, ME.started), true);
  assert.equal(stillRunning(ME.pid, ME.started, () => 0), false);
  assert.equal(stillRunning(0, ME.started), false);
  assert.equal(stillRunning(ME.pid, 0), false);
  assert.equal(stillRunning(gone.pid, gone.started), false);
});

test("writable: a terminal that can't be reached is said so, and not typed into", async () => {
  await sockReady;
  const b = createBridges({ tmux: async () => { throw new Error("no server running"); }, hasTmux: () => true });
  const w = await b.writable({ pane: "%3", tmux: SOCK, tmux_pid: SERVER, ...ME });
  assert.equal(w.error, "unreachable");
  const inMode = createBridges({ tmux: fakeTmux({ got: "", screen: "", inMode: true }).run, hasTmux: () => true });
  assert.equal((await inMode.writable({ pane: "%3", tmux: SOCK, tmux_pid: SERVER, ...ME })).error, "not_ready");
});

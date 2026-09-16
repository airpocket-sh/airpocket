"use strict";
// Try own-terminal mode end to end: `airpocket run claude` in a hidden terminal
// window, a real throwaway Claude inside Airpocket's private tmux, driven from
// the terminal the way a person would and from the phone API.
//
// The terminal window is pty-term.py (a pty with a pyte screen), so every key
// is the bytes a terminal sends: Esc, Shift+Enter in its two encodings and
// Option+Enter, a bracketed paste, Ctrl+V, mouse wheel and drag, a window
// resize, closing the window. A throwaway Airpocket (service, hook endpoint,
// phone server) and the tmux socket live in a temp folder under /tmp; the
// user's own tmux server, ~/.tmux.conf and settings are never used. Claude
// runs with --setting-sources project and only the trial's hook, in the repo
// folder (already trusted), with a small model.
//
// Part 1, bytes: a stand-in agent that logs what reaches it through tmux (how
//   long Esc takes to arrive, what Shift+Enter and a paste arrive as, the new
//   size after a resize, scrollback and typing out of it, copy to the clipboard).
// Part 2, Claude directly in a terminal, for comparison: Esc, Shift+Enter,
//   paste, an image.
// Part 3, Claude through airpocket run: the phone reaches it; the same keys;
//   copy; resize; scrollback; close the window, airpocket attach, still there
//   with its scrollback; the service restarts under it; /exit.
//
// The clipboard: the copy and image checks use the Mac's real clipboard. Text on
// it is put back at the end; anything else (an image) is not.
//
//   node docs/reference/try-own-terminal.js [path to claude]
//
// Needs tmux, pyte (pip install pyte; set PYTHON to a python that has it) and a
// logged-in claude.
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawn, execFileSync, spawnSync } = require("child_process");
const { createServer } = require("../../src/server");
const { createService } = require("../../src/service");
const { createStore } = require("../../src/store");
const { findTmux } = require("../../src/bridges");

const REPO = path.resolve(__dirname, "..", "..");
const CLI = path.join(REPO, "src", "cli.js");
const CLAUDE = process.argv[2] || path.join(os.homedir(), ".local", "bin", "claude");
const PYTHON = process.env.PYTHON || "python3";
const TMUX = findTmux();
if (!TMUX) { console.error("tmux isn't installed"); process.exit(1); }
if (spawnSync(PYTHON, ["-c", "import pyte"]).status !== 0) { console.error(`pyte isn't installed for ${PYTHON} (pip install pyte, or set PYTHON)`); process.exit(1); }

const ESC = String.fromCharCode(27);
const KEY = {
  esc: ESC, enter: "\r", ctrlC: String.fromCharCode(3), ctrlV: String.fromCharCode(22),
  shiftEnterCsiU: ESC + "[13;2u",                 // kitty, Ghostty, iTerm2 (CSI u)
  shiftEnterXterm: ESC + "[27;2;13~",             // xterm's modifyOtherKeys, which tmux asks the terminal for
  optionEnter: ESC + "\r",                        // Terminal.app with Option as Meta
  paste: (t) => ESC + "[200~" + t + ESC + "[201~",
  wheelUp: (x, y) => `${ESC}[<64;${x};${y}M`, wheelDown: (x, y) => `${ESC}[<65;${x};${y}M`,
  press: (x, y) => `${ESC}[<0;${x};${y}M`, drag: (x, y) => `${ESC}[<32;${x};${y}M`, release: (x, y) => `${ESC}[<0;${x};${y}m`,
};

const data = fs.realpathSync(fs.mkdtempSync("/tmp/ap-try-own-"));   // short: the socket path must fit in 104 bytes
const SOCK = path.join(data, "tmux", "sock");
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const tmux = (...args) => execFileSync(TMUX, ["-u", "-S", SOCK, ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" } });
const tmuxOk = (...args) => { try { return tmux(...args); } catch { return null; } };
// How a terminal answers tmux's queries when a client attaches. tmux holds Esc for 500 ms
// (whatever escape-time says) until DA1, DA2 and XTVERSION are answered, for at most 5 s.
const ST = ESC + "\\";
const COLORS = [[ESC + "]10;?", ESC + "]10;rgb:ffff/ffff/ffff" + ST], [ESC + "]11;?", ESC + "]11;rgb:1e1e/1e1e/1e1e" + ST]];
const ANSWERS = {
  all: [[ESC + "[>c", ESC + "[>0;95;0c"], [ESC + "[>q", ESC + "P>|iTerm2 3.6.0" + ST], ...COLORS],   // iTerm2, Ghostty, kitty, WezTerm
  noVersion: [[ESC + "[>c", ESC + "[>1;95;0c"], ...COLORS],                                      // a terminal that doesn't answer XTVERSION
};
const results = [];                                 // [part, check, pass, detail]
const check = (part, name, pass, detail = "") => { results.push([part, name, !!pass, detail]); say(`${pass ? "PASS" : "FAIL"} ${name}${detail ? "  (" + detail + ")" : ""}`); return !!pass; };

// The environment a person's shell would have: none of Superset's, Claude's, Codex's or tmux's own.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SUPERSET_|CLAUDE|CODEX_|TMUX)/.test(k)));
Object.assign(baseEnv, { TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal", LANG: baseEnv.LANG || "en_US.UTF-8", AIRPOCKET_DIR: data });
baseEnv.PATH = `${path.dirname(CLAUDE)}:${baseEnv.PATH}`;

/** A hidden terminal window. */
function terminalWindow(label) {
  const proc = spawn(PYTHON, [path.join(__dirname, "pty-term.py")], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const waiting = [];
  proc.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) { const line = buf.slice(0, i); buf = buf.slice(i + 1); waiting.shift()(JSON.parse(line)); }
  });
  const req = (o) => new Promise((r) => { waiting.push(r); proc.stdin.write(JSON.stringify(o) + "\n"); });
  const w = {
    label,
    open: (argv, { env = baseEnv, rows = 30, cols = 100, answers = ANSWERS.all } = {}) => req({ op: "spawn", argv, env, cwd: REPO, rows, cols, answers }),
    send: (s) => req({ op: "write", b64: Buffer.from(s, "utf8").toString("base64") }),
    async type(text) { await w.send(text); await sleep(250); },     // a burst, then a pause, so Enter isn't part of a paste
    screen: async () => (await req({ op: "screen" })).screen.map((l) => l.trimEnd()),
    raw: async () => Buffer.from((await req({ op: "screen" })).raw, "base64").toString("latin1"),
    resize: (rows, cols) => req({ op: "resize", rows, cols }),
    close: () => req({ op: "close" }),
    wait: async (secs) => (await req({ op: "wait", secs })).exit,
    quit: () => proc.kill(),
  };
  return w;
}

async function until(fn, ms, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}
const show = (lines, n = 8) => { for (const l of lines.filter((x) => x.trim()).slice(-n)) say("   |", l); };

// Claude's prompt box on a screen: the text between its last two rules.
function box(lines) {
  const rules = lines.map((l, i) => (/^─{20,}$/.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
  if (rules.length < 2) return null;
  const [a, b] = rules.slice(-2);
  return lines.slice(a + 1, b).map((l) => l.replace(/^❯ ?/, "").trim()).filter(Boolean);
}
const working = (lines) => lines.some((l) => /esc to interrupt/.test(l));
const readyScreen = async (w) => { const s = await w.screen(); const b = box(s); return b && !b.length && !working(s) ? s : null; };

// ---------------------------------------------------------------- the clipboard

const clipboardText = () => spawnSync("/usr/bin/pbpaste", { encoding: "utf8" }).stdout;
const clipboardInfo = () => spawnSync("/usr/bin/osascript", ["-e", "clipboard info"], { encoding: "utf8" }).stdout.trim();
/** A small PNG on the clipboard, as an app's Copy would put it there. */
function imageOnClipboard() {
  const w = 16, h = 16;
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, body) => { const len = Buffer.alloc(4); len.writeUInt32BE(body.length); const tb = Buffer.concat([Buffer.from(type), body]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(tb)); return Buffer.concat([len, tb, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows[y * (w * 3 + 1) + 1 + x * 3] = 255;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  const file = path.join(data, "red.png");
  fs.writeFileSync(file, png);
  spawnSync("/usr/bin/osascript", ["-e", `set the clipboard to (read (POSIX file "${file}") as «class PNGf»)`]);
}

// ---------------------------------------------------------------- the throwaway Airpocket

const store = createStore(data);
let service = null, app = null, base = "", token = "";
async function startAirpocket() {
  service = createService({ dir: data });
  app = createServer({ store, service, log: () => {},
    superset: async () => { throw new Error("Superset isn't part of this trial"); }, hasSuperset: () => false });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await new Promise((r) => service.listen(0, r));
}
async function stopAirpocket() {
  await new Promise((r) => app.server.close(r));
  service.close();
}
async function api(method, p, body) {
  const res = await fetch(base + p, { method, headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const phoneSession = async () => ((await api("GET", "/api/sessions")).json.sessions || [])[0] || null;
const phoneReplies = async (id) => ((await api("GET", "/api/screen?id=" + id)).json.items || []).filter((it) => it.type === "agent").map((it) => it.text.trim().toLowerCase());

const hook = `AIRPOCKET_DIR=${q(data)} ${q(process.execPath)} ${q(path.join(REPO, "src", "hook.js"))} claude`;
const events = ["SessionStart", "UserPromptSubmit", "Stop", "Notification", "SessionEnd"];
const claudeSettings = JSON.stringify({ remoteControlAtStartup: false,
  hooks: Object.fromEntries(events.map((e) => [e, [{ hooks: [{ type: "command", command: hook, timeout: 5 }] }]])) });
const claudeArgs = ["--setting-sources", "project", "--settings", claudeSettings, "--model", "haiku"];

// ---------------------------------------------------------------- part 1: bytes through tmux

async function partBytes() {
  const P = "bytes";
  say("Part 1: what reaches an agent through Airpocket's tmux (a stand-in agent that logs its input)");
  const bin = path.join(data, "bin");
  fs.mkdirSync(bin);
  const log = path.join(data, "keys.log");
  // The stand-in: raw mode, asks for extended keys and bracketed paste as Claude does, prints 200 lines, logs input and size changes.
  fs.writeFileSync(path.join(data, "keylog.py"), [
    "import os, sys, time, tty, signal, struct, fcntl, termios",
    `log = open(${JSON.stringify(log)}, "a", buffering=1)`,
    "def size(): r, c, _, _ = struct.unpack('HHHH', fcntl.ioctl(0, termios.TIOCGWINSZ, b'\\0' * 8)); return '%dx%d' % (c, r)",
    "signal.signal(signal.SIGWINCH, lambda *a: log.write('%.1f WINCH %s\\n' % (time.time() * 1000, size())))",
    "tty.setraw(0)",
    "os.write(1, b'\\x1b[?2004h\\x1b[>4;2m')",
    "for i in range(200): os.write(1, b'output line %d\\r\\n' % i)",
    "while True:",
    "    d = os.read(0, 4096)",
    "    if not d: break",
    "    log.write('%.1f %s\\n' % (time.time() * 1000, d.hex()))",
  ].join("\n"));
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec /usr/bin/python3 ${q(path.join(data, "keylog.py"))}\n`, { mode: 0o755 });
  const entries = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => { const [at, ...rest] = l.split(" "); return { at: +at, what: rest.join(" ") }; }) : []);
  /** Send bytes, wait for what arrives: [{ at, what }] after `since`. */
  const sendAndSee = async (w, bytes, ms = 600) => { const n = entries().length; const at = Date.now(); await w.send(bytes); await sleep(ms); return { at, got: entries().slice(n) }; };

  const standIn = { env: { ...baseEnv, PATH: `${bin}:/usr/bin:/bin` } };
  const lagOf = async (w, bytes) => { const r = await sendAndSee(w, bytes, 650); return r.got.length ? Math.round(r.got[0].at - r.at) : null; };
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

  // Esc in the first seconds after attaching, from a terminal that answers every query and one that doesn't answer XTVERSION.
  const escWindow = {};
  for (const [kind, answers] of Object.entries(ANSWERS)) {
    const v = terminalWindow("esc-" + kind);
    await v.open([process.execPath, CLI, "run", "claude"], { ...standIn, answers });
    await until(async () => (await v.screen()).some((l) => l.includes("output line 199")), 8000);
    const started = Date.now();
    const early = [], late = [];
    while (Date.now() - started < 4000) early.push(await lagOf(v, ESC));
    while (Date.now() - started < 6000) await sleep(100);
    for (let i = 0; i < 3; i++) late.push(await lagOf(v, ESC));
    escWindow[kind] = { early: med(early), late: med(late) };
    await v.close(); await sleep(300); v.quit();
    tmuxOk("kill-server");
    fs.writeFileSync(log, "");
    await sleep(300);
  }
  check(P, "Esc with no delay from a terminal that answers tmux's queries (like iTerm2, Ghostty)", escWindow.all.early < 30 && escWindow.all.late < 30,
    `first 4 s after attaching: ${escWindow.all.early} ms; after 6 s: ${escWindow.all.late} ms`);
  check(P, "Esc with no delay from a terminal that doesn't answer XTVERSION", escWindow.noVersion.early < 30 && escWindow.noVersion.late < 30,
    `first 4 s after attaching: ${escWindow.noVersion.early} ms; after 6 s: ${escWindow.noVersion.late} ms (tmux 3.6a holds Esc 500 ms until DA1, DA2 and XTVERSION are answered, at most 5 s)`);

  const w = terminalWindow("stand-in");
  await w.open([process.execPath, CLI, "run", "claude"], standIn);
  const up = await until(async () => (await w.screen()).some((l) => l.includes("output line 199")), 8000);
  const sessions = tmuxOk("list-sessions", "-F", "#{session_name}") || "";
  check(P, "airpocket run starts it in tmux on Airpocket's socket, attached to this window", up && /^claude-/.test(sessions.trim()), sessions.trim());
  const statusBar = (await w.screen()).some((l) => /\[claude-.*\]\s+0:/.test(l));
  check(P, "no tmux status bar on screen", !statusBar);
  const opt = (flag, name) => (tmuxOk("show-options", flag, name) || "").trim();
  const running = [opt("-s", "escape-time"), opt("-s", "extended-keys"), opt("-s", "extended-keys-format"), opt("-g", "status"), opt("-g", "prefix"), opt("-g", "mouse"), opt("-s", "set-clipboard")];
  check(P, "the running server has Airpocket's settings (read from the server, not the file)",
    running.join(", ") === "escape-time 0, extended-keys always, extended-keys-format csi-u, status off, prefix None, mouse on, set-clipboard on", running.join(", "));

  await sleep(5500);                                      // past tmux's query window, for the byte checks below

  let r = await sendAndSee(w, KEY.shiftEnterCsiU);
  check(P, "Shift+Enter (CSI u from the terminal) arrives as a modified Enter, not a plain Enter", r.got.length && r.got.map((g) => g.what).join("") !== "0d",
    `sent 1b5b31333b3275, got ${r.got.map((g) => g.what).join(" ") || "nothing"}`);
  r = await sendAndSee(w, KEY.shiftEnterXterm);
  check(P, "Shift+Enter (xterm modifyOtherKeys) arrives as a modified Enter", r.got.length && r.got.map((g) => g.what).join("") !== "0d",
    `got ${r.got.map((g) => g.what).join(" ") || "nothing"}`);
  r = await sendAndSee(w, KEY.optionEnter);
  check(P, "Option+Enter (Esc, Enter) arrives", r.got.length > 0, `got ${r.got.map((g) => g.what).join(" ") || "nothing"}`);

  r = await sendAndSee(w, KEY.paste("one\ntwo"));
  const pasted = r.got.map((g) => g.what).join("");
  check(P, "a paste arrives bracketed, so the agent knows it's a paste", pasted.startsWith("1b5b3230307e") && pasted.endsWith("1b5b3230317e"), `got ${pasted}`);
  r = await sendAndSee(w, KEY.ctrlV);
  // An agent that asked for extended keys (as Claude does) gets Ctrl+V in that form; one that didn't gets the byte.
  const ctrlV = r.got.map((g) => g.what).join("");
  check(P, "Ctrl+V (Claude's image paste) arrives, as the byte or in the extended form the agent asked for", ctrlV === "16" || ctrlV === "1b5b3131383b3575", `got ${ctrlV}`);

  const resized = await sendAndSee({ send: () => w.resize(24, 70) }, "", 800);
  check(P, "a window resize reaches the agent with the new size", resized.got.some((g) => g.what === "WINCH 70x24"), resized.got.map((g) => g.what).join(", "));
  await w.resize(30, 100);
  await sleep(500);

  // Scrollback: the wheel scrolls back; scrolling to the end, or typing, leaves it; a typed key isn't lost.
  const inMode = () => (tmuxOk("display-message", "-p", "#{pane_in_mode}") || "").trim() === "1";
  for (let i = 0; i < 3; i++) await w.send(KEY.wheelUp(10, 10));
  await sleep(400);
  const scrolled = inMode() && (await w.screen()).some((l) => /output line 1[0-8]\d$/.test(l) && !l.includes("199"));
  for (let i = 0; i < 10; i++) await w.send(KEY.wheelDown(10, 10));
  await sleep(400);
  check(P, "the wheel scrolls back, and scrolling down to the end leaves scrollback", scrolled && !inMode());
  for (let i = 0; i < 3; i++) await w.send(KEY.wheelUp(10, 10));
  await sleep(300);
  r = await sendAndSee(w, "k");
  check(P, "typing while scrolled back leaves scrollback, and the key reaches the agent", inMode() === false && r.got.map((g) => g.what).join("") === "6b",
    `got ${r.got.map((g) => g.what).join(" ") || "nothing"}`);
  for (let i = 0; i < 3; i++) await w.send(KEY.wheelUp(10, 10));
  await sleep(300);
  r = await sendAndSee(w, ESC);
  check(P, "Esc while scrolled back only leaves scrollback (it doesn't interrupt the agent)", !inMode() && r.got.length === 0);

  // Copy: drag over a word; tmux copies it to the clipboard (pbcopy) and to the terminal (OSC 52).
  const s = await w.screen();
  const row = s.findIndex((l) => /^output line 19\d$/.test(l));
  const before = (await w.raw()).length;
  await w.send(KEY.press(1, row + 1)); await sleep(80);
  for (let x = 2; x <= 16; x++) { await w.send(KEY.drag(x, row + 1)); await sleep(15); }
  await w.send(KEY.release(16, row + 1));
  await sleep(700);
  const want = s[row].slice(0, 16);
  const osc = /\x1b\]52;[a-z]*;([A-Za-z0-9+/=]+)(\x07|\x1b\\)/.exec((await w.raw()).slice(before));
  check(P, "dragging selects and copies to the Mac's clipboard (pbcopy)", clipboardText() === want, JSON.stringify(clipboardText()));
  check(P, "and to the terminal's own clipboard (OSC 52, for terminals that allow it)", osc && Buffer.from(osc[1], "base64").toString() === want, osc ? Buffer.from(osc[1], "base64").toString() : "no OSC 52");
  check(P, "copying leaves scrollback", !inMode());

  // An agent that asks for the kitty keyboard protocol and turns modifyOtherKeys off, as Codex does.
  fs.writeFileSync(path.join(data, "keylog-kitty.py"), fs.readFileSync(path.join(data, "keylog.py"), "utf8").replace("\\x1b[>4;2m", "\\x1b[>4;0m\\x1b[>7u"));
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nexec /usr/bin/python3 ${q(path.join(data, "keylog-kitty.py"))}\n`, { mode: 0o755 });
  const k = terminalWindow("kitty-agent");
  await k.open([process.execPath, CLI, "run", "codex"], standIn);
  await until(async () => (await k.screen()).some((l) => l.includes("output line 199")), 8000);
  await sleep(500);
  const kShift = (await sendAndSee(k, KEY.shiftEnterCsiU)).got.map((g) => g.what).join("");
  const kCtrlC = (await sendAndSee(k, KEY.ctrlC)).got.map((g) => g.what).join("");
  check(P, "an agent that asks for the kitty protocol (Codex) gets Shift+Enter as CSI 13;2u, and Ctrl+C as the plain byte",
    kShift === "1b5b31333b3275" && kCtrlC === "03", `Shift+Enter ${kShift}, Ctrl+C ${kCtrlC}`);
  await k.close(); await sleep(300); k.quit();

  await w.close();
  await sleep(500);
  const kept = (tmuxOk("list-sessions", "-F", "#{session_name} #{session_attached}") || "").split("\n").filter((l) => l.startsWith("claude-")).join("\n");
  check(P, "closing the window detaches; the agent keeps running", kept && / 0$/.test(kept.trim()), kept && kept.trim());
  w.quit();
  tmuxOk("kill-server");
  await sleep(300);
}

// ---------------------------------------------------------------- the key checks on a real Claude

/** Shift+Enter, Option+Enter, paste and image on a Claude in a window. Returns what happened for each. */
async function claudeKeys(w, P) {
  const out = {};
  // Ctrl+C clears the box; a second one within a moment would exit Claude, so wait that moment out.
  const clear = async () => { await w.send(KEY.ctrlC); await sleep(1800); return until(() => readyScreen(w), 3000); };
  for (const [name, bytes] of [["Shift+Enter, CSI u", KEY.shiftEnterCsiU], ["Shift+Enter, xterm", KEY.shiftEnterXterm], ["Option+Enter", KEY.optionEnter]]) {
    await w.type("first line");
    await w.send(bytes);
    await sleep(300);
    await w.type("second line");
    await sleep(700);
    const s = await w.screen();
    const b = box(s) || [];
    out[name] = b.includes("first line") && b.includes("second line") && !working(s);
    check(P, `${name} puts a newline in the prompt box, and doesn't send`, out[name], JSON.stringify(b));
    if (!out[name]) show(s);
    await clear();
  }

  await w.send(KEY.paste("alpha\nbeta\ngamma"));
  await sleep(800);
  let s = await w.screen();
  let b = box(s) || [];
  out.paste = b.join(" ").includes("alpha") || b.some((l) => /Pasted text/.test(l));
  check(P, "a pasted three-line text sits in the box, not sent", out.paste && !working(s), JSON.stringify(b));
  await clear();

  imageOnClipboard();
  await w.send(KEY.ctrlV);
  const img = await until(async () => { const x = await w.screen(); return (box(x) || []).some((l) => /\[Image #\d+\]/.test(l)) ? x : null; }, 5000);
  out.image = !!img;
  check(P, "an image on the clipboard pastes into Claude with Ctrl+V", out.image, img ? JSON.stringify(box(img)) : "no [Image #1]");
  if (!img) show(await w.screen());
  await clear();
  return out;
}

/** Ask for a long answer, press Esc once it streams, and time how long until Claude shows it stopped. */
async function escLatency(w, P) {
  await w.type("Write the numbers from 1 to 400, each on its own line, with no other text.");
  await w.send(KEY.enter);
  const streaming = await until(async () => { const s = await w.screen(); return working(s) && s.some((l) => /^\s*\d{1,3}$/.test(l)); }, 30000, 50);
  if (!streaming) { check(P, "Esc interrupts a turn", false, "the answer never started"); return null; }
  const at = Date.now();
  await w.send(KEY.esc);
  const done = await until(async () => (await w.screen()).some((l) => /Interrupted/.test(l)), 5000, 10);
  const ms = done ? Date.now() - at : null;
  check(P, "Esc interrupts a turn at once", done && ms < 1000, ms === null ? "not interrupted" : `${ms} ms from the key to "Interrupted" on screen`);
  await until(() => readyScreen(w), 5000);
  return ms;
}

// ---------------------------------------------------------------- part 2: Claude directly

async function partDirect() {
  const P = "direct";
  say("Part 2: Claude directly in the terminal window, no tmux, for comparison");
  const w = terminalWindow("direct");
  await w.open([CLAUDE, ...claudeArgs]);
  if (!(await until(() => readyScreen(w), 30000))) { check(P, "Claude starts", false); show(await w.screen(), 20); w.quit(); return {}; }
  const keys = await claudeKeys(w, P);
  const esc = await escLatency(w, P);
  await w.type("/exit");
  await w.send(KEY.enter);
  await w.wait(10);
  w.quit();
  return { ...keys, esc };
}

// ---------------------------------------------------------------- part 3: Claude through airpocket run

async function partRun() {
  const P = "run";
  say("Part 3: Claude through airpocket run, and the phone");
  const w = terminalWindow("run");
  await w.open([process.execPath, CLI, "run", "claude", ...claudeArgs]);
  const up = await until(() => readyScreen(w), 30000);
  if (!check(P, "airpocket run claude starts Claude in this window", up)) { show(await w.screen(), 20); w.quit(); return {}; }
  const screen0 = await w.screen();
  check(P, "no tmux status bar", !screen0.some((l) => /\[claude-.*\]\s+\d+:/.test(l)));
  const panePid = Number((tmuxOk("display-message", "-p", "#{pane_pid}") || "").trim());
  const cmd = panePid ? spawnSync("/bin/ps", ["-o", "command=", "-p", String(panePid)], { encoding: "utf8" }).stdout.trim() : "";
  check(P, "the pane's process is Claude itself, on Airpocket's socket", cmd.startsWith(CLAUDE) && fs.lstatSync(SOCK).isSocket(), cmd.slice(0, 60));

  const s = await until(async () => { const x = await phoneSession(); return x && x.can.bridge === "tmux" && x.can.send ? x : null; }, 30000, 400);
  if (!check(P, "the phone sees it, with the tmux bridge, and can send", s, s && JSON.stringify(s.can))) { w.quit(); return {}; }
  const id = s.id;

  let r = await api("POST", "/api/send", { id, text: "Reply with just the word pong." });
  check(P, "a prompt from the phone gets a reply", r.status === 200 && (await until(async () => (await phoneReplies(id)).some((t) => t.includes("pong")), 90000, 500)));
  await until(() => readyScreen(w), 20000);

  // Copy a word from the reply on screen.
  let screen = await w.screen();
  const row = screen.findIndex((l) => /⏺\s+pong/i.test(l));
  if (row >= 0) {
    // From the line's start to past the word: the ⏺ before it may take one cell or two, so columns are counted loosely.
    const end = screen[row].toLowerCase().indexOf("pong") + 8;
    await w.send(KEY.press(1, row + 1)); await sleep(80);
    for (let x = 2; x <= end; x++) { await w.send(KEY.drag(x, row + 1)); await sleep(20); }
    await w.send(KEY.release(end, row + 1));
    await sleep(700);
    check(P, "dragging over the reply copies it to the clipboard", /⏺\s+pong/i.test(clipboardText()), JSON.stringify(clipboardText()));
    check(P, "and Claude's prompt box is still there to type in", !!(await until(() => readyScreen(w), 2000)));
  } else check(P, "dragging over the reply copies it to the clipboard", false, "pong isn't on screen");


  const keys = await claudeKeys(w, P);
  const esc = await escLatency(w, P);

  // Resize: Claude redraws at the new width, and back.
  const rules = (lines) => lines.filter((l) => /^─{20,}$/.test(l.trim())).map((l) => l.trim().length);
  await w.resize(30, 70);
  const narrow = await until(async () => { const x = await w.screen(); return rules(x).length >= 2 && rules(x).slice(-2).every((n) => n === 70) ? x : null; }, 5000);
  const paneW = (tmuxOk("display-message", "-p", "#{window_width}x#{window_height}") || "").trim();
  check(P, "a narrower window: tmux and Claude redraw at 70 columns", narrow && paneW === "70x30", `pane ${paneW}, rules ${narrow ? rules(narrow).slice(-2) : rules(await w.screen())}`);
  await w.resize(30, 100);
  const wide = await until(async () => { const x = await w.screen(); return rules(x).length >= 2 && rules(x).slice(-2).every((n) => n === 100) ? x : null; }, 5000);
  check(P, "and back to 100 columns, the box whole", wide && box(wide) !== null);

  // A long answer, then scrollback.
  await w.type("Write the words alpha1 to alpha60, each on its own line, with no other text.");
  await w.send(KEY.enter);
  await until(async () => (await w.screen()).some((l) => /alpha60/.test(l)), 60000, 300);
  await until(() => readyScreen(w), 20000);
  const inMode = () => (tmuxOk("display-message", "-p", "#{pane_in_mode}") || "").trim() === "1";
  for (let i = 0; i < 8; i++) await w.send(KEY.wheelUp(20, 10));
  await sleep(500);
  screen = await w.screen();
  const early = screen.some((l) => /^\s*⏺?\s*alpha([1-9]|1\d)$/.test(l));
  check(P, "the wheel scrolls back through the conversation", inMode() && early);
  r = await api("POST", "/api/send", { id, text: "should not arrive", submit: false });
  check(P, "the phone waits while the Mac is scrolled back, and says why", r.status === 409 && /copy mode/.test(r.json.message || ""), `${r.status} ${r.json.message || ""}`);
  await w.send("z");
  await sleep(500);
  check(P, "typing leaves scrollback and lands in the prompt box", !inMode() && (box(await w.screen()) || []).join("") === "z");
  await w.send(KEY.ctrlC);
  await sleep(1800);
  await until(() => readyScreen(w), 3000);

  // Close the window: the agent stays, the phone still reaches it.
  await w.close();
  await sleep(800);
  w.quit();
  const listed = (tmuxOk("list-sessions", "-F", "#{session_name} #{session_attached}") || "").trim();
  const alive = (() => { try { process.kill(panePid, 0); return true; } catch { return false; } })();
  check(P, "closing the window detaches: the session and Claude keep running", / 0$/.test(listed) && alive, listed);
  r = await api("POST", "/api/send", { id, text: "Reply with just the word detached." });
  check(P, "the phone still reaches it while no window shows it", r.status === 200 && (await until(async () => (await phoneReplies(id)).some((t) => t.includes("detached")), 90000, 500)));

  // airpocket attach in a new window.
  const w2 = terminalWindow("attach");
  await w2.open([process.execPath, CLI, "attach"]);
  const back = await until(async () => { const x = await w2.screen(); return x.some((l) => /detached/.test(l)) && box(x) ? x : null; }, 8000);
  check(P, "airpocket attach brings it back to a new window", back);
  const history = tmuxOk("capture-pane", "-p", "-S", "-", "-E", "-") || "";
  check(P, "with its scrollback (pong, alpha1 and the rest)", /pong/i.test(history) && /alpha1\b/.test(history) && /alpha60/.test(history));
  for (let i = 0; i < 12; i++) await w2.send(KEY.wheelUp(20, 10));
  await sleep(500);
  check(P, "and the wheel scrolls back through it in the new window", inMode() && (await w2.screen()).some((l) => /alpha\d+$/.test(l)));
  for (let i = 0; i < 40; i++) await w2.send(KEY.wheelDown(20, 10));
  await sleep(400);

  // The service restarts: Claude runs on, and the new service reaches it.
  await stopAirpocket();
  await sleep(500);
  await startAirpocket();
  const again = await until(async () => { const x = await phoneSession(); return x && x.id === id && x.can.send ? x : null; }, 15000, 400);
  check(P, "Airpocket's service restarts; the session is still listed and reachable", again);
  r = await api("POST", "/api/send", { id, text: "Reply with just the word restarted." });
  check(P, "and answers the phone through the new service", r.status === 200 && (await until(async () => (await phoneReplies(id)).some((t) => t.includes("restarted")), 90000, 500)));
  check(P, "the same Claude process all along", (tmuxOk("display-message", "-p", "#{pane_pid}") || "").trim() === String(panePid));

  // /exit: the window gets its prompt back, and nothing is left to attach.
  await until(() => readyScreen(w2), 20000);
  const beforeExit = (await w2.raw()).length;
  await w2.type("/exit");
  await w2.send(KEY.enter);
  const code = await w2.wait(15);
  const tail = (await w2.raw()).slice(beforeExit);
  check(P, "/exit ends the session and the window's command", code === 0 && !tmuxOk("list-sessions"), `exit ${code}, printed after: ${JSON.stringify(tail.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim().slice(-60))}`);
  const gone = await until(async () => !(await phoneSession()), 20000, 400);
  check(P, "and it leaves the phone's list", gone);
  const none = spawnSync(process.execPath, [CLI, "attach"], { encoding: "utf8", env: baseEnv });
  check(P, "airpocket attach then says nothing is running", none.status === 1 && /No agents started with airpocket run are running/.test(none.stderr), none.stderr.trim());
  w2.quit();
  return { ...keys, esc };
}

// ---------------------------------------------------------------- main

(async () => {
  const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
  const mtime = () => { try { return fs.statSync(SETTINGS).mtimeMs; } catch { return 0; } };
  const settingsBefore = mtime();
  const clipBefore = clipboardText();
  const clipKind = clipboardInfo();
  if (clipKind && !/string|utf8/i.test(clipKind)) say(`note: the clipboard holds more than text (${clipKind.slice(0, 60)}); only its text is put back`);
  let direct = {}, run = {};
  try {
    await startAirpocket();
    token = (await (await fetch(base + "/api/pair", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: store.newCode().code, name: "try-own-terminal" }) })).json()).token;
    await partBytes();
    direct = await partDirect();
    run = await partRun();
  } catch (err) {
    say("error:", err.stack || err.message);
    results.push(["trial", "ran to the end", false, err.message]);
  } finally {
    tmuxOk("kill-server");
    try { await stopAirpocket(); } catch {}
    spawnSync("/usr/bin/pbcopy", { input: clipBefore });
    check("trial", "the user's ~/.claude/settings.json untouched", mtime() === settingsBefore);
    fs.rmSync(data, { recursive: true, force: true });
    console.log("\nSide by side, Claude directly vs through airpocket run:");
    for (const k of ["Shift+Enter, CSI u", "Shift+Enter, xterm", "Option+Enter", "paste", "image"]) {
      console.log(`  ${k.padEnd(20)} ${String(direct[k] ?? "-").padEnd(8)} ${run[k] ?? "-"}`);
    }
    console.log(`  ${"Esc to Interrupted".padEnd(20)} ${(direct.esc ?? "-") + " ms"}   ${(run.esc ?? "-") + " ms"}`);
    console.log();
    for (const [part, name, pass, detail] of results) console.log(`${pass ? "PASS" : "FAIL"} [${part}] ${name}${detail ? "  (" + detail + ")" : ""}`);
    const failed = results.filter((x) => !x[2]).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();

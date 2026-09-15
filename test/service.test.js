"use strict";
// The background service: records, the waiting list and the hook endpoint,
// each in its own temp folder, with a clock and a process table the tests move.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { createService, takeLock } = require("../src/service");
const { startTimeOf, processAlive, parseLstart } = require("../src/proc");
const { start, createServer } = require("../src/server");
const { createStore } = require("../src/store");

const MIN = 60000;
const ID = "11111111-2222-4333-8444-555555555555";
const ID2 = "66666666-7777-4888-9999-000000000000";
const temps = [];
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "airpocket-svc-")); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

/** A service on an ephemeral loopback port, with a clock and a set of dead pids the test controls. */
async function setup(dir = tempDir()) {
  const t = { dir, clock: Date.parse("2026-09-15T10:00:00Z"), dead: new Set(), logs: [] };
  t.svc = createService({ dir, now: () => t.clock, alive: (pid) => !t.dead.has(pid), log: (...a) => t.logs.push(a.join(" ")) });
  t.port = await new Promise((ok) => t.svc.listen(0, ok));
  t.secret = JSON.parse(fs.readFileSync(path.join(dir, "hook.json"), "utf8")).secret;
  t.hook = (event, body, o = {}) => call(t.port, "/hook/" + event, body, { Authorization: "Bearer " + t.secret, ...o });
  t.waiting = () => t.svc.getQueue().map((q) => [q.sid, q.kind, q.reason]);
  t.close = () => new Promise((ok) => t.svc.close(ok));
  return t;
}

function call(port, p, body, headers = {}, { method = "POST", raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw !== undefined ? Buffer.from(raw) : body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const all = { ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}), ...headers };
    for (const k of Object.keys(all)) if (all[k] === undefined) delete all[k];
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: all }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
const mode = (p) => fs.statSync(p).mode & 0o777;

test("hooks need the secret from the private file; anything else is refused and changes nothing", async () => {
  const t = await setup();
  try {
    const body = { session_id: ID, agent: "claude", cwd: "/Users/x/proj", pid: 4242 };
    assert.equal(await t.hook("session", body, { Authorization: undefined }), 401, "no secret");
    assert.equal(await t.hook("session", body, { Authorization: "Bearer " + "x".repeat(43) }), 401, "wrong secret");
    assert.equal(await t.hook("session", body, { Authorization: "Bearer " + t.secret.slice(0, -1) }), 401, "almost the secret");
    assert.equal(await t.hook("session", body, { Authorization: "Bearer " + t.secret + "x" }), 401, "the secret and more");
    assert.equal(await t.hook("session", body, { Origin: "https://evil.example" }), 403, "a web page, even one holding the secret");
    assert.equal(await t.hook("session", body, { Host: "evil.example:80" }), 403, "a rebound DNS name");
    assert.equal(await call(t.port, "/hook/session?secret=" + t.secret, body), 401, "never in the address");
    assert.equal(await call(t.port, "/hook/session", undefined, { Authorization: "Bearer " + t.secret, "Content-Type": "text/plain" }, { raw: "{}" }), 415);
    assert.equal(await call(t.port, "/hook/session", undefined, { Authorization: "Bearer " + t.secret }, { raw: "x".repeat(20000) }), 413);
    assert.equal(await call(t.port, "/hook/session", undefined, { Authorization: "Bearer " + t.secret }, { raw: "[1]" }), 400);
    assert.equal(await t.hook("session", { ...body, session_id: "../../etc/passwd" }), 400, "a session id that is not an id");
    assert.equal(await t.hook("enqueue", { ...body, reason: "because" }), 400, "reasons are an allow-list");
    assert.equal(await t.hook("dequeue", { ...body, why: "whatever" }), 400);
    assert.equal(await t.hook("nuke", body), 404);
    assert.equal(await call(t.port, "/hook/session", undefined, { Authorization: "Bearer " + t.secret }, { method: "GET" }), 405);
    assert.deepEqual(t.svc.knownSessions(), []);
    assert.deepEqual(t.svc.getQueue(), []);
    assert.deepEqual(fs.readdirSync(path.join(t.dir, "sessions")), []);
    assert.ok(t.logs.every((l) => !l.includes(t.secret)), "the secret is never logged");
  } finally { await t.close(); }
});

test("files are private and written whole", async () => {
  const t = await setup();
  try {
    await t.hook("enqueue", { session_id: ID, agent: "codex", cwd: "/Users/x/proj", reason: "finished", pid: 4242 });
    assert.equal(mode(t.dir), 0o700);
    assert.equal(mode(path.join(t.dir, "sessions")), 0o700);
    for (const f of ["hook.json", "queue.json", path.join("sessions", ID + ".json")]) assert.equal(mode(path.join(t.dir, f)), 0o600, f);
    const leftovers = [...fs.readdirSync(t.dir), ...fs.readdirSync(path.join(t.dir, "sessions"))].filter((n) => n.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "no temporary files stay behind");
    const rec = JSON.parse(fs.readFileSync(path.join(t.dir, "sessions", ID + ".json"), "utf8"));
    assert.deepEqual([rec.session_id, rec.bridge_id, rec.agent, rec.title, rec.pid], [ID, "codex:" + ID, "codex", "proj", 4242]);
  } finally { await t.close(); }
});

test("what a hook sends is cleaned: control characters, lengths, paths and ids", async () => {
  const t = await setup();
  try {
    const ESC = String.fromCharCode(27);
    await t.hook("session", { session_id: ID, agent: "robot", cwd: "relative/dir", title: "a" + ESC + "[31mb\nc", note: "n".repeat(500),
      pid: -5, terminal: "term 1; rm", workspace: "ws-1", bridge_id: "evil" });
    const [r] = t.svc.knownSessions();
    assert.equal(r.agent, "claude", "unknown agents are claude");
    assert.equal(r.cwd, "", "only absolute folders");
    assert.equal(r.title, "a[31mb c");
    assert.equal(r.note.length, 120);
    assert.equal(r.pid, 0);
    assert.equal(r.terminal, "", "terminal ids are an id, not text");
    assert.equal(r.workspace, "ws-1");
    assert.equal(r.bridge_id, "local:" + ID, "the entry id is the service's, not the hook's");
    await t.hook("touch", { session_id: ID, title: "" });
    assert.equal(t.svc.knownSessions()[0].title, "a[31mb c", "an empty field keeps what was there");
  } finally { await t.close(); }
});

test("waiting list: finished waits 20 minutes, questions 60", async () => {
  const t = await setup();
  try {
    await t.hook("enqueue", { session_id: ID, reason: "finished" });
    await t.hook("enqueue", { session_id: ID2, reason: "needs permission" });
    assert.deepEqual(t.waiting(), [[ID, "done", "finished"], [ID2, "input", "needs permission"]]);
    t.clock += 19 * MIN;
    assert.equal(t.waiting().length, 2);
    t.clock += 1 * MIN;
    assert.deepEqual(t.waiting(), [[ID2, "input", "needs permission"]], "finished expired at 20 minutes");
    t.clock += 39 * MIN;
    assert.equal(t.waiting().length, 1);
    t.clock += 1 * MIN;
    assert.deepEqual(t.waiting(), [], "the question expired at 60 minutes");
    assert.equal(t.svc.knownSessions().length, 2, "expired sessions stay on the list, just not waiting");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.dir, "queue.json"), "utf8")).queue, [], "and the file says so");
  } finally { await t.close(); }
});

test("waiting list: every reason has its kind; the same session replaces its old entry", async () => {
  const dir = tempDir();
  // A waiting list from before, holding this session under another entry id.
  fs.writeFileSync(path.join(dir, "queue.json"), JSON.stringify({ queue: [
    { id: "session_OLD", sid: ID, kind: "done", reason: "finished", message: "old", at: Date.parse("2026-09-15T09:59:00Z") },
    { id: "junk" }, { id: "bad", sid: "../x", kind: "done" }] }));
  const t = await setup(dir);
  try {
    assert.deepEqual(t.waiting(), [[ID, "done", "finished"]], "broken entries are dropped on load");
    await t.hook("enqueue", { session_id: ID, reason: "needs permission", message: "Run it?", pid: 100 });
    assert.deepEqual(t.svc.getQueue().map((q) => [q.id, q.kind, q.message, q.pid]), [["local:" + ID, "input", "Run it?", 100]]);
    await t.hook("enqueue", { session_id: ID, reason: "waiting for you", pid: 200 });
    assert.deepEqual(t.svc.getQueue().map((q) => [q.id, q.reason, q.message, q.pid]), [["local:" + ID, "waiting for you", "Run it?", 200]],
      "one entry per session; a new event without a message keeps the old one");
    for (const [reason, kind] of [["finished", "done"], ["waiting for you", "input"], ["needs permission", "input"], ["needs input", "input"], ["needs a response", "input"]]) {
      assert.equal(await t.hook("enqueue", { session_id: ID2, reason }), 204);
      assert.equal(t.svc.getQueue().find((q) => q.sid === ID2).kind, kind, reason);
    }
  } finally { await t.close(); }
});

test("a session whose process is gone leaves the list and the records; a day-old one is forgotten", async () => {
  const t = await setup();
  try {
    await t.hook("enqueue", { session_id: ID, reason: "needs permission", pid: 4242 });
    await t.hook("session", { session_id: ID2, pid: 5151 });
    assert.equal(t.svc.knownSessions().length, 2);
    t.dead.add(4242);
    assert.deepEqual(t.svc.knownSessions().map((r) => r.session_id), [ID2]);
    assert.deepEqual(t.svc.getQueue(), []);
    assert.ok(!fs.existsSync(path.join(t.dir, "sessions", ID + ".json")), "its file is gone");
    t.clock += 24 * 3600 * 1000 + 1000;
    assert.deepEqual(t.svc.knownSessions(), [], "not heard from in a day");
  } finally { await t.close(); }
});

test("a restart keeps records and the waiting list, and the old secret stops working", async () => {
  const t = await setup();
  await t.hook("enqueue", { session_id: ID, reason: "finished", cwd: "/Users/x/proj", pid: process.pid });
  await t.close();
  fs.writeFileSync(path.join(t.dir, "sessions", ID2 + ".json.1.abc.tmp"), "{ half");
  fs.writeFileSync(path.join(t.dir, "sessions", "junk.json"), "{ not json");
  const t2 = await setup(t.dir);
  try {
    t2.clock = t.clock;
    assert.deepEqual(t2.svc.knownSessions().map((r) => [r.session_id, r.title]), [[ID, "proj"]]);
    assert.deepEqual(t2.waiting(), [[ID, "done", "finished"]]);
    assert.ok(!fs.readdirSync(path.join(t.dir, "sessions")).some((n) => n.endsWith(".tmp")), "a half-written file from a crash is cleaned up");
    assert.notEqual(t2.secret, t.secret, "a new secret every start");
    assert.equal(await call(t2.port, "/hook/dequeue", { session_id: ID, why: "prompt" }, { Authorization: "Bearer " + t.secret }), 401);
    assert.equal(await t2.hook("dequeue", { session_id: ID, why: "prompt" }), 204);
    assert.deepEqual(t2.waiting(), []);
  } finally { await t2.close(); }
});

test("one service per data folder: a second one refuses, writes nothing, and the first keeps working", async () => {
  const t = await setup();
  try {
    await t.hook("enqueue", { session_id: ID, reason: "finished", pid: process.pid });
    const snapshot = () => Object.fromEntries(["hook.json", "queue.json", "airpocket.lock", path.join("sessions", ID + ".json")]
      .map((f) => [f, fs.readFileSync(path.join(t.dir, f), "utf8")]));
    const before = snapshot();
    assert.equal(before["airpocket.lock"], `${process.pid} ${startTimeOf(process.pid)}`, "the lock names this process: pid and start time");
    assert.throws(() => createService({ dir: t.dir }), (err) => err.code === "ELOCKED" && /already running/.test(err.message));
    assert.throws(() => start({ dataDir: t.dir, port: 0, filePort: 0, hookPort: 0, log: () => {} }), { code: "ELOCKED" }, "npm start refuses too");
    assert.deepEqual(snapshot(), before, "hook.json, the waiting list, the record and the lock are untouched");
    assert.deepEqual(fs.readdirSync(t.dir).filter((n) => n.endsWith(".tmp")), []);
    assert.equal(await t.hook("touch", { session_id: ID }), 204, "a hook with the file's secret still works");
    assert.deepEqual(t.waiting(), [[ID, "done", "finished"]]);
  } finally { await t.close(); }
  assert.ok(!fs.existsSync(path.join(t.dir, "airpocket.lock")), "closing lets go of the folder");
});

test("a lock left by a process that is gone, or an empty one, is taken over; hook.json waits for listen", async () => {
  const { spawnSync } = require("child_process");
  const gone = spawnSync(process.execPath, ["-e", ""]).pid;          // ran and exited: its pid is free
  const own = startTimeOf(process.pid);
  // Gone; empty; junk; an old-style pid-only lock of a gone process; this very
  // pid with another start time (the pid was reused: the service that wrote it is gone).
  for (const content of [String(gone), "", "not a pid", `${gone} 1700000000`, `${process.pid} ${own - 3600}`]) {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "airpocket.lock"), content);
    const svc = createService({ dir });
    assert.equal(fs.readFileSync(path.join(dir, "airpocket.lock"), "utf8"), `${process.pid} ${own}`, JSON.stringify(content));
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== "airpocket.lock" && n !== "sessions"), [], "nothing left aside");
    assert.ok(!fs.existsSync(path.join(dir, "hook.json")), "nothing tells the hooks about a service that isn't listening");
    const port = await new Promise((ok) => svc.listen(0, ok));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "hook.json"), "utf8")).port, port);
    await new Promise((ok) => svc.close(ok));
  }
});

test("one process: start() runs the phone server, the file server and the hooks, all on loopback", async () => {
  const dataDir = tempDir();
  const app = start({ dataDir, port: 0, filePort: 0, hookPort: 0, log: () => {} });
  const servers = [app.server, app.fileServer];
  try {
    servers.push(app.service.hookServer);
    await Promise.all(servers.map((s) => (s.listening ? null : new Promise((ok) => s.once("listening", ok)))));
    for (const s of servers) assert.equal(s.address().address, "127.0.0.1");
    // hook.json is rewritten with the port once the hook server listens.
    await new Promise((ok) => setImmediate(ok));
    const hook = JSON.parse(fs.readFileSync(path.join(dataDir, "hook.json"), "utf8"));
    assert.equal(hook.port, app.service.hookServer.address().port);
    assert.equal(await call(hook.port, "/hook/session", { session_id: ID }, { Authorization: "Bearer " + hook.secret }), 204);
    assert.deepEqual(app.deps.knownSessions().map((r) => r.session_id), [ID], "the phone server sees what the hooks reported");
  } finally {
    app.service.release();
    await Promise.all(servers.map((s) => new Promise((ok) => s.close(ok))));
  }
});

test("a process is its pid and its start time: a reused pid is someone else", () => {
  const own = startTimeOf(process.pid);
  assert.ok(own > 1700000000, "this process's start time");
  assert.equal(parseLstart("Tue Sep 15 20:04:54 2026"), Math.floor(new Date(2026, 8, 15, 20, 4, 54).getTime() / 1000));
  assert.equal(parseLstart("yesterday"), 0);
  assert.equal(processAlive(process.pid, own), true);
  assert.equal(processAlive(process.pid, own - 60), false, "same pid, started at another time: not the same process");
  assert.equal(processAlive(process.pid, 0), true, "no start time recorded: the pid alone");
  const { spawnSync } = require("child_process");
  assert.equal(processAlive(spawnSync(process.execPath, ["-e", ""]).pid, 0), false, "gone");
});

test("a reused pid can't keep a dead session alive, on the list or waiting", async () => {
  const dir = tempDir();
  const svc = createService({ dir });                           // the real process table
  const port = await new Promise((ok) => svc.listen(0, ok));
  const secret = JSON.parse(fs.readFileSync(path.join(dir, "hook.json"), "utf8")).secret;
  const hook = (event, body) => call(port, "/hook/" + event, body, { Authorization: "Bearer " + secret });
  const own = startTimeOf(process.pid);
  const [LIVE, DEAD, OLD] = [ID, ID2, "77777777-8888-4999-aaaa-bbbbbbbbbbbb"];
  try {
    // This process's pid, as reported by a session that is running: alive.
    await hook("enqueue", { session_id: LIVE, reason: "finished", pid: process.pid, started: own });
    // The same pid as reported by a session that ended long ago: the pid has since
    // been handed to this process, which must not keep that session on the list.
    await hook("enqueue", { session_id: DEAD, reason: "needs permission", pid: process.pid, started: own - 3600 });
    // A record from before start times were kept: the pid is all there is.
    await hook("session", { session_id: OLD, pid: process.pid });
    assert.deepEqual(svc.knownSessions().map((r) => r.session_id).sort(), [LIVE, OLD].sort());
    assert.deepEqual(svc.getQueue().map((q) => [q.sid, q.started]), [[LIVE, own]]);
    assert.ok(!fs.existsSync(path.join(dir, "sessions", DEAD + ".json")));
    // A new pid never inherits the old pid's start time.
    await hook("touch", { session_id: LIVE, pid: 4242 });
    const r = JSON.parse(fs.readFileSync(path.join(dir, "sessions", LIVE + ".json"), "utf8"));
    assert.deepEqual([r.pid, r.started], [4242, 0]);
  } finally { await new Promise((ok) => svc.close(ok)); }
});

test("a start time that can't be read proves nothing: sessions and waiting entries stay", async () => {
  const { spawnSync } = require("child_process");
  const dir = tempDir();
  const svc = createService({ dir, readStarts: () => new Map() });   // ps failing or timing out, every time
  const port = await new Promise((ok) => svc.listen(0, ok));
  const secret = JSON.parse(fs.readFileSync(path.join(dir, "hook.json"), "utf8")).secret;
  const hook = (event, body) => call(port, "/hook/" + event, body, { Authorization: "Bearer " + secret });
  try {
    // A start time that, if it could be read, wouldn't match: unread, it must not count.
    await hook("enqueue", { session_id: ID, reason: "needs permission", pid: process.pid, started: startTimeOf(process.pid) - 3600 });
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(svc.knownSessions().map((r) => r.session_id), [ID], "still on the list, poll " + i);
      assert.deepEqual(svc.getQueue().map((q) => q.reason), ["needs permission"], "still waiting, poll " + i);
    }
    assert.ok(fs.existsSync(path.join(dir, "sessions", ID + ".json")), "its record is kept");
    assert.equal(svc.isLive(svc.knownSessions()[0]), true);
    // A pid that is really gone still leaves: kill(pid, 0) says so, no ps needed.
    await hook("session", { session_id: ID2, pid: spawnSync(process.execPath, ["-e", ""]).pid, started: 5 });
    assert.deepEqual(svc.knownSessions().map((r) => r.session_id), [ID]);
  } finally { await new Promise((ok) => svc.close(ok)); }
});

test("liveness costs one ps call per second, however many sessions and phone polls", async () => {
  const dir = tempDir();
  const own = startTimeOf(process.pid);
  let clock = Date.parse("2026-09-15T10:00:00Z");
  const reads = [];
  const svc = createService({ dir, now: () => clock, readStarts: (pids) => { reads.push(pids.length); return new Map(pids.map((p) => [p, own])); } });
  const hookPort = await new Promise((ok) => svc.listen(0, ok));
  const secret = JSON.parse(fs.readFileSync(path.join(dir, "hook.json"), "utf8")).secret;
  const store = createStore(dir);
  const app = createServer({ store, service: svc, log: () => {} });
  await new Promise((ok) => app.server.listen(0, "127.0.0.1", ok));
  const api = (method, p, body, token) => new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: "127.0.0.1", port: app.server.address().port, path: p, method,
      headers: { ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}), ...(token ? { Authorization: "Bearer " + token } : {}) } },
    (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(JSON.parse(b))); });
    r.on("error", reject);
    r.end(data);
  });
  try {
    for (let i = 0; i < 8; i++) {
      const sid = `aaaaaaaa-0000-4000-8000-00000000000${i}`;
      await call(hookPort, "/hook/session", { session_id: sid, pid: process.pid, started: own }, { Authorization: "Bearer " + secret });
    }
    const { token } = await api("POST", "/api/pair", { code: store.newCode().code });
    reads.length = 0;
    for (let i = 0; i < 5; i++) {
      const { sessions } = await api("GET", "/api/sessions", null, token);
      assert.equal(sessions.length, 8);
      assert.ok(sessions.every((s) => s.live), "every session is live");
    }
    assert.equal(reads.length, 1, "five polls of eight sessions: one ps call");
    clock += 1000;
    await api("GET", "/api/sessions", null, token);
    assert.equal(reads.length, 2, "and one more a second later");
  } finally {
    app.server.close();
    await new Promise((ok) => svc.close(ok));
  }
});

test("the transcript path is kept only when it is that session's .jsonl, by an absolute path", async () => {
  const t = await setup();
  const CODEX = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  const rec = (sid) => t.svc.knownSessions().find((r) => r.session_id === sid);
  try {
    for (const bad of ["relative/" + ID + ".jsonl", "/x/" + ID + ".json", "/x/" + ID2 + ".jsonl", "/x/" + ID + ".jsonl\n", "/etc/passwd", 7]) {
      await t.hook("session", { session_id: ID, agent: "claude", transcript: bad });
      assert.equal(rec(ID).transcript, "", JSON.stringify(bad));
    }
    await t.hook("session", { session_id: ID, transcript: "/Users/x/work-config/projects/-p/" + ID + ".jsonl" });
    assert.equal(rec(ID).transcript, "/Users/x/work-config/projects/-p/" + ID + ".jsonl");
    await t.hook("touch", { session_id: ID, transcript: "/x/" + ID2 + ".jsonl" });
    assert.equal(rec(ID).transcript, "/Users/x/work-config/projects/-p/" + ID + ".jsonl", "a bad one never replaces a good one");
    await t.hook("session", { session_id: CODEX, agent: "codex", transcript: "/x/" + CODEX + ".jsonl" });
    assert.equal(rec(CODEX).transcript, "", "Codex's are rollout files");
    await t.hook("session", { session_id: CODEX, agent: "codex", transcript: `/c/sessions/2026/09/15/rollout-2026-09-15T10-00-00-${CODEX}.jsonl` });
    assert.equal(rec(CODEX).transcript, `/c/sessions/2026/09/15/rollout-2026-09-15T10-00-00-${CODEX}.jsonl`);
    await t.hook("session", { session_id: ID2, pane: "%12", tmux: "/private/tmp/tmux-501/default", tmux_pid: 321 });
    await t.hook("touch", { session_id: ID2, pane: "12; kill", tmux: "relative", tmux_pid: 999 });
    assert.deepEqual([rec(ID2).pane, rec(ID2).tmux, rec(ID2).tmux_pid], ["%12", "/private/tmp/tmux-501/default", 321],
      "tmux pane ids only, absolute socket paths only, and the server pid only with its socket");
    await t.hook("touch", { session_id: ID2, tmux: "/private/tmp/tmux-501/other", tmux_pid: "77" });
    assert.deepEqual([rec(ID2).tmux, rec(ID2).tmux_pid], ["/private/tmp/tmux-501/other", 0], "another server's socket never keeps the old server's pid");
    // The service screens snippets too, whatever sent them.
    await t.hook("dequeue", { session_id: ID2, why: "prompt", note: "deploy with ghp_" + "c".repeat(36) });
    assert.equal(rec(ID2).note, "", "a note that looks like a token is not stored");
    await t.hook("enqueue", { session_id: ID2, reason: "finished", message: "Key: sk-" + "d".repeat(30) });
    assert.equal(t.svc.getQueue().find((q) => q.sid === ID2).message, "", "nor a message");
  } finally { await t.close(); }
});

test("a lock held by another running process is respected", () => {
  const dir = tempDir();
  // The test runner that started this file: alive, with its own start time.
  fs.writeFileSync(path.join(dir, "airpocket.lock"), `${process.ppid} ${startTimeOf(process.ppid)}`);
  assert.throws(() => createService({ dir }), { code: "ELOCKED" });
  assert.equal(fs.readFileSync(path.join(dir, "airpocket.lock"), "utf8"), `${process.ppid} ${startTimeOf(process.ppid)}`);
  assert.deepEqual(fs.readdirSync(dir), ["airpocket.lock"], "and nothing else was written");
});

test("two services that find the same stale lock at once: the second to move it puts the winner's back", () => {
  const dir = tempDir();
  const file = path.join(dir, "airpocket.lock");
  fs.writeFileSync(file, "999999 5");                          // a service long gone
  const running = new Set(["111 1000", "222 2000"]);
  const alive = (pid, started) => running.has(`${pid} ${started}`);
  // A judges the lock stale; before A moves it, B does the same, moves it aside
  // and links its own. A then moves B's lock aside instead of the stale one.
  let bTook = false;
  assert.throws(() => takeLock(file, "111 1000", { alive, onStale: () => { takeLock(file, "222 2000", { alive }); bTook = true; } }),
    { code: "ELOCKED" }, "A sees what it moved wasn't the stale lock, puts it back, and gives way");
  assert.ok(bTook, "B took the folder");
  assert.equal(fs.readFileSync(file, "utf8"), "222 2000", "B's lock is in place");
  assert.deepEqual(fs.readdirSync(dir), ["airpocket.lock"], "nothing left aside");
  // Before this fix, A unlinked what it judged stale, which by then was B's lock,
  // and both ran.
});

test("six services started at the same moment over a stale lock: one runs, five refuse", async () => {
  const { spawn, spawnSync } = require("child_process");
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "airpocket.lock"), `${spawnSync(process.execPath, ["-e", ""]).pid} 5`);
  const at = Date.now() + 1500;                               // every child waits for this moment, then goes
  const code = `const { createService } = require(${JSON.stringify(path.join(__dirname, "..", "src", "service"))});
    while (Date.now() < ${at}) {}
    try { createService({ dir: process.argv[1] }); process.stdout.write("ok"); setTimeout(() => {}, 1500); }
    catch (e) { process.stdout.write(e.code || e.message); }`;
  const outs = await Promise.all(Array.from({ length: 6 }, () => new Promise((ok) => {
    const c = spawn(process.execPath, ["-e", code, dir]);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => ok(out));
  })));
  assert.deepEqual(outs.sort(), ["ELOCKED", "ELOCKED", "ELOCKED", "ELOCKED", "ELOCKED", "ok"]);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith("airpocket.lock")), ["airpocket.lock"], "no lock copies left behind");
});

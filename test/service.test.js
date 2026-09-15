"use strict";
// The background service: records, the waiting list and the hook endpoint,
// each in its own temp folder, with a clock and a process table the tests move.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { createService } = require("../src/service");
const { start } = require("../src/server");

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
  t.close = () => new Promise((ok) => t.svc.hookServer.close(ok));
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

test("one process: start() runs the phone server, the file server and the hooks, all on loopback", async () => {
  const dataDir = tempDir();
  const app = start({ dataDir, port: 0, filePort: 0, hookPort: 0, log: () => {} });
  const servers = [app.server, app.fileServer, app.service.hookServer];
  try {
    await Promise.all(servers.map((s) => (s.listening ? null : new Promise((ok) => s.once("listening", ok)))));
    for (const s of servers) assert.equal(s.address().address, "127.0.0.1");
    // hook.json is rewritten with the port once the hook server listens.
    await new Promise((ok) => setImmediate(ok));
    const hook = JSON.parse(fs.readFileSync(path.join(dataDir, "hook.json"), "utf8"));
    assert.equal(hook.port, app.service.hookServer.address().port);
    assert.equal(await call(hook.port, "/hook/session", { session_id: ID }, { Authorization: "Bearer " + hook.secret }), 204);
    assert.deepEqual(app.deps.knownSessions().map((r) => r.session_id), [ID], "the phone server sees what the hooks reported");
  } finally {
    await Promise.all(servers.map((s) => new Promise((ok) => s.close(ok))));
  }
});

"use strict";
// The background service: Airpocket's own record of the sessions on this Mac and
// of which ones are waiting for you. It runs in the same process as the phone
// server, which reaches it through three plain functions (no HTTP hop):
//
//   knownSessions()   session records from the last day, newest first
//   getQueue()        the waiting list: [{ id, sid, kind, reason, message, at, pid }]
//   dequeue(id, sid)  take a session off the waiting list
//
// The hooks in Claude Code and Codex tell it what happens, through a small
// endpoint on 127.0.0.1 (never published to the tailnet). Each call must carry
// the secret in hook.json, a private file that only this Mac's user can read;
// the secret is new every time the service starts, and hook.json is written
// only once the endpoint is listening.
//
// One service per data folder: airpocket.lock holds the running one's pid. A
// second one refuses to start and writes nothing; a lock whose process is gone
// is stale and is taken over.
//
//   POST /hook/session   a session started, or something about it changed
//   POST /hook/enqueue   it waits for you: finished, waiting for you, needs permission, ...
//   POST /hook/dequeue   it no longer waits: you sent a prompt, or the session ended
//   POST /hook/touch     it is still there
//
// Every body names the session ({ session_id, agent, cwd, title, branch, note,
// account, pid, terminal, workspace }); a field left out or empty keeps what
// was recorded before.
//
// What it keeps, in Airpocket's data folder (folders 0700, files 0600, every
// file written whole to a temporary name and renamed into place, so a crash
// never leaves half a file):
//
//   sessions/<id>.json   one record per session
//   queue.json           the waiting list
//   hook.json            { port, secret } for the hooks
//
// The waiting list's rules: a turn that finished is "done" and waits 20
// minutes; anything that needs a decision is "input" and waits 60. A session
// has one entry at most, and a new event replaces the old one. A session whose
// process is gone leaves the list and the records; a record not heard from in
// a day is forgotten.
const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const DAY_S = 24 * 3600;
const TTL_MS = Object.freeze({ input: 60 * 60000, done: 20 * 60000 });
const REASONS = new Set(["finished", "waiting for you", "needs permission", "needs input", "needs a response"]);
const SESSION_ID = /^[A-Za-z0-9_-]{6,100}$/;
const TERMINAL_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SECRET_HEADER = /^Bearer ([A-Za-z0-9_-]{43})$/;
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/i;
const JSON_TYPE = /^application\/json(\s*;.*)?$/i;
const MAX_BODY = 16 * 1024;
const EVENTS = new Set(["session", "enqueue", "dequeue", "touch"]);

/** "input" blocks on a human decision; "done" just means a turn ended. */
const kindOf = (reason) => (!reason || reason === "finished" ? "done" : "input");

/** Is this process still there? Without a pid there is nothing to check, so yes. */
function processAlive(pid) {
  if (!pid) return true;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
}

/** Write a file whole or not at all: a private temporary file, flushed, then renamed over the old one. */
function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/** A folder only this user can open, made if missing and tightened if not. */
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

const stripControl = (s) => Array.from(String(s)).filter((ch) => { const c = ch.charCodeAt(0); return c > 31 && c !== 127; }).join("");
/** A hook's text field: no control characters, clipped to n. Anything but a string is "". */
const text = (v, n) => {
  if (typeof v !== "string") return "";
  const t = stripControl(v.replace(/\s+/g, " ")).trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const absPath = (v) => (typeof v === "string" && v.length <= 1024 && path.isAbsolute(v) && stripControl(v) === v ? v : "");
const pidOf = (v) => (Number.isSafeInteger(v) && v > 1 ? v : 0);
const terminalId = (v) => (typeof v === "string" && TERMINAL_ID.test(v) ? v : "");

/**
 * Take the data folder's lock, or throw (code ELOCKED) when another running
 * service holds it. A lock whose process is gone, or that says nothing, is stale.
 */
function takeLock(file) {
  for (let tries = 0; tries < 3; tries++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    let pid = 0;
    try { pid = Number(fs.readFileSync(file, "utf8").trim()); } catch {}
    if (pidOf(pid) && processAlive(pid)) {
      const err = new Error(`Airpocket is already running for ${path.dirname(file)} (process ${pid}).`);
      err.code = "ELOCKED";
      throw err;
    }
    try { fs.unlinkSync(file); } catch {}
  }
  throw new Error(`Couldn't take ${file}.`);
}

function createService({ dir, log = () => {}, now = Date.now, alive = processAlive } = {}) {
  if (!dir) throw new Error("createService needs a data folder");
  const sessionsDir = path.join(dir, "sessions");
  const queueFile = path.join(dir, "queue.json");
  const hookFile = path.join(dir, "hook.json");
  const lockFile = path.join(dir, "airpocket.lock");
  // The lock comes before anything else is written, so a second service changes nothing.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  takeLock(lockFile);
  let locked = true;
  privateDir(dir);
  privateDir(sessionsDir);

  const records = new Map();          // session id -> record
  let queue = [];

  // What an earlier run left: records and the waiting list. Leftover temporary
  // files are from a write that never finished, so they go.
  for (const name of fs.readdirSync(sessionsDir)) {
    const file = path.join(sessionsDir, name);
    if (name.endsWith(".tmp")) { try { fs.unlinkSync(file); } catch {} continue; }
    const id = name.endsWith(".json") ? name.slice(0, -5) : "";
    if (!SESSION_ID.test(id)) continue;
    try {
      const r = JSON.parse(fs.readFileSync(file, "utf8"));
      if (r && r.session_id === id) records.set(id, r);
    } catch {}
  }
  try {
    const saved = JSON.parse(fs.readFileSync(queueFile, "utf8"));
    queue = (Array.isArray(saved && saved.queue) ? saved.queue : [])
      .filter((q) => q && typeof q.id === "string" && typeof q.sid === "string" && SESSION_ID.test(q.sid) && Object.hasOwn(TTL_MS, q.kind));
  } catch {}

  const persist = (what, fn) => { try { fn(); } catch (err) { log(`service: couldn't save ${what}: ${err.code || err.message}`); } };
  const saveQueue = () => persist("the waiting list", () => writeAtomic(queueFile, JSON.stringify({ queue }, null, 2)));
  const saveRecord = (r) => persist("a session", () => writeAtomic(path.join(sessionsDir, r.session_id + ".json"), JSON.stringify(r, null, 2)));
  const dropRecord = (sid) => { records.delete(sid); try { fs.unlinkSync(path.join(sessionsDir, sid + ".json")); } catch {} };

  /** Expired entries, gone processes and day-old records leave. Cheap enough to run on every read. */
  function sweep() {
    const t = now();
    let changed = false;
    for (const [sid, r] of records) {
      if ((r.pid && !alive(r.pid)) || !(r.last_seen >= t / 1000 - DAY_S)) {
        dropRecord(sid);
        if (queue.some((q) => q.sid === sid)) { queue = queue.filter((q) => q.sid !== sid); changed = true; }
      }
    }
    const before = queue.length;
    queue = queue.filter((q) => t - (q.at || 0) < TTL_MS[q.kind] && (!q.pid || alive(q.pid)));
    if (changed || queue.length !== before) saveQueue();
  }

  /** Record what a hook says about a session; fields it leaves out or empty keep their old values. */
  function upsert(b) {
    const sid = b.session_id;
    const prev = records.get(sid) || {};
    const agent = b.agent === "codex" || b.agent === "claude" ? b.agent : prev.agent || "claude";
    const cwd = absPath(b.cwd) || prev.cwd || "";
    const r = {
      session_id: sid,
      bridge_id: (agent === "codex" ? "codex:" : "local:") + sid,
      agent,
      cwd,
      title: text(b.title, 120) || prev.title || path.basename(cwd) || "session",
      branch: text(b.branch, 200) || prev.branch || "",
      note: text(b.note, 120) || prev.note || "",
      account: text(b.account, 200) || prev.account || "",
      pid: pidOf(b.pid) || prev.pid || 0,
      terminal: terminalId(b.terminal) || prev.terminal || "",
      workspace: terminalId(b.workspace) || prev.workspace || "",
      last_seen: Math.floor(now() / 1000),
    };
    records.set(sid, r);
    saveRecord(r);
    return r;
  }

  /** Put a session on the waiting list. One entry per session: a new event replaces the old one. */
  function enqueue(r, reason, message) {
    const old = queue.find((q) => q.id === r.bridge_id) || {};
    queue = queue.filter((q) => q.id !== r.bridge_id && q.sid !== r.session_id);
    queue.push({ id: r.bridge_id, sid: r.session_id, kind: kindOf(reason), reason, message: message || old.message || "", at: now(), pid: r.pid || 0 });
    saveQueue();
  }

  /** Take a session off the waiting list, by entry id or session id. How many left. */
  function dequeue(id, sid) {
    if (!id && !sid) return 0;
    const before = queue.length;
    queue = queue.filter((q) => !((id && q.id === id) || (sid && q.sid === sid)));
    if (queue.length !== before) saveQueue();
    return before - queue.length;
  }

  function knownSessions() {
    sweep();
    return [...records.values()].sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0)).map((r) => ({ ...r }));
  }
  function getQueue() {
    sweep();
    return queue.map((q) => ({ ...q }));
  }

  /** One hook event. Returns an HTTP status. */
  function handle(event, b) {
    if (!SESSION_ID.test(String(b.session_id))) return 400;
    switch (event) {
      case "session":
      case "touch":
        upsert(b);
        return 204;
      case "enqueue": {
        if (!REASONS.has(b.reason)) return 400;
        enqueue(upsert(b), b.reason, text(b.message, 220));
        return 204;
      }
      case "dequeue": {
        if (b.why === "end") {
          const r = records.get(b.session_id);
          dequeue(r && r.bridge_id, b.session_id);
          dropRecord(b.session_id);
          return 204;
        }
        if (b.why !== "prompt") return 400;
        const r = upsert(b);
        dequeue(r.bridge_id, r.session_id);
        return 204;
      }
    }
    return 404;
  }

  // ---- the hook endpoint ----
  const secret = crypto.randomBytes(32).toString("base64url");
  const secretHash = crypto.createHash("sha256").update(secret).digest();
  const secretOk = (header) => {
    const m = SECRET_HEADER.exec(String(header || ""));
    const got = crypto.createHash("sha256").update(m ? m[1] : "").digest();
    return !!m && crypto.timingSafeEqual(got, secretHash);
  };
  const writeHookFile = (port) => writeAtomic(hookFile, JSON.stringify({ port, secret }, null, 2) + "\n");

  const hookServer = http.createServer((req, res) => {
    const done = (status, close) => {
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Content-Length": 0,
                              ...(close ? { Connection: "close" } : {}) });
      res.end();
      // Hooks fire all the time; log refusals only. Never the body or the secret.
      if (status >= 400) log(`hook ${req.method} ${pathname.slice(0, 40)} ${status}`);
    };
    let pathname = "";
    try { pathname = new URL(req.url || "/", "http://hook.invalid").pathname; } catch {}
    const event = /^\/hook\/([a-z]+)$/.exec(pathname);
    if (!event || !EVENTS.has(event[1])) { req.resume(); return done(404); }
    if (req.method !== "POST") { req.resume(); return done(405); }
    // Only programs on this Mac, never a web page: a browser always sends Origin,
    // and a rebound DNS name would show up in Host.
    if (req.headers.origin || !LOOPBACK_HOST.test(String(req.headers.host || ""))) { req.resume(); return done(403); }
    if (!secretOk(req.headers.authorization)) { req.resume(); return done(401); }
    if (!JSON_TYPE.test(req.headers["content-type"] || "")) { req.resume(); return done(415); }
    // Too big: answer at once and close the connection, without reading the rest.
    if (Number(req.headers["content-length"]) > MAX_BODY) return done(413, true);
    const chunks = [];
    let size = 0, over = false;
    req.on("data", (c) => {
      if (over) return;
      size += c.length;
      if (size <= MAX_BODY) { chunks.push(c); return; }
      over = true;
      req.pause();
      done(413, true);
    });
    req.on("end", () => {
      if (over) return;
      let b;
      try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
      if (!b || typeof b !== "object" || Array.isArray(b)) return done(400);
      let status;
      try { status = handle(event[1], b); } catch (err) { log("hook error:", err && err.message); status = 500; }
      done(status);
    });
    req.on("error", () => {});
  });
  hookServer.requestTimeout = 5000;
  hookServer.headersTimeout = 5000;

  /** Listen on 127.0.0.1; only once it is up does hook.json tell the hooks where, and with which secret. */
  function listen(port, cb) {
    hookServer.listen(port, "127.0.0.1", () => {
      const actual = hookServer.address().port;
      persist("hook.json", () => writeHookFile(actual));
      if (cb) cb(actual);
    });
    return hookServer;
  }

  /** Let go of the data folder: the lock goes, if it is still this process's. */
  function release() {
    if (!locked) return;
    locked = false;
    try { if (fs.readFileSync(lockFile, "utf8").trim() === String(process.pid)) fs.unlinkSync(lockFile); } catch {}
  }
  /** Stop the hook endpoint and release the lock. */
  function close(cb) {
    release();
    if (hookServer.listening) hookServer.close(() => cb && cb());
    else if (cb) cb();
  }

  return { dir, hookFile, lockFile, knownSessions, getQueue, dequeue, sweep, hookServer, listen, release, close };
}

module.exports = { createService, kindOf, writeAtomic, TTL_MS, REASONS };

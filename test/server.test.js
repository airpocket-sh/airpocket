"use strict";
// npm test   (node --test)
// Starts the server with a stand-in service and a stand-in Superset, and
// checks each security promise the README makes.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { createServer, tidyScreen, cleanText, liveState, claudeItems, shellLabel, codexStep, sessionInfo, sessionRoot } = require("../src/server");
const { createStore } = require("../src/store");
const { createService } = require("../src/service");
const { portsFrom } = require("../src/ports");
const { othersOn, serveLines } = require("../src/cli");
const { startTimeOf, processInfo } = require("../src/proc");
const ME = startTimeOf(process.pid);          // the stand-in sessions' agent is this test process

const ESC = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airpocket-test-"));
const store = createStore(dir);
const now = Math.floor(Date.now() / 1000);
const CLAUDE = "cb2d94c7-3e54-464a-8086-79db7d007c02";
const CODEX = "01a09c74-c19c-79d0-926f-81a420e20565";
const PLAIN = "aaaaaaaa-0000-0000-0000-000000000000";
const SESS = [
  { session_id: PLAIN, bridge_id: "local:" + PLAIN, title: "plain", agent: "claude", last_seen: now - 120 },
  { session_id: CODEX, bridge_id: "codex:" + CODEX, title: "u", account: "", agent: "codex", pid: 0, last_seen: now - 60, terminal: "", workspace: "" },
  { session_id: CLAUDE, bridge_id: "session_01ABC", title: "SEO Research", account: "info@example.com", branch: "main",
    note: "hi", agent: "claude", pid: process.pid, started: ME,last_seen: now, terminal: "term-1", workspace: "ws-1" },
];
const CLAUDE2 = "11111111-2222-3333-4444-555555555555";
SESS.push({ session_id: CLAUDE2, bridge_id: "session_02", title: "Chat", agent: "claude", pid: process.pid, started: ME,last_seen: now - 5, terminal: "term-2", workspace: "ws-2" });
const LIVE_SCREEN = "some output\n✽ Fermenting… (3m 28s · ↓ 15.0k tokens)\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don't ask again\n   3. No, and tell Claude what to do differently (esc)\n";
const proj = path.join(dir, "projects", "-Users-x-Chat");
fs.mkdirSync(proj, { recursive: true });
const J = (o) => JSON.stringify(o);
fs.writeFileSync(path.join(proj, CLAUDE2 + ".jsonl"), [
  J({ type: "user", uuid: "u1", timestamp: "2026-09-14T10:00:00Z", message: { role: "user", content: "Build the list <system-reminder>secret reminder</system-reminder>" } }),
  J({ type: "user", uuid: "u2", isMeta: true, message: { role: "user", content: "meta stuff" } }),
  J({ type: "user", uuid: "u3", message: { role: "user", content: "<command-name>/model</command-name><command-args>opus</command-args>" } }),
  J({ type: "user", uuid: "u4", message: { role: "user", content: "<task-notification>done</task-notification>" } }),
  J({ type: "assistant", uuid: "a1", message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "hidden thoughts" }] } }),
  J({ type: "assistant", uuid: "a2", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Here is **the plan**." }] } }),
  J({ type: "assistant", uuid: "a3", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "curl -H 'Authorization: Bearer SECRET-TOKEN' x", description: "Check the address" } }] } }),
  J({ type: "user", uuid: "u5", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "SECRET-OUTPUT" }] } }),
  J({ type: "assistant", uuid: "a4", message: { id: "m2", role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/Users/x/private/notes.md" } }, { type: "text", text: "Done." }] } }),
  J({ type: "assistant", uuid: "a5", isSidechain: true, message: { id: "m3", role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } }),
  J({ type: "attachment", uuid: "q1", attachment: { type: "queued_command", prompt: "and push it", timestamp: "2026-09-14T10:01:00Z" } }),
  J({ type: "user", uuid: "u6", message: { role: "user", content: "[Request interrupted by user]" } }),
  "{ not json",
].join("\n"));
// A Codex session in a Superset terminal, mid-turn. Its session file already has
// the steps so far; the screen has Codex's dot animation over the prompt line.
const CODEX_T = "01a0a069-1fef-7a71-b5f1-1db10d06b25c";
SESS.push({ session_id: CODEX_T, bridge_id: "codex:" + CODEX_T, title: "PM", agent: "codex", pid: process.pid, started: ME,last_seen: now - 3, terminal: "term-3", workspace: "ws-3" });
const D1 = String.fromCharCode(0x2801), D2 = String.fromCharCode(0x2840);
const BRAILLE_RE = new RegExp("[" + String.fromCharCode(0x2800) + "-" + String.fromCharCode(0x28ff) + "]");
const CODEX_SCREEN = ["› Can you combine everything into a PDF?", "", "• Working (3s • esc to interrupt)",
  `  ${D1}    ${D2}   ${D1}`, `›${D1}Ask Codex to do anything${D2}    ${D1}`, `${D2}      ${D1}`, "  gpt-6 medium · ~/Desktop/PM"].join("\n");
const t7 = new Date(parseInt(CODEX_T.slice(0, 8) + CODEX_T.slice(9, 13), 16)), p2 = (n) => String(n).padStart(2, "0");
const rolloutDir = path.join(dir, "codex", "sessions", String(t7.getFullYear()), p2(t7.getMonth() + 1), p2(t7.getDate()));
fs.mkdirSync(rolloutDir, { recursive: true });
const rollout = path.join(rolloutDir, `rollout-2026-09-14T17-53-59-${CODEX_T}.jsonl`);
const ev = (payload, ts = "2026-09-14T18:00:00.000Z") => J({ timestamp: ts, ordinal: 1, type: "event_msg", payload });
const finished = (item) => ev({ type: "item_completed", thread_id: CODEX_T, turn_id: "t1", item });
const FINAL = finished({ type: "AgentMessage", id: "a2", phase: "final_answer", content: [{ type: "Text", text: "Made the PDF." }] });
fs.writeFileSync(rollout, [
  J({ timestamp: "2026-09-14T18:00:00.000Z", type: "session_meta", payload: { id: CODEX_T } }),
  ev({ type: "task_started", turn_id: "t1" }),
  finished({ type: "UserMessage", id: "u1", content: [{ type: "text", text: "Can you combine everything into a PDF?" }] }),
  J({ timestamp: "x", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "SECRET-CONTEXT" }] } }),
  finished({ type: "Reasoning", id: "r1", summary_text: [], raw_content: [] }),
  finished({ type: "AgentMessage", id: "a1", phase: "commentary", content: [{ type: "Text", text: "I'll gather the reports first." }] }),
  finished({ type: "CommandExecution", id: "c1", command: ["/bin/zsh", "-lc", "cat /x/SKILL.md"], status: "completed", exit_code: 0,
    parsed_cmd: [{ type: "read", cmd: "cat /x/SKILL.md", name: "SKILL.md", path: "/x/SKILL.md" }], stdout: "SECRET-OUT", aggregated_output: "SECRET-OUT" }),
  finished({ type: "CommandExecution", id: "c2", command: ["/bin/zsh", "-lc", "cd /x && npm test -- --token SECRET-ARG"], status: "failed", exit_code: 1,
    parsed_cmd: [{ type: "unknown", cmd: "cd /x && npm test -- --token SECRET-ARG" }], stdout: "", aggregated_output: "SECRET-OUT" }),
  finished({ type: "FileChange", id: "f1", changes: { "/x/out/report.md": { type: "add", content: "SECRET-CONTENT" } }, status: "completed" }),
  finished({ type: "Extension", id: "w1", kind: "web.search", query: "pdf tools", action: { type: "search", queries: ["pdf tools"] }, results: [{ snippet: "SECRET-RESULT" }] }),
].join("\n") + "\n" + FINAL.slice(0, 40));        // the last line is still being written

// Superset's own lists, and a session with text typed but not sent.
const PROJ = "11111111-aaaa-4aaa-8aaa-111111111111", WS = "22222222-bbbb-4bbb-8bbb-222222222222";
const CLAUDE3 = "33333333-4444-5555-6666-777777777777";
SESS.push({ session_id: CLAUDE3, bridge_id: "session_03", title: "Typed", agent: "claude", pid: process.pid, started: ME,last_seen: now - 8, terminal: "term-4", workspace: "ws-4" });
const STAGED_SCREEN = "output\n❯ half typed thought\n  default | Opus 5 | context: 12%";
const QUEUE = [{ id: "session_01ABC", sid: CLAUDE, kind: "input", reason: "input", message: "Claude is waiting" }];

// A session in a tmux pane (a real socket file, a stand-in tmux), and one whose
// agent has exited: its pid now has another start time.
const TMUXS = "66666666-7777-8888-9999-000000000000", GONE = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
const TMUX_OLD = "88888888-9999-aaaa-bbbb-cccccccccccc";
const TMUX_SOCK = path.join(dir, "tmux.sock"), TMUX_SERVER = 4343;
const sockServer = net.createServer().listen(TMUX_SOCK);
SESS.push({ session_id: TMUXS, bridge_id: "local:" + TMUXS, title: "In tmux", agent: "claude", pid: process.pid, started: ME, last_seen: now - 10, pane: "%7", tmux: TMUX_SOCK, tmux_pid: TMUX_SERVER });
// Yesterday's session on the same pane id, from a tmux server that has since restarted.
SESS.push({ session_id: TMUX_OLD, bridge_id: "local:" + TMUX_OLD, title: "Old tmux", agent: "claude", pid: process.pid, started: ME - 60, last_seen: now - 12, pane: "%7", tmux: TMUX_SOCK, tmux_pid: 1111 });
SESS.push({ session_id: GONE, bridge_id: "local:" + GONE, title: "Ended", agent: "claude", pid: process.pid, started: ME - 60, last_seen: now - 11, terminal: "term-9", workspace: "ws-9" });
const TMUX_SCREEN = "tmux output   \n❯ ";
let supersetHere = true;

// Files: a project under a stand-in home, and a session that wrote, read and mentioned things there.
const HOME = path.join(dir, "home"), ROOT = path.join(HOME, "proj");
for (const d of ["out", "sub/.hidden", "node_modules/x"]) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
const PDF = "%PDF-1.7\n" + "x".repeat(4000) + "\n%%EOF\n";
const put = (rel, data) => fs.writeFileSync(path.join(ROOT, rel), data);
put("out/report.pdf", PDF);
put("fake.pdf", "<html><script>steal()</script></html>");
put("notes.md", "# Notes\nHello **there**\n");
put("page.html", "<html><body><h1>Hi</h1><script>steal()</script></body></html>");
put("pic.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]));
put(".env", "SECRET-ENV=1"); put("prod.key", "SECRET-KEY"); put("api-keys.txt", "SECRET-KEYS");
put("sub/.hidden/x.md", "SECRET-HIDDEN"); put("node_modules/x/readme.md", "SECRET-DEP"); put("data.sqlite", "SQLite format 3");
put("keyfile.md", "-----BEGIN RSA PRIVATE KEY-----\nSECRET\n");                       // caught by its first bytes
put("later.md", "# Log\n" + "ok\n".repeat(3000) + "token sk-ant-" + "a".repeat(40) + "\n");  // caught when read
fs.writeFileSync(path.join(HOME, "outside.md"), "SECRET-OUTSIDE");
fs.symlinkSync(path.join(HOME, "outside.md"), path.join(ROOT, "link.md"));
fs.linkSync(path.join(HOME, "outside.md"), path.join(ROOT, "hard.md"));
fs.symlinkSync(path.join(ROOT, "notes.md"), path.join(ROOT, "alias.pdf"));
const FILES = "44444444-5555-6666-7777-888888888888";
SESS.push({ session_id: FILES, bridge_id: "session_04", title: "Files", agent: "claude", pid: process.pid, started: ME,last_seen: now - 9, cwd: ROOT });
fs.mkdirSync(path.join(dir, "projects", "-Users-x-Files"), { recursive: true });
const said = "Saved `out/report.pdf`, the [page](page.html), `pic.png`, `.env`, `prod.key`, `api-keys.txt`, `../outside.md`, `" + path.join(HOME, "outside.md") +
  "`, `link.md`, `hard.md`, `alias.pdf`, `data.sqlite`, `sub/.hidden/x.md`, `node_modules/x/readme.md`, `keyfile.md`, `later.md`, " +
  "[web](https://example.com/a.pdf) and [again](out/report.pdf#page=2).";
const tool = (uuid, mid, id, name, file) => J({ type: "assistant", uuid, message: { id: mid, role: "assistant", content: [{ type: "tool_use", id, name, input: { file_path: path.join(ROOT, file), content: "x" } }] } });
fs.writeFileSync(path.join(dir, "projects", "-Users-x-Files", FILES + ".jsonl"), [
  J({ type: "user", uuid: "f1", message: { role: "user", content: "make files" } }),
  tool("f2", "fm1", "w1", "Write", "notes.md"), tool("f3", "fm2", "r1", "Read", "api-keys.txt"), tool("f4", "fm3", "w2", "Write", "fake.pdf"),
  J({ type: "assistant", uuid: "f5", message: { id: "fm4", role: "assistant", content: [{ type: "text", text: said }] } }),
].join("\n"));
let fileBase = "";

const calls = { superset: [], dequeue: [], tmux: [] };
let removes = 1;                                  // what the stand-in dequeue reports it took off

const app = createServer({
  store, log: () => {}, hostLabel: "Test-Mac", claudeProjects: path.join(dir, "projects"), codexHome: path.join(dir, "codex"),
  homeDir: HOME, fileBase: async () => fileBase, ticketMs: 1500,
  knownSessions: () => SESS,
  getQueue: () => QUEUE,
  superset: async (args) => {
    calls.superset.push(args);
    if (args[0] === "projects" && args[1] === "list") return J([{ id: PROJ, name: "Shop", path: "/Users/x/SECRET-PATH", repo: "https://x/SECRET-REPO" }, { id: "not-a-uuid", name: "bad" }]);
    if (args[0] === "workspaces" && args[1] === "list") return J([{ id: WS, projectId: PROJ, name: "main", branch: "main", type: "main", hostId: "SECRET-HOST" }]);
    if (args[0] === "agents" && args[1] === "list") return J([{ presetId: "claude", label: "Claude", command: "claude", args: ["--SECRET-FLAG"] }, { presetId: "codex", label: "Codex" }, { presetId: "Bad Id", label: "x" }]);
    const term = args[args.indexOf("--terminal") + 1];
    if (args[1] === "read") return JSON.stringify({ terminalId: term, cols: 80, rows: 24, text: term === "term-2" ? LIVE_SCREEN : term === "term-3" ? CODEX_SCREEN : term === "term-4" ? STAGED_SCREEN : "hello   \n" + "─".repeat(40) + "\n❯ " });
    return "{}";
  },
  dequeue: (id, sid) => { calls.dequeue.push([id, sid]); return removes; },
  hasSuperset: () => supersetHere,
  tmux: async (args) => {
    calls.tmux.push(args);
    if (args.includes("capture-pane")) return `${TMUX_SERVER}\n${TMUX_SCREEN}`;
    if (args[3] === "display-message") return `${TMUX_SERVER} 0 /dev/ttys998\n`;
    return "";
  },
  typeGap: () => 0,
  // This test process stands in for every agent: its real start time, in the foreground of the stand-in terminal.
  inspectAgent: (pid) => { const i = processInfo(pid); return i && { ...i, tty: "ttys998", pgid: 9, tpgid: 9 }; },
});
test.after(() => sockServer.close());

let base;
test.before(() => new Promise((ok) => app.server.listen(0, "127.0.0.1", () => {
  base = `http://127.0.0.1:${app.server.address().port}`;
  app.fileServer.listen(0, "127.0.0.1", () => { fileBase = `http://127.0.0.1:${app.fileServer.address().port}`; ok(); });
})));
test.after(() => { app.server.close(); app.fileServer.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function req(method, p, { body, headers = {}, raw, at = base } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw !== undefined ? Buffer.from(raw) : body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(at + p, { method, headers: { ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}), ...headers } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, headers: res.headers, body: b, json }); });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
let token;
const auth = (t = token) => ({ Authorization: "Bearer " + t });
const last = () => calls.superset[calls.superset.length - 1];

test("the static app is served with a strict CSP; anything else is 404", async () => {
  const r = await req("GET", "/");
  assert.equal(r.status, 200);
  assert.match(r.headers["content-security-policy"], /default-src 'none'.*script-src 'self'/);
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.equal(r.headers["cache-control"], "no-store");
  for (const p of ["/../store.js", "/server.js", "/src/server.js", "/test/server.test.js", "/%2e%2e/package.json", "/sessions"]) {
    assert.equal((await req("GET", p)).status, 404, p);
  }
});

test("every API call but pairing needs a paired device's token", async () => {
  for (const [m, p] of [["GET", "/api/hello"], ["GET", "/api/sessions"], ["GET", "/api/screen?id=" + CLAUDE]]) {
    assert.equal((await req(m, p)).status, 401, p);
    assert.equal((await req(m, p, { headers: auth("x".repeat(43)) })).status, 401, p + " with a made-up token");
  }
  assert.equal((await req("POST", "/api/send", { body: { id: CLAUDE, text: "hi" } })).status, 401);
  assert.equal(calls.superset.length, 0, "nothing reached Superset");
});

test("pairing: no code, then a code with five tries, then a working token", async () => {
  assert.equal((await req("POST", "/api/pair", { body: { code: "123456" } })).status, 400, "no code waiting");
  store.newCode();
  for (let i = 0; i < 4; i++) assert.equal((await req("POST", "/api/pair", { body: { code: "000000" } })).status, 401);
  const fifth = await req("POST", "/api/pair", { body: { code: "000000" } });
  assert.equal(fifth.status, 401);
  assert.equal(fifth.json.left, 0);
  assert.equal((await req("POST", "/api/pair", { body: { code: "000000" } })).status, 400, "the code is gone after five tries");

  const { code } = store.newCode();
  const ok = await req("POST", "/api/pair", { body: { code: code.slice(0, 3) + " " + code.slice(3), name: "iPhone " + BELL + "\n" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.host, "Test-Mac");
  token = ok.json.token;
  assert.ok(token.length >= 40);
  assert.equal(store.devices()[0].name, "iPhone", "control characters stripped from the name");
  assert.ok(!JSON.stringify(store.devices()).includes(token), "the token itself is never stored");
  assert.equal((await req("POST", "/api/pair", { body: { code } })).status, 400, "a code works once");
});

test("sessions come back merged with the queue, the one that needs you first", async () => {
  const r = await req("GET", "/api/sessions", { headers: auth() });
  assert.equal(r.status, 200);
  const s = r.json.sessions;
  assert.equal(s[0].id, CLAUDE);
  assert.equal(s[0].waiting, true);
  assert.equal(s[0].note, "Claude is waiting");
  assert.equal(s[0].account, "info");
  assert.equal(s[0].via, "terminal");
  assert.equal(s.find((x) => x.id === CODEX).via, null, "a Codex thread with no terminal is read-only");
  assert.equal(s.find((x) => x.id === PLAIN).via, null);
  assert.ok(!("workspace" in s[0]) && !("terminal" in s[0]), "terminal ids never leave the Mac");
});

test("reading a screen uses the terminal on record, and tidies it", async () => {
  const r = await req("GET", "/api/screen?id=" + CLAUDE, { headers: auth() });
  assert.equal(r.status, 200);
  assert.deepEqual(last(), ["terminals", "read", "--workspace", "ws-1", "--terminal", "term-1", "--json"]);
  assert.equal(r.json.text, "hello\n\n❯");
  assert.equal((await req("GET", "/api/screen?id=../../etc", { headers: auth() })).status, 404);
  assert.equal((await req("GET", "/api/screen?id=" + PLAIN, { headers: auth() })).status, 409);
});

test("sending: argv only, line breaks become spaces, Enter optional, limits enforced", async () => {
  const evil = "a\nb; rm -rf ~ $(whoami) `id`" + ESC + "[31m";
  assert.equal((await req("POST", "/api/send", { headers: auth(), body: { id: CLAUDE, text: evil } })).status, 200);
  assert.deepEqual(last(), ["terminals", "send", "--workspace", "ws-1", "--terminal", "term-1", "--text", "a b; rm -rf ~ $(whoami) `id`[31m"]);
  await req("POST", "/api/send", { headers: auth(), body: { id: CLAUDE, text: "staged", submit: false } });
  assert.deepEqual(last().slice(-2), ["staged", "--no-submit"]);
  const n = calls.superset.length;
  assert.equal((await req("POST", "/api/send", { headers: auth(), body: { id: CLAUDE, text: "   " } })).status, 400);
  assert.equal((await req("POST", "/api/send", { headers: auth(), body: { id: CLAUDE, text: "x".repeat(8001) } })).status, 400);
  assert.equal((await req("POST", "/api/send", { headers: auth(), body: { id: "nope-nope", text: "hi" } })).status, 404);
  assert.equal((await req("POST", "/api/send", { headers: auth(), body: { id: CLAUDE, text: 5 } })).status, 400);
  assert.equal(calls.superset.length, n, "none of the refused sends reached Superset");
});

test("keys are an allow-list: digits and Esc without Enter, Enter alone", async () => {
  await req("POST", "/api/key", { headers: auth(), body: { id: CLAUDE, key: "esc" } });
  assert.deepEqual(last().slice(-3), ["--text", ESC, "--no-submit"]);
  await req("POST", "/api/key", { headers: auth(), body: { id: CLAUDE, key: "enter" } });
  assert.deepEqual(last().slice(-2), ["--text", ""]);
  await req("POST", "/api/key", { headers: auth(), body: { id: CLAUDE, key: "2" } });
  assert.deepEqual(last().slice(-3), ["--text", "2", "--no-submit"]);
  for (const key of ["ctrl-c", "", "__proto__", "constructor", 1]) {
    assert.equal((await req("POST", "/api/key", { headers: auth(), body: { id: CLAUDE, key } })).status, 400, String(key));
  }
  assert.equal((await req("POST", "/api/key", { headers: auth(), body: { id: CODEX, key: "1" } })).status, 409, "no keys without a terminal");
});

test("codex without a terminal is read-only: nothing to type into, no approvals to answer", async () => {
  const n = calls.superset.length;
  const r = await req("GET", "/api/screen?id=" + CODEX, { headers: auth() });
  assert.equal(r.status, 409, "no terminal and no session file: nothing to show");
  const sent = await req("POST", "/api/send", { headers: auth(), body: { id: CODEX, text: "next" } });
  assert.equal(sent.status, 409);
  assert.match(sent.json.message, /read-only/);
  assert.equal((await req("POST", "/api/answer", { headers: auth(), body: { id: CODEX, request: "7", decision: "accept" } })).status, 404, "there is no answer route any more");
  assert.equal(calls.superset.length, n, "nothing reached Superset");
});

test("a tmux session: read with capture-pane, typed with send-keys, keys by tmux name, Controls too", async () => {
  const list = (await req("GET", "/api/sessions", { headers: auth() })).json;
  assert.deepEqual(list.can, { start: true });
  const s = list.sessions.find((x) => x.id === TMUXS);
  assert.deepEqual(s.can, { bridge: "tmux", read: true, send: true, keys: true, controls: true, why: "" });
  assert.equal(s.via, "terminal");
  assert.equal(list.sessions.find((x) => x.id === CLAUDE).can.bridge, "superset");
  assert.deepEqual(list.sessions.find((x) => x.id === PLAIN).can, { bridge: null, read: false, send: false, keys: false, controls: false,
    why: "It isn't in a Superset or tmux terminal." });
  assert.ok(!JSON.stringify(list).includes(TMUX_SOCK) && !JSON.stringify(list).includes("%7"), "socket and pane never leave the Mac");
  const n = calls.superset.length;
  const r = await req("GET", "/api/screen?id=" + TMUXS, { headers: auth() });
  assert.equal(r.status, 200);
  assert.equal(r.json.kind, "terminal");
  assert.equal(r.json.text, "tmux output\n❯");
  assert.equal(r.json.can.bridge, "tmux");
  assert.deepEqual(calls.tmux.at(-1), ["-u", "-S", TMUX_SOCK, "display-message", "-p", "-t", "%7", "#{pid}", ";", "capture-pane", "-p", "-t", "%7"]);
  calls.tmux.length = 0;
  assert.equal((await req("POST", "/api/send", { headers: auth(), body: { id: TMUXS, text: "a\nb;" } })).status, 200);
  assert.deepEqual(calls.tmux.map((a) => a.slice(3)), [["display-message", "-p", "-t", "%7", "#{pid} #{pane_in_mode} #{pane_tty}"],
    ["send-keys", "-t", "%7", "-l", "--", "a b\\;"], ["send-keys", "-t", "%7", "Enter"]]);
  await req("POST", "/api/key", { headers: auth(), body: { id: TMUXS, key: "esc" } });
  assert.deepEqual(calls.tmux.at(-1).slice(3), ["send-keys", "-t", "%7", "Escape"]);
  await req("POST", "/api/key", { headers: auth(), body: { id: TMUXS, key: "2" } });
  assert.deepEqual(calls.tmux.at(-1).slice(3), ["send-keys", "-t", "%7", "-l", "--", "2"]);
  calls.tmux.length = 0;
  const c = await req("POST", "/api/command", { headers: auth(), body: { id: TMUXS, cmd: "effort", arg: "high" } });
  assert.equal(c.status, 200);
  assert.deepEqual(calls.tmux.map((a) => a[3]), ["display-message", "display-message", "send-keys", "send-keys"], "checked, looked, typed, Enter");
  assert.ok(calls.tmux[1].includes("capture-pane"), "the look is the screen");
  assert.deepEqual(calls.tmux.slice(-2).map((a) => a.slice(3)), [["send-keys", "-t", "%7", "-l", "--", "/effort high"], ["send-keys", "-t", "%7", "Enter"]]);
  assert.equal(calls.superset.length, n, "nothing went to Superset");
});

test("an old tmux session whose server restarted shows nothing of the pane that took its id", async () => {
  const chat = await req("GET", "/api/screen?id=" + TMUX_OLD, { headers: auth() });
  assert.equal(chat.status, 200);
  assert.deepEqual([chat.json.text, chat.json.live, chat.json.info], ["", null, undefined], "no screen, no live state, no model line from someone else's pane");
  const term = await req("GET", "/api/screen?id=" + TMUX_OLD + "&view=terminal", { headers: auth() });
  assert.equal(term.status, 502, "like a closed terminal");
  assert.ok(!JSON.stringify([chat.json, term.json]).includes("tmux output"));
});

test("an ended agent's terminal is read-only: the phone is told, and nothing is typed", async () => {
  const s = (await req("GET", "/api/sessions", { headers: auth() })).json.sessions.find((x) => x.id === GONE);
  assert.equal(s.live, false);
  assert.deepEqual([s.can.bridge, s.can.read, s.can.send, s.can.keys, s.can.controls], ["superset", true, false, false, false]);
  assert.match(s.can.why, /exited/);
  const n = calls.superset.length;
  for (const [p, body] of [["/api/send", { id: GONE, text: "hi" }], ["/api/key", { id: GONE, key: "enter" }], ["/api/command", { id: GONE, cmd: "compact" }]]) {
    const r = await req("POST", p, { headers: auth(), body });
    assert.equal(r.status, 409, p);
    assert.equal(r.json.error, "ended", p);
  }
  assert.equal(calls.superset.length, n, "nothing reached its terminal, not even a read");
});

test("new sessions need Superset: without it the Mac says so, and nothing runs", async () => {
  supersetHere = false;
  try {
    assert.deepEqual((await req("GET", "/api/sessions", { headers: auth() })).json.can, { start: false });
    assert.deepEqual((await req("GET", "/api/hello", { headers: auth() })).json.can, { start: false });
    const n = calls.superset.length;
    const o = await req("GET", "/api/new/options", { headers: auth() });
    assert.equal(o.status, 409);
    assert.equal(o.json.error, "no_superset");
    assert.equal((await req("POST", "/api/new", { headers: auth(), body: { agent: "claude", prompt: "x", workspace: WS } })).status, 409);
    assert.equal(calls.superset.length, n);
  } finally {
    supersetHere = true;
  }
});

test("CORS only for tailnet and loopback origins; bodies must be small JSON", async () => {
  const ok = await req("GET", "/api/hello", { headers: { ...auth(), Origin: "https://mac-b.tail1234.ts.net" } });
  assert.equal(ok.headers["access-control-allow-origin"], "https://mac-b.tail1234.ts.net");
  assert.equal(ok.headers["access-control-allow-credentials"], undefined, "no credentials: auth is a header, never a cookie");
  const bad = await req("GET", "/api/hello", { headers: { ...auth(), Origin: "https://evil.example" } });
  assert.equal(bad.headers["access-control-allow-origin"], undefined);
  const fake = await req("GET", "/api/hello", { headers: { ...auth(), Origin: "https://ts.net.evil.example" } });
  assert.equal(fake.headers["access-control-allow-origin"], undefined);
  assert.equal((await req("OPTIONS", "/api/send", { headers: { Origin: "https://evil.example" } })).status, 404);
  assert.equal((await req("OPTIONS", "/api/send", { headers: { Origin: "https://mac-b.tail1234.ts.net" } })).status, 204);
  assert.equal((await req("POST", "/api/send", { headers: { ...auth(), "Content-Type": "text/plain" }, raw: "{}" })).status, 415);
  assert.equal((await req("POST", "/api/send", { headers: auth(), raw: "x".repeat(40000) })).status, 413);
  assert.equal((await req("POST", "/api/send", { headers: auth(), raw: "[1,2]" })).status, 400);
});

test("a revoked phone stops working on its next request", async () => {
  assert.equal((await req("GET", "/api/hello", { headers: auth() })).status, 200);
  store.revoke(store.devices()[0].id);
  assert.equal((await req("GET", "/api/hello", { headers: auth() })).status, 401);
});

test("tidyScreen drops full-width rules; cleanText can't carry control characters", () => {
  assert.equal(tidyScreen("a  \n" + "─".repeat(200) + "\n\n\n\nb"), "a\n\nb");
  assert.equal(tidyScreen("─".repeat(12) + " View teammates " + "─".repeat(9)), "View teammates");
  assert.equal(cleanText("x\r\nyz"), "x yz");
  assert.equal(cleanText("a" + ESC + "b"), "ab");
  assert.equal(cleanText(null), null);
});

test("pair a second phone for the chat tests", async () => {
  const { code } = store.newCode();
  token = (await req("POST", "/api/pair", { body: { code, name: "second" } })).json.token;
  assert.ok(token);
});

test("chat view: the transcript becomes messages; tool output, commands and side chatter stay on the Mac", async () => {
  const r = await req("GET", "/api/screen?id=" + CLAUDE2, { headers: auth() });
  assert.equal(r.status, 200);
  assert.equal(r.json.kind, "chat");
  assert.deepEqual(r.json.items.map((i) => i.type), ["user", "command", "agent", "tool", "tool", "agent", "user", "note"]);
  const [u, c, a, t1, t2, a2, q, n] = r.json.items;
  assert.equal(u.text, "Build the list");
  assert.equal(c.text, "/model opus");
  assert.equal(a.text, "Here is **the plan**.");
  assert.deepEqual([t1.name, t1.label, t1.error], ["Bash", "Check the address", true]);
  assert.deepEqual([t2.name, t2.label], ["Read", "notes.md"]);
  assert.equal(a2.text, "Done.");
  assert.equal(q.queued, true);
  assert.equal(n.text, "You interrupted");
  for (const leak of ["SECRET", "secret reminder", "subagent", "hidden thoughts", "meta stuff", "/Users/x/private"]) assert.ok(!r.body.includes(leak), leak);
  assert.equal(r.json.text, undefined, "no terminal text in chat view");
});

test("chat view: an unchanged conversation is not sent again", async () => {
  const first = await req("GET", "/api/screen?id=" + CLAUDE2, { headers: auth() });
  const again = await req("GET", `/api/screen?id=${CLAUDE2}&sig=${first.json.sig}`, { headers: auth() });
  assert.equal(again.json.sig, first.json.sig);
  assert.equal(again.json.items, undefined);
  assert.ok(again.body.length < 1200, "a no-change poll stays small");
  const term = await req("GET", `/api/screen?id=${CLAUDE2}&view=terminal&sig=${first.json.sig}`, { headers: auth() });
  assert.ok(term.json.text.includes("Fermenting"), "terminal view still has the screen");
});

test("live state: working, the on-screen question, and typed-but-unsent text", async () => {
  const r = await req("GET", "/api/screen?id=" + CLAUDE2, { headers: auth() });
  assert.deepEqual([r.json.live.state, r.json.live.verb, r.json.live.elapsed], ["working", "Fermenting…", "3m 28s"]);
  assert.equal(r.json.live.menu.question, "Do you want to proceed?");
  assert.deepEqual(r.json.live.menu.options.map((o) => [o.n, o.cur]), [[1, true], [2, false], [3, false]]);
  const idle = liveState("output\n❯ wait for the other three\n  default | Opus");
  assert.deepEqual([idle.state, idle.staged, idle.menu], ["idle", "wait for the other three", null]);
  assert.equal(liveState("1. first\n2. second\n❯ ").menu, null, "a numbered list in a reply is not a question");
  assert.equal(liveState("• Working (12s • esc to interrupt)").state, "working");
  assert.equal(liveState("› Ask Codex to do anything").staged, "");
});

test("keys: any single digit, nothing longer", async () => {
  assert.equal((await req("POST", "/api/key", { headers: auth(), body: { id: CLAUDE, key: "9" } })).status, 200);
  assert.equal((await req("POST", "/api/key", { headers: auth(), body: { id: CLAUDE, key: "10" } })).status, 400);
});

test("claudeItems copes with an empty or broken tail", () => {
  assert.deepEqual(claudeItems([]), []);
  assert.deepEqual(claudeItems(["", "{", "not json", "{\"type\":\"user\"}"]), []);
});

test("codex citations become the file's name", () => {
  const item = codexStep({ id: "x", type: "AgentMessage", content: [{ type: "Text", text: 'Made it: :codex-file-citation{path="/Users/x/out/report.pdf" purpose="output"}' }] });
  assert.equal(item.text, "Made it: `report.pdf`");
});

test("codex in a terminal: steps come from the session file mid-turn", async () => {
  const r = await req("GET", "/api/screen?id=" + CODEX_T, { headers: auth() });
  assert.equal(r.json.kind, "chat");
  assert.deepEqual(r.json.items.map((i) => [i.type, i.name || "", i.label || i.text]), [
    ["user", "", "Can you combine everything into a PDF?"],
    ["agent", "", "I'll gather the reports first."],
    ["tool", "Read", "SKILL.md"],
    ["tool", "Shell", "npm test …"],
    ["tool", "Edit", "report.md"],
    ["tool", "Search", "pdf tools"],
  ], "a half-written line waits; reasoning and model context are left out");
  assert.equal(r.json.items[1].aside, true, "running narration is marked");
  assert.equal(r.json.items[3].error, true, "a failed command is marked");
  assert.ok(!/SECRET/.test(r.body), "no output, file content, arguments, results or context leaves the Mac");
  assert.deepEqual([r.json.live.state, r.json.live.verb, r.json.live.staged], ["working", "Working…", ""],
    "the prompt from history above is not 'typed, not sent'");

  fs.appendFileSync(rollout, FINAL.slice(40) + "\n" + ev({ type: "task_complete", turn_id: "t1" }) + "\n");
  const r2 = await req("GET", `/api/screen?id=${CODEX_T}&sig=${r.json.sig}`, { headers: auth() });
  assert.notEqual(r2.json.sig, r.json.sig);
  assert.deepEqual(r2.json.items.at(-1), { type: "agent", id: "a2", text: "Made the PDF." });
  const r3 = await req("GET", `/api/screen?id=${CODEX_T}&sig=${r2.json.sig}`, { headers: auth() });
  assert.equal(r3.json.items, undefined, "nothing new, nothing sent");

  const t = await req("GET", `/api/screen?id=${CODEX_T}&view=terminal`, { headers: auth() });
  assert.ok(!BRAILLE_RE.test(t.json.text), "the dot animation is gone from the terminal view");
  assert.ok(t.json.text.includes("› Ask Codex to do anything"));
});

test("codex: a session file that is replaced is read again from the start", async () => {
  fs.writeFileSync(rollout, finished({ type: "UserMessage", id: "u9", content: [{ type: "text", text: "fresh" }] }) + "\n");
  const r = await req("GET", "/api/screen?id=" + CODEX_T, { headers: auth() });
  assert.deepEqual(r.json.items.map((i) => i.text), ["fresh"]);
});

test("codex screens: approval menus, working words, placeholders, history", () => {
  const menu = liveState("Would you like to run the following command?\n\n  $ ls\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)");
  assert.deepEqual(menu.menu.options.map((o) => [o.n, o.cur]), [[1, true], [2, false]]);
  assert.equal(liveState("• Reviewing files (1m 02s • esc to interrupt)").verb, "Reviewing files…");
  assert.equal(liveState("› Ask a follow-up question\n  gpt-6 · ~/x").staged, "");
  assert.equal(liveState("› make it shorter\n  gpt-6 · ~/x").staged, "make it shorter");
});

test("shell steps show the program, and a subcommand only for git, npm and friends", () => {
  assert.equal(shellLabel("git status --short"), "git status …");
  assert.equal(shellLabel("cd /x && pnpm build"), "pnpm build …");
  assert.equal(shellLabel("python3 - <<'PY'\nprint(1)"), "python3 …");
  assert.equal(shellLabel("echo hunter2"), "echo …");
  assert.equal(shellLabel("TOKEN=abc curl https://x"), "curl …");
  assert.equal(shellLabel("pwd"), "pwd");
  assert.equal(shellLabel('for f in a b; do cat "$f"; done'), "script …");
});

test("codex: browser, MCP, image and helper-agent steps get a short label, never their arguments or results", () => {
  const pick = (it) => { const x = codexStep(it, "f"); return [x.name, x.label, !!x.error]; };
  assert.deepEqual(pick({ type: "McpToolCall", id: "m", server: "node_repl", tool: "js", status: "completed",
    arguments: { code: "SECRET", title: "Check browser access to Linear" }, result: { content: [{ text: "SECRET" }], isError: false } }),
    ["node repl", "Check browser access to Linear", false]);
  assert.deepEqual(pick({ type: "McpToolCall", id: "m2", server: "linear", tool: "list_issues", arguments: { q: "SECRET" }, result: { isError: true } }),
    ["linear", "list issues", true]);
  assert.deepEqual(pick({ type: "ImageView", id: "v", path: "file:///tmp/audit/home-mobile.png" }), ["View", "home-mobile.png", false]);
  assert.deepEqual(pick({ type: "Extension", id: "o", kind: "web.search", query: "https://didit.me/x", action: { type: "openPage", url: "https://didit.me/x" } }), ["Open", "didit.me", false]);
  assert.deepEqual(pick({ type: "CollabAgentToolCall", id: "c", tool: "spawn_agent", prompt: "SECRET", receiver_agents: [{ agent_nickname: "Sartre" }], status: "completed" }),
    ["Agent", "spawn agent · Sartre", false]);
  assert.deepEqual(pick({ type: "Extension", id: "w", kind: "web.search", query: "", action: { type: "other" }, results: [{ snippet: "SECRET" }] }), ["Web", "", false]);
});

test("codex: a tail full of huge tool results is widened until it holds the conversation", async () => {
  const id = CODEX_T.slice(0, -1) + "d";
  SESS.push({ session_id: id, bridge_id: "codex:" + id, title: "big", agent: "codex", pid: process.pid, started: ME,last_seen: now, terminal: "term-3", workspace: "ws-3" });
  const big = "y".repeat(1024 * 1024);
  const lines = [finished({ type: "UserMessage", id: "bu", content: [{ type: "text", text: "start here" }] })];
  for (let i = 0; i < 6; i++) lines.push(finished({ type: "McpToolCall", id: "bm" + i, server: "node_repl", tool: "js", arguments: {}, result: { content: [{ type: "text", text: big }] }, status: "completed" }));
  fs.writeFileSync(path.join(rolloutDir, `rollout-2026-09-14T17-53-59-${id}.jsonl`), lines.join("\n") + "\n");
  const r = await req("GET", "/api/screen?id=" + id, { headers: auth() });
  assert.equal(r.json.items[0].text, "start here", "your message is still in view");
  assert.equal(r.json.items.length, 7);
  assert.ok(r.body.length < 5000, "the big results stay on the Mac");
});

test("controls: fixed slash commands, typed then submitted, only when the prompt is free", async () => {
  const ok = await req("POST", "/api/command", { headers: auth(), body: { id: CLAUDE, cmd: "model", arg: "opus" } });
  assert.equal(ok.status, 200);
  const [typed, enter] = calls.superset.slice(-2);
  assert.deepEqual(typed, ["terminals", "send", "--workspace", "ws-1", "--terminal", "term-1", "--text", "/model opus", "--no-submit"]);
  assert.deepEqual(enter, ["terminals", "send", "--workspace", "ws-1", "--terminal", "term-1", "--text", ""]);
  assert.equal((await req("POST", "/api/command", { headers: auth(), body: { id: CLAUDE, cmd: "effort", arg: "xhigh" } })).json.sent, "/effort xhigh");
  assert.equal((await req("POST", "/api/command", { headers: auth(), body: { id: CLAUDE, cmd: "model" } })).json.sent, "/model", "no model opens the picker");
  const n = calls.superset.length;
  for (const body of [{ id: CLAUDE, cmd: "model", arg: "gpt-6; rm -rf ~" }, { id: CLAUDE, cmd: "effort", arg: "ultra" },
                      { id: CLAUDE, cmd: "permissions" }, { id: CLAUDE, cmd: "__proto__" }, { id: CLAUDE, cmd: "toString" }]) {
    assert.equal((await req("POST", "/api/command", { headers: auth(), body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await req("POST", "/api/command", { headers: auth(), body: { id: CLAUDE2, cmd: "compact" } })).json.error, "menu_open");
  assert.equal((await req("POST", "/api/command", { headers: auth(), body: { id: CLAUDE3, cmd: "compact" } })).json.error, "typed_text");
  assert.equal((await req("POST", "/api/command", { headers: auth(), body: { id: CODEX_T, cmd: "permissions" } })).json.error, "busy");
  assert.equal((await req("POST", "/api/command", { headers: auth(), body: { id: CODEX, cmd: "model" } })).status, 409, "no terminal, no controls");
  assert.ok(calls.superset.slice(n).every((a) => a[1] === "read"), "refused commands typed nothing");
});

test("keys: arrows, Tab and Shift+Tab for pickers and Claude's mode", async () => {
  assert.equal((await req("POST", "/api/key", { headers: auth(), body: { id: CLAUDE, key: "stab" } })).status, 200);
  assert.deepEqual(calls.superset.at(-1).slice(-2), [ESC + "[Z", "--no-submit"]);
  assert.equal((await req("POST", "/api/key", { headers: auth(), body: { id: CLAUDE, key: "down" } })).status, 200);
  assert.equal(calls.superset.at(-1)[7], ESC + "[B");
});

test("session info from the screen: Claude's own markers, never a custom status line", async () => {
  const claude = sessionInfo("claude", ["❯", "  default | Opus 5 (1M context) | context: 82% | acct a@b S4%",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)", "                      ◐ medium · /effort"].join("\n"));
  assert.deepEqual(claude, { effort: "medium", mode: "bypass permissions" }, "a status line's model and context are not read");
  assert.deepEqual(sessionInfo("claude", "❯\n  ⏸ plan mode on (shift+tab to cycle)").mode, "plan mode");
  assert.equal(sessionInfo("claude", "❯ \n  ? for shortcuts                ● high · /effort").mode, "default", "the footer without a mode line");
  assert.equal(sessionInfo("claude", " Select model\n ❯ 1. Opus 5\n   2. Sonnet 5").mode, undefined, "a picker hides the footer: no guess");
  assert.deepEqual(sessionInfo("claude", " ✻ Welcome\n   Fable 5.1 with xhigh effort · Claude Max\n❯ "), { model: "Fable 5.1", effort: "xhigh" }, "Claude's own banner");
  const codex = sessionInfo("codex", "› Ask Codex to do anything\n  gpt-6-astra xhigh fast · ~/x · title");
  assert.deepEqual(codex, { model: "gpt-6-astra", effort: "xhigh", fast: true });
  // This Codex file has no settings lines, so the screen says what it runs with.
  const r = await req("GET", "/api/screen?id=" + CODEX_T, { headers: auth() });
  assert.deepEqual([r.json.info.model, r.json.info.name, r.json.info.effort], ["gpt-6", "gpt-6", "medium"]);
  const d = await req("GET", "/api/screen?id=" + CODEX, { headers: auth() });
  assert.equal(d.json.info, undefined, "no terminal and no session file: nothing to say");
});

test("menus: Codex descriptions come apart from the option", () => {
  const m = liveState("  Select Model and Effort\n› 1. gpt-5.6-sol (current)  Latest frontier model.\n  2. gpt-6-astra            Most capable.\n  Press enter to confirm");
  assert.deepEqual(m.menu.options.map((o) => [o.label, o.hint]), [["gpt-5.6-sol (current)", "Latest frontier model."], ["gpt-6-astra", "Most capable."]]);
  assert.equal(liveState('❯ Try "refactor app.js"\n  ? for shortcuts').staged, "", "Claude's grey suggestion is not typed text");
  // Claude marks earlier prompts with ❯ too: under an empty box they are history, not typed text.
  const after = ["❯ Reply with just the word pong.", "", "⏺ pong", "", "✻ Baked for 1s", "", "─".repeat(40), "❯ ", "─".repeat(40), "  ⏸ manual mode on · ? for shortcuts"].join("\n");
  assert.equal(liveState(tidyScreen(after)).staged, "", "an empty box under an earlier prompt");
  assert.equal(liveState(tidyScreen(after.replace("❯ \n", "❯ next one\n"))).staged, "next one");
});

test("seen: opening a finished or idle session clears it; a question stays", async () => {
  QUEUE.push({ id: "session_02", sid: CLAUDE2, kind: "done", reason: "finished" });
  const before = calls.dequeue.length;
  const a = await req("POST", "/api/seen", { headers: auth(), body: { id: CLAUDE2 } });
  assert.equal(a.json.cleared, true);
  assert.deepEqual(calls.dequeue.at(-1), ["session_02", CLAUDE2], "dequeued in-process, by entry and session");
  const b = await req("POST", "/api/seen", { headers: auth(), body: { id: CLAUDE } });
  assert.equal(b.json.cleared, false, "reason 'input' is a real question");
  assert.equal(calls.dequeue.length, before + 1);
  removes = 0;
  const c = await req("POST", "/api/seen", { headers: auth(), body: { id: CLAUDE2 } });
  assert.equal(c.json.cleared, false, "nothing was taken off (another phone or expiry got there first), so it says so");
  removes = 1;
  const s = (await req("GET", "/api/sessions", { headers: auth() })).json.sessions;
  assert.equal(s.find((x) => x.id === CLAUDE2).reason, "finished");
});

test("new session: Superset lists without paths, argv built from checked values only", async () => {
  const o = await req("GET", "/api/new/options", { headers: auth() });
  assert.deepEqual(o.json.projects, [{ id: PROJ, name: "Shop" }]);
  assert.deepEqual(o.json.agents.map((a) => a.id), ["claude", "codex"]);
  assert.ok(!/SECRET/.test(o.body), "no path, repo, host id or agent flags leave the Mac");

  const ok = await req("POST", "/api/new", { headers: auth(), body: { workspace: WS, agent: "claude", prompt: "-rf: tidy up\nthen test", model: "opus", effort: "high" } });
  assert.equal(ok.status, 200);
  assert.deepEqual(calls.superset.at(-1), ["agents", "create", "--workspace", WS, "--agent", "claude", "--model", "opus", "--effort", "high",
    "--prompt", " -rf: tidy up\nthen test", "--json"]);
  const nb = await req("POST", "/api/new", { headers: auth(), body: { project: PROJ, branch: "feat/phone", agent: "codex", prompt: "go", model: "gpt-6-astra" } });
  assert.equal(nb.status, 200);
  assert.deepEqual(calls.superset.at(-1), ["workspaces", "create", "--local", "--project", PROJ, "--branch", "feat/phone", "--name", "feat/phone",
    "--agent", "codex", "--model", "gpt-6-astra", "--prompt", "go", "--json"]);
  const n = calls.superset.length;
  for (const body of [{ workspace: "33333333-bbbb-4bbb-8bbb-222222222222", agent: "claude", prompt: "x" }, { workspace: WS, agent: "Bad Id", prompt: "x" },
                      { workspace: WS, agent: "claude", prompt: "   " }, { workspace: WS, agent: "claude", prompt: "x", model: "gpt-6-astra" },
                      { workspace: WS, agent: "codex", prompt: "x", effort: "max" }, { project: PROJ, branch: "../etc", agent: "claude", prompt: "x" },
                      { project: PROJ, branch: "-D", agent: "claude", prompt: "x" }, { project: PROJ, branch: "a//b", agent: "claude", prompt: "x" }]) {
    assert.equal((await req("POST", "/api/new", { headers: auth(), body })).status, 400, JSON.stringify(body));
  }
  assert.ok(calls.superset.slice(n).every((a) => a[1] === "list"), "nothing was started for a refused request");
});

test("the app's own files by name: fonts, map, icons, launch images; the camera for the app's origin only", async () => {
  const r = await req("GET", "/");
  assert.match(r.headers["content-security-policy"], /font-src 'self'/);
  assert.match(r.headers["permissions-policy"], /camera=\(self\), microphone=\(\), geolocation=\(\)/);
  for (const [p, type] of [["/fonts/b612-400.woff2", "font/woff2"], ["/fonts/plex-600.woff2", "font/woff2"], ["/map.svg", "image/svg+xml"],
    ["/icon-maskable-512.png", "image/png"], ["/launch/390x844@3.jpg", "image/jpeg"], ["/qr.js", "text/javascript; charset=utf-8"], ["/where.js", "text/javascript; charset=utf-8"]]) {
    const g = await get(base + p);
    assert.equal(g.status, 200, p);
    assert.equal(g.headers["content-type"], type, p);
  }
  for (const p of ["/fonts/OFL-B612.txt", "/fonts/", "/launch/", "/launch/1x1@1.jpg", "/fonts/app.js", "/fonts/b612-400.woff2.map", "/agent-claude.png"]) {
    assert.equal((await get(base + p)).status, 404, p);
  }
  // Everything the page and the service worker ask for is there.
  const wanted = [...r.body.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
  const sw = (await get(base + "/sw.js")).body.toString();
  for (const list of sw.match(/const (SHELL|ASSETS) = \[[^\]]*\]/g)) wanted.push(...[...list.matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]));
  assert.ok(wanted.length > 25);
  for (const p of wanted) assert.equal((await get(base + p)).status, 200, p);
});

test("the Accounts screen is gone: its routes answer 404", async () => {
  assert.equal((await req("GET", "/api/accounts", { headers: auth() })).status, 404);
  assert.equal((await req("POST", "/api/accounts/switch", { headers: auth(), body: { name: "a@x.com" } })).status, 404);
});

function get(u, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const r = http.request(u, { method, headers }, (res) => { const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); });
    r.on("error", reject); r.end();
  });
}
const fileList = async () => (await req("GET", "/api/files?id=" + FILES, { headers: auth() })).json.files;
const refOf = (files, n) => files.find((f) => f.name === n).ref;

test("files: only what the session wrote or mentioned, inside its folder, of a safe kind, checked by content", async () => {
  const r = await req("GET", "/api/files?id=" + FILES, { headers: auth() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.files.map((f) => f.name).sort(), ["later.md", "notes.md", "page.html", "pic.png", "report.pdf"]);
  const pdf = r.json.files.find((f) => f.name === "report.pdf");
  assert.deepEqual([pdf.kind, pdf.dir], ["pdf", "out"]);
  assert.ok(!r.body.includes(HOME) && !r.body.includes("SECRET"), "no path and no content in the list");
  assert.equal((await req("GET", "/api/files?id=" + FILES)).status, 401);
  assert.deepEqual((await req("GET", "/api/files?id=" + CLAUDE2, { headers: auth() })).json, { files: [], root: false }, "no folder on record, no files");

  const s = await req("GET", "/api/screen?id=" + FILES, { headers: auth() });
  const step = (id) => s.json.items.find((i) => i.id === id);
  assert.equal(step("w1").file.name, "notes.md", "a step that wrote a file opens it");
  assert.equal(step("r1").file, undefined, "a file it only read is not offered");
  assert.equal(step("w2").file, undefined, "a .pdf that is really HTML is not offered");
  assert.deepEqual(s.json.items.find((i) => i.type === "agent").files.map((f) => f.name).sort(), ["later.md", "page.html", "pic.png", "report.pdf"]);
  // The agent's own words are shown as written; what the Mac adds is a ref and a name, never a path.
  for (const it of s.json.items) {
    assert.ok(!("path" in it) && !("paths" in it), "no path field reaches the phone");
    for (const f of [it.file, ...(it.files || [])].filter(Boolean)) {
      assert.deepEqual(Object.keys(f).sort(), ["dir", "kind", "name", "ref"]);
      assert.ok(!JSON.stringify(f).includes(HOME));
    }
  }
  assert.ok(!s.body.includes("SECRET"), "no file content in the chat");
});

test("files: text and images come through the app, each only by its own route and in its own session", async () => {
  const files = await fileList();
  const t = await req("GET", `/api/file/text?id=${FILES}&ref=${refOf(files, "notes.md")}`, { headers: auth() });
  assert.equal(t.json.kind, "markdown");
  assert.match(t.json.text, /Hello \*\*there\*\*/);
  const later = await req("GET", `/api/file/text?id=${FILES}&ref=${refOf(files, "later.md")}`, { headers: auth() });
  assert.equal(later.status, 403, "a key further into the file is caught when it is read");
  assert.ok(!later.body.includes("sk-ant"));
  const img = await req("GET", `/api/file/image?id=${FILES}&ref=${refOf(files, "pic.png")}`, { headers: auth() });
  assert.equal(img.headers["content-type"], "image/png");
  assert.match(img.headers["content-security-policy"], /sandbox/);
  assert.equal(img.headers["x-content-type-options"], "nosniff");
  assert.equal((await req("GET", `/api/file/text?id=${FILES}&ref=${refOf(files, "pic.png")}`, { headers: auth() })).status, 400);
  assert.equal((await req("GET", `/api/file/image?id=${FILES}&ref=${refOf(files, "notes.md")}`, { headers: auth() })).status, 400);
  assert.equal((await req("GET", `/api/file/text?id=${CLAUDE2}&ref=${refOf(files, "notes.md")}`, { headers: auth() })).status, 404, "a ref works only in its session");
  for (const bad of ["", "x", "../../etc/passwd", "a".repeat(22), path.join(ROOT, "notes.md"), "__proto__"]) {
    assert.equal((await req("GET", `/api/file/text?id=${FILES}&ref=${encodeURIComponent(bad)}`, { headers: auth() })).status, 404, bad);
  }
  assert.equal((await req("GET", `/api/file/text?id=${FILES}&ref=${refOf(files, "notes.md")}`)).status, 401);
});

test("files: PDFs and pages open from the file-only origin, through a short link for one file, checked again when used", async () => {
  const files = await fileList();
  const o = await req("POST", "/api/file/open", { headers: auth(), body: { id: FILES, ref: refOf(files, "report.pdf") } });
  assert.equal(o.status, 200);
  assert.ok(o.json.url.startsWith(fileBase + "/f/") && !o.json.url.includes(HOME));
  const f = await get(o.json.url);
  assert.equal(f.status, 200);
  assert.equal(f.headers["content-type"], "application/pdf");
  assert.equal(f.headers["x-content-type-options"], "nosniff");
  assert.match(f.headers["cache-control"], /no-store/);
  assert.equal(f.headers["access-control-allow-origin"], undefined);
  assert.equal(f.body.toString("latin1").slice(0, 5), "%PDF-");
  const part = await get(o.json.url, { Range: "bytes=0-4" });
  assert.deepEqual([part.status, part.body.toString("latin1"), part.headers["content-range"]], [206, "%PDF-", `bytes 0-4/${PDF.length}`]);
  assert.equal((await get(o.json.url, {}, "POST")).status, 405);
  assert.equal((await get(o.json.url.replace(/\/[^/]+$/, "/other.pdf"))).status, 404, "the link names its file");
  assert.equal((await get(`${fileBase}/f/${"A".repeat(43)}/report.pdf`)).status, 404);
  for (const p of ["/", "/api/sessions", "/app.js", "/f/", "/f/x/y"]) assert.equal((await get(fileBase + p)).status, 404, "the file origin serves nothing else: " + p);

  const viaTailnet = await req("POST", "/api/file/open", { headers: { ...auth(), Host: "mac-b.tail1234.ts.net" }, body: { id: FILES, ref: refOf(files, "report.pdf") } });
  assert.match(viaTailnet.json.url, /^https:\/\/mac-b\.tail1234\.ts\.net:8443\/f\/[A-Za-z0-9_-]{43}\/report\.pdf$/, "the link uses the Mac's tailnet name on the file port");
  const page = await req("POST", "/api/file/open", { headers: auth(), body: { id: FILES, ref: refOf(files, "page.html") } });
  const pg = await get(page.json.url);
  assert.equal(pg.status, 200);
  assert.match(pg.headers["content-security-policy"], /sandbox/);
  assert.match(pg.headers["content-security-policy"], /script-src 'none'/);
  assert.equal((await req("POST", "/api/file/open", { headers: auth(), body: { id: FILES, ref: refOf(files, "notes.md") } })).status, 400, "text is drawn by the app, not linked");

  await new Promise((r) => setTimeout(r, 1600));
  assert.equal((await get(o.json.url)).status, 404, "the link has run out");
  const again = await req("POST", "/api/file/open", { headers: auth(), body: { id: FILES, ref: refOf(files, "report.pdf") } });
  put("out/report.pdf", "<html>now a page</html>");
  assert.equal((await get(again.json.url)).status, 404, "a file that stopped being a PDF is refused at the moment of use");
  put("out/report.pdf", PDF);
});

test("DNS rebinding: the app and the file origin answer only to the tailnet name or loopback", async () => {
  const rebound = ["attacker.example", "attacker.example:47871", "127.0.0.1.attacker.example", "ts.net.attacker.example",
                   "mac.tail1234.ts.net.attacker.example", "192.168.1.5", "[::1]", "localhost.", "mac..ts.net"];
  for (const host of rebound) {
    assert.equal((await req("GET", "/", { headers: { Host: host } })).status, 403, "the static app, Host " + JSON.stringify(host));
  }
  // Pairing: a rebound page can't spend the code's tries.
  const { code } = store.newCode();
  for (let i = 0; i < 6; i++) {
    const r = await req("POST", "/api/pair", { headers: { Host: "attacker.example" }, body: { code: "000000" } });
    assert.equal(r.status, 403);
  }
  // X-Forwarded-Host is the page's to set; only Host counts.
  assert.equal((await req("GET", "/", { headers: { Host: "attacker.example", "X-Forwarded-Host": "mac-b.tail1234.ts.net" } })).status, 403);
  assert.equal((await req("GET", "/api/hello", { headers: { ...auth(), Host: "attacker.example" } })).status, 403, "a token doesn't help");
  for (const host of ["mac-b.tail1234.ts.net", "MAC-B.tail1234.ts.net:443", "127.0.0.1", "localhost:47871"]) {
    assert.equal((await req("GET", "/", { headers: { Host: host } })).status, 200, "Host " + host);
  }
  const paired = await req("POST", "/api/pair", { headers: { Host: "mac-b.tail1234.ts.net" }, body: { code, name: "rebind test" } });
  assert.equal(paired.status, 200, "the code still had all its tries");
  store.revoke(paired.json.deviceId);

  // A file link: refused under a rebound name, and the refusal doesn't count as a use.
  const files = await fileList();
  const o = await req("POST", "/api/file/open", { headers: auth(), body: { id: FILES, ref: refOf(files, "report.pdf") } });
  for (let i = 0; i < 41; i++) assert.equal((await get(o.json.url, { Host: "attacker.example" })).status, 403);
  assert.equal((await get(o.json.url, { Host: "mac-b.tail1234.ts.net:8443" })).status, 200);
  assert.equal((await get(o.json.url)).status, 200, "loopback");
  assert.equal((await req("POST", "/api/send", { headers: { ...auth(), Host: "attacker.example" }, body: { id: CLAUDE, text: "hi" } })).status, 403);
});

test("files: a session's folder must be a real folder inside home, not home itself and not a hidden one", () => {
  assert.equal(sessionRoot(HOME, HOME), null);
  assert.equal(sessionRoot("/", HOME), null);
  assert.equal(sessionRoot("relative/proj", HOME), null);
  assert.equal(sessionRoot(dir, HOME), null, "outside home");
  assert.equal(sessionRoot(ROOT, HOME), fs.realpathSync(ROOT));
  for (const d of [".ssh/p", ".superset", ".superset/worktrees", ".superset/.x/p"]) {
    fs.mkdirSync(path.join(HOME, d), { recursive: true });
    assert.equal(sessionRoot(path.join(HOME, d), HOME), null, d);
  }
  fs.mkdirSync(path.join(HOME, ".superset/worktrees/p"), { recursive: true });
  assert.equal(sessionRoot(path.join(HOME, ".superset/worktrees/p"), HOME), fs.realpathSync(path.join(HOME, ".superset/worktrees/p")), "Superset workspaces are fine");
});

test("a server is handed its service; it never makes one by itself", () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "airpocket-data-"));
  try {
    assert.throws(() => createServer({ store: createStore(data), log: () => {} }), /needs a service/);
    assert.throws(() => createServer({ store: createStore(data), knownSessions: () => [], getQueue: () => [] }), /needs a service/);
    assert.deepEqual(fs.readdirSync(data), [], "and it wrote nothing");
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
});

test("with no stubs: hook events put a session on the list, make it wait, and clear it", async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "airpocket-data-"));
  const own = createStore(data);
  const bare = createServer({ store: own, log: () => {}, superset: async () => { throw new Error("no Superset here"); },
    service: createService({ dir: data }), claudeProjects: path.join(data, "none"), codexHome: path.join(data, "none") });
  assert.ok(!fs.existsSync(path.join(data, "hook.json")), "no hook.json before the hook endpoint listens");
  const hookPort = await new Promise((ok) => bare.service.listen(0, ok));
  await new Promise((ok) => bare.server.listen(0, "127.0.0.1", ok));
  const at = `http://127.0.0.1:${bare.server.address().port}`;
  const { port, secret } = JSON.parse(fs.readFileSync(path.join(data, "hook.json"), "utf8"));
  assert.equal(port, hookPort, "hook.json tells the hooks where to call");
  const hook = (event, body, headers = { Authorization: "Bearer " + secret }) =>
    req("POST", "/hook/" + event, { at: `http://127.0.0.1:${hookPort}`, headers, body });
  const ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  try {
    const t = (await req("POST", "/api/pair", { at, body: { code: own.newCode().code } })).json.token;
    const list = async () => (await req("GET", "/api/sessions", { at, headers: auth(t) })).json.sessions
      .map((x) => ({ id: x.id, title: x.title, waiting: x.waiting, kind: x.kind, reason: x.reason, note: x.note, via: x.via }));
    const seen = async () => (await req("POST", "/api/seen", { at, headers: auth(t), body: { id: ID } })).json.cleared;
    assert.deepEqual(await list(), []);

    // Wrong or missing secrets change nothing.
    const body = { session_id: ID, agent: "claude", cwd: "/Users/x/proj", pid: process.pid, started: ME,terminal: "term-9", workspace: "ws-9" };
    assert.equal((await hook("session", body, {})).status, 401, "no secret");
    assert.equal((await hook("session", body, { Authorization: "Bearer " + "A".repeat(43) })).status, 401, "wrong secret");
    assert.equal((await hook("session", body, { Authorization: secret })).status, 401, "the secret without Bearer");
    assert.deepEqual(await list(), []);

    assert.equal((await hook("session", body)).status, 204);
    assert.deepEqual(await list(), [{ id: ID, title: "proj", waiting: false, kind: null, reason: "", note: "", via: "terminal" }], "on the list");

    await hook("enqueue", { session_id: ID, reason: "finished", message: "All done." });
    assert.deepEqual((await list())[0], { id: ID, title: "proj", waiting: true, kind: "done", reason: "finished", note: "All done.", via: "terminal" }, "waiting");
    await hook("dequeue", { session_id: ID, why: "prompt", note: "next thing" });
    assert.equal((await list())[0].waiting, false, "a new prompt clears it");

    await hook("enqueue", { session_id: ID, reason: "waiting for you" });
    assert.equal(await seen(), true);
    assert.equal((await list())[0].waiting, false, "seen clears 'waiting for you'");
    await hook("enqueue", { session_id: ID, reason: "finished" });
    assert.equal(await seen(), true);
    assert.equal((await list())[0].waiting, false, "seen clears 'finished'");

    await hook("enqueue", { session_id: ID, reason: "needs permission", message: "Run rm?" });
    assert.equal(await seen(), false);
    assert.deepEqual((await list())[0].kind, "input", "a question stays after seen");

    await hook("dequeue", { session_id: ID, why: "end" });
    assert.deepEqual(await list(), [], "session end clears it and forgets the session");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, "queue.json"), "utf8")).queue, []);
  } finally {
    bare.server.close();
    bare.service.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test("ports: 47871 for the app, 47872 for files, 47873 for hooks by default, moved together", () => {
  assert.deepEqual(portsFrom({}), { app: 47871, file: 47872, hook: 47873, publicApp: 443, publicFile: 8443 });
  assert.equal(portsFrom({ AIRPOCKET_PORT: "48000" }).file, 48001);
  assert.equal(portsFrom({ AIRPOCKET_PORT: "48000" }).hook, 48002);
  assert.equal(portsFrom({ AIRPOCKET_PORT: "x", AIRPOCKET_FILE_PORT: "99999" }).file, 47872, "nonsense falls back to the default");
});

test("serve never takes a tailnet port that publishes something else, and unserve never removes it", () => {
  const ours = "http://127.0.0.1:47871";
  const status = { TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } }, Web: {
    "mac.tail1234.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:47821" } } },
    "mac.tail1234.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:47872/" } } } } };
  assert.deepEqual(othersOn(status, 443, ours), ["http://127.0.0.1:47821"]);
  assert.deepEqual(othersOn(status, 8443, "http://127.0.0.1:47872"), [], "our own entry is ours");
  assert.deepEqual(othersOn({}, 443, ours), []);
  assert.deepEqual(othersOn({ TCP: { 443: { TCPForward: "127.0.0.1:22" } } }, 443, ours), ["tcp 127.0.0.1:22"]);
  assert.deepEqual(othersOn({ Web: { "m:443": { Handlers: { "/": { Path: "/srv" } } } } }, 443, ours), ["something else"]);
  // `airpocket status` says which ports are Airpocket's and which belong to something else.
  const [app, files] = serveLines(status);
  assert.match(app, /^https 443 .*taken by http:\/\/127\.0\.0\.1:47821$/);
  assert.match(files, /^https 8443 .*published for Airpocket$/);
  assert.match(serveLines({})[0], /not published$/);
});

test("nothing in the app points at the private tool it came from", () => {
  const src = path.join(__dirname, "..", "src");
  const files = [];
  const walk = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else if (!n.name.endsWith(".png")) files.push(p); } };
  walk(src);
  for (const f of files) {
    const t = fs.readFileSync(f, "utf8");
    for (const bad of [/4782[012]\b/, /claude-overlay/i, /claude-accounts/i, /accounts\.json/, /\/api\/accounts/, /joinvoicedata/i, /[OÖ]ncel/, /mobile:[a-z]/, /\bpanel\b/i]) {
      assert.ok(!bad.test(t), `${path.relative(src, f)} matches ${bad}`);
    }
  }
});

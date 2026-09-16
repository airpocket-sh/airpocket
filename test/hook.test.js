"use strict";
// The hook, run for real: `node src/hook.js claude|codex` with an event on
// stdin, against a real service in a temp folder, with a stand-in home so
// nothing of this Mac's own Claude or Codex setup is read.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { createService } = require("../src/service");
const { createServer } = require("../src/server");
const { createStore } = require("../src/store");
const { plan, gitBranch, claudeAccount } = require("../src/hook");
const { startTimeOf } = require("../src/proc");

const HOOK = path.join(__dirname, "..", "src", "hook.js");
const CLAUDE_ID = "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const CODEX_ID = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const OWN_START = startTimeOf(process.pid);
const temps = [];
const tempDir = (p = "airpocket-hook-") => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

/** A stand-in home: a git repo on branch "feature/x", a Claude login, a transcript and a Codex session file. */
function world() {
  const home = tempDir("airpocket-home-");
  const repo = path.join(home, "code", "shop");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/feature/x\n");
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "main@example.com" }, projects: {} }));
  const transcript = path.join(home, ".claude", "projects", "-code-shop", CLAUDE_ID + ".jsonl");
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, "");
  const rollout = path.join(home, ".codex", "sessions", "2026", "09", "15", `rollout-2026-09-15T10-00-00-${CODEX_ID}.jsonl`);
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, "");
  return { home, repo, transcript, rollout };
}

/** A service on an ephemeral port, in its own data folder. */
async function service() {
  const dir = tempDir();
  const logs = [];
  const svc = createService({ dir, log: (...a) => logs.push(a.join(" ")) });
  const port = await new Promise((ok) => svc.listen(0, ok));
  return { dir, svc, port, logs, secret: JSON.parse(fs.readFileSync(path.join(dir, "hook.json"), "utf8")).secret,
    close: () => new Promise((ok) => svc.close(ok)) };
}

/** Run the hook as an agent would: a child process with the event on stdin. */
function fire(agent, input, env, { shell = false, keepOpen = false } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const cmd = shell ? ["/bin/sh", ["-c", `"${process.execPath}" "${HOOK}" ${agent}; exit 0`]] : [process.execPath, [HOOK, agent]];
    const child = spawn(cmd[0], cmd[1], { env: { PATH: "/usr/bin:/bin", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
    child.stdin.on("error", () => {});
    child.stdin.write(typeof input === "string" ? input : JSON.stringify(input));
    if (!keepOpen) child.stdin.end();
  });
}

const quiet = (r, what) => {
  assert.equal(r.code, 0, what + ": exit 0");
  assert.equal(r.out, "", what + ": nothing on stdout (Claude would add it to the conversation)");
  assert.equal(r.err, "", what + ": nothing on stderr");
};

test("plan: every event of both agents, and nothing for the rest", () => {
  const P = (agent, input) => plan(agent, input);
  assert.deepEqual(P("claude", { hook_event_name: "SessionStart" }), { event: "session" });
  assert.deepEqual(P("claude", { hook_event_name: "UserPromptSubmit", prompt: "fix\nthe bug" }), { event: "dequeue", why: "prompt", note: "fix the bug" });
  assert.deepEqual(P("claude", { hook_event_name: "Stop", last_assistant_message: "Done." }), { event: "enqueue", reason: "finished", message: "Done." });
  assert.deepEqual(P("claude", { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }),
    { event: "enqueue", reason: "needs permission", message: "Claude needs your permission to use Bash" });
  assert.deepEqual(P("claude", { hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" }),
    { event: "enqueue", reason: "waiting for you", message: "Claude is waiting for your input" });
  assert.deepEqual(P("claude", { hook_event_name: "Notification", notification_type: "elicitation_dialog", message: "Pick one" }),
    { event: "enqueue", reason: "needs a response", message: "Pick one" });
  assert.deepEqual(P("claude", { hook_event_name: "Notification", notification_type: "auth_success" }), { event: "touch" });
  assert.deepEqual(P("claude", { hook_event_name: "SessionEnd", reason: "prompt_input_exit" }), { event: "dequeue", why: "end" });
  assert.equal(P("claude", { hook_event_name: "Stop", agent_id: "sub-1" }), null, "a subagent's events are not the session's");
  assert.equal(P("claude", { hook_event_name: "PreToolUse" }), null);
  assert.equal(P("claude", { hook_event_name: "Interrupt" }), null, "Interrupt is Codex's");

  assert.deepEqual(P("codex", { hook_event_name: "SessionStart", source: "startup" }), { event: "session" });
  assert.deepEqual(P("codex", { hook_event_name: "UserPromptSubmit", prompt: "go" }), { event: "dequeue", why: "prompt", note: "go" });
  assert.deepEqual(P("codex", { hook_event_name: "Stop", last_assistant_message: "Made it." }), { event: "enqueue", reason: "finished", message: "Made it." });
  assert.deepEqual(P("codex", { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
    { event: "enqueue", reason: "needs permission", message: "Wants to use Bash" }, "the tool's name, never its input");
  assert.deepEqual(P("codex", { hook_event_name: "PermissionRequest", tool_name: "rm -rf /; x" }), { event: "enqueue", reason: "needs permission", message: "" });
  assert.deepEqual(P("codex", { hook_event_name: "Interrupt" }), { event: "dequeue", why: "interrupt" });
  assert.deepEqual(P("codex", { hook_event_name: "SessionEnd", reason: "other" }), { event: "dequeue", why: "end" });
  assert.equal(P("codex", { hook_event_name: "Notification", notification_type: "idle_prompt" }), null, "Notification is Claude's");
  assert.equal(P("codex", { hook_event_name: "PostToolUse" }), null);
  assert.equal(P("codex", {}), null);
  assert.equal(P("claude", { hook_event_name: "Stop", last_assistant_message: "x".repeat(1000) }).message.length, 220, "clipped");
});

test("a prompt or reply that looks like a key or token is dropped whole, not clipped", () => {
  const P = (agent, input) => plan(agent, input);
  assert.equal(P("claude", { hook_event_name: "UserPromptSubmit", prompt: "use sk-ant-" + "a".repeat(40) + " for the API" }).note, "");
  assert.equal(P("codex", { hook_event_name: "UserPromptSubmit", prompt: "x".repeat(200) + " ghp_" + "b".repeat(36) }).note, "", "even past the clip");
  assert.equal(P("codex", { hook_event_name: "Stop", last_assistant_message: "Set AKIAABCDEFGHIJKLMNOP as the key." }).message, "");
  assert.equal(P("claude", { hook_event_name: "Stop", last_assistant_message: "Here: -----BEGIN RSA PRIVATE KEY----- ..." }).message, "");
  assert.equal(P("claude", { hook_event_name: "Notification", notification_type: "elicitation_dialog", message: "Paste xoxb-" + "1".repeat(24) }).message, "");
  assert.equal(P("claude", { hook_event_name: "UserPromptSubmit", prompt: "fix the login page" }).note, "fix the login page", "ordinary text passes");
});

test("claude, through the real hook: start, prompt, finished, permission, idle, a question, end", async () => {
  const s = await service();
  const w = world();
  const env = { HOME: w.home, AIRPOCKET_DIR: s.dir, SUPERSET_TERMINAL_ID: "term-7", SUPERSET_WORKSPACE_ID: "ws-7",
                TMUX: "/private/tmp/tmux-501/default,123,0", TMUX_PANE: "%3" };
  const base = { session_id: CLAUDE_ID, cwd: w.repo, transcript_path: w.transcript, permission_mode: "default" };
  const claude = async (event, extra = {}) => { const r = await fire("claude", { ...base, hook_event_name: event, ...extra }, env); quiet(r, event); return r; };
  const waiting = () => s.svc.getQueue().map((q) => [q.reason, q.kind, q.message]);
  try {
    await claude("SessionStart", { source: "startup", model: "claude-opus-5" });
    const [r] = s.svc.knownSessions();
    assert.deepEqual(r && { ...r, last_seen: 0 }, {
      session_id: CLAUDE_ID, bridge_id: "local:" + CLAUDE_ID, agent: "claude", cwd: w.repo, transcript: w.transcript, title: "shop",
      branch: "feature/x", note: "", account: "main@example.com", pid: process.pid, started: OWN_START,
      terminal: "term-7", workspace: "ws-7", pane: "%3", tmux: "/private/tmp/tmux-501/default", tmux_pid: 123, working_since: 0, last_seen: 0,
    }, "the record: the agent's pid is the hook's parent, with its start time");
    assert.deepEqual(waiting(), []);
    const working = () => s.svc.knownSessions()[0].working_since > 0;

    await claude("UserPromptSubmit", { prompt: "Add a cart page" });
    assert.equal(s.svc.knownSessions()[0].note, "Add a cart page");
    assert.ok(working(), "a prompt starts a turn");
    await claude("Stop", { stop_hook_active: false, last_assistant_message: "Added the cart page." });
    assert.deepEqual(waiting(), [["finished", "done", "Added the cart page."]]);
    assert.ok(!working(), "Stop ends it");
    await claude("UserPromptSubmit", { prompt: "Now run the tests" });
    assert.deepEqual(waiting(), [], "a prompt clears it");
    await claude("Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
    assert.deepEqual(waiting(), [["needs permission", "input", "Claude needs your permission to use Bash"]]);
    assert.ok(working(), "a permission question comes mid-turn");
    await claude("Stop", { last_assistant_message: "Tests pass." });
    await claude("Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" });
    assert.deepEqual(waiting(), [["waiting for you", "input", "Claude is waiting for your input"]], "idle after finishing");
    await claude("Notification", { notification_type: "auth_success", message: "ok" });
    assert.deepEqual(waiting(), [["waiting for you", "input", "Claude is waiting for your input"]], "other notifications only touch");
    await claude("Notification", { notification_type: "elicitation_dialog", message: "Which database?" });
    assert.deepEqual(waiting(), [["needs a response", "input", "Which database?"]]);
    await claude("Stop", { agent_id: "sub-1", last_assistant_message: "subagent done" });
    assert.deepEqual(waiting(), [["needs a response", "input", "Which database?"]], "a subagent changes nothing");
    await claude("SessionEnd", { reason: "prompt_input_exit" });
    assert.deepEqual(s.svc.knownSessions(), [], "the end forgets it");
    assert.deepEqual(waiting(), []);
    assert.ok(s.logs.every((l) => !l.includes(s.secret)), "the secret is never logged");
  } finally { await s.close(); }
});

test("codex, through the real hook: start, prompt, finished, permission, interrupt, end", async () => {
  const s = await service();
  const w = world();
  const env = { HOME: w.home, AIRPOCKET_DIR: s.dir, SUPERSET_TERMINAL_ID: "term-8", SUPERSET_WORKSPACE_ID: "ws-8" };
  const base = { session_id: CODEX_ID, cwd: w.repo, transcript_path: w.rollout, model: "gpt-6", permission_mode: "default", turn_id: "t1" };
  const codex = async (event, extra = {}) => { const r = await fire("codex", { ...base, hook_event_name: event, ...extra }, env); quiet(r, event); return r; };
  const waiting = () => s.svc.getQueue().map((q) => [q.reason, q.kind, q.message]);
  try {
    await codex("SessionStart", { source: "startup" });
    const [r] = s.svc.knownSessions();
    assert.deepEqual([r.agent, r.bridge_id, r.transcript, r.branch, r.account, r.pid, r.started, r.terminal, r.pane],
      ["codex", "codex:" + CODEX_ID, w.rollout, "feature/x", "", process.pid, OWN_START, "term-8", ""], "no Claude account for Codex; no tmux outside tmux");
    await codex("UserPromptSubmit", { prompt: "Make a PDF" });
    await codex("Stop", { stop_hook_active: false, last_assistant_message: "Made the PDF." });
    assert.deepEqual(waiting(), [["finished", "done", "Made the PDF."]]);
    await codex("UserPromptSubmit", { prompt: "Delete the drafts" });
    await codex("PermissionRequest", { tool_name: "Bash", tool_use_id: "c1", tool_input: { command: "rm -rf drafts SECRET-COMMAND" } });
    assert.deepEqual(waiting(), [["needs permission", "input", "Wants to use Bash"]]);
    assert.ok(s.svc.knownSessions()[0].working_since > 0, "mid-turn");
    await codex("Interrupt");
    assert.deepEqual(waiting(), [], "stopping it at the terminal clears it");
    assert.equal(s.svc.knownSessions()[0].working_since, 0, "and ends the turn");
    await codex("Stop", { last_assistant_message: "Stopped." });
    await codex("SessionEnd", { reason: "other" });
    assert.deepEqual(s.svc.knownSessions(), []);
    assert.deepEqual(waiting(), []);
    const saved = fs.readdirSync(s.dir, { recursive: true }).filter((f) => f.endsWith(".json")).map((f) => fs.readFileSync(path.join(s.dir, f), "utf8")).join("\n");
    assert.ok(!saved.includes("SECRET-COMMAND"), "a command line never reaches the service");
  } finally { await s.close(); }
});

test("the agent is found past the shell that runs the hook", async () => {
  const s = await service();
  const w = world();
  try {
    const r = await fire("claude", { session_id: CLAUDE_ID, hook_event_name: "SessionStart", cwd: w.repo }, { HOME: w.home, AIRPOCKET_DIR: s.dir }, { shell: true });
    quiet(r, "through sh");
    const [rec] = s.svc.knownSessions();
    assert.deepEqual([rec.pid, rec.started], [process.pid, OWN_START], "the shell's parent, not the shell");
  } finally { await s.close(); }
});

test("it never gets in the way: no service, a dead port, a hung service, a wrong secret, junk, stdin left open", async () => {
  const w = world();
  const ev = { session_id: CLAUDE_ID, hook_event_name: "Stop", cwd: w.repo };
  const dir = tempDir();
  const cases = [];
  cases.push(["no hook.json", await fire("claude", ev, { HOME: w.home, AIRPOCKET_DIR: dir })]);
  cases.push(["no data folder", await fire("claude", ev, { HOME: w.home, AIRPOCKET_DIR: path.join(dir, "nope") })]);
  // A port nobody listens on.
  const free = await new Promise((ok) => { const x = net.createServer().listen(0, "127.0.0.1", () => { const p = x.address().port; x.close(() => ok(p)); }); });
  const secret = "S".repeat(43);
  fs.writeFileSync(path.join(dir, "hook.json"), JSON.stringify({ port: free, secret }));
  cases.push(["a dead port", await fire("claude", ev, { HOME: w.home, AIRPOCKET_DIR: dir })]);
  // A service that takes the connection and never answers.
  const sockets = [];
  const hung = net.createServer((c) => sockets.push(c));
  await new Promise((ok) => hung.listen(0, "127.0.0.1", ok));
  fs.writeFileSync(path.join(dir, "hook.json"), JSON.stringify({ port: hung.address().port, secret }));
  const slow = await fire("claude", ev, { HOME: w.home, AIRPOCKET_DIR: dir });
  cases.push(["a hung service", slow]);
  for (const c of sockets) c.destroy();
  hung.close();
  // stdin never closed: the agent never waits past the limit.
  const open = await fire("claude", "", { HOME: w.home, AIRPOCKET_DIR: dir }, { keepOpen: true });
  cases.push(["stdin left open", open]);
  cases.push(["junk on stdin", await fire("claude", "{ not json", { HOME: w.home, AIRPOCKET_DIR: dir })]);
  cases.push(["junk hook.json", (fs.writeFileSync(path.join(dir, "hook.json"), "{ half"), await fire("claude", ev, { HOME: w.home, AIRPOCKET_DIR: dir }))]);
  const s = await service();
  try {
    fs.writeFileSync(path.join(dir, "hook.json"), JSON.stringify({ port: s.port, secret }));
    cases.push(["a wrong secret", await fire("claude", ev, { HOME: w.home, AIRPOCKET_DIR: dir })]);
    assert.deepEqual(s.svc.knownSessions(), [], "the wrong secret changed nothing");
    cases.push(["a bad session id", await fire("claude", { ...ev, session_id: "../../x" }, { HOME: w.home, AIRPOCKET_DIR: s.dir })]);
    assert.deepEqual(s.svc.knownSessions(), []);
  } finally { await s.close(); }
  for (const [what, r] of cases) {
    quiet(r, what);
    assert.ok(r.ms < 2500, `${what}: gave up in time (${r.ms} ms)`);
  }
  assert.ok(slow.ms >= 1400, "the hung service was waited on only up to the limit");
});

test("the Claude account comes from the session's own config folder, and only from Claude's own file", () => {
  const home = tempDir("airpocket-home-");
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "main@example.com" } }));
  const work = path.join(home, "configs", "work");
  fs.mkdirSync(path.join(work, "projects", "p"), { recursive: true });
  fs.writeFileSync(path.join(work, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" } }));
  fs.writeFileSync(path.join(work, "accounts.json"), JSON.stringify({ emailAddress: "never@example.com" }));
  const bare = path.join(home, "configs", "bare");
  fs.mkdirSync(bare, { recursive: true });
  const t = (dir) => path.join(dir, "projects", "p", CLAUDE_ID + ".jsonl");
  assert.equal(claudeAccount({}, "", home), "main@example.com", "the standard setup: ~/.claude.json");
  assert.equal(claudeAccount({}, t(path.join(home, ".claude")), home), "main@example.com");
  assert.equal(claudeAccount({ CLAUDE_CONFIG_DIR: work }, "", home), "work@example.com", "$CLAUDE_CONFIG_DIR");
  assert.equal(claudeAccount({}, t(work), home), "work@example.com", "the folder the transcript sits in");
  assert.equal(claudeAccount({ CLAUDE_CONFIG_DIR: bare }, "", home), "", "a folder that doesn't show one: none, not the main account");
  assert.equal(claudeAccount({ CLAUDE_CONFIG_DIR: "relative" }, "", home), "");
  fs.writeFileSync(path.join(bare, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "not an email" } }));
  assert.equal(claudeAccount({ CLAUDE_CONFIG_DIR: bare }, "", home), "");
});

test("the branch comes from .git, worktrees included, without running git", () => {
  const home = tempDir("airpocket-home-");
  const repo = path.join(home, "repo"), wt = path.join(home, "wt"), deep = path.join(repo, "a", "b");
  fs.mkdirSync(path.join(repo, ".git", "worktrees", "wt"), { recursive: true });
  fs.mkdirSync(deep, { recursive: true });
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(repo, ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/step-6-hook\n");
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: " + path.join(repo, ".git", "worktrees", "wt") + "\n");
  assert.equal(gitBranch(repo), "main");
  assert.equal(gitBranch(deep), "main", "from a folder inside the repo");
  assert.equal(gitBranch(wt), "step-6-hook", "a worktree");
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
  assert.equal(gitBranch(repo), "", "detached: no branch");
  assert.equal(gitBranch(""), "");
});

test("sessions from several Claude accounts land in one list, each with its own chat", async () => {
  const s = await service();
  const home = tempDir("airpocket-home-");
  const other = "7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b";
  const accounts = [["main", path.join(home, ".claude"), CLAUDE_ID, "Hello from main"], ["work", path.join(home, "work-config"), other, "Hello from work"]];
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "main@example.com" } }));
  fs.mkdirSync(path.join(home, "work-config"), { recursive: true });
  fs.writeFileSync(path.join(home, "work-config", ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "work@example.com" } }));
  const store = createStore(s.dir);
  // The server looks for transcripts under a folder that has none: each chat must come from its record.
  const app = createServer({ store, service: s.svc, log: () => {}, superset: async () => { throw new Error("no Superset"); },
    claudeProjects: path.join(home, "nowhere"), codexHome: path.join(home, "nowhere"), homeDir: home });
  await new Promise((ok) => app.server.listen(0, "127.0.0.1", ok));
  const at = `http://127.0.0.1:${app.server.address().port}`;
  const get = (p, body, token) => new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(at + p, { method: data ? "POST" : "GET",
      headers: { ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}), ...(token ? { Authorization: "Bearer " + token } : {}) } },
    (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(JSON.parse(b || "null"))); });
    r.on("error", reject);
    r.end(data);
  });
  try {
    for (const [name, config, sid, said] of accounts) {
      const cwd = path.join(home, name);
      fs.mkdirSync(cwd, { recursive: true });
      const transcript = path.join(config, "projects", "-" + name, sid + ".jsonl");
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      fs.writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "u-" + name, message: { role: "user", content: "hi" } }) + "\n" +
        JSON.stringify({ type: "assistant", uuid: "a-" + name, message: { id: "m-" + name, role: "assistant", content: [{ type: "text", text: said }] } }) + "\n");
      const env = { HOME: home, AIRPOCKET_DIR: s.dir, ...(name === "work" ? { CLAUDE_CONFIG_DIR: config } : {}) };
      quiet(await fire("claude", { session_id: sid, hook_event_name: "SessionStart", cwd, transcript_path: transcript }, env), name);
      quiet(await fire("claude", { session_id: sid, hook_event_name: "Stop", cwd, transcript_path: transcript, last_assistant_message: said }, env), name);
    }
    const token = (await get("/api/pair", { code: store.newCode().code })).token;
    const list = (await get("/api/sessions", null, token)).sessions;
    assert.deepEqual(list.map((x) => [x.title, x.account, x.waiting, x.reason]).sort(), [["main", "main", true, "finished"], ["work", "work", true, "finished"]]);
    for (const [name, , sid, said] of accounts) {
      const chat = await get("/api/screen?id=" + sid, null, token);
      assert.equal(chat.kind, "chat", name);
      assert.ok(chat.items.some((it) => it.type === "agent" && it.text === said), `${name}: its own transcript`);
    }
    assert.ok(!JSON.stringify(list).includes(home), "transcript paths stay on the Mac");
  } finally {
    app.server.close();
    await s.close();
  }
});

test("after the service stops, a hook sends nothing, even to a program that took its port", async () => {
  const w = world();
  const s = await service();
  await s.close();
  assert.ok(!fs.existsSync(path.join(s.dir, "hook.json")), "a stopped service leaves no hook.json");
  // Something else takes the port the service had.
  const got = [];
  const squatter = net.createServer((c) => { got.push(c); c.destroy(); });
  await new Promise((ok, fail) => { squatter.once("error", fail); squatter.listen(s.port, "127.0.0.1", ok); });
  try {
    const r = await fire("claude", { session_id: CLAUDE_ID, hook_event_name: "UserPromptSubmit", prompt: "deploy it", cwd: w.repo },
      { HOME: w.home, AIRPOCKET_DIR: s.dir, TMUX_PANE: "%3" });
    quiet(r, "no service");
    assert.equal(got.length, 0, "no connection reached the port");
  } finally { squatter.close(); }
});

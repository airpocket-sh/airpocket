#!/usr/bin/env node
"use strict";
// The one hook for Claude Code and Codex. Each agent runs it on its events,
// with the event as JSON on stdin; it tells the Airpocket service on this Mac
// what happened, and nothing else:
//
//   node src/hook.js claude   for SessionStart, UserPromptSubmit, Stop, Notification, SessionEnd
//   node src/hook.js codex    for SessionStart, UserPromptSubmit, Stop, PermissionRequest, Interrupt, SessionEnd
//
// It must never get in the agent's way. It writes nothing to stdout or stderr
// (Claude adds a hook's output to the conversation), always exits 0, gives up
// after 1.5 seconds whatever it is waiting for, and does nothing at all when
// the service isn't running. It reads hook.json (port and secret) on every
// run, since the secret changes whenever the service starts, and it sends to
// 127.0.0.1 only. It never logs.
//
// What it sends, per session: the id, the folder, where the transcript is, the
// agent, the folder's name as a title, the git branch, the Claude account's
// email (when the config folder shows it), the Superset terminal and workspace,
// the tmux pane, and the agent's pid with the time that process started. With
// an event, the user's prompt as a note or the agent's last reply as the
// message, each clipped. Never tool input, tool output or command lines.
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { agentProcess } = require("./proc");

const LIMIT_MS = 1500;
const MAX_INPUT = 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9_-]{6,100}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const EMAIL = /^[^\s@]{1,100}@[^\s@]{1,150}$/;

const str = (v) => (typeof v === "string" ? v : "");
const clip = (v, n) => { const t = str(v).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/**
 * What an agent's event means for the waiting list: { event, ...fields } for the
 * hook endpoint, or null when it means nothing.
 */
function plan(agent, input) {
  const ev = str(input.hook_event_name);
  if (agent === "claude") {
    if (input.agent_id) return null;                       // a subagent's event, not the session's
    switch (ev) {
      case "SessionStart": return { event: "session" };
      case "UserPromptSubmit": return { event: "dequeue", why: "prompt", note: clip(input.prompt, 120) };
      case "Stop": return { event: "enqueue", reason: "finished", message: clip(input.last_assistant_message, 220) };
      case "Notification": {
        const reason = { permission_prompt: "needs permission", idle_prompt: "waiting for you", elicitation_dialog: "needs a response" }[str(input.notification_type)];
        return reason ? { event: "enqueue", reason, message: clip(input.message, 220) } : { event: "touch" };
      }
      case "SessionEnd": return { event: "dequeue", why: "end" };
    }
    return null;
  }
  switch (ev) {
    case "SessionStart": return { event: "session" };
    case "UserPromptSubmit": return { event: "dequeue", why: "prompt", note: clip(input.prompt, 120) };
    case "Stop": return { event: "enqueue", reason: "finished", message: clip(input.last_assistant_message, 220) };
    case "PermissionRequest": {
      // The tool's name only: its input is a command line or a file's contents.
      const tool = /^[A-Za-z0-9_.:-]{1,60}$/.test(str(input.tool_name)) ? input.tool_name : "";
      return { event: "enqueue", reason: "needs permission", message: tool ? `Wants to use ${tool}` : "" };
    }
    case "Interrupt": return { event: "dequeue", why: "prompt" };  // you stopped it at the terminal: you are there
    case "SessionEnd": return { event: "dequeue", why: "end" };
  }
  return null;
}

/** The checked-out branch of the repository holding this folder, read from .git without running git. */
function gitBranch(cwd) {
  if (!cwd || !path.isAbsolute(cwd)) return "";
  for (let dir = cwd, i = 0; i < 40; i++) {
    const dotgit = path.join(dir, ".git");
    let st = null;
    try { st = fs.statSync(dotgit); } catch {}
    if (st) {
      try {
        let gitdir = dotgit;
        if (st.isFile()) {                                   // a worktree: "gitdir: <path>"
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, "utf8").slice(0, 4096));
          if (!m) return "";
          gitdir = path.resolve(dir, m[1].trim());
        }
        const head = fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").slice(0, 1024);
        const ref = /^ref: refs\/heads\/(.+)$/m.exec(head);
        return ref ? ref[1].trim() : "";                     // detached: no branch
      } catch { return ""; }
    }
    const up = path.dirname(dir);
    if (up === dir) return "";
    dir = up;
  }
  return "";
}

/**
 * The email of the Claude account a session runs under, from its config folder:
 * $CLAUDE_CONFIG_DIR, or the folder the transcript sits in
 * (<config>/projects/<project>/<session>.jsonl), or ~/.claude. Only Claude's
 * own .claude.json is read, and only its oauthAccount's email is taken.
 */
function claudeAccount(env, transcript, home) {
  const standard = path.join(home, ".claude");
  const m = /^(\/.+)\/projects\/[^/]+\/[^/]+\.jsonl$/.exec(str(transcript));
  const config = str(env.CLAUDE_CONFIG_DIR) || (m ? m[1] : "") || standard;
  if (!path.isAbsolute(config)) return "";
  const files = path.resolve(config) === standard ? [path.join(home, ".claude.json"), path.join(standard, ".claude.json")] : [path.join(config, ".claude.json")];
  for (const f of files) {
    try {
      if (fs.statSync(f).size > 32 * 1024 * 1024) continue;
      const email = str(((JSON.parse(fs.readFileSync(f, "utf8")) || {}).oauthAccount || {}).emailAddress);
      if (EMAIL.test(email)) return email;
    } catch {}
  }
  return "";
}

/** Where the service listens and its secret, or null when it isn't running. */
function readHookFile(dir) {
  try {
    const { port, secret } = JSON.parse(fs.readFileSync(path.join(dir, "hook.json"), "utf8"));
    return Number.isInteger(port) && port > 0 && port < 65536 && SECRET.test(secret) ? { port, secret } : null;
  } catch { return null; }
}

/** Everything the service is told about a session, with the event's own fields. */
function bodyFor(agent, input, step, env, proc, home) {
  const cwd = str(input.cwd);
  const tmux = str(env.TMUX).split(",")[0];                  // "<socket>,<server pid>,<session>"
  const { event, ...fields } = step;
  return {
    session_id: str(input.session_id),
    agent,
    cwd,
    transcript: str(input.transcript_path),
    title: cwd ? path.basename(cwd) : "",
    branch: gitBranch(cwd),
    account: agent === "claude" ? claudeAccount(env, input.transcript_path, home) : "",
    pid: proc.pid,
    started: proc.started,
    terminal: str(env.SUPERSET_TERMINAL_ID),
    workspace: str(env.SUPERSET_WORKSPACE_ID),
    pane: str(env.TMUX_PANE),
    tmux: path.isAbsolute(tmux) ? tmux : "",
    ...fields,
  };
}

function post({ port, secret }, event, body) {
  return new Promise((done) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: "127.0.0.1", port, path: "/hook/" + event, method: "POST", agent: false, timeout: LIMIT_MS,
      headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json", "Content-Length": data.length } }, (res) => {
      res.resume();
      res.on("end", () => done(res.statusCode));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => done(0));
    req.end(data);
  });
}

/** One event, start to end. Resolves to the status the service answered, or 0. */
async function run(agent, raw, env = process.env, home = os.homedir(), ppid = process.ppid) {
  let input;
  try { input = JSON.parse(raw); } catch { return 0; }
  if (!input || typeof input !== "object") return 0;
  const step = plan(agent, input);
  if (!step || !SESSION_ID.test(str(input.session_id))) return 0;
  const hook = readHookFile(str(env.AIRPOCKET_DIR) || path.join(home, "Library", "Application Support", "Airpocket"));
  if (!hook) return 0;                                       // the service isn't running: nothing to tell
  return post(hook, step.event, bodyFor(agent, input, step, env, agentProcess(ppid), home));
}

module.exports = { plan, gitBranch, claudeAccount, bodyFor, run };

if (require.main === module) {
  const quit = () => process.exit(0);
  setTimeout(quit, LIMIT_MS + 200).unref();                  // whatever hangs, the agent never waits on us
  process.on("uncaughtException", quit);
  process.on("unhandledRejection", quit);
  const agent = process.argv[2] === "codex" ? "codex" : "claude";
  const chunks = [];
  let size = 0;
  process.stdin.on("data", (c) => { size += c.length; if (size > MAX_INPUT) quit(); chunks.push(c); });
  process.stdin.on("error", quit);
  process.stdin.on("end", () => run(agent, Buffer.concat(chunks).toString("utf8")).then(quit, quit));
}

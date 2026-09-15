"use strict";
// Airpocket's server: the phone app and its API.
//
// A deliberately small HTTP server. It listens on 127.0.0.1 only; the phone
// reaches it through `tailscale serve`, which publishes it inside your tailnet
// over HTTPS and nowhere else. It exposes a short allow-list:
//
//   POST /api/pair      six-digit code from `airpocket pair` -> device token
//   GET  /api/hello     which Mac is this
//   GET  /api/sessions  every session this Mac knows, the waiting ones marked
//   GET  /api/screen    one session: its conversation, live state, or terminal screen
//   POST /api/send      type text into a session, with or without Enter
//   POST /api/key       one of a few fixed keys: digits, arrows, Tab, Enter, Esc
//   POST /api/command   a Controls action, from a fixed table of slash commands
//   POST /api/seen      opening a finished session takes it off the waiting list
//   GET  /api/new/options, POST /api/new    start a session through Superset
//   GET  /api/files, /api/file/text, /api/file/image, POST /api/file/open
//
// Everything except pairing and the static app needs `Authorization: Bearer
// <device token>`. There are no cookies, so there is nothing for another site to
// ride on. The phone never names a terminal or a workspace: it names a session
// id, and the terminal is looked up here in Airpocket's own records. A second
// server, on the next port, is the file-only origin (see "files" below). A
// session with no terminal to type into is read-only.
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { createStore } = require("./store");
const { PORTS } = require("./ports");
const { createService, transcriptPath } = require("./service");
const { processAlive } = require("./proc");

const PUBLIC = path.join(__dirname, "public");
const SUPERSET = path.join(os.homedir(), ".superset", "bin", "superset");

const MAX_BODY = 32 * 1024;
const MAX_TEXT = 8000;
const TAIL_BYTES = 4 * 1024 * 1024;   // read only the end of a transcript; some are 100 MB
const MAX_ITEMS = 160;
const CODEX_WINDOW_MAX = 32 * 1024 * 1024;   // how far back a first look at a Codex file may go
const SESSION_ID = /^[A-Za-z0-9_-]{6,100}$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]{32,128})$/;
const JSON_TYPE = /^application\/json(\s*;.*)?$/i;
const ORIGIN_OK = /^(https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net|http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?)$/i;
const ESC = String.fromCharCode(27);
const BRAILLE = new RegExp("[" + String.fromCharCode(0x2800) + "-" + String.fromCharCode(0x28ff) + "]", "g");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// What Codex shows, greyed out, in an empty prompt box (older versions rotate examples).
const CODEX_PLACEHOLDERS = new Set(["Ask Codex to do anything", "Ask a follow-up question",
  "Use /skills to list available skills or ask Codex to use one.", "Explain this codebase", "Summarize recent commits",
  "Implement {feature}", "Find and fix a bug in @filename", "Write tests for @filename",
  "Improve documentation in @filename", "Run /review on my current changes"]);
// Programs whose next word is a subcommand worth showing ("git status", "npm test").
const SUBCOMMANDS = new Set(["git", "npm", "pnpm", "yarn", "bun", "npx", "cargo", "go", "docker", "gh", "uv", "pip", "pip3",
  "brew", "make", "swift", "xcodebuild", "kubectl", "terraform", "vercel", "supabase"]);

/** Drop control characters (codes 0-31 and 127) from anything typed on the phone. */
const stripControl = (s) => Array.from(String(s)).filter((ch) => { const c = ch.charCodeAt(0); return c > 31 && c !== 127; }).join("");

// The only keys the phone can press. Digits pick an option in a prompt without
// pressing Enter; Enter submits whatever is typed; Esc interrupts a turn.
const KEYS = Object.freeze({
  // Arrows and Tab move through a picker on screen; Shift+Tab cycles Claude's permission mode.
  up: { text: ESC + "[A", submit: false }, down: { text: ESC + "[B", submit: false },
  right: { text: ESC + "[C", submit: false }, left: { text: ESC + "[D", submit: false },
  tab: { text: String.fromCharCode(9), submit: false }, stab: { text: ESC + "[Z", submit: false },
  ...Object.fromEntries(["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => [d, { text: d, submit: false }])),
  enter: { text: "", submit: true },
  esc: { text: ESC, submit: false },
});

// ------------------------------------------------------------ controls ---
// The Controls sheet names a command; the Mac picks the exact text from this
// table. Each one is a slash command the agent itself understands.
const CLAUDE_MODELS = ["opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku", "fable", "fable[1m]", "opusplan"];
const CODEX_MODELS = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"];
const MODELS = Object.freeze({ claude: CLAUDE_MODELS, codex: CODEX_MODELS });
const EFFORTS = Object.freeze({ claude: ["low", "medium", "high", "xhigh", "max"], codex: ["low", "medium", "high", "xhigh"] });
const plain = (text) => () => text;
const COMMANDS = Object.freeze({
  claude: {
    model: (a) => (a === undefined ? "/model" : CLAUDE_MODELS.includes(a) || a === "default" ? "/model " + a : null),
    effort: (a) => (EFFORTS.claude.includes(a) ? "/effort " + a : null),
    fast: plain("/fast"), plan: plain("/plan"), compact: plain("/compact"), context: plain("/context"),
    usage: plain("/usage"), resume: plain("/resume"), rewind: plain("/rewind"), clear: plain("/clear"), status: plain("/status"),
  },
  codex: {
    model: plain("/model"), permissions: plain("/permissions"), fast: plain("/fast"), plan: plain("/plan"),
    compact: plain("/compact"), status: plain("/status"), usage: plain("/usage"), diff: plain("/diff"),
    review: plain("/review"), resume: plain("/resume"), new: plain("/new"),
  },
});

/** Prompts for a new session reach Superset as one argument, so line breaks may stay. */
const cleanPrompt = (t) => (typeof t !== "string" ? "" : Array.from(t.replace(/\r\n?/g, "\n"))
  .filter((ch) => { const c = ch.charCodeAt(0); return c === 10 || (c > 31 && c !== 127); }).join("").trim());

const STATIC = Object.freeze({
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/md.js": ["md.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/sw.js": ["sw.js", "text/javascript; charset=utf-8"],
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json; charset=utf-8"],
  "/icon-180.png": ["icon-180.png", "image/png"],
  "/icon-512.png": ["icon-512.png", "image/png"],
  "/apple-touch-icon.png": ["icon-180.png", "image/png"],
  "/agent-claude.png": ["agent-claude.png", "image/png"],
  "/agent-codex.png": ["agent-codex.png", "image/png"],
});

const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:",
  "connect-src 'self' https://*.ts.net http://127.0.0.1:* http://localhost:*",
  "manifest-src 'self'", "worker-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");
const BASE_HEADERS = Object.freeze({
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
});

// ---------------------------------------------------------------- helpers ---

function send(res, status, body, type, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""));
  res.writeHead(status, { ...BASE_HEADERS, "Content-Type": type, "Content-Length": buf.length, ...extra });
  res.end(buf);
  return status;
}
const json = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), "application/json; charset=utf-8", extra);

function corsHeaders(origin) {
  if (!origin || !ORIGIN_OK.test(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

/** The request body as a plain object, or null after answering the error itself. */
function readJson(req, res, extra) {
  return new Promise((resolve) => {
    if (!JSON_TYPE.test(req.headers["content-type"] || "")) { json(res, 415, { error: "json_only" }, extra); req.resume(); return resolve(null); }
    const chunks = [];
    let size = 0, done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY) { done = true; json(res, 413, { error: "too_large" }, extra); req.resume(); return resolve(null); }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { body = undefined; }
      if (!body || typeof body !== "object" || Array.isArray(body)) { json(res, 400, { error: "bad_json" }, extra); return resolve(null); }
      resolve(body);
    });
    req.on("error", () => { if (!done) { done = true; resolve(null); } });
  });
}

/**
 * Text for a terminal. A newline reaches the terminal as Enter and would fire
 * half a prompt, so line breaks become spaces; other control characters are
 * dropped, so typed text can never smuggle in an escape sequence.
 */
function cleanText(t) {
  if (typeof t !== "string") return null;
  return stripControl(t.replace(/\r\n?|\n/g, " "));
}
const cleanName = (n) => (typeof n === "string" ? stripControl(n).trim().slice(0, 40) : "") || "Phone";

/** The Mac terminal is ~250 columns wide; its full-width rules are noise on a phone. */
function tidyScreen(text, { codex = false } = {}) {
  let t = String(text || "");
  // While it works, Codex drifts a dot animation (braille cells) across the lower
  // rows and over the prompt line. On a phone that is only noise.
  if (codex) t = t.replace(BRAILLE, " ");
  return t
    .split("\n")
    .map((l) => l.replace(/\s+$/, "").replace(/^[─━═]{8,}\s*/, "").replace(/\s*[─━═]{8,}$/, ""))
    .map((l) => (/^[\s─━═╌┄-]*$/.test(l) ? "" : l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

// ------------------------------------------------------------ chat view ---
// The phone shows the conversation, not the raw terminal. Claude Code writes
// every session to ~/.claude/projects/<project>/<session id>.jsonl; the tail of
// that file becomes chat items. What leaves the Mac: your messages, Claude's
// replies, and one short label per tool step (a Bash step's own description, a
// file's base name). Never a tool's output, never a full command line.

const clip = (s, n = 110) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const base = (p) => (typeof p === "string" && p ? path.basename(p) : "");
const stripTags = (s) => String(s)
  .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
  .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
  .trim();

function describeTool(name, input) {
  const n = String(name || "Tool");
  if (n.startsWith("mcp__")) {
    const parts = n.split("__");
    return { name: clip((parts[1] || "").replace(/^claude_ai_/, "").replace(/_/g, " "), 30), label: clip((parts[2] || "").replace(/_/g, " ")) };
  }
  switch (n) {
    case "Bash": return { name: "Bash", label: clip(input.description || (String(input.command || "").trim().split(/\s+/)[0] + " …")) };
    case "Read": case "Write": case "Edit": case "MultiEdit": case "NotebookEdit":
      return { name: n, label: clip(base(input.file_path || input.notebook_path)) };
    case "Grep": case "Glob": return { name: n, label: clip(input.pattern, 80) };
    case "Agent": case "Task": return { name: "Agent", label: clip(input.description || input.subagent_type) };
    case "WebFetch": { let host = ""; try { host = new URL(String(input.url)).host; } catch {} return { name: "Fetch", label: host }; }
    case "WebSearch": return { name: "Search", label: clip(input.query) };
    case "Skill": return { name: "Skill", label: clip(input.skill) };
    case "TodoWrite": return { name: "Plan", label: "updated the to-do list" };
    case "AskUserQuestion": return { name: "Asked", label: clip((input.questions || []).map((q) => q && q.question).filter(Boolean).join(" · "), 200) };
    case "Artifact": return { name: "Artifact", label: clip(input.label || base(input.file_path) || input.action) };
    default: return { name: clip(n, 30), label: "" };
  }
}

/** Transcript lines -> chat items: user, command, agent, tool, note. */
function claudeItems(lines) {
  const items = [], errors = new Set();
  const push = (it) => {
    const prev = items[items.length - 1];
    if (it.type === "agent" && prev && prev.type === "agent" && prev.msg === it.msg) { prev.text += "\n\n" + it.text; return; }
    items.push(it);
  };
  for (const line of lines) {
    if (!line || line[0] !== "{") continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (!d || d.isSidechain) continue;
    const at = d.timestamp || null;
    if (d.type === "attachment") {
      const a = d.attachment || {};
      if (a.type === "queued_command" && typeof a.prompt === "string" && a.prompt.trim()) {
        push({ type: "user", id: String(d.uuid || ""), text: stripTags(a.prompt).slice(0, 8000), at: a.timestamp || at, queued: true });
      }
      continue;
    }
    if (d.type === "system") {
      if (/compact/i.test(String(d.subtype || ""))) push({ type: "note", id: String(d.uuid || ""), text: "Earlier conversation was compacted" });
      continue;
    }
    const m = d.message || {};
    if (d.type === "user") {
      if (d.isMeta || d.isCompactSummary) continue;
      const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
      const texts = [];
      let images = 0;
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === "tool_result") { if (b.is_error) errors.add(String(b.tool_use_id)); continue; }
        if (b.type === "image") { images++; continue; }
        if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
      }
      const raw = texts.join("\n");
      if (!raw.trim() && !images) continue;
      if (/<task-notification>|<local-command-stdout>|<bash-stdout>|<bash-stderr>|^Caveat: /.test(raw)) continue;
      const cmd = /<command-name>([^<]*)<\/command-name>/.exec(raw);
      if (cmd) {
        const args = (/<command-args>([^<]*)<\/command-args>/.exec(raw) || [])[1] || "";
        push({ type: "command", id: String(d.uuid || ""), text: clip(`${cmd[1].trim()} ${args.trim()}`, 200), at });
        continue;
      }
      const bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(raw);
      if (bash) { push({ type: "command", id: String(d.uuid || ""), text: clip("! " + bash[1], 200), at }); continue; }
      if (/^\[Request interrupted/.test(raw.trim())) { push({ type: "note", id: String(d.uuid || ""), text: "You interrupted" }); continue; }
      const text = stripTags(raw);
      if (!text && !images) continue;
      const pics = images ? `[${images} image${images > 1 ? "s" : ""}]` : "";
      push({ type: "user", id: String(d.uuid || ""), text: [text, pics].filter(Boolean).join("\n").slice(0, 8000), at });
      continue;
    }
    if (d.type === "assistant" && Array.isArray(m.content)) {
      m.content.forEach((b, i) => {
        if (!b) return;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          push({ type: "agent", id: `${d.uuid}:${i}`, msg: String(m.id || d.uuid), text: b.text.slice(0, 60000) });
        } else if (b.type === "tool_use") {
          const input = b.input || {};
          const fp = FILE_TOOLS.has(b.name) ? input.file_path || input.notebook_path : null;
          push({ type: "tool", id: String(b.id || `${d.uuid}:${i}`), ...describeTool(b.name, input), ...(typeof fp === "string" ? { path: fp } : {}) });
        }
      });
    }
  }
  for (const it of items) if (it.type === "tool" && errors.has(it.id)) it.error = true;
  return items.slice(-MAX_ITEMS).map(({ msg, ...rest }) => rest);
}

/** The last `max` bytes of a file as whole lines. */
function readTail(file, size, max) {
  const start = Math.max(0, size - max);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text.split("\n");
  } finally {
    fs.closeSync(fd);
  }
}

// What the terminal shows right now: working, waiting, a question on screen,
// or text typed into the prompt but not sent.
const WORKING = /^\s*\S{1,2}\s+([A-Z][A-Za-z]+…)\s+\((\d+[hms][^·•)]*)/;
// Codex: "• Working (12s • esc to interrupt)"; the word can change with what it is doing.
const CODEX_WORKING = /^\s*[•◦·*]?\s*([^()]{1,80}?)\s*\((\d+[hms][^·•)]*?)\s*•\s*esc to interrupt/i;
// Claude marks the highlighted option with ❯, Codex with ›.
const OPTION = /^\s*[│┃|]?\s*([❯›]\s*)?(\d)\.\s+(.+?)\s*[│┃|]?\s*$/;
const CURSOR_OPTION = /^\s*[│┃|]?\s*[❯›]\s*\d\.\s/;
function liveState(text) {
  const lines = String(text || "").split("\n");
  let working = null;
  for (const l of lines) {
    let m = WORKING.exec(l);
    if (m) { working = { verb: m[1], elapsed: m[2].trim() }; continue; }
    m = CODEX_WORKING.exec(l);
    if (m) { const v = clip(m[1], 40); working = { verb: /…$/.test(v) ? v : v + "…", elapsed: m[2].trim() }; }
  }
  // A numbered list is only a question when the selection cursor sits on it.
  let menu = null;
  const cur = lines.findIndex((l) => CURSOR_OPTION.test(l));
  if (cur >= 0) {
    let a = cur, b = cur;
    for (let k = cur - 1; k >= Math.max(0, cur - 12); k--) { if (OPTION.test(lines[k])) a = k; else if (!lines[k].trim() || !/^\s{4,}\S/.test(lines[k])) break; }
    for (let k = cur + 1; k < Math.min(lines.length, cur + 24); k++) { if (OPTION.test(lines[k])) b = k; else if (!lines[k].trim()) break; }
    const options = [];
    for (let k = a; k <= b; k++) {
      const m = OPTION.exec(lines[k]);
      // Codex puts a description after two or more spaces: "gpt-6-astra   Our most capable model".
      if (m) { const [lab, ...rest] = m[3].split(/\s{2,}/); options.push({ n: Number(m[2]), label: clip(lab, 120), hint: clip(rest.join(" "), 160), cur: !!m[1] }); }
    }
    let question = "";
    for (let k = a - 1; k >= Math.max(0, a - 4); k--) {
      const t = lines[k].replace(/[│┃╭╮╰╯─━]/g, "").trim();
      if (t) { question = clip(t, 200); break; }
    }
    if (options.length >= 2) menu = { question, options };
  }
  let staged = "";
  if (!menu) {
    // Only the prompt box at the bottom counts. Prompts further up are history,
    // and an empty Codex box shows a grey placeholder.
    for (let k = lines.length - 1, seen = 0; k >= 0 && seen < 12; k--) {
      if (!lines[k].trim()) continue;
      seen++;
      const m = /^\s*[❯›]\s+(\S.*?)\s*$/.exec(lines[k]);
      if (m) { if (!CODEX_PLACEHOLDERS.has(m[1]) && !/^Try "/.test(m[1])) staged = clip(m[1], 160); break; }
    }
  }
  return { state: working ? "working" : "idle", verb: working ? working.verb : "", elapsed: working ? working.elapsed : "", menu, staged };
}

// Codex cites files with :codex-file-citation{path="..." ...}; on the phone the file name is enough.
const citations = (t) => String(t).replace(/:codex-file-citation\{[^}]*?path="([^"]+)"[^}]*\}/g, (_, p) => "`" + base(p) + "`");

// ------------------------------------------------------------ codex view ---
// Codex writes each thread to ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl
// and appends an item_completed event the moment a step finishes, while the turn
// is still running, so the phone reads the file.
// What leaves the Mac is the same as for Claude: your messages, Codex's
// messages, one short label per step. Never command output, file contents,
// search results or the model's context.

/** "cd x && npm test -- --flag" -> "npm test …": the program, plus a subcommand for git, npm and friends. */
function shellLabel(cmd) {
  const segs = String(cmd || "").split(/&&|\|\||;|\||\n/).map((x) => x.trim()).filter(Boolean);
  const seg = segs.find((x) => !/^cd(\s|$)/.test(x)) || segs[0] || "";
  const words = seg.split(/\s+/);
  while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  const first = base(words[0] || "") || "shell";
  const prog = /^(for|while|until|if|case|do|then|\{|\(|\[\[?)$/.test(first) ? "script" : first;   // a loop, not a program
  const sub = SUBCOMMANDS.has(prog) && /^[a-z][a-z0-9:-]{0,24}$/.test(words[1] || "") ? words[1] : "";
  const more = words.length > (sub ? 2 : 1) || segs.length > 1;
  return clip([prog, sub].filter(Boolean).join(" ") + (more ? " …" : ""), 60);
}

const partsText = (content) => (Array.isArray(content) ? content : [])
  .filter((c) => c && typeof c.text === "string").map((c) => c.text).join("");

/** One finished Codex item -> a chat item, or null for what the phone does not show. */
function codexStep(it, fallbackId) {
  const id = String(it.id || fallbackId);
  const failed = /fail|declin|error/i.test(String(it.status || ""));
  switch (it.type) {
    case "UserMessage": {
      const pics = (Array.isArray(it.content) ? it.content : []).filter((c) => c && /image/i.test(String(c.type))).length;
      const text = [partsText(it.content).trim(), pics ? `[${pics} image${pics > 1 ? "s" : ""}]` : ""].filter(Boolean).join("\n");
      return text ? { type: "user", id, text: text.slice(0, 8000) } : null;
    }
    case "AgentMessage": {
      const text = partsText(it.content);
      if (!text.trim()) return null;
      // "commentary" is the running narration between steps; the last message of a turn is the answer.
      return { type: "agent", id, text: citations(text).slice(0, 60000), paths: mentions(text), ...(it.phase === "commentary" ? { aside: true } : {}) };
    }
    case "CommandExecution": {
      const parsed = Array.isArray(it.parsed_cmd) ? it.parsed_cmd : [];
      const p = parsed[0] || {};
      const argv = Array.isArray(it.command) ? it.command : null;
      const raw = argv ? (argv.length >= 3 && /^-l?c$/.test(argv[1]) ? argv[2] : argv.join(" ")) : it.command;
      let step;
      if (p.type === "read") step = { name: "Read", label: clip(p.name || base(p.path)) };
      else if (p.type === "list_files") step = { name: "List", label: clip(base(p.path) || "files") };
      else if (p.type === "search") step = { name: "Search", label: clip(p.query || base(p.path) || "files", 80) };
      else step = { name: "Shell", label: shellLabel(p.cmd || raw) };
      if (parsed.length > 1 && step.name !== "Shell") step.label += ` +${parsed.length - 1}`;
      const code = it.exit_code == null ? 0 : Number(it.exit_code);
      return { type: "tool", id, ...step, error: failed || code !== 0 };
    }
    case "FileChange": {
      const ch = it.changes && typeof it.changes === "object" ? it.changes : {};
      const names = (Array.isArray(ch) ? ch.map((c) => c && c.path) : Object.keys(ch)).map(base).filter(Boolean);
      const paths = (Array.isArray(ch) ? ch.map((c) => c && c.path) : Object.keys(ch)).filter((p) => typeof p === "string").slice(0, 20);
      return { type: "tool", id, name: "Edit", label: clip(names.slice(0, 4).join(", ") + (names.length > 4 ? ` +${names.length - 4}` : "")), error: failed, paths };
    }
    case "WebSearch": case "Extension": {
      const a = it.action && typeof it.action === "object" ? it.action : {};
      if (it.type === "WebSearch" || /search/i.test(String(it.kind || ""))) {
        if (a.url && a.type !== "search") {
          let host = "";
          try { host = new URL(String(a.url)).host; } catch {}
          return { type: "tool", id, name: "Open", label: clip(host) };
        }
        const q = a.query || it.query || (Array.isArray(a.queries) ? a.queries.join(" · ") : "");
        return q ? { type: "tool", id, name: "Search", label: clip(q, 80) } : { type: "tool", id, name: "Web", label: "" };
      }
      if (it.savedPath) return { type: "tool", id, name: "Image", label: clip(base(String(it.savedPath))), error: failed };
      return { type: "tool", id, name: clip(String(it.kind || "Tool"), 30), label: "", error: failed };
    }
    case "ImageView": return { type: "tool", id, name: "View", label: clip(base(String(it.path || ""))), ...(typeof it.path === "string" ? { path: it.path } : {}) };
    case "McpToolCall": {
      const args = it.arguments && typeof it.arguments === "object" ? it.arguments : {};
      // Some tools carry a one-line title of what the call is for. That is shown; the arguments and result never are.
      const title = typeof args.title === "string" ? args.title : typeof args.description === "string" ? args.description : "";
      return { type: "tool", id, name: clip(String(it.server || "MCP").replace(/_/g, " "), 30),
               label: clip(title || String(it.tool || "").replace(/_/g, " ")),
               error: failed || !!it.error || !!(it.result && it.result.isError) };
    }
    case "CollabAgentToolCall": {
      const who = (Array.isArray(it.receiver_agents) ? it.receiver_agents : []).map((r) => r && r.agent_nickname).filter(Boolean).join(", ");
      return { type: "tool", id, name: "Agent", label: clip([String(it.tool || "").replace(/_/g, " "), who].filter(Boolean).join(" · ")), error: failed };
    }
    case "Reasoning": return null;
    case "ContextCompaction": return { type: "note", id, text: "Earlier conversation was compacted" };
    default:
      // MCP calls and whatever comes next: the server and tool names, never arguments or results.
      return { type: "tool", id, name: clip(String(it.server || it.kind || it.type || "Tool"), 30), label: clip(String(it.tool || ""), 60), error: failed };
  }
}

/** Feed one line of a Codex session file into its running state. */
function codexLine(s, line) {
  if (!line) return;
  const head = line.slice(0, 240);
  // The settings each turn ran with: model, effort, plan mode, permissions.
  if (/"type"\s*:\s*"turn_context"/.test(head)) {
    try { s.ctx = codexContext(JSON.parse(line).payload); } catch {}
    return;
  }
  // Otherwise only events matter. Skip the large model-input lines without parsing them.
  if (!/"type"\s*:\s*"event_msg"/.test(head)) return;
  let d;
  try { d = JSON.parse(line); } catch { return; }
  const p = d && d.type === "event_msg" ? d.payload : null;
  if (!p || typeof p !== "object") return;
  s.n++;
  if (p.type === "item_completed" && p.item && typeof p.item === "object") {
    const it = codexStep(p.item, "x" + s.n);
    if (!it) return;
    const k = s.items.findLastIndex((x) => x.id === it.id);
    if (k >= 0) s.items[k] = it; else s.items.push(it);
    if (s.items.length > 600) s.items.splice(0, s.items.length - 400);
  } else if (p.type === "task_started") {
    s.running = Date.parse(d.timestamp) || Date.now();
  } else if (p.type === "task_complete") {
    s.running = null;
  } else if (/abort/i.test(String(p.type))) {
    s.running = null;
    s.items.push({ type: "note", id: "x" + s.n, text: "Stopped" });
  }
}

function codexContext(p) {
  if (!p || typeof p !== "object") return null;
  const cm = p.collaboration_mode && typeof p.collaboration_mode === "object" ? p.collaboration_mode : {};
  const sb = p.sandbox_policy && typeof p.sandbox_policy === "object" ? String(p.sandbox_policy.type || "") : String(p.sandbox_policy || "");
  const ap = String(p.approval_policy || "");
  const access = sb === "danger-full-access" && ap === "never" ? "full access" : sb === "read-only" ? "read only"
    : ap === "on-request" || ap === "untrusted" ? "asks first" : ap === "never" ? "no approvals" : "";
  return { model: typeof p.model === "string" ? clip(p.model, 40) : "", effort: clip(p.effort || (cm.settings && cm.settings.reasoning_effort) || "", 12),
           mode: clip(cm.mode || "", 12), access };
}

/**
 * Model, effort, permission mode and context, as the terminal shows them.
 * Codex prints "gpt-6-astra xhigh fast · ~/dir" under its prompt; its session
 * file fills gaps. Claude has an effort marker ("◐ medium · /effort"), a mode
 * line ("⏵⏵ bypass permissions on") and, with a status line, the model.
 */
function sessionInfo(agent, text, ctx) {
  const lines = String(text || "").split("\n").slice(-40);
  const joined = lines.join("\n");
  const info = {};
  if (agent === "codex") {
    for (let k = lines.length - 1; k >= 0; k--) {
      const m = /^\s*([a-z][\w.-]*\d[\w.-]*)\s+(?:(none|minimal|low|medium|high|xhigh|max|ultra)\s+)?(fast\s+)?·/.exec(lines[k]);
      if (m) { info.model = m[1]; if (m[2]) info.effort = m[2]; if (m[3]) info.fast = true; break; }
    }
    if (ctx) {
      if (!info.model && ctx.model) info.model = ctx.model;
      if (!info.effort && ctx.effort) info.effort = ctx.effort;
      if (ctx.mode === "plan") info.mode = "plan";
      if (ctx.access) info.access = ctx.access;
    }
    return info;
  }
  let m = /\|\s*([^|\n]*?(?:Opus|Sonnet|Haiku|Fable|Mythos|Claude)[^|\n]*?)\s*\|\s*context:\s*(\d+|--)/i.exec(joined);
  if (m) { info.model = clip(m[1], 40); if (m[2] !== "--") info.context = Number(m[2]); }
  const banner = /((?:Opus|Sonnet|Haiku|Fable|Mythos)[^\n·|]*?) with (low|medium|high|xhigh|max) effort/.exec(joined);
  if (!info.model && banner) info.model = clip(banner[1], 40);
  m = /\b(low|medium|high|xhigh|max|ultracode)\s*·\s*\/effort/.exec(joined);
  if (m) info.effort = m[1]; else if (banner) info.effort = banner[2];
  m = /⏵⏵\s*(.+?)\s+on\b/.exec(joined) || /⏸\s*(plan mode)\s+on\b/.exec(joined);
  info.mode = m ? clip(m[1], 30) : "default";
  return info;
}

function elapsedSince(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}

const digest = (s) => crypto.createHash("sha1").update(s).digest("base64url").slice(0, 16);

// ------------------------------------------------------------------ files ---
// Opening a file the session made or mentioned, on the phone. The rules:
//  - The phone never sends a path. It sends an opaque ref; the Mac rebuilds the
//    session's own list (files it wrote or edited, cited or linked) and looks the
//    ref up there, so a device token cannot reach anything else.
//  - Only inside the session's folder, by real path after links; never the home
//    folder itself, hidden files or folders, node_modules, key or secret names,
//    or a file with more than one hard link.
//  - Only the kinds below, each checked by its first bytes, whatever the name says.
//  - Text, Markdown and code travel as text and are drawn by the app. Images are
//    fetched with the device token and shown as images. PDFs and HTML pages open
//    from a second, file-only origin through a two-minute link for one file; an
//    HTML page there runs no scripts at all.
const MB = 1024 * 1024;
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Artifact"]);
const TEXT = (max = 20 * MB) => ({ kind: "text", type: "text/plain; charset=utf-8", max });
const FILE_KINDS = Object.freeze({
  pdf: { kind: "pdf", type: "application/pdf", max: 60 * MB },
  png: { kind: "image", type: "image/png", max: 25 * MB }, jpg: { kind: "image", type: "image/jpeg", max: 25 * MB },
  jpeg: { kind: "image", type: "image/jpeg", max: 25 * MB }, gif: { kind: "image", type: "image/gif", max: 25 * MB },
  webp: { kind: "image", type: "image/webp", max: 25 * MB }, heic: { kind: "image", type: "image/heic", max: 25 * MB },
  heif: { kind: "image", type: "image/heif", max: 25 * MB }, svg: { kind: "image", type: "image/svg+xml", max: 5 * MB },
  html: { kind: "page", type: "text/html; charset=utf-8", max: 5 * MB }, htm: { kind: "page", type: "text/html; charset=utf-8", max: 5 * MB },
  md: { kind: "markdown", type: "text/markdown; charset=utf-8", max: 20 * MB }, markdown: { kind: "markdown", type: "text/markdown; charset=utf-8", max: 20 * MB },
  ...Object.fromEntries(["txt", "csv", "tsv", "json", "jsonl", "log", "yaml", "yml", "toml", "xml", "sql", "sh", "py", "js", "mjs", "cjs",
    "ts", "tsx", "jsx", "css", "rb", "go", "rs", "swift", "java", "kt", "c", "h", "cpp"].map((x) => [x, TEXT()])),
});
const TEXT_SHOW = 512 * 1024;
const DENY_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p8|p12|pfx|keychain(-db)?|kdbx|ovpn|mobileprovision|cer|crt|der|asc|gpg|jks|keystore)|.*(secret|credential|passw|private[-_. ]?key|api[-_. ]?key).*|(.*[._-])?env(\..*)?)$/i;
// Text that looks like a credential never leaves, whatever the file is called.
const SECRET_CONTENT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|"private_key"\s*:|\bAKIA[0-9A-Z]{16}\b|\bsk-(ant-)?[A-Za-z0-9_-]{24,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abprs]-[A-Za-z0-9-]{20,}/;
const FILE_SECRET = crypto.randomBytes(32);          // refs cannot be computed off the Mac, and change on restart
const BOM = String.fromCharCode(0xfeff);

const mentionRes = () => [/:codex-file-citation\{[^}]*?path="([^"]+)"/g, /\]\(([^)\s]+)\)/g, /`([^`\s]{1,300}\.[A-Za-z0-9]{1,10})`/g];
/** Paths an agent's message points at: Codex citations, Markdown links, `file.ext` in backticks. */
function mentions(text) {
  const out = new Set();
  for (const re of mentionRes()) { let m; while ((m = re.exec(String(text || ""))) && out.size < 30) out.add(m[1]); }
  return [...out];
}
function isUtf8Text(buf) {
  if (buf.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf, { stream: true }); return true; } catch { return false; }
}
/** Does the file start the way its kind must? */
function looksLike(ext, head) {
  const a = (i, j) => head.subarray(i, j).toString("latin1");
  switch (ext) {
    case "pdf": return a(0, 5) === "%PDF-";
    case "png": return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "jpg": case "jpeg": return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case "gif": return /^GIF8[79]a$/.test(a(0, 6));
    case "webp": return a(0, 4) === "RIFF" && a(8, 12) === "WEBP";
    case "heic": case "heif": return a(4, 8) === "ftyp" && /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)$/.test(a(8, 12));
    case "svg": {
      if (!isUtf8Text(head)) return false;
      const t = head.toString("utf8").replace(BOM, "").trimStart();
      return /^<svg[\s>]/i.test(t) || (/^<\?xml/i.test(t) && /<svg[\s>]/i.test(t));
    }
    default: return isUtf8Text(head);
  }
}
function readHead(file, n = 4096) {
  const fd = fs.openSync(file, "r");
  try { const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, got); } finally { fs.closeSync(fd); }
}
const inside = (root, p) => { const r = path.relative(root, p); return !!r && !r.startsWith("..") && !path.isAbsolute(r); };
const hiddenIn = (rel) => rel.split(path.sep).some((seg) => seg.startsWith(".") || seg === "node_modules");

/** The folder a session's files may come from, or null when it is too broad or not a folder. */
function sessionRoot(cwd, home) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  let real, h;
  try { real = fs.realpathSync(cwd); h = fs.realpathSync(home); if (!fs.statSync(real).isDirectory()) return null; } catch { return null; }
  if (!inside(h, real)) return null;                           // never the home folder itself, never outside it
  const rel = path.relative(h, real);
  const segs = rel.split(path.sep);
  // Hidden folders are off limits, except Superset's own workspaces two levels in
  // (~/.superset/worktrees/<project>/…); never ~/.superset itself, where its settings live.
  if (hiddenIn(rel) && !(segs[0] === ".superset" && segs.length >= 3 && !hiddenIn(segs.slice(1).join(path.sep)))) return null;
  return real;
}
/** A candidate path, checked end to end. Null unless every rule passes. */
function fileMeta(root, raw, home, base = root) {
  let p = String(raw || "").trim();
  if (!root || !p || p.length > 400) return null;
  if (/^file:\/\//i.test(p)) { try { p = decodeURIComponent(new URL(p).pathname); } catch { return null; } }
  else if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return null;         // a web address, not a file
  p = p.replace(/#.*$/, "").replace(/:\d+(:\d+)?$/, "");
  try { p = decodeURIComponent(p); } catch {}
  if (p.startsWith("~/")) p = path.join(home, p.slice(2));
  // Relative paths are read from the session's own folder as it recorded it; the real
  // path, after links, is what decides (macOS reaches /var through /private/var).
  const abs = path.resolve(base || root, p);
  const lex = [base, root].find((b) => b && inside(b, abs));
  if (lex && hiddenIn(path.relative(lex, abs))) return null;
  const name = path.basename(abs);
  const ext = path.extname(name).slice(1).toLowerCase();
  const spec = Object.hasOwn(FILE_KINDS, ext) ? FILE_KINDS[ext] : null;
  if (!spec || DENY_NAME.test(name)) return null;
  let real, st;
  try { real = fs.realpathSync(abs); st = fs.statSync(real); } catch { return null; }
  // A link may not lead out of the folder, into a hidden one, or to a differently named kind.
  if (!st.isFile() || st.nlink > 1 || !inside(root, real) || hiddenIn(path.relative(root, real))) return null;
  if (DENY_NAME.test(path.basename(real)) || path.extname(real).slice(1).toLowerCase() !== ext || st.size > spec.max) return null;
  let head;
  try { head = readHead(real); } catch { return null; }
  if (!looksLike(ext, head)) return null;
  if ((spec.kind !== "pdf" && spec.kind !== "image") || ext === "svg") { if (SECRET_CONTENT.test(head.toString("utf8"))) return null; }
  const dir = path.relative(root, path.dirname(real)).split(path.sep).join("/");
  return { abs: real, name, dir, ext, kind: spec.kind, type: spec.type, size: st.size, mtime: st.mtimeMs, ino: st.ino, dev: st.dev };
}

const FILE_ORIGIN_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store, private",
  "X-Frame-Options": "DENY", "Cross-Origin-Resource-Policy": "same-origin", "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()", "X-Robots-Tag": "noindex",
});
// An HTML page is shown as a picture of itself: no scripts, no forms, no loads, no frames.
const PAGE_CSP = "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'";
const TICKET = /^\/f\/([A-Za-z0-9_-]{43})\/([^/]{1,300})$/;

function tailscaleDns() {
  for (const p of ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]) {
    let bin;
    try { bin = fs.realpathSync(p); fs.accessSync(bin, fs.constants.X_OK); } catch { continue; }
    return runFile(bin, ["status", "--json"], 6000)
      .then((out) => { const d = JSON.parse(out); const dns = String((d.Self && d.Self.DNSName) || "").replace(/\.$/, ""); return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(dns) ? dns : ""; })
      .catch(() => "");
  }
  return Promise.resolve("");
}

/** Is the session's process still there: that pid, started when the hook said (a reused pid is not). */
function alive(pid, started) {
  return !!pid && processAlive(pid, started || 0);
}

// --------------------------------------------------------------- superset ---

function runFile(file, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) =>
      err ? reject(new Error(String(errOut || err.message).trim().slice(0, 300))) : resolve(out));
  });
}
function runSuperset(args, o = {}) { return runFile(SUPERSET, args, o.timeout || 15000); }

// ----------------------------------------------------------------- server ---

function createServer(opts = {}) {
  const store = opts.store || createStore(opts.dataDir);
  const log = opts.log || ((...a) => console.log(new Date().toISOString(), ...a));
  // The seams to the background service (service.js), called in-process: its
  // session records, its waiting list, and taking one off that list. Only start()
  // creates a service; a server built any other way is handed one, or all three
  // seams, so it never touches the data folder's records by itself.
  const service = opts.service || null;
  if (!service && !(opts.knownSessions && opts.getQueue && opts.dequeue)) {
    throw new Error("createServer needs a service, or knownSessions, getQueue and dequeue");
  }
  const deps = {
    knownSessions: opts.knownSessions || service.knownSessions,
    getQueue: opts.getQueue || service.getQueue,
    dequeue: opts.dequeue || service.dequeue,
    superset: opts.superset || runSuperset,
    store,
    log,
    hostLabel: opts.hostLabel || os.hostname().replace(/\.local$/i, ""),
    claudeProjects: opts.claudeProjects || path.join(os.homedir(), ".claude", "projects"),
    codexHome: opts.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    homeDir: opts.homeDir || os.homedir(),
    ticketMs: opts.ticketMs || 120000,
  };
  // Where the file-only origin is reached from the phone: this Mac's tailnet name on
  // its own port, published by `airpocket serve`. Loopback when there is no tailnet.
  const filePort = opts.filePort ?? (opts.port != null ? opts.port + 1 : PORTS.file);
  const publicFilePort = opts.publicFilePort ?? PORTS.publicFile;
  let fileBaseCache = null;
  deps.fileBase = opts.fileBase || (async () => {
    if (fileBaseCache && Date.now() - fileBaseCache.at < 600000) return fileBaseCache.url;
    const dns = await tailscaleDns();
    const url = dns ? `https://${dns}:${publicFilePort}` : `http://127.0.0.1:${filePort}`;
    fileBaseCache = { at: Date.now(), url };
    return url;
  });

  // Several polls of one terminal within a second share a single read.
  const reads = new Map();
  function readTerminal(workspace, terminal, fresh) {
    const key = workspace + "/" + terminal;
    const hit = reads.get(key);
    if (!fresh && hit && Date.now() - hit.at < 900) return hit.promise;
    const promise = deps.superset(["terminals", "read", "--workspace", workspace, "--terminal", terminal, "--json"]);
    reads.set(key, { at: Date.now(), promise });
    promise.catch(() => reads.delete(key));
    return promise;
  }

  // The transcript a session's hook reported, checked again at use: a real file,
  // named after that session, by its real path. This is what finds sessions from
  // other Claude config folders and other CODEX_HOMEs. null when there is none.
  function recordedTranscript(e, agent) {
    if (!transcriptPath(e.transcript, e.session_id, agent)) return null;
    try {
      const real = fs.realpathSync(e.transcript);
      return fs.statSync(real).isFile() && transcriptPath(real, e.session_id, agent) ? real : null;
    } catch { return null; }
  }

  // Where each Claude session's transcript lives: the one on record, or else
  // found once under ~/.claude/projects and remembered.
  const transcriptPaths = new Map();
  function transcriptFor(e) {
    const sid = String(e.session_id);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) return null;
    const own = recordedTranscript(e, "claude");
    if (own) return own;
    const known = transcriptPaths.get(sid);
    if (known && fs.existsSync(known)) return known;
    let dirs = [];
    try { dirs = fs.readdirSync(deps.claudeProjects); } catch { return null; }
    for (const d of dirs) {
      const p = path.join(deps.claudeProjects, d, sid + ".jsonl");
      if (fs.existsSync(p)) { transcriptPaths.set(sid, p); return p; }
    }
    return null;
  }
  // Parse a transcript again only when it has changed.
  const parsed = new Map();
  function chatItems(file) {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    const hit = parsed.get(file);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.items;
    const items = claudeItems(readTail(file, st.size, TAIL_BYTES));
    parsed.set(file, { size: st.size, mtimeMs: st.mtimeMs, items });
    if (parsed.size > 24) parsed.delete(parsed.keys().next().value);
    return items;
  }

  // A Codex thread's session file: the one on record, or else found under
  // CODEX_HOME. Thread ids are UUIDv7, so the id says which day's folder it was
  // created in. Found once, then remembered.
  const rolloutPaths = new Map(), rolloutMiss = new Map();
  function rolloutFor(e) {
    const tid = String(e.session_id);
    if (!UUID.test(tid)) return null;
    const own = recordedTranscript(e, "codex");
    if (own) return own;
    const known = rolloutPaths.get(tid);
    if (known && fs.existsSync(known)) return known;
    if (Date.now() - (rolloutMiss.get(tid) || 0) < 10000) return null;
    const ms = parseInt(tid.slice(0, 8) + tid.slice(9, 13), 16);
    const pad = (n) => String(n).padStart(2, "0");
    const suffix = "-" + tid.toLowerCase() + ".jsonl";
    for (const shift of [0, -1, 1]) {
      const d = new Date(ms + shift * 86400000);
      if (isNaN(d)) break;
      let names = [];
      const dir = path.join(deps.codexHome, "sessions", String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
      try { names = fs.readdirSync(dir); } catch { continue; }
      const hit = names.find((n) => n.startsWith("rollout-") && n.toLowerCase().endsWith(suffix));
      if (hit) { const p = path.join(dir, hit); rolloutPaths.set(tid, p); rolloutMiss.delete(tid); return p; }
    }
    if (rolloutMiss.size > 200) rolloutMiss.clear();
    rolloutMiss.set(tid, Date.now());
    return null;
  }
  // Read incrementally: the first look reads the tail, later polls only what was appended.
  const rollouts = new Map();
  function codexChat(file) {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    let s = rollouts.get(file);
    if (!s || s.ino !== st.ino || st.size < s.offset) {
      // A browser or MCP result can be a megabyte on one line, so a fixed tail
      // may hold only a handful of steps. Widen it until it holds enough.
      for (let window = TAIL_BYTES; ; window *= 2) {
        s = { ino: st.ino, offset: Math.max(0, st.size - window), cut: st.size > window, items: [], running: null, n: 0 };
        readOn(s, file, st.size);
        if (s.items.length >= 40 || window >= st.size || window >= CODEX_WINDOW_MAX) break;
      }
      rollouts.set(file, s);
      if (rollouts.size > 24) rollouts.delete(rollouts.keys().next().value);
    } else if (st.size > s.offset) {
      readOn(s, file, st.size);
    }
    return s;
  }
  function readOn(s, file, size) {
    const buf = Buffer.alloc(size - s.offset);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, buf, 0, buf.length, s.offset); } finally { fs.closeSync(fd); }
    const end = buf.lastIndexOf(10);                     // a line still being written waits for the next poll
    if (end < 0) return;
    const from = s.cut ? buf.indexOf(10) + 1 : 0;        // the tail began mid-line
    s.cut = false;
    s.offset += end + 1;
    if (from <= end) for (const line of buf.toString("utf8", from, end).split("\n")) codexLine(s, line);
  }

  function list() {
    const byId = new Map();
    for (const q of deps.getQueue() || []) {
      if (q && q.id) byId.set(String(q.id), q);
      if (q && q.sid) byId.set("sid:" + q.sid, q);
    }
    const seen = new Set(), out = [];
    for (const e of deps.knownSessions() || []) {
      if (!e || !e.session_id || seen.has(String(e.session_id))) continue;
      seen.add(String(e.session_id));
      const q = byId.get(String(e.bridge_id)) || byId.get("sid:" + e.session_id);
      const terminal = !!(e.workspace && e.terminal);
      out.push({
        id: String(e.session_id),
        title: String(e.title || path.basename(e.cwd || "") || "session"),
        agent: e.agent === "codex" ? "codex" : "claude",
        account: String(e.account || "").split("@")[0],
        branch: String(e.branch || ""),
        note: String((q && q.message) || e.note || "").slice(0, 240),
        lastSeen: e.last_seen || 0,
        live: alive(e.pid, e.started),
        waiting: !!q,
        kind: q ? (q.kind || "input") : null,
        via: terminal ? "terminal" : null,               // null: read-only on the phone
        reason: q ? String(q.reason || "") : "",
      });
    }
    const rank = (s) => (s.waiting && s.kind === "input" ? 0 : s.waiting ? 1 : s.live ? 2 : 3);
    return out.sort((a, b) => rank(a) - rank(b) || b.lastSeen - a.lastSeen);
  }

  function find(id) {
    if (typeof id !== "string" || !SESSION_ID.test(id)) return null;
    return (deps.knownSessions() || []).find((e) => e && String(e.session_id) === id) || null;
  }
  const typeInto = (e, text, submit) => deps.superset(["terminals", "send", "--workspace", e.workspace,
    "--terminal", e.terminal, "--text", text, ...(submit ? [] : ["--no-submit"])]);

  async function pair(res, body, cors) {
    const r = deps.store.useCode(body.code);
    if (r === "ok") {
      const { token, device } = deps.store.addDevice(cleanName(body.name));
      deps.log(`paired ${device.name} (${device.id})`);
      return json(res, 200, { token, deviceId: device.id, host: deps.hostLabel }, cors);
    }
    if (r === "none") return json(res, 400, { error: "no_code", message: "No pairing code is waiting. On the Mac run: airpocket pair" }, cors);
    if (r === "expired") return json(res, 400, { error: "expired", message: "That code expired. Make a new one on the Mac." }, cors);
    if (r === "locked") return json(res, 429, { error: "locked", message: "Too many wrong tries. Make a new code on the Mac." }, cors);
    return json(res, 401, { error: "wrong_code", left: r.wrong,
      message: r.wrong ? `Wrong code. ${r.wrong} ${r.wrong === 1 ? "try" : "tries"} left.` : "Wrong code. Make a new one on the Mac." }, cors);
  }

  /**
   * One session for the phone. view=chat (default) returns the conversation and
   * the live state; view=terminal returns the screen. `sig` is the fingerprint of
   * the items the phone already has: when nothing changed, the items are left out
   * and a poll over mobile data costs a few hundred bytes.
   */
  async function screen(res, url, cors) {
    const e = find(url.searchParams.get("id"));
    if (!e) return json(res, 404, { error: "unknown_session", message: "That session is gone." }, cors);
    const view = url.searchParams.get("view") === "terminal" ? "terminal" : "chat";
    const since = String(url.searchParams.get("sig") || "");
    const terminal = !!(e.workspace && e.terminal);
    const agent = e.agent === "codex" || String(e.bridge_id || "").startsWith("codex:") ? "codex" : "claude";

    let text = null, live = null;
    if (terminal) {
      try { text = tidyScreen(JSON.parse(await readTerminal(e.workspace, e.terminal)).text, { codex: agent === "codex" }); }
      catch { if (view === "terminal") return json(res, 502, { error: "read_failed", message: "Couldn't read that terminal. It may have been closed." }, cors); }
      if (text !== null) live = liveState(text);
    }

    let items = null, ctx = null;
    if (agent === "claude") {
      const file = transcriptFor(e);
      if (file) items = chatItems(file);
    } else {
      // Codex: steps come from its session file as they finish, even mid-turn.
      const file = rolloutFor(e);
      const s = file ? codexChat(file) : null;
      ctx = s ? s.ctx || null : null;
      if (s && s.items.length) {
        items = s.items.slice(-MAX_ITEMS);
        if (!live && s.running) live = { state: "working", verb: "Working…", elapsed: elapsedSince(s.running), menu: null, staged: "" };
      }
    }
    if (!terminal && items === null) return json(res, 409, { error: "no_route", message: "This session isn't in a Superset terminal, so it can't be reached from here." }, cors);

    if (items) items = filesFor(e, items).items;
    const sig = items ? digest(JSON.stringify(items)) : "";
    const out = { kind: items ? "chat" : "terminal", agent, sig, live, at: Date.now() };
    if (terminal && text !== null) out.info = sessionInfo(agent, text, ctx);
    if (items && sig !== since) out.items = items;
    if (view === "terminal" || !items) out.text = text ?? "";
    return json(res, 200, out, cors);
  }

  async function sendText(res, body, cors) {
    const e = find(body.id);
    if (!e) return json(res, 404, { error: "unknown_session", message: "That session is gone." }, cors);
    const text = cleanText(body.text);
    if (text === null || !text.trim()) return json(res, 400, { error: "empty", message: "Nothing to send." }, cors);
    if (text.length > MAX_TEXT) return json(res, 400, { error: "too_long", message: `Keep it under ${MAX_TEXT} characters.` }, cors);
    const submit = body.submit !== false;
    if (e.workspace && e.terminal) {
      await typeInto(e, text, submit);
      return json(res, 200, { ok: true, via: "terminal", submitted: submit }, cors);
    }
    return json(res, 409, { error: "no_route", message: "This session isn't in a terminal Airpocket can type into, so it's read-only here." }, cors);
  }

  async function pressKey(res, body, cors) {
    const e = find(body.id);
    if (!e) return json(res, 404, { error: "unknown_session", message: "That session is gone." }, cors);
    const key = typeof body.key === "string" && Object.hasOwn(KEYS, body.key) ? KEYS[body.key] : null;
    if (!key) return json(res, 400, { error: "bad_key" }, cors);
    if (!(e.workspace && e.terminal)) return json(res, 409, { error: "no_route", message: "Keys work for terminal sessions only." }, cors);
    await typeInto(e, key.text, key.submit);
    return json(res, 200, { ok: true }, cors);
  }

  // ---- files ----
  const rootFor = (e) => sessionRoot(e && e.cwd, deps.homeDir);
  const metaMemo = new Map();                       // root + path -> { at, meta }, for ten seconds
  function checkFile(root, raw, base) {
    const key = root + "\0" + (base || "") + "\0" + raw;
    const hit = metaMemo.get(key);
    if (hit && Date.now() - hit.at < 10000) return hit.meta;
    const meta = fileMeta(root, raw, deps.homeDir, base);
    if (metaMemo.size > 2000) metaMemo.clear();
    metaMemo.set(key, { at: Date.now(), meta });
    return meta;
  }
  const refOf = (e, abs) => crypto.createHmac("sha256", FILE_SECRET).update(String(e.session_id) + "\0" + abs).digest("base64url").slice(0, 22);
  /** Chat items with their files as refs (paths stay here), and the session's file index. */
  function filesFor(e, items) {
    const root = rootFor(e);
    const index = new Map();
    const note = (raw) => {
      if (!root || typeof raw !== "string") return null;
      const meta = checkFile(root, raw, typeof e.cwd === "string" ? e.cwd : root);
      if (!meta) return null;
      const ref = refOf(e, meta.abs);
      index.set(ref, { ...meta, ref });
      return { ref, name: meta.name, kind: meta.kind, dir: meta.dir };
    };
    const out = (items || []).map((it) => {
      const { path: p, paths, ...rest } = it;
      if (it.type === "tool") {
        const f = [p, ...(paths || [])].filter(Boolean).map(note).find(Boolean);
        return f ? { ...rest, file: f } : rest;
      }
      if (it.type === "agent") {
        const seen = new Set(), files = [];
        for (const raw of paths || mentions(it.text)) {
          const f = note(raw);
          if (f && !seen.has(f.ref) && files.length < 8) { seen.add(f.ref); files.push(f); }
        }
        return files.length ? { ...rest, files } : rest;
      }
      return rest;
    });
    return { items: out, index, root };
  }
  /** Everything the session's record points at, found again from scratch. */
  function sessionFiles(e) {
    let items = [];
    if (agentOf(e) === "claude") { const f = transcriptFor(e); if (f) items = chatItems(f) || []; }
    else { const f = rolloutFor(e); const s = f ? codexChat(f) : null; if (s) items = s.items; }
    return filesFor(e, items);
  }
  function lookupFile(e, ref) {
    if (typeof ref !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(ref)) return null;
    const { index, root } = sessionFiles(e);
    const f = index.get(ref);
    if (!f) return null;
    const now = fileMeta(root, f.abs, deps.homeDir);           // checked again at the moment of use
    return now && now.ino === f.ino && now.dev === f.dev ? { ...now, ref, root } : null;
  }
  async function listFiles(res, url, cors) {
    const e = find(url.searchParams.get("id"));
    if (!e) return json(res, 404, { error: "unknown_session", message: "That session is gone." }, cors);
    const { index, root } = sessionFiles(e);
    const files = [...index.values()].sort((a, b) => b.mtime - a.mtime).slice(0, 200)
      .map((f) => ({ ref: f.ref, name: f.name, dir: f.dir, kind: f.kind, size: f.size, mtime: Math.round(f.mtime) }));
    return json(res, 200, { files, root: !!root }, cors);
  }
  async function fileText(res, url, cors) {
    const e = find(url.searchParams.get("id"));
    const f = e && lookupFile(e, url.searchParams.get("ref"));
    if (!f) return json(res, 404, { error: "no_file", message: "That file isn't available." }, cors);
    if (f.kind !== "text" && f.kind !== "markdown") return json(res, 400, { error: "wrong_kind" }, cors);
    const fd = fs.openSync(f.abs, "r");
    let buf;
    try { buf = Buffer.alloc(Math.min(f.size, TEXT_SHOW)); buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)); } finally { fs.closeSync(fd); }
    const text = Array.from(buf.toString("utf8").replace(BOM, "")).filter((ch) => { const c = ch.charCodeAt(0); return c === 9 || c === 10 || (c > 31 && c !== 127); }).join("");
    if (SECRET_CONTENT.test(text)) return json(res, 403, { error: "secret", message: "This file looks like it holds a key or a password, so it stays on the Mac." }, cors);
    return json(res, 200, { name: f.name, kind: f.kind, text, truncated: f.size > TEXT_SHOW, size: f.size }, cors);
  }
  async function fileImage(res, url, cors) {
    const e = find(url.searchParams.get("id"));
    const f = e && lookupFile(e, url.searchParams.get("ref"));
    if (!f) return json(res, 404, { error: "no_file", message: "That file isn't available." }, cors);
    if (f.kind !== "image") return json(res, 400, { error: "wrong_kind" }, cors);
    const data = fs.readFileSync(f.abs);
    return send(res, 200, data, f.type, { ...cors, "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": "inline" });
  }
  // Two-minute links to one file on the file-only origin. Held in memory only.
  const tickets = new Map();
  // The file origin is this Mac's tailnet name on its own port: taken from the address
  // the phone used to get here, else looked up, else loopback.
  const tailnetHost = (req) => {
    for (const v of [req && req.headers["x-forwarded-host"], req && req.headers.host]) {
      const host = String(v || "").split(",")[0].trim().replace(/:\d+$/, "").toLowerCase();
      if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(host)) return host;
    }
    return "";
  };
  async function openFile(res, body, cors, req) {
    const e = find(body.id);
    const f = e && lookupFile(e, body.ref);
    if (!f) return json(res, 404, { error: "no_file", message: "That file isn't available." }, cors);
    if (f.kind !== "pdf" && f.kind !== "page") return json(res, 400, { error: "wrong_kind" }, cors);
    const now = Date.now();
    for (const [k, t] of tickets) if (t.expires < now) tickets.delete(k);
    if (tickets.size >= 100) tickets.delete(tickets.keys().next().value);
    const id = crypto.randomBytes(32).toString("base64url");
    tickets.set(id, { root: f.root, abs: f.abs, ino: f.ino, dev: f.dev, ext: f.ext, name: f.name, kind: f.kind, type: f.type, expires: now + deps.ticketMs, uses: 0 });
    deps.log(`opened a ${f.kind} (${f.ext})`);
    const host = tailnetHost(req);
    const origin = host ? `https://${host}:${publicFilePort}` : await deps.fileBase();
    return json(res, 200, { url: `${origin}/f/${id}/${encodeURIComponent(f.name)}`, expires: now + deps.ticketMs }, cors);
  }
  function fileRoute(req, res) {
    const nope = (status) => { res.writeHead(status, { ...FILE_ORIGIN_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": "default-src 'none'" }); res.end(status === 404 ? "Not found" : ""); return status; };
    if (req.method !== "GET" && req.method !== "HEAD") return nope(405);
    let pathname;
    try { pathname = new URL(req.url || "/", "http://files.invalid").pathname; } catch { return nope(400); }
    const m = TICKET.exec(pathname);
    const t = m ? tickets.get(m[1]) : null;
    if (!t) return nope(404);
    if (t.expires < Date.now() || ++t.uses > 40) { tickets.delete(m[1]); return nope(404); }
    let name;
    try { name = decodeURIComponent(m[2]); } catch { return nope(404); }
    const f = name === t.name ? fileMeta(t.root, t.abs, deps.homeDir) : null;
    if (!f || f.ino !== t.ino || f.dev !== t.dev || f.ext !== t.ext) return nope(404);
    if (t.kind === "page") { try { if (SECRET_CONTENT.test(fs.readFileSync(f.abs, "utf8"))) return nope(404); } catch { return nope(404); } }
    const headers = { ...FILE_ORIGIN_HEADERS, "Content-Type": t.type, "Accept-Ranges": "bytes",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(t.name)}`,
      "Content-Security-Policy": t.kind === "page" ? PAGE_CSP : "frame-ancestors 'none'" };
    let start = 0, end = f.size - 1, status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
    if (req.headers.range) {
      if (!range || (!range[1] && !range[2])) { res.writeHead(416, { ...headers, "Content-Range": `bytes */${f.size}` }); res.end(); return 416; }
      if (range[1]) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), f.size - 1) : f.size - 1; }
      else { start = Math.max(0, f.size - Number(range[2])); }
      if (start > end || start >= f.size) { res.writeHead(416, { ...headers, "Content-Range": `bytes */${f.size}` }); res.end(); return 416; }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${f.size}`;
    }
    headers["Content-Length"] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === "HEAD") { res.end(); return status; }
    fs.createReadStream(f.abs, { start, end }).on("error", () => res.destroy()).pipe(res);
    return status;
  }

  const agentOf = (e) => (e.agent === "codex" || String(e.bridge_id || "").startsWith("codex:") ? "codex" : "claude");
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * A Controls-sheet action. The phone names a command and the Mac picks the
   * text. It looks at the screen first: a command typed over a half-written
   * message, an open question or a running turn would mangle both.
   */
  async function command(res, body, cors) {
    const e = find(body.id);
    if (!e) return json(res, 404, { error: "unknown_session", message: "That session is gone." }, cors);
    if (!(e.workspace && e.terminal)) return json(res, 409, { error: "no_route", message: "Controls work for sessions in a Superset terminal." }, cors);
    const agent = agentOf(e);
    const table = COMMANDS[agent];
    const make = typeof body.cmd === "string" && Object.hasOwn(table, body.cmd) ? table[body.cmd] : null;
    if (!make) return json(res, 400, { error: "bad_command" }, cors);
    const text = make(body.arg == null || body.arg === "" ? undefined : String(body.arg));
    if (!text) return json(res, 400, { error: "bad_arg" }, cors);
    let live;
    try { live = liveState(tidyScreen(JSON.parse(await readTerminal(e.workspace, e.terminal, true)).text, { codex: agent === "codex" })); }
    catch { return json(res, 502, { error: "read_failed", message: "Couldn't read that terminal." }, cors); }
    if (live.menu) return json(res, 409, { error: "menu_open", message: "Answer the question on screen first." }, cors);
    if (live.staged) return json(res, 409, { error: "typed_text", message: "There's unsent text in its box. Send or clear it first." }, cors);
    if (live.state === "working") return json(res, 409, { error: "busy", message: "It's working. Wait for it to finish, or press Esc first." }, cors);
    await typeInto(e, text, false);
    await wait(300);                        // let the slash-command list catch up before Enter
    await typeInto(e, "", true);
    return json(res, 200, { ok: true, sent: text }, cors);
  }

  // Opening a session on the phone counts as reading it: a finished turn, or
  // Claude idling at its prompt, leaves the waiting list. A question stays.
  const SEEN_CLEARS = new Set(["finished", "waiting for you"]);
  async function seen(res, body, cors) {
    const e = find(body.id);
    if (!e) return json(res, 404, { error: "unknown_session" }, cors);
    const q = (deps.getQueue() || []).find((x) => x && (String(x.id) === String(e.bridge_id) || (x.sid && String(x.sid) === String(e.session_id))));
    if (!q || !SEEN_CLEARS.has(String(q.reason || ""))) return json(res, 200, { ok: true, cleared: false }, cors);
    // Another phone, or expiry, may have taken it off first.
    const removed = deps.dequeue(String(q.id), q.sid ? String(q.sid) : "");
    return json(res, 200, { ok: true, cleared: removed > 0 }, cors);
  }

  // ---- starting sessions through Superset ----
  const PRESET = /^[a-z][a-z0-9-]{0,30}$/;
  const BRANCH = /^(?![-/.])(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,80}$/;
  let options = null;
  async function loadOptions() {
    if (options && Date.now() - options.at < 60000) return options;
    const rows = (out) => { const d = JSON.parse(out); return Array.isArray(d) ? d : Array.isArray(d && d.data) ? d.data : []; };
    const [p, w, a] = await Promise.all([
      deps.superset(["projects", "list", "--json"]),
      deps.superset(["workspaces", "list", "--json"]),
      deps.superset(["agents", "list", "--local", "--json"]),
    ]);
    options = {
      at: Date.now(),
      // Names and ids only: no paths or repository addresses leave the Mac.
      projects: rows(p).map((x) => ({ id: String(x.id || ""), name: clip(x.name || "project", 80) })).filter((x) => UUID.test(x.id)),
      workspaces: rows(w).map((x) => ({ id: String(x.id || ""), projectId: String(x.projectId || ""), name: clip(x.name || "", 80),
                                         branch: clip(x.branch || "", 80), type: String(x.type || "") })).filter((x) => UUID.test(x.id)),
      agents: rows(a).map((x) => ({ id: String(x.presetId || ""), label: clip(x.label || x.presetId || "", 30) })).filter((x) => PRESET.test(x.id)),
    };
    return options;
  }
  async function newOptions(res, cors) {
    let o;
    try { o = await loadOptions(); } catch { return json(res, 502, { error: "superset_failed", message: "Couldn't ask Superset for its projects." }, cors); }
    return json(res, 200, { projects: o.projects, workspaces: o.workspaces, agents: o.agents, models: MODELS, efforts: EFFORTS }, cors);
  }
  async function newSession(res, body, cors) {
    let o;
    try { o = await loadOptions(); } catch { return json(res, 502, { error: "superset_failed", message: "Couldn't ask Superset for its projects." }, cors); }
    const agent = o.agents.find((a) => a.id === body.agent);
    if (!agent) return json(res, 400, { error: "bad_agent", message: "Pick an agent." }, cors);
    const prompt = cleanPrompt(body.prompt);
    if (!prompt) return json(res, 400, { error: "empty", message: "Write what it should do." }, cors);
    if (prompt.length > MAX_TEXT) return json(res, 400, { error: "too_long", message: `Keep it under ${MAX_TEXT} characters.` }, cors);
    const args = [];
    if (body.workspace != null) {
      const ws = o.workspaces.find((w) => w.id === body.workspace);
      if (!ws) return json(res, 400, { error: "bad_workspace", message: "That workspace is gone. Reload and pick again." }, cors);
      args.push("agents", "create", "--workspace", ws.id, "--agent", agent.id);
    } else {
      const pr = o.projects.find((x) => x.id === body.project);
      if (!pr) return json(res, 400, { error: "bad_project", message: "Pick a project." }, cors);
      const branch = typeof body.branch === "string" ? body.branch.trim() : "";
      if (!BRANCH.test(branch)) return json(res, 400, { error: "bad_branch", message: "Use letters, digits, dots, dashes and slashes for the branch." }, cors);
      args.push("workspaces", "create", "--local", "--project", pr.id, "--branch", branch, "--name", branch, "--agent", agent.id);
    }
    for (const [flag, list, v] of [["--model", MODELS[agent.id] || [], body.model], ["--effort", EFFORTS[agent.id] || [], body.effort]]) {
      if (v == null || v === "") continue;
      if (!list.includes(v)) return json(res, 400, { error: "bad_" + flag.slice(2), message: `That ${flag.slice(2)} isn't offered for ${agent.label}.` }, cors);
      args.push(flag, v);
    }
    // A prompt that starts with "-" would read as an option.
    args.push("--prompt", prompt.startsWith("-") ? " " + prompt : prompt, "--json");
    try { await deps.superset(args, { timeout: 90000 }); }
    catch (err) { return json(res, 502, { error: "start_failed", message: "Superset couldn't start it: " + String(err.message || "").slice(0, 160) }, cors); }
    options = null;                           // a new workspace changes the lists
    deps.log(`started ${agent.id} ${body.workspace != null ? "in a workspace" : "on a new branch"}`);
    return json(res, 200, { ok: true }, cors);
  }

  async function route(req, res, url) {
    const p = url.pathname;
    const api = p.startsWith("/api/");
    const cors = api ? corsHeaders(req.headers.origin) : {};

    if (req.method === "OPTIONS") {
      return api && cors["Access-Control-Allow-Origin"] ? send(res, 204, "", "text/plain", cors) : send(res, 404, "", "text/plain");
    }
    if (!api) {
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "", "text/plain");
      const hit = Object.hasOwn(STATIC, p) ? STATIC[p] : null;
      if (!hit) return send(res, 404, "Not found", "text/plain; charset=utf-8");
      let data;
      try { data = fs.readFileSync(path.join(PUBLIC, hit[0])); } catch { return send(res, 404, "Not found", "text/plain; charset=utf-8"); }
      return send(res, 200, data, hit[1]);
    }

    if (p === "/api/pair") {
      if (req.method !== "POST") return json(res, 405, { error: "method" }, cors);
      const body = await readJson(req, res, cors);
      return body ? pair(res, body, cors) : res.statusCode;
    }

    const m = BEARER.exec(req.headers.authorization || "");
    const device = m ? deps.store.deviceFor(m[1]) : null;
    if (!device) return json(res, 401, { error: "unauthorized", message: "This phone isn't paired with this Mac." }, cors);
    deps.store.touch(device.id);

    if (req.method === "GET") {
      if (p === "/api/hello") return json(res, 200, { host: deps.hostLabel, device: device.name }, cors);
      if (p === "/api/sessions") return json(res, 200, { host: deps.hostLabel, sessions: list() }, cors);
      if (p === "/api/screen") return screen(res, url, cors);
      if (p === "/api/new/options") return newOptions(res, cors);
      if (p === "/api/files") return listFiles(res, url, cors);
      if (p === "/api/file/text") return fileText(res, url, cors);
      if (p === "/api/file/image") return fileImage(res, url, cors);
      return json(res, 404, { error: "not_found" }, cors);
    }
    if (req.method === "POST") {
      const handler = { "/api/send": sendText, "/api/key": pressKey, "/api/command": command,
                        "/api/seen": seen, "/api/new": newSession, "/api/file/open": openFile }[p];
      if (!handler) return json(res, 404, { error: "not_found" }, cors);
      const body = await readJson(req, res, cors);
      return body ? handler(res, body, cors, req) : res.statusCode;
    }
    return json(res, 405, { error: "method" }, cors);
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    let url;
    try { url = new URL(req.url || "/", "http://airpocket.invalid"); } catch { res.writeHead(400); return res.end(); }
    route(req, res, url)
      .then((status) => {
        // Polls are frequent; log writes and failures only. Never the query or the body.
        if (req.method === "POST" || status >= 400) deps.log(`${req.method} ${url.pathname} ${status} ${Date.now() - started}ms`);
      })
      .catch((err) => {
        deps.log("error:", err && err.stack ? err.stack : err);
        if (!res.headersSent) json(res, 500, { error: "internal", message: "Something went wrong on the Mac." });
        else res.destroy();
      });
  });
  server.requestTimeout = 30000;
  // The file-only origin: nothing but two-minute file links. No API, no app, no cookies.
  const fileServer = http.createServer((req, res) => {
    let status;
    try { status = fileRoute(req, res); } catch (err) { deps.log("file server error:", err && err.message); if (!res.headersSent) { res.writeHead(500); res.end(); } }
    if (status >= 400 && status !== 404) deps.log(`file ${req.method} ${status}`);
  });
  fileServer.requestTimeout = 60000;
  server.headersTimeout = 15000;
  return { server, fileServer, service, deps };
}

/**
 * Airpocket in one process: the service with its hook endpoint, the phone
 * server and the file-only server, all on 127.0.0.1 only. `npm start` calls this.
 */
function start(opts = {}) {
  const port = opts.port ?? PORTS.app;
  const filePort = opts.filePort ?? (opts.port != null ? opts.port + 1 : PORTS.file);
  const hookPort = opts.hookPort ?? (opts.port != null ? opts.port + 2 : PORTS.hook);
  const store = opts.store || createStore(opts.dataDir);
  const log = opts.log || ((...a) => console.log(new Date().toISOString(), ...a));
  const service = opts.service || createService({ dir: store.dir, log });
  const app = createServer({ ...opts, store, log, service, port, filePort });
  const taken = (what, p) => (err) => log(`${what}: ${err.code === "EADDRINUSE" ? `port ${p} is already taken` : err.message}`);
  app.server.on("error", taken("server", port));
  app.server.listen(port, "127.0.0.1", () => log(`airpocket on http://127.0.0.1:${app.server.address().port}`));
  app.fileServer.on("error", taken("file server", filePort));
  app.fileServer.listen(filePort, "127.0.0.1", () => log(`file server on http://127.0.0.1:${app.fileServer.address().port}`));
  service.hookServer.on("error", taken("hooks", hookPort));
  service.listen(hookPort, (p) => log(`hooks on http://127.0.0.1:${p}`));
  return app;
}

module.exports = { start, createServer, tidyScreen, cleanText, KEYS, liveState, claudeItems, describeTool, codexStep, shellLabel, sessionInfo, sessionRoot, fileMeta, mentions };

if (require.main === module) {
  let app;
  try { app = start(); } catch (err) {
    console.error(err.code === "ELOCKED" ? err.message : err.stack || err);
    process.exit(1);
  }
  // Leave the lock behind only after a crash; a stale lock is taken over anyway.
  process.on("exit", () => app.service.release());
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
}

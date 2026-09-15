"use strict";
// Try the tmux bridge end to end with a real, throwaway Claude Code session.
//
// A throwaway Airpocket (service, hook endpoint and phone server) runs from a
// temp folder. Claude runs in a tmux server on a private socket in that folder,
// never the user's own tmux server or its default socket. tmux is the terminal,
// so it answers Claude's terminal queries itself (no pyte). Only the hook in
// --settings is on: --setting-sources project skips the user's own settings and
// hooks, so nothing else on the Mac hears of this session and no settings file
// is edited. It runs in the repo folder (already trusted), with a small model,
// and everything is typed through the phone's API, as a phone would:
//
//   appears with the tmux bridge; a prompt with Enter -> a reply; text without
//   Enter -> sits in the box, Enter key -> a reply; a Controls command; /exit ->
//   gone, and nothing typed reaches what the pane runs after Claude.
//
//   node docs/reference/try-tmux.js [path to claude]
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { createServer } = require("../../src/server");
const { createService } = require("../../src/service");
const { createStore } = require("../../src/store");
const { findTmux } = require("../../src/bridges");

const REPO = path.resolve(__dirname, "..", "..");
const CLAUDE = process.argv[2] || path.join(os.homedir(), ".local", "bin", "claude");
const TMUX = findTmux();
if (!TMUX) { console.error("tmux isn't installed"); process.exit(1); }

const data = fs.mkdtempSync(path.join(os.tmpdir(), "airpocket-try-tmux-"));
const sock = path.join(data, "tmux.sock");
const after = path.join(data, "after.log");
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const tmux = (...args) => execFileSync(TMUX, ["-u", "-S", sock, ...args], { env: paneEnv, encoding: "utf8" });

// The pane's environment: none of Superset's, Claude's, Codex's or tmux's own
// variables, so the hook can only record the tmux pane.
const paneEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !/^(SUPERSET_|CLAUDE|CODEX_|TMUX)/.test(k)));
paneEnv.LANG = paneEnv.LANG || "en_US.UTF-8";

const store = createStore(data);
const service = createService({ dir: data });
const app = createServer({ store, service, log: () => {},
  superset: async () => { throw new Error("Superset isn't part of this trial"); }, hasSuperset: () => false });
let base = "", token = "";
async function api(method, p, body) {
  const res = await fetch(base + p, { method, headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
                                      body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function until(what, fn, secs) {
  const end = Date.now() + secs * 1000;
  for (;;) {
    const v = await fn();
    if (v) { say(what); return v; }
    if (Date.now() > end) { say("TIMED OUT:", what); return null; }
    await sleep(400);
  }
}
const session = async () => ((await api("GET", "/api/sessions")).json.sessions || [])[0] || null;
const chat = async (id) => (await api("GET", "/api/screen?id=" + id)).json;
const replies = (d) => (d.items || []).filter((it) => it.type === "agent").map((it) => it.text.trim().toLowerCase());
// An empty prompt box and nothing running: ready for the next prompt. When that
// doesn't come, show what the phone saw and the bottom of the screen.
let lastLive = null;
const readyFor = async (id) => { const d = await chat(id); lastLive = d.live; return d.live && d.live.state === "idle" && !d.live.menu && !d.live.staged ? d : null; };
const showScreen = (n = 8) => { for (const l of tmux("capture-pane", "-p").trimEnd().split("\n").slice(-n)) say("   |", l); };
async function waitReady(id, secs) {
  const d = await until("an empty prompt box", () => readyFor(id), secs);
  if (!d) { say("   live:", JSON.stringify(lastLive)); showScreen(); }
  return d;
}

(async () => {
  const ok = {};
  try {
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${app.server.address().port}`;
    await new Promise((r) => service.listen(0, r));
    const { code } = store.newCode();
    token = (await (await fetch(base + "/api/pair", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "try-tmux" }) })).json()).token;

    const hook = `AIRPOCKET_DIR=${q(data)} ${q(process.execPath)} ${q(path.join(REPO, "src", "hook.js"))} claude`;
    const events = ["SessionStart", "UserPromptSubmit", "Stop", "Notification", "SessionEnd"];
    const settings = { remoteControlAtStartup: false,
      hooks: Object.fromEntries(events.map((e) => [e, [{ hooks: [{ type: "command", command: hook, timeout: 5 }] }]])) };
    const claude = [CLAUDE, "--setting-sources", "project", "--settings", JSON.stringify(settings), "--model", "haiku"].map(q).join(" ");
    // When Claude exits, the pane runs cat, the way a terminal falls back to a shell.
    tmux("-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "40", "-c", REPO, "/bin/sh", "-c", `${claude}; exec /bin/cat > ${q(after)}`);

    const s = await until("started, on the list", async () => { const x = await session(); return x && x.can.bridge === "tmux" && x.can.send ? x : null; }, 40);
    ok["appears with the tmux bridge"] = !!s;
    if (!s) {
      if (/trust/i.test(tmux("capture-pane", "-p"))) say("the folder isn't trusted; not answering the prompt");
      return;
    }
    say("   can:", JSON.stringify(s.can));
    const id = s.id;
    const pane = tmux("list-panes", "-F", "#{pane_id}").trim();

    await waitReady(id, 30);
    let r = await api("POST", "/api/send", { id, text: "Reply with just the word pong." });
    ok["send is accepted"] = r.status === 200;
    ok["text and Enter: submitted in one go"] = !!(await until("a reply: pong", async () => replies(await chat(id)).some((t) => t.includes("pong")), 90));

    await waitReady(id, 60);
    await api("POST", "/api/send", { id, text: "Reply with just the word ok.", submit: false });
    const staged = await until("typed, not sent", async () => { const d = await chat(id); return d.live && d.live.staged ? d.live.staged : null; }, 10);
    ok["without Enter it waits in the box"] = !!staged && staged.includes("Reply with just the word ok");
    r = await api("POST", "/api/key", { id, key: "enter" });
    ok["the Enter key submits it"] = r.status === 200 && !!(await until("a reply: ok", async () => replies(await chat(id)).some((t) => /^ok\.?$/.test(t)), 90));

    await waitReady(id, 60);
    r = await api("POST", "/api/command", { id, cmd: "context" });
    say("   command:", r.status, JSON.stringify(r.json));
    // /context prints to the screen and, in current Claude, not to the transcript: look where the phone would.
    ok["a Controls command"] = r.status === 200 && !!(await until("/context output on the screen", async () =>
      /context usage|tokens/i.test((await api("GET", `/api/screen?id=${id}&view=terminal`)).json.text || ""), 20));
    if (!ok["a Controls command"]) showScreen(20);
    await sleep(1500);
    await api("POST", "/api/key", { id, key: "esc" });
    await sleep(800);

    await waitReady(id, 20);
    await api("POST", "/api/send", { id, text: "/exit" });
    const gone = await until("ended, gone from the list", async () => !(await session()), 30);
    ok["gone at the end"] = !!gone;
    const late = await api("POST", "/api/send", { id, text: "typed after the end" });
    say("   a send after the end:", late.status, late.json.error);
    await sleep(500);
    const leftover = fs.existsSync(after) ? fs.readFileSync(after, "utf8") : "";
    ok["nothing reached the pane after Claude"] = late.status >= 400 && leftover === "" && tmux("list-panes", "-F", "#{pane_id}").trim() === pane;
  } catch (err) {
    say("error:", err.message);
  } finally {
    try { tmux("kill-server"); } catch {}
    app.server.close();
    service.close();
    fs.rmSync(data, { recursive: true, force: true });
    console.log();
    for (const [k, v] of Object.entries(ok)) console.log((v ? "PASS " : "FAIL ") + k);
    process.exit(Object.keys(ok).length && Object.values(ok).every(Boolean) ? 0 : 1);
  }
})();

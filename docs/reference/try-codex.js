"use strict";
// Try Codex end to end: a real, throwaway Codex session with the hooks setup
// installs, driven through the phone API.
//
// Everything is its own: a throwaway CODEX_HOME holding only hooks.json (written
// by the same functions setup uses), a config.toml that trusts one temp work
// folder and picks a small model, and a copy of the login; a throwaway Airpocket
// (service, hook endpoint, phone server); a tmux server on a private socket.
// Nothing reads or writes ~/.codex except to copy auth.json and
// models_cache.json, and the real hooks.json, config.toml and auth.json are
// checked unchanged at the end.
//
//   hooks need review -> trusted in Codex's own prompt; the session appears
//   with the tmux bridge (SessionStart); a prompt from the phone -> working
//   (UserPromptSubmit) -> finished, with the reply (Stop); a command that needs
//   approval -> needs permission (PermissionRequest), denied from the phone;
//   Esc from the phone mid-turn -> idle (Interrupt); /exit -> gone (SessionEnd).
//
//   node docs/reference/try-codex.js [--no-model] [path to codex]
//
// The login. A ChatGPT login refreshes its tokens when the last refresh is about
// eight days old, and a refresh replaces the refresh token: a copy that
// refreshed would leave ~/.codex/auth.json holding a used one, which signs you
// out. So the trial copies the login only when ~/.codex/auth.json was refreshed
// less than seven days ago, and otherwise stops and says so (start Codex once,
// normally, then run the trial). An API-key login has no such problem.
//
// --no-model runs without any login (a made-up API key): it proves the hooks
// are installed, trusted and fire (SessionStart, UserPromptSubmit, SessionEnd),
// but no reply, permission or interrupt, since no model ever answers.
//
// Codex starts its thread with the first prompt, and only then runs
// SessionStart: a Codex session reaches the phone once something was typed in
// it. The trial types that first prompt at the terminal, as a user would.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const { createServer } = require("../../src/server");
const { createService } = require("../../src/service");
const { createStore } = require("../../src/store");
const { findTmux } = require("../../src/bridges");
const cfg = require("../../src/agentconfig");
const { codexUntrusted } = require("../../src/doctor");

const REPO = path.resolve(__dirname, "..", "..");
const NO_MODEL = process.argv.includes("--no-model");
const REAL_HOME = path.join(os.homedir(), ".codex");
const realCodex = () => {
  const given = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (given) return given;
  for (const p of [path.join(os.homedir(), ".local", "bin", "codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) {
    try { return fs.realpathSync(p); } catch {}
  }
  return "";
};
const CODEX = realCodex();
const TMUX = findTmux();
if (!TMUX) { console.error("tmux isn't installed"); process.exit(1); }
if (!CODEX) { console.error("codex isn't installed"); process.exit(1); }

const REAL = ["hooks.json", "config.toml", "auth.json"].map((n) => path.join(REAL_HOME, n));
const mtimes = () => REAL.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } });
const realBefore = mtimes();

// The login, if copying it is safe.
let authMode = "none";
if (!NO_MODEL) {
  let auth = null;
  try { auth = JSON.parse(fs.readFileSync(path.join(REAL_HOME, "auth.json"), "utf8")); } catch {}
  if (!auth) { console.error("No Codex login in ~/.codex/auth.json. Sign in to Codex, or run with --no-model."); process.exit(2); }
  if (auth.OPENAI_API_KEY) authMode = "api key";
  else {
    const age = (Date.now() - Date.parse(auth.last_refresh || 0)) / 86400000;
    if (!(age < 7)) {
      console.error(`Codex's login was last refreshed ${age.toFixed(1)} days ago, so a copy would refresh it now and sign ~/.codex out.`);
      console.error("Start Codex once the usual way (that refreshes it), then run this trial again. Or run with --no-model.");
      process.exit(2);
    }
    authMode = "chatgpt";
  }
}

const tmp = fs.realpathSync(fs.mkdtempSync("/tmp/airpocket-try-codex-"));
const data = path.join(tmp, "data"), codexHome = path.join(tmp, "codex"), work = path.join(tmp, "work"), sock = path.join(tmp, "tmux.sock");
for (const d of [data, codexHome, work]) fs.mkdirSync(d, { mode: 0o700 });
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const paneEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SUPERSET_|CLAUDE|CODEX_|TMUX|OPENAI_)/.test(k)));
paneEnv.LANG = paneEnv.LANG || "en_US.UTF-8";
paneEnv.CODEX_HOME = codexHome;
const tmux = (...args) => execFileSync(TMUX, ["-u", "-S", sock, ...args], { env: paneEnv, encoding: "utf8" });
const screenText = () => { try { return tmux("capture-pane", "-p"); } catch { return ""; } };
const showScreen = (n = 12) => { for (const l of screenText().trimEnd().split("\n").filter((x) => x.trim()).slice(-n)) say("   |", l); };

const store = createStore(data);
const service = createService({ dir: data });
const app = createServer({ store, service, log: () => {}, codexHome,
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
    await sleep(500);
  }
}
const session = async () => ((await api("GET", "/api/sessions")).json.sessions || []).find((s) => s.agent === "codex") || null;
const chat = async (id) => (await api("GET", "/api/screen?id=" + id)).json;
const replies = (d) => (d.items || []).filter((it) => it.type === "agent").map((it) => String(it.text || "").trim().toLowerCase());
const record = (sid) => { try { return JSON.parse(fs.readFileSync(path.join(data, "sessions", sid + ".json"), "utf8")); } catch { return null; } };

(async () => {
  const ok = {};
  try {
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${app.server.address().port}`;
    await new Promise((r) => service.listen(0, r));
    const { code } = store.newCode();
    token = (await (await fetch(base + "/api/pair", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "try-codex" }) })).json()).token;

    // The hooks, as setup writes them (only the data folder differs: this trial's).
    let command = cfg.hookCommand({ node: process.execPath, hook: path.join(REPO, "src", "hook.js"), agent: "codex", dataDir: data });
    // AIRPOCKET_TRIAL_TAP=<file>: keep a copy of every event Codex hands the hook (for debugging the trial itself).
    if (process.env.AIRPOCKET_TRIAL_TAP) command = `tee -a ${q(process.env.AIRPOCKET_TRIAL_TAP)} | ${command}`;
    const hooksFile = path.join(codexHome, "hooks.json");
    fs.writeFileSync(hooksFile, cfg.serialize(cfg.addHooks({}, "codex", command).config, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(codexHome, "config.toml"),
      `model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\ncheck_for_update_on_startup = false\n\n[projects.${JSON.stringify(work)}]\ntrust_level = "trusted"\n`, { mode: 0o600 });
    try { fs.copyFileSync(path.join(REAL_HOME, "models_cache.json"), path.join(codexHome, "models_cache.json")); } catch {}
    if (authMode === "none") {
      const r = spawnSync(CODEX, ["login", "--with-api-key"], { input: "sk-airpocket-trial-not-a-key", env: paneEnv, encoding: "utf8" });
      if (r.status !== 0) throw new Error("codex login --with-api-key failed: " + r.stderr);
    } else {
      fs.copyFileSync(path.join(REAL_HOME, "auth.json"), path.join(codexHome, "auth.json"));
      fs.chmodSync(path.join(codexHome, "auth.json"), 0o600);
    }
    execFileSync("git", ["init", "-q"], { cwd: work });
    fs.writeFileSync(path.join(work, "README.md"), "A throwaway folder for Airpocket's Codex trial.\n");
    say(`codex ${spawnSync(CODEX, ["--version"], { encoding: "utf8" }).stdout.trim()}, login: ${authMode === "none" ? "none (--no-model)" : authMode}`);

    tmux("-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "40", "-c", work, "/bin/sh", "-c", `${q(CODEX)}; exec /bin/cat > /dev/null`);

    // Codex's own review of new hooks, answered at the Mac: that is where the user trusts them.
    const review = await until("Codex asks to review the new hooks", () => /Hooks need review/.test(screenText()) && /6 hooks are new/.test(screenText()), 30);
    ok["Codex lists Airpocket's 6 hooks for review"] = !!review;
    if (!review) { showScreen(); return; }
    tmux("send-keys", "-t", ":", "2");
    await sleep(300);
    tmux("send-keys", "-t", ":", "Enter");
    const trusted = await until("trusted: config.toml has all six", () => { try { return codexUntrusted(null, hooksFile, cfg.hookState(JSON.parse(fs.readFileSync(hooksFile, "utf8")), "codex")).length === 0; } catch { return false; } }, 15);
    ok["Trust all: doctor reads them as trusted"] = !!trusted;
    await sleep(2000);
    const warnings = screenText().split("\n").filter((l) => /hook/i.test(l) && /⚠|warn|clamp|error/i.test(l));
    ok["no hook warnings on screen"] = warnings.length === 0;
    if (warnings.length) for (const w of warnings) say("   |", w.trim());

    // Codex starts its thread, and fires SessionStart, with the first prompt: before that the phone can't know of it.
    const early = await until("nothing on the list before the first prompt", async () => !(await session()), 1);
    await sleep(5000);
    ok["before the first prompt there is no session yet"] = !!early && !(await session()) && !fs.readdirSync(path.join(data, "sessions")).length;
    // The first prompt, typed at the Mac.
    tmux("send-keys", "-t", ":", "-l", "Reply with just the word hello.");
    await sleep(400);
    tmux("send-keys", "-t", ":", "Enter");
    const s = await until("SessionStart: on the list, with the tmux bridge", async () => { const x = await session(); return x && x.can.bridge === "tmux" ? x : null; }, 30);
    ok["SessionStart (with the first prompt): the session appears, with the tmux bridge"] = !!s;
    if (!s) { showScreen(); return; }
    const id = s.id;
    const rec = record(id);
    say("   record:", JSON.stringify({ agent: rec.agent, title: rec.title, pane: rec.pane, transcript: rec.transcript ? path.basename(rec.transcript) : "", pid: rec.pid }));
    ok["the record names the pane, the socket and a pid"] = !!(rec.pane && rec.tmux === sock && rec.pid);

    if (NO_MODEL) {
      await sleep(3000);
      showScreen(6);
      await api("POST", "/api/send", { id, text: "Reply with just the word pong." });
      // Without a login the first turn retries for about 25 s; Codex holds the phone's prompt until it gives up.
      ok["UserPromptSubmit: the phone's prompt is recorded"] = !!(await until("the note holds the prompt", () => /pong/.test((record(id) || {}).note || ""), 60));
      await sleep(3000);
      showScreen(6);
    } else {
      // A reply.
      let r = await api("POST", "/api/send", { id, text: "Reply with just the word pong." });
      ok["send is accepted"] = r.status === 200;
      ok["UserPromptSubmit: working"] = !!(await until("working", async () => { const x = await session(); return x && x.status && x.status.state === "working"; }, 20));
      ok["Stop: finished, waiting for you, with the reply"] = !!(await until("finished, with pong", async () => {
        const x = await session();
        return x && x.waiting && x.reason === "finished" && replies(await chat(id)).some((t) => t.includes("pong"));
      }, 120));

      // A command that needs approval: denied from the phone.
      await until("idle", async () => { const x = await session(); return x && x.status && x.status.state === "idle"; }, 30);
      r = await api("POST", "/api/send", { id, text: "Run exactly this shell command, with network access, and tell me the first line it prints: curl -sI https://example.com" });
      const asked = await until("PermissionRequest: needs permission", async () => { const x = await session(); return x && x.waiting && x.reason === "needs permission" ? x : null; }, 120);
      ok["PermissionRequest: needs permission on the list"] = !!asked;
      if (asked) {
        say("   note:", asked.note);
        showScreen(10);
        await api("POST", "/api/key", { id, key: "esc" });
        ok["answered from the phone: no longer waiting for permission"] = !!(await until("the question is gone", async () => { const x = await session(); return x && x.reason !== "needs permission"; }, 60));
      } else showScreen(10);

      // Esc mid-turn.
      await until("idle", async () => { const x = await session(); return x && x.status && x.status.state === "idle" && !(await chat(id)).live?.menu; }, 60);
      await api("POST", "/api/send", { id, text: "Write the numbers from 1 to 400, one per line, as plain text, and nothing else." });
      const busy = await until("working on the long turn", async () => { const x = await session(); return x && x.status && x.status.state === "working"; }, 30);
      await sleep(2500);
      await api("POST", "/api/key", { id, key: "esc" });
      ok["Interrupt: Esc from the phone ends the turn"] = !!busy && !!(await until("Interrupt: idle, turn ended", async () => {
        const x = await session(); const rr = record(id);
        return x && rr && rr.working_since === 0 && x.status && x.status.state === "idle";
      }, 45));
    }

    await sleep(1000);
    await api("POST", "/api/send", { id, text: "/exit" });
    ok["SessionEnd: gone from the list"] = !!(await until("ended, gone", async () => !(await session()), 30));
    if (!ok["SessionEnd: gone from the list"]) showScreen();
  } catch (err) {
    say("error:", err.stack || err.message);
  } finally {
    try { tmux("kill-server"); } catch {}
    app.server.close();
    service.close();
    fs.rmSync(tmp, { recursive: true, force: true });              // the copied login goes with it
    ok["~/.codex/hooks.json, config.toml and auth.json untouched"] = JSON.stringify(mtimes()) === JSON.stringify(realBefore);
    console.log();
    for (const [k, v] of Object.entries(ok)) console.log((v ? "PASS " : "FAIL ") + k);
    process.exit(Object.keys(ok).length && Object.values(ok).every(Boolean) ? 0 : 1);
  }
})();

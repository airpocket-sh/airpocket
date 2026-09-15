"use strict";
// Try step 8 end to end with a real, throwaway Claude Code session: model,
// effort, mode and status from what Claude records itself, with and without a
// screen to read.
//
// Same setup as try-tmux.js: a throwaway Airpocket from a temp folder, Claude
// in a tmux server on a private socket there (never the user's own tmux), only
// the trial's hook (--setting-sources project), the repo folder, and everything
// typed through the phone's API. A second phone server sees the same sessions
// without their tmux pane, so there they are read-only, like a session in a
// terminal Airpocket can't reach:
//
//   after a reply, the model and effort come from the transcript, on both;
//   Shift+Tab (does the transcript hear of it, and what the phone shows);
//   read-only: "working" while a turn runs and "idle" after, from the hooks, and
//   the new mode once the next prompt is recorded; /exit -> gone.
//
//   node docs/reference/try-info.js [path to claude]
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

const data = fs.mkdtempSync(path.join(os.tmpdir(), "airpocket-try-info-"));
const sock = path.join(data, "tmux.sock");
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const paneEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SUPERSET_|CLAUDE|CODEX_|TMUX)/.test(k)));
paneEnv.LANG = paneEnv.LANG || "en_US.UTF-8";
const tmux = (...args) => execFileSync(TMUX, ["-u", "-S", sock, ...args], { env: paneEnv, encoding: "utf8" });

const store = createStore(data);
const service = createService({ dir: data });
const noSuperset = { superset: async () => { throw new Error("Superset isn't part of this trial"); }, hasSuperset: () => false };
const app = createServer({ store, service, log: () => {}, ...noSuperset });
// The same sessions with no terminal on record: read-only.
const blind = createServer({ store, log: () => {}, ...noSuperset, isLive: service.isLive, getQueue: service.getQueue, dequeue: service.dequeue,
  knownSessions: () => service.knownSessions().map((r) => ({ ...r, pane: "", tmux: "", tmux_pid: 0, terminal: "", workspace: "" })) });
let token = "";
const at = { app: "", blind: "" };
async function api(which, method, p, body) {
  const res = await fetch(at[which] + p, { method, headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
                                           body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function until(what, fn, secs) {
  const end = Date.now() + secs * 1000;
  for (;;) {
    const v = await fn();
    if (v) { say(what); return v; }
    if (Date.now() > end) { say("TIMED OUT:", what); return null; }
    await sleep(300);
  }
}
const screen = async (which, id) => (await api(which, "GET", "/api/screen?id=" + id)).json;
const replies = (d) => (d.items || []).filter((it) => it.type === "agent").map((it) => it.text.trim().toLowerCase());
const ready = async (id) => { const d = await screen("app", id); return d.live && d.live.state === "idle" && !d.live.menu && !d.live.staged ? d : null; };
const show = (label, d) => say(`   ${label}:`, JSON.stringify(d.info || null), "live:", d.live ? d.live.state + (d.live.elapsed ? " " + d.live.elapsed : "") : null);
const count = (file, re) => { try { return fs.readFileSync(file, "utf8").split("\n").filter((l) => re.test(l)).length; } catch { return -1; } };
const showScreen = (label, n = 10) => { say(`   ${label}:`); for (const l of tmux("capture-pane", "-p").trimEnd().split("\n").slice(-n)) say("   |", l); };

// The user's own Claude settings must come out of this untouched.
const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const mtime = () => { try { return fs.statSync(SETTINGS).mtimeMs; } catch { return 0; } };
const settingsBefore = mtime();

(async () => {
  const ok = {};
  try {
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    await new Promise((r) => blind.server.listen(0, "127.0.0.1", r));
    at.app = `http://127.0.0.1:${app.server.address().port}`;
    at.blind = `http://127.0.0.1:${blind.server.address().port}`;
    await new Promise((r) => service.listen(0, r));
    token = (await (await fetch(at.app + "/api/pair", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: store.newCode().code, name: "try-info" }) })).json()).token;

    const hook = `AIRPOCKET_DIR=${q(data)} ${q(process.execPath)} ${q(path.join(REPO, "src", "hook.js"))} claude`;
    const events = ["SessionStart", "UserPromptSubmit", "Stop", "Notification", "SessionEnd"];
    const settings = { remoteControlAtStartup: false,
      hooks: Object.fromEntries(events.map((e) => [e, [{ hooks: [{ type: "command", command: hook, timeout: 5 }] }]])) };
    const claude = [CLAUDE, "--setting-sources", "project", "--settings", JSON.stringify(settings), "--model", "sonnet"].map(q).join(" ");
    tmux("-f", "/dev/null", "new-session", "-d", "-x", "120", "-y", "40", "-c", REPO, "/bin/sh", "-c", `${claude}; exec /bin/cat > /dev/null`);

    const s = await until("started, on the list", async () => {
      const x = ((await api("app", "GET", "/api/sessions")).json.sessions || [])[0];
      return x && x.can.send ? x : null;
    }, 40);
    if (!s) return;
    const id = s.id;
    const transcript = () => (service.knownSessions()[0] || {}).transcript || "";
    await until("an empty prompt box", () => ready(id), 30);
    show("before any reply (screen)", await screen("app", id));

    await api("app", "POST", "/api/send", { id, text: "Reply with just the word pong." });
    await until("a reply: pong", async () => replies(await screen("app", id)).some((t) => t.includes("pong")), 90);
    let d = await screen("app", id), b = await screen("blind", id);
    show("with a screen", d); show("read-only", b);
    ok["model and effort from the transcript, read-only too"] = !!(b.info && /^Sonnet \d/.test(b.info.name) && b.info.effort && b.info.model === d.info.model);

    // /effort and /model are never typed here, not even without Enter: Claude saves
    // them as the default for new sessions in the user's own settings
    // (~/.claude/settings.json), whatever --setting-sources says. The transcript
    // records them at once ("Set effort level to low (saved as your default for new
    // sessions): …"); the tests cover reading that.
    await until("an empty prompt box", () => ready(id), 30);

    const modeOnScreen = () => { const m = /⏵⏵\s*(.+?)\s+on\b|⏸\s*(plan mode)\s+on\b/.exec(tmux("capture-pane", "-p")); return m ? m[1] || m[2] : "default"; };
    const modesBefore = count(transcript(), /"type":"permission-mode"/);
    const modeBefore = modeOnScreen();
    await api("app", "POST", "/api/key", { id, key: "stab" });
    await sleep(2000);
    d = await screen("app", id); b = await screen("blind", id);
    const modeNow = modeOnScreen();
    say(`   Shift+Tab: the screen went "${modeBefore}" -> "${modeNow}"; the phone with a screen says "${d.info.mode}", read-only "${b.info.mode || ""}";` +
        ` permission-mode entries in the transcript ${modesBefore} -> ${count(transcript(), /"type":"permission-mode"/)}`);
    ok["Shift+Tab: the phone with a screen shows the screen's new mode"] = modeNow !== modeBefore && d.info.mode === modeNow;

    if (!(await until("an empty prompt box", () => ready(id), 20))) { showScreen("the box isn't empty: stopping"); return; }
    await api("app", "POST", "/api/send", { id, text: "Write about 250 words on why clouds float. No tools." });
    const w = await until("read-only: working, from the hooks", async () => { const x = await screen("blind", id); return x.live && x.live.state === "working" ? x : null; }, 20);
    if (w) show("read-only mid-turn", w);
    ok["read-only: working while a turn runs"] = !!w;
    const idle = await until("read-only: idle after the reply", async () => { const x = await screen("blind", id); return x.live && x.live.state === "idle" ? x : null; }, 120);
    ok["read-only: idle when it finishes"] = !!idle;
    b = await screen("blind", id);
    show("read-only after the turn", b);
    say(`   permission-mode entries now ${count(transcript(), /"type":"permission-mode"/)}`);
    ok["read-only: the mode after the next prompt"] = !!(b.info && b.info.mode === (await screen("app", id)).info.mode);

    if (!(await until("an empty prompt box", () => ready(id), 20))) { showScreen("the box isn't empty: not typing /exit"); return; }
    await api("app", "POST", "/api/send", { id, text: "/exit" });
    ok["gone at the end"] = !!(await until("gone from the list", async () => !((await api("app", "GET", "/api/sessions")).json.sessions || []).length, 30));
  } catch (err) {
    say("error:", err.message);
  } finally {
    try { tmux("kill-server"); } catch {}
    app.server.close(); blind.server.close(); service.close();
    fs.rmSync(data, { recursive: true, force: true });
    ok["the user's ~/.claude/settings.json is untouched"] = mtime() === settingsBefore;
    console.log();
    for (const [k, v] of Object.entries(ok)) console.log((v ? "PASS " : "FAIL ") + k);
    process.exit(Object.keys(ok).length && Object.values(ok).every(Boolean) ? 0 : 1);
  }
})();

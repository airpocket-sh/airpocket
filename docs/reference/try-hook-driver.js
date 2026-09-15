"use strict";
// A throwaway Airpocket for trying the hook with a real agent (see try-hook.py):
// its own data folder, loopback ports chosen by the system, a Superset that
// refuses everything, and no transcript folder to search, so a chat can only
// come from the path the hook reported. It pairs itself and prints, one JSON
// line each time it changes, what the phone would see, plus the record.
//
//   node docs/reference/try-hook-driver.js <data folder>
const path = require("path");
const http = require("http");
const { start } = require("../../src/server");

const dir = process.argv[2];
const t0 = Date.now();
const note = (...a) => process.stderr.write(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${a.join(" ")}\n`);
const quietApi = /^(GET|POST) \/api\//;                    // the polling below, every 300 ms
const app = start({ dataDir: dir, port: 0, filePort: 0, hookPort: 0, log: (...a) => { if (!quietApi.test(a.join(" "))) note("airpocket:", ...a); },
  superset: async () => { throw new Error("no Superset in this trial"); },
  claudeProjects: path.join(dir, "no-projects"), codexHome: path.join(dir, "no-codex") });
// Each hook call as it lands: the event and the answer, never the body.
app.service.hookServer.on("request", (req, res) => res.on("finish", () => note("hook", req.url, res.statusCode)));

const get = (p, body, token) => new Promise((resolve, reject) => {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const r = http.request(`http://127.0.0.1:${app.server.address().port}${p}`, { method: data ? "POST" : "GET",
    headers: { ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}), ...(token ? { Authorization: "Bearer " + token } : {}) } },
  (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
  r.on("error", reject);
  r.end(data);
});

app.server.once("listening", async () => {
  const { token } = await get("/api/pair", { code: app.deps.store.newCode().code });
  let last = "";
  setInterval(async () => {
    try {
      const sessions = ((await get("/api/sessions", null, token)) || {}).sessions || [];
      const out = [];
      for (const s of sessions) {
        const rec = app.deps.knownSessions().find((r) => r.session_id === s.id) || {};
        const chat = await get("/api/screen?id=" + s.id, null, token);
        const said = ((chat && chat.items) || []).filter((it) => it.type === "agent").map((it) => it.text);
        out.push({ phone: { id: s.id, title: s.title, account: s.account, branch: s.branch, live: s.live, waiting: s.waiting, kind: s.kind, reason: s.reason, note: s.note },
          record: { pid: rec.pid, started: rec.started, transcript: rec.transcript, terminal: rec.terminal, pane: rec.pane },
          chat: { kind: chat && chat.kind, items: ((chat && chat.items) || []).length, lastReply: said[said.length - 1] || "" } });
      }
      const line = JSON.stringify(out);
      if (line !== last) { last = line; process.stdout.write(JSON.stringify({ at: Date.now(), sessions: out }) + "\n"); }
    } catch {}
  }, 300);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { app.service.release(); process.exit(0); });

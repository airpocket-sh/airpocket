"use strict";
// Stand-ins for the background service, until build step 5 replaces them.
//
// The server reaches what it does not own through three seams, passed to
// createServer() as options (the tests pass their own):
//
//   knownSessions()  session records written by the hooks: session_id, cwd,
//                    title, agent, account, pid, last_seen, bridge_id, and the
//                    Superset terminal and workspace ids when there are some
//   getQueue()       the waiting list: [{ id, sid, kind, reason, message }]
//   service(method, path, body) -> { status, json, text }
//                    GET  /codex/thread?id=<thread>        a Codex thread and what it waits on
//                    POST /codex/turn   { threadId, text }
//                    POST /codex/answer { id, result }
//                    GET  /dequeue?id=<id>&sid=<session>   take one off the waiting list
//
// The defaults here read records and the waiting list from Airpocket's own data
// folder (nothing writes them until steps 5 and 6), and answer every service
// call with 503, which the server already reads as "not available". None of
// them talks to another program.
const fs = require("fs");
const path = require("path");

const DAY = 24 * 3600;

/** Hook-written session records from the last day, newest first. */
function fileSessions(dir) {
  const cutoff = Date.now() / 1000 - DAY;
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    try { const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); if (e && e.last_seen >= cutoff) out.push(e); } catch {}
  }
  return out.sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
}

/** The waiting list, from { queue: [...] }. */
function fileQueue(file) {
  try { const d = JSON.parse(fs.readFileSync(file, "utf8")); return Array.isArray(d.queue) ? d.queue : []; }
  catch { return []; }
}

/** No service yet: every call is "not available". */
const noService = async () => ({ status: 503, json: null, text: "The Airpocket service isn't running." });

module.exports = { fileSessions, fileQueue, noService };

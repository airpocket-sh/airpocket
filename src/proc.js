"use strict";
// Which process is which. A pid alone can't say whether a session is still
// there: macOS hands a free pid to the next program, so a dead session's pid
// may belong to something else by now. A pid plus the time that process
// started names one process for good. The hooks record both, and so does
// airpocket.lock.
const { execFileSync } = require("child_process");

const PS = "/bin/ps";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// ps -o lstart in the C locale: "Tue Sep 15 20:04:54 2026", local time.
const LSTART = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/;
// A command that runs another one rather than being the agent: the hook's
// parent may be the shell that ran it.
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "tcsh", "csh", "env"]);

const pidOf = (v) => (Number.isSafeInteger(v) && v > 1 ? v : 0);

/** Seconds since 1970 for a ps lstart, or 0. */
function parseLstart(s) {
  const m = LSTART.exec(String(s).trim());
  const mon = m ? MONTHS.indexOf(m[1]) : -1;
  if (mon < 0) return 0;
  const t = new Date(+m[6], mon, +m[2], +m[3], +m[4], +m[5]).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

function ps(pids, fields) {
  try {
    return execFileSync(PS, ["-o", fields, "-p", pids.join(",")], {
      encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
  } catch (err) {
    return typeof err.stdout === "string" ? err.stdout : "";      // ps exits 1 when some pid is gone
  }
}

/** When each of these processes started, in seconds; a gone one is left out. One ps call for all. */
function startTimes(pids) {
  const out = new Map();
  const list = [...new Set(pids.map(pidOf).filter(Boolean))];
  if (!list.length) return out;
  for (const line of ps(list, "pid=,lstart=").split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    const t = m ? parseLstart(m[2]) : 0;
    if (t) out.set(Number(m[1]), t);
  }
  return out;
}
const startTimeOf = (pid) => startTimes([pid]).get(pidOf(pid)) || 0;

/** Is there a process with this pid? (Someone else's counts: it exists.) */
function pidExists(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
}

/**
 * Is this the same process that was recorded? Without a pid there is nothing to
 * check, so yes. A pid that exists is that process unless its start time was
 * read and differs: then the pid was reused. A start time that couldn't be read
 * (ps failed or timed out) proves nothing, so the answer stays yes; a session
 * is only ever dropped on real evidence. `startOf(pid)` reads a start time, 0
 * when it can't; the service passes one backed by a batched, cached ps call.
 */
function processAlive(pid, started, startOf = startTimeOf) {
  if (!pid) return true;
  if (!pidExists(pid)) return false;
  if (!started) return true;
  const t = startOf(pid);
  return !t || t === started;
}

/**
 * Stricter than processAlive, for typing into a terminal: yes only when the pid
 * exists and its start time was read and matches the one recorded. No pid, no
 * recorded start time, or a ps that can't answer: no. When an agent exits, its
 * terminal falls back to a shell, and a guess here would type into that shell.
 */
function stillRunning(pid, started, startOf = startTimeOf) {
  const p = pidOf(pid);
  if (!p || !(Number.isSafeInteger(started) && started > 0) || !pidExists(p)) return false;
  return startOf(p) === started;
}

/**
 * The agent a hook runs for: its parent, or the first parent that isn't a
 * shell (Claude Code and Codex run hooks through one). { pid, started }, or
 * zeros when it can't be told.
 */
function agentProcess(ppid = process.ppid) {
  let pid = pidOf(ppid);
  for (let i = 0; pid && i < 4; i++) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d{4})\s+(.+)$/.exec(ps([pid], "pid=,ppid=,lstart=,comm=").split("\n")[0] || "");
    if (!m) break;
    const name = m[4].trim().split("/").pop().replace(/^-/, "");
    const parent = pidOf(Number(m[2]));
    if (SHELLS.has(name) && parent) { pid = parent; continue; }
    return { pid, started: parseLstart(m[3]) };
  }
  return { pid: 0, started: 0 };
}

module.exports = { parseLstart, startTimes, startTimeOf, pidExists, processAlive, stillRunning, agentProcess, pidOf };

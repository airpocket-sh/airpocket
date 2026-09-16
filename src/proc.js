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

// An agent's executable, as ps names it: .../claude or .../codex, or the
// versioned file Claude Code's installer links `claude` to. Claude Code run
// through npm is `node` to ps and isn't counted: its arguments are never read.
const AGENT_EXEC = /(?:^|\/)(claude|codex)$|\/claude\/versions\/[\w.+-]+$/;
const agentOfExec = (comm) => { const m = AGENT_EXEC.exec(comm); return m ? m[1] || "claude" : ""; };
const SCAN_FIELDS = "pid=,ppid=,uid=,tdev=,lstart=,comm=";
const SCAN_LINES = 20000;           // ps -A on a busy Mac is under a thousand
const SCAN_AGENTS = 200;

/**
 * Every process, from one ps call: when each started (as startTimes gives it),
 * and the Claude Code and Codex processes of this user that run in a terminal,
 * as [{ pid, started, agent }]. One started by another agent (a tool that runs
 * codex, say) is part of that agent's session and left out. Only the pid, parent,
 * user, terminal device ("16/2", or "??" for none; its name costs a lookup per
 * process), start time and executable are read, never the arguments.
 */
function scanProcesses(uid = process.getuid()) {
  let out = "";
  try {
    out = execFileSync(PS, ["-A", "-o", SCAN_FIELDS], {
      encoding: "utf8", timeout: 2000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
  } catch {}
  return parseProcesses(out, uid);
}

/** scanProcesses from ps's output. */
function parseProcesses(out, uid) {
  const starts = new Map(), rows = [];
  const lines = String(out).split("\n", SCAN_LINES);
  const parent = new Map(), named = new Set();
  for (const line of lines) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d{4})\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]), started = parseLstart(m[5]);
    if (started) starts.set(pid, started);
    parent.set(pid, Number(m[2]));
    const agent = agentOfExec(m[6].trim());
    if (!agent) continue;
    named.add(pid);
    if (Number(m[3]) === uid && /^\d+\/\d+$/.test(m[4]) && started) rows.push({ pid, started, agent });
  }
  const underAgent = (pid) => {
    for (let p = parent.get(pid), i = 0; p > 1 && i < 32; p = parent.get(p), i++) if (named.has(p)) return true;
    return false;
  };
  return { starts, agents: rows.filter((r) => !underAgent(r.pid)).slice(0, SCAN_AGENTS) };
}

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
 * A process as typing into its terminal needs it, from one ps call: when it
 * started (seconds), its terminal ("ttys001", or "" when it has none), its
 * process group, and the process group that holds that terminal's foreground.
 * null when the pid is gone or ps can't tell.
 */
function processInfo(pid) {
  const p = pidOf(pid);
  if (!p) return null;
  const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(-?\d+)\s+(.+)$/.exec(ps([p], "pid=,tty=,pgid=,tpgid=,lstart=").split("\n")[0] || "");
  const started = m && Number(m[1]) === p ? parseLstart(m[5]) : 0;
  if (!started) return null;
  return { started, tty: /^[a-z0-9]{1,32}$/i.test(m[2]) ? m[2] : "", pgid: Number(m[3]), tpgid: Number(m[4]) };
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

/**
 * The agents no record names: a record matches by pid, and by start time when
 * both have one (a pid reused since is another process).
 */
function unrecordedAgents(agents, records) {
  const known = new Map(records.filter((r) => r && pidOf(r.pid)).map((r) => [r.pid, r.started || 0]));
  return agents.filter((a) => !(known.has(a.pid) && (!known.get(a.pid) || !a.started || known.get(a.pid) === a.started)));
}

/** How many of these agents are Claude Code and how many Codex: { claude, codex }. */
function byAgent(agents) {
  const out = { claude: 0, codex: 0 };
  for (const a of agents) if (a && Object.hasOwn(out, a.agent)) out[a.agent]++;
  return out;
}

module.exports = { parseLstart, startTimes, scanProcesses, parseProcesses, unrecordedAgents, byAgent, agentOfExec, startTimeOf, pidExists, processAlive, stillRunning, processInfo, agentProcess, pidOf };

"use strict";
// Own-terminal mode: `airpocket run claude|codex [args…]` and `airpocket attach [name]`.
//
// A session in Terminal, iTerm2, Warp, Ghostty or an editor's pane has no
// terminal Airpocket can type into, so the phone can only watch it. `run`
// starts the agent in a tmux session on Airpocket's own socket
// (<data folder>/tmux/sock, never your default tmux server or ~/.tmux.conf),
// with tmux.conf next to this file, and attaches this terminal to it. The
// agent's hook records the pane as it does for any tmux session, and the tmux
// bridge does the rest. Closing the window only detaches: the agent keeps
// running, the phone can still reach it, and `attach` brings it back.
//
// Where nesting would gain nothing, the agent starts directly instead:
//   - already inside tmux ($TMUX) or a Superset terminal, which a bridge reaches;
//   - not on a terminal (a pipe), or a command that prints and exits
//     (claude -p, codex exec, --version, mcp, …), which isn't a session.
//
// The agent gets this shell's environment, not the tmux server's (the server
// keeps the one it started with): a short start script, private and deleted as
// it runs, sets exactly this environment plus tmux's own TMUX, TMUX_PANE and
// TERM, then execs the agent, so the pane's process is the agent itself.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { dataDirFor } = require("./ports");
const { TMUX_BINS, tmuxSocket } = require("./bridges");
const { shellQuote } = require("./agentconfig");

const CONF = path.join(__dirname, "tmux.conf");
const SOCKET_MAX = 104;                        // macOS: sun_path, including the final NUL
const MIN_TMUX = [3, 2];                       // extended keys (Shift+Enter)
const AGENTS = Object.freeze(["claude", "codex"]);
const INSTALL_TMUX = "brew install tmux";

// Commands that print something and exit rather than open a session. Run
// through tmux, their output would vanish with the session.
const ONE_SHOT = Object.freeze({
  claude: { flags: ["-p", "--print", "-v", "--version", "-h", "--help", "--bg"],
    commands: ["agents", "attach", "auth", "auto-mode", "doctor", "gateway", "import", "install", "logs", "mcp", "plugin", "plugins",
      "project", "respawn", "rm", "setup-token", "stop", "kill", "ultrareview", "update", "upgrade"] },
  codex: { flags: ["-h", "--help", "-V", "--version"],
    commands: ["agents", "exec", "e", "review", "login", "logout", "mcp", "plugin", "app-server", "remote-control", "app", "completion",
      "update", "doctor", "sandbox", "debug", "apply", "a", "queue", "archive", "delete", "migrate-rollouts", "unarchive", "cloud",
      "exec-server", "features", "help"] },
});
// The terminal the agent sees is tmux, not the one outside it.
const FROM_TMUX = Object.freeze(["TMUX", "TMUX_PANE", "TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SESSION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Everything run and attach touch outside themselves. The tests replace parts of it. */
function context(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || env.HOME || os.homedir();
  const dataDir = dataDirFor(env, home);
  return {
    env, home, dataDir,
    socket: path.join(dataDir, "tmux", "sock"),
    conf: opts.conf || CONF,
    cwd: opts.cwd || process.cwd(),
    uid: opts.uid ?? process.getuid(),
    tty: opts.tty ?? (!!process.stdin.isTTY && !!process.stdout.isTTY),
    tmuxBins: opts.tmuxBins || TMUX_BINS,
    // A command whose output is read: { status, stdout, stderr }.
    run: opts.run || ((file, args) => {
      const r = spawnSync(file, args, { encoding: "utf8", timeout: 10000, env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" } });
      return { status: r.error ? -1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
    }),
    // A command on this terminal; resolves its exit code.
    spawn: opts.spawn || spawnInherit,
    alive: opts.alive || ((pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; } }),
    err: opts.err || ((line) => process.stderr.write(line + "\n")),
    out: opts.out || ((line = "") => process.stdout.write(line + "\n")),
    choose: opts.choose || chooseOnTerminal,
    now: opts.now || (() => new Date()),
  };
}

/**
 * Run a program on this terminal and resolve its exit code. Ctrl+C, Ctrl+\ and
 * Ctrl+Z are the program's: this process ignores them while it waits, so it
 * never quits and leaves the program behind.
 */
function spawnInherit(file, args, { env, cwd } = {}) {
  const ignore = () => {};
  const signals = ["SIGINT", "SIGQUIT", "SIGTSTP"];
  for (const s of signals) process.on(s, ignore);
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: "inherit", env, cwd });
    const done = (code) => { for (const s of signals) process.removeListener(s, ignore); resolve(code); };
    child.on("error", (e) => { process.stderr.write(`${file}: ${e.message}\n`); done(127); });
    child.on("exit", (code, signal) => done(code ?? (signal ? 128 + (os.constants.signals[signal] || 0) : 1)));
  });
}

/** A number from 1 to n typed on the terminal; 0 for anything else. */
function chooseOnTerminal(question, n) {
  return new Promise((resolve) => {
    const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); const i = Number(a.trim()); resolve(Number.isInteger(i) && i >= 1 && i <= n ? i : 0); });
  });
}

/** Where this shell runs, if a bridge already reaches it: "tmux", "Superset", or "". */
function reachableHere(env) {
  if (env.TMUX) return "tmux";
  if (env.SUPERSET_TERMINAL_ID && env.SUPERSET_WORKSPACE_ID) return "Superset";
  return "";
}

/** Does this command line print and exit, rather than open a session? */
function oneShot(agent, args) {
  const o = ONE_SHOT[agent];
  if (args.some((a) => o.flags.includes(a) || (agent === "claude" && (a.startsWith("--print=") || a.startsWith("-p="))))) return true;
  return args.length > 0 && o.commands.includes(args[0]);
}

/** The first executable called `name` on a PATH. */
function which(name, envPath) {
  for (const dir of String(envPath || "").split(":")) {
    if (!path.isAbsolute(dir)) continue;
    const p = path.join(dir, name);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return "";
}

/** tmux, and its version: { bin, version, ok }. bin is "" when not installed. */
function findTmux(ctx) {
  const bin = ctx.tmuxBins.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } }) || "";
  if (!bin) return { bin: "", version: "", ok: false };
  const r = ctx.run(bin, ["-V"]);
  const version = (/tmux\s+(\S+)/.exec(r.stdout || "") || [])[1] || "";
  return { bin, version, ok: versionAtLeast(version, MIN_TMUX) };
}
/** "3.6a" >= [3, 2]; "next-3.7" too. An unreadable version passes: tmux itself will say. */
function versionAtLeast(v, [maj, min]) {
  const m = /(\d+)\.(\d+)/.exec(String(v));
  if (!m) return true;
  return +m[1] > maj || (+m[1] === maj && +m[2] >= min);
}

const tmuxMissing = (what) => `tmux isn't installed, and ${what} needs it. Install it with: ${INSTALL_TMUX}`;

/**
 * Airpocket's tmux folder, ready to use: <data>/tmux, 0700, a real folder owned
 * by this user; a socket there must be a socket this user owns. Returns "" or
 * why it can't be used.
 */
function prepareFolder(ctx, create) {
  const dir = path.dirname(ctx.socket);
  const bytes = Buffer.byteLength(ctx.socket) + 1;
  if (bytes > SOCKET_MAX) return `Airpocket's tmux socket would be ${ctx.socket}, ${bytes} bytes, over macOS's ${SOCKET_MAX}. Use a shorter AIRPOCKET_DIR.`;
  if (create) {
    fs.mkdirSync(ctx.dataDir, { recursive: true, mode: 0o700 });
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  }
  let st;
  try { st = fs.lstatSync(dir); } catch { return create ? `Couldn't make ${dir}.` : ""; }
  if (!st.isDirectory() || st.uid !== ctx.uid) return `${dir} isn't a folder of yours. Airpocket won't use it.`;
  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
  if (fs.existsSync(ctx.socket) || isLink(ctx.socket)) {
    if (!tmuxSocket(ctx.socket, ctx.uid)) return `${ctx.socket} isn't a tmux socket of yours. Airpocket won't use it.`;
  }
  return "";
}
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

/**
 * The agents running on Airpocket's socket, one row per session:
 * { name, attached, pid, dead, cwd, created }. [] when no server runs there.
 */
function listSessions(ctx, bin) {
  if (!tmuxSocket(ctx.socket, ctx.uid)) return [];
  const r = ctx.run(bin, ["-u", "-S", ctx.socket, "list-sessions", "-F",
    "#{session_name}\t#{session_attached}\t#{pane_pid}\t#{pane_dead}\t#{session_created}\t#{pane_current_path}"]);
  if (r.status !== 0) return [];
  return String(r.stdout).split("\n").filter(Boolean).map((line) => {
    const [name, attached, pid, dead, created, ...cwd] = line.split("\t");
    const p = Number(pid) || 0;
    return { name, attached: Number(attached) || 0, pid: p, ended: dead === "1" || !p || !ctx.alive(p), created: Number(created) || 0, cwd: cwd.join("\t") };
  }).filter((s) => SESSION_NAME.test(s.name));
}

/** A tmux session name for an agent in a folder: claude-airpocket, then claude-airpocket-2, … */
function sessionName(agent, cwd, taken) {
  const base = `${agent}-${path.basename(cwd) || "root"}`.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/-+$/, "").slice(0, 40);
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * The start script: this shell's environment, tmux's own terminal variables,
 * then the agent. It deletes itself first, since the environment may hold keys.
 */
function startScript(file, env, agentPath, args) {
  const vars = Object.entries(env).filter(([k, v]) => ENV_NAME.test(k) && !FROM_TMUX.includes(k) && typeof v === "string" && !v.includes("\0"));
  return [
    `rm -f -- ${shellQuote(file)}`,
    "exec /usr/bin/env -i \\",
    ...FROM_TMUX.map((k) => `  "${k}=$${k}" \\`),
    ...vars.map(([k, v]) => `  ${shellQuote(`${k}=${v}`)} \\`),
    `  ${[agentPath, ...args].map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
}

/** airpocket run claude|codex [args…]. Resolves to an exit code. */
async function runAgent(ctx, argv) {
  const [agent, ...args] = argv;
  if (!AGENTS.includes(agent)) { ctx.err("Usage: airpocket run claude|codex [arguments for it…]"); return 2; }
  const agentPath = which(agent, ctx.env.PATH);
  if (!agentPath) { ctx.err(`${agent} isn't on your PATH.`); return 127; }

  const here = reachableHere(ctx.env);
  if (here || !ctx.tty || oneShot(agent, args)) {
    if (here && ctx.tty && !oneShot(agent, args)) ctx.err(`Already in ${here}, where Airpocket can reach it: starting ${agent} here.`);
    return ctx.spawn(agentPath, args, { env: ctx.env, cwd: ctx.cwd });
  }

  const tmux = findTmux(ctx);
  if (!tmux.bin) { ctx.err(tmuxMissing(`airpocket run`)); return 1; }
  if (!tmux.ok) { ctx.err(`tmux ${tmux.version} is too old for airpocket run (it needs ${MIN_TMUX.join(".")} or later). Update it with: brew upgrade tmux`); return 1; }
  const bad = prepareFolder(ctx, true);
  if (bad) { ctx.err(bad); return 1; }

  const name = sessionName(agent, ctx.cwd, listSessions(ctx, tmux.bin).map((s) => s.name));
  const script = path.join(path.dirname(ctx.socket), `start-${crypto.randomBytes(6).toString("hex")}.sh`);
  fs.writeFileSync(script, startScript(script, ctx.env, agentPath, args), { mode: 0o600, flag: "wx" });
  try {
    // -f counts only when this starts the server; -u: this terminal takes UTF-8.
    return await ctx.spawn(tmux.bin, ["-u", "-S", ctx.socket, "-f", ctx.conf, "new-session", "-s", name, "-c", ctx.cwd, "--", "/bin/sh", script],
      { env: ctx.env, cwd: ctx.cwd });
  } finally {
    try { fs.unlinkSync(script); } catch {}                // gone already once the agent started
  }
}

/** airpocket attach [name]. Resolves to an exit code. */
async function attach(ctx, argv) {
  const [wanted] = argv;
  const tmux = findTmux(ctx);
  if (!tmux.bin) { ctx.err(tmuxMissing("airpocket attach")); return 1; }
  const bad = prepareFolder(ctx, false);
  if (bad) { ctx.err(bad); return 1; }
  const all = listSessions(ctx, tmux.bin);
  const live = all.filter((s) => !s.ended);
  const go = (s) => {
    if (ctx.env.TMUX) { ctx.err(`This terminal is inside tmux already. Open a new window and run: airpocket attach ${s.name}`); return 1; }
    if (!ctx.tty) { ctx.err("airpocket attach needs a terminal."); return 1; }
    return ctx.spawn(tmux.bin, ["-u", "-S", ctx.socket, "attach-session", "-t", "=" + s.name], { env: ctx.env, cwd: ctx.cwd });
  };

  if (wanted) {
    const s = all.find((x) => x.name === wanted);
    if (s && !s.ended) return go(s);
    ctx.err(s ? `${wanted} has ended: its agent exited.` : `No agent called ${wanted} is running. It may have ended.${live.length ? " Running now: " + live.map((x) => x.name).join(", ") : ""}`);
    return 1;
  }
  if (!live.length) {
    ctx.err(all.length ? `The ${all.length === 1 ? "session" : "sessions"} started with airpocket run ${all.length === 1 ? "has" : "have"} ended.` : "No agents started with airpocket run are running.");
    return 1;
  }
  const detached = live.filter((s) => !s.attached);
  if (live.length === 1) return go(live[0]);
  if (detached.length === 1) return go(detached[0]);

  ctx.out("Agents started with airpocket run:");
  live.forEach((s, i) => ctx.out(`  ${i + 1}. ${describe(ctx, s)}`));
  if (!ctx.tty || ctx.env.TMUX) { ctx.out("Attach one with: airpocket attach <name>"); return 2; }
  const i = await ctx.choose(`Which one? [1-${live.length}] `, live.length);
  if (!i) { ctx.out("Nothing attached."); return 1; }
  return go(live[i - 1]);
}

function describe(ctx, s) {
  const home = ctx.home;
  const where = s.cwd && home && (s.cwd === home || s.cwd.startsWith(home + "/")) ? "~" + s.cwd.slice(home.length) : s.cwd;
  const started = s.created ? new Date(s.created * 1000) : null;
  const when = !started ? "" : started.toDateString() === ctx.now().toDateString()
    ? `started ${started.toTimeString().slice(0, 5)}` : `started ${started.toDateString().slice(4, 10)}`;
  return [s.name, where, when, s.attached ? "(open in another window)" : ""].filter(Boolean).join("   ");
}

module.exports = { context, runAgent, attach, reachableHere, oneShot, which, findTmux, versionAtLeast, listSessions, sessionName, startScript,
  prepareFolder, CONF, MIN_TMUX, INSTALL_TMUX, SOCKET_MAX, tmuxMissing };

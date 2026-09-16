"use strict";
// airpocket setup and airpocket uninstall.
//
// The one rule: what setup adds, uninstall removes, and nothing else is ever
// changed. Both work in two phases. First they look (read-only: files, launchd,
// Tailscale) and make a plan: problems that stop everything, and the steps they
// would take. `--dry-run` prints that plan and ends there. Only then do they
// act, one step at a time, recording what setup added in install.json in the
// data folder as it goes, so an uninstall after a setup that stopped half way
// still finds everything.
//
// Setup adds, in this order:
//   1. the data folder (0700), as the service makes it
//   2. a copy of Airpocket in <data>/app, which the hooks and the login item run
//      (npx's cache can disappear; this copy stays where setup put it)
//   3. hook entries in Claude Code's settings.json and Codex's hooks.json
//      (merged, backed up first; see agentconfig.js)
//   4. the login item, loaded and checked (see loginitem.js)
//   5. two `tailscale serve` addresses on ports nothing else uses
//   6. if you say so (asked, or --alias / --no-alias): aliases in your shell
//      profile so `claude` and `codex` start with `airpocket run` (see shellalias.js)
//   7. a pairing code, printed with its QR
//
// Everything outside is reached through `ctx` (home, env, run, probe, ...), so
// the tests run all of it against a temporary HOME with stand-in launchctl and
// Tailscale.
const fs = require("fs");
const os = require("os");
const net = require("net");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const cfg = require("./agentconfig");
const ts = require("./tailscale");
const li = require("./loginitem");
const { dataDirFor, portsFrom } = require("./ports");
const { processAlive } = require("./proc");
const { writeAtomic } = require("./service");
const { createStore } = require("./store");
const { TMUX_BINS } = require("./bridges");
const sa = require("./shellalias");
const own = require("./ownterm");
const QR = require("./public/qr");

const ROOT = path.join(__dirname, "..");
const SOCKET_MAX = 104;                // macOS: sun_path, including the final NUL
const COPY = ["package.json", "LICENSE", "README.md", "SECURITY.md", "src"];

const tilde = (p, home) => (home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p);
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const versionOf = (dir) => { const j = readJson(path.join(dir, "package.json")); return j && j.name === "airpocket" ? String(j.version || "") : ""; };
const majorOf = (v) => Number(String(v).replace(/^v/, "").split(".")[0]) || 0;

/**
 * Why a folder can't be Airpocket's data folder, or "": the home folder itself,
 * or anything that holds it (say AIRPOCKET_DIR=$HOME), would get its mode
 * changed by setup and could be deleted whole by uninstall --remove-data.
 */
function unsafeDataDir(dir, home) {
  if (!path.isAbsolute(dir)) return "is not an absolute path";
  const d = path.resolve(dir), h = path.resolve(home);
  if (d === path.parse(d).root) return "is the root folder";
  if (d === h || h.startsWith(d + path.sep)) return "is your home folder or holds it";
  return "";
}

/** What Airpocket keeps in its data folder. Anything else there means it isn't only Airpocket's. */
const OWN_ENTRY = /^(devices\.json|pairing\.json|hook\.json|queue\.json|install\.json|airpocket\.lock(\..+)?|sessions|logs|app(\.(new|old)-[0-9a-f]+)?|tmux|.+\.tmp)$/;

/** A command-line option: --name. */
const flag = (argv, name) => argv.includes("--" + name);

/** Everything setup, doctor and uninstall touch outside themselves. The tests replace parts of it. */
function context(opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || env.HOME || os.homedir();
  const ctx = {
    env, home,
    uid: opts.uid ?? process.getuid(),
    platform: opts.platform || process.platform,
    nodeVersion: opts.nodeVersion || process.versions.node,
    execPath: opts.execPath || process.execPath,
    run: opts.run || ts.runReal,
    alive: opts.alive || processAlive,
    now: opts.now || (() => new Date()),
    out: opts.out || ((line = "") => process.stdout.write(line + "\n")),
    ask: opts.ask || askTerminal,
    tty: opts.tty ?? !!process.stdin.isTTY,
    root: opts.root || ROOT,
    label: opts.label || li.LABEL,
    tailscaleBin: opts.tailscaleBin !== undefined ? opts.tailscaleBin : ts.tailscaleBin(),
    tmuxBins: opts.tmuxBins || TMUX_BINS,
    color: opts.color ?? (!!process.stdout.isTTY && !env.NO_COLOR),
    waitMs: opts.waitMs || 20000,
  };
  const dataDir = dataDirFor(env, home);
  ctx.paths = {
    dataDir,
    appDir: path.join(dataDir, "app"),
    logFile: path.join(dataDir, "logs", "service.log"),
    install: path.join(dataDir, "install.json"),
    lock: path.join(dataDir, "airpocket.lock"),
    hookFile: path.join(dataDir, "hook.json"),
    socket: path.join(dataDir, "tmux", "sock"),
    profile: sa.profileFor(env, home),
    plist: path.join(home, "Library", "LaunchAgents", ctx.label + ".plist"),
    ...cfg.configPaths(env, home),
  };
  ctx.ports = portsFrom(env);
  ctx.targets = { app: `http://127.0.0.1:${ctx.ports.app}`, file: `http://127.0.0.1:${ctx.ports.file}` };
  ctx.node = stableNode(ctx.execPath, env);
  ctx.t = (p) => tilde(p, home);
  return ctx;
}

/**
 * The node to write into the hooks and the login item: a path that survives an
 * upgrade (Homebrew's /opt/homebrew/bin/node rather than its versioned Cellar
 * folder) when one points at the node running now, else this node's own path.
 */
function stableNode(execPath, env) {
  let real;
  try { real = fs.realpathSync(execPath); } catch { return execPath; }
  const dirs = String(env.PATH || "").split(":").filter((d) => path.isAbsolute(d));
  for (const dir of [...dirs, "/opt/homebrew/bin", "/usr/local/bin"]) {
    const p = path.join(dir, "node");
    if (p.includes("/_npx/") || p.startsWith(os.tmpdir())) continue;
    try { if (fs.realpathSync(p) === real) return p; } catch {}
  }
  return execPath;
}

/** A yes/no question on the terminal; no is the default. */
function askTerminal(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question + " [y/N] ", (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
  });
}

/** Does something accept connections on 127.0.0.1:port? */
function listening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const end = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(1000, () => end(false));
    s.on("connect", () => end(true));
    s.on("error", () => end(false));
  });
}

/** One request to 127.0.0.1; resolves the status, or 0 (with `withBody`, { status, body }, the body up to 64 KB). */
function probe(port, pathname = "/", method = "GET", withBody = false) {
  return new Promise((resolve) => {
    const done = (status, body = "") => resolve(withBody ? { status, body } : status);
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, agent: false, timeout: 2000,
      headers: method === "POST" ? { "Content-Type": "application/json", "Content-Length": 2 } : {} }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => { size += c.length; if (size <= 65536) chunks.push(c); });
      res.on("end", () => done(res.statusCode, Buffer.concat(chunks).toString("utf8")));
      res.on("error", () => done(res.statusCode));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => done(0));
    req.end(method === "POST" ? "{}" : undefined);
  });
}

/** The data folder's lock: { pid, started, alive } or null. */
function readLock(ctx) {
  let text;
  try { text = fs.readFileSync(ctx.paths.lock, "utf8"); } catch { return null; }
  const m = /^(\d+)(?:\s+(\d+))?\s*$/.exec(text);
  if (!m) return { pid: 0, started: 0, alive: false };
  const pid = Number(m[1]), started = Number(m[2] || 0);
  return { pid, started, alive: pid > 1 && ctx.alive(pid, started) };
}

/** What install.json says setup did here (a fresh record when nothing). */
function readInstall(ctx) {
  const j = readJson(ctx.paths.install);
  return j && typeof j === "object" && !Array.isArray(j) ? { hooks: {}, ...j } : null;
}
function saveInstall(ctx, record) {
  fs.mkdirSync(ctx.paths.dataDir, { recursive: true, mode: 0o700 });
  writeAtomic(ctx.paths.install, JSON.stringify(record, null, 2) + "\n");
}

/** Look around, change nothing. */
async function survey(ctx) {
  const f = { ctx };
  f.mac = ctx.platform === "darwin";
  if (f.mac) {
    const r = ctx.run("/usr/bin/sw_vers", ["-productVersion"], { timeout: 5000 });
    f.macVersion = r.status === 0 ? r.stdout.trim() : "";
  }
  f.nodeOk = majorOf(ctx.nodeVersion) >= 20;
  f.tailscale = ctx.tailscaleBin ? ts.tailscaleStatus(ctx.tailscaleBin, ctx.run) : null;
  f.serve = ctx.tailscaleBin && f.tailscale && f.tailscale.running ? ts.serveStatus(ctx.tailscaleBin, ctx.run) : null;
  f.tmux = ctx.tmuxBins.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || "";
  if (f.tmux) {
    const v = ctx.run(f.tmux, ["-V"], { timeout: 5000 });
    f.tmuxVersion = (/tmux\s+(\S+)/.exec(v.stdout || "") || [])[1] || "";
    f.tmuxOk = own.versionAtLeast(f.tmuxVersion, own.MIN_TMUX);
  }
  f.profile = { ...ctx.paths.profile, read: ctx.paths.profile.file ? sa.readProfile(ctx.paths.profile.file) : null };
  f.onPath = airpocketOnPath(ctx);
  f.install = readInstall(ctx);
  f.lock = readLock(ctx);
  f.job = li.jobStatus(ctx.run, ctx.uid, ctx.label);
  f.plistOurs = li.isOurPlist(ctx.paths.plist, ctx.label);
  f.dataDirExists = exists(ctx.paths.dataDir);
  f.appVersion = versionOf(ctx.paths.appDir);
  f.version = versionOf(ctx.root);
  // The agents: installed if their config folder exists (or a config file does).
  f.agents = {};
  for (const agent of ["claude", "codex"]) {
    const file = ctx.paths[agent];
    const present = exists(path.dirname(file));
    f.agents[agent] = { file, present, read: present ? cfg.readConfig(file) : null };
  }
  f.portsInUse = {};
  for (const [name, port] of Object.entries({ app: ctx.ports.app, file: ctx.ports.file, hook: ctx.ports.hook })) f.portsInUse[name] = await listening(port);
  return f;
}

// ---------------------------------------------------------------- setup

/** The plan: { problems, notes, steps }. Each step has a title, lines saying what it changes, and apply(). */
function planSetup(f, opts = {}) {
  const { ctx } = f;
  const problems = [], notes = [], checks = [], steps = [];
  const t = ctx.t;

  // 1. Requirements. Any problem here stops setup before it changes anything.
  if (f.mac) checks.push(`macOS ${f.macVersion || ""}`.trim());
  else problems.push(`Airpocket runs on macOS; this is ${ctx.platform}.`);
  if (f.nodeOk) checks.push(`Node ${ctx.nodeVersion} (${ctx.node})`);
  else problems.push(`Airpocket needs Node 20 or newer; this is Node ${ctx.nodeVersion}. Install a newer one (brew install node), then run setup again.`);
  if (!ctx.tailscaleBin) problems.push("Tailscale is not installed. Install it from https://tailscale.com/download/mac, sign in, then run setup again.");
  else if (!f.tailscale) problems.push("Tailscale is installed but didn't answer. Open the Tailscale app, then run setup again.");
  else if (!f.tailscale.running) problems.push(`Tailscale is not signed in (it says ${f.tailscale.state}). Open the Tailscale app and sign in, then run setup again.`);
  else if (!f.tailscale.dns) problems.push("Tailscale didn't say this Mac's name in your tailnet. Turn on MagicDNS in the Tailscale admin console (DNS page), then run setup again.");
  else if (!f.tailscale.https) problems.push("Your tailnet has no HTTPS certificates, which Airpocket's addresses need. Turn on HTTPS Certificates in the Tailscale admin console (DNS page), then run setup again.");
  else if (!f.serve) problems.push("Couldn't read what Tailscale already publishes on this Mac. Nothing was changed.");
  else checks.push(`Tailscale ${f.tailscale.version}, this Mac is ${f.tailscale.dns}`);
  if (!f.tmux) checks.push(`tmux not found: airpocket run and sessions in tmux need it (${own.INSTALL_TMUX}); Superset works without`);
  else if (!f.tmuxOk) checks.push(`tmux ${f.tmuxVersion} at ${f.tmux} is older than ${own.MIN_TMUX.join(".")}, which airpocket run needs (brew upgrade tmux)`);
  else checks.push(`tmux ${f.tmuxVersion ? f.tmuxVersion + " " : ""}${f.tmux}`);

  const agents = ["claude", "codex"].filter((a) => f.agents[a].present);
  for (const a of ["claude", "codex"]) {
    const { file, present, read } = f.agents[a];
    if (present && read.problem) problems.push(`${t(file)} ${read.problem}. Airpocket won't change a file it can't read as JSON. Fix it, then run setup again.`);
  }
  if (!agents.length) problems.push(`Neither Claude Code (${t(path.dirname(ctx.paths.claude))}) nor Codex (${t(path.dirname(ctx.paths.codex))}) is set up for this user. Run one of them once, then run setup again.`);

  // Another Airpocket already running that isn't the login item (npm start, say).
  if (f.lock && f.lock.alive && !(f.job.loaded && f.job.pid === f.lock.pid)) {
    problems.push(`Airpocket is already running as process ${f.lock.pid}, not as the login item. Stop it, then run setup again.`);
  }
  // Our loopback ports taken by something that isn't Airpocket.
  const ourService = f.lock && f.lock.alive;
  if (!ourService) {
    for (const [name, port] of Object.entries({ app: ctx.ports.app, file: ctx.ports.file, hook: ctx.ports.hook })) {
      if (f.portsInUse[name]) problems.push(`Port ${port} on 127.0.0.1 (${name}) is already taken by another program. Free it, or move Airpocket with AIRPOCKET_PORT.`);
    }
  }
  if (/\/(\.nvm|\.fnm|\.volta|\.asdf|\.local\/share\/(fnm|mise)|\.nodenv)\//.test(ctx.node)) {
    notes.push(`Node comes from a version manager (${ctx.node}). The hooks and the login item run that exact Node: if you remove it, run setup again.`);
  }
  const unsafe = unsafeDataDir(ctx.paths.dataDir, ctx.home);
  if (unsafe) problems.push(`The data folder ${ctx.paths.dataDir} ${unsafe}. Point AIRPOCKET_DIR at a folder of Airpocket's own.`);
  const socketBytes = Buffer.byteLength(ctx.paths.socket) + 1;
  if (socketBytes > SOCKET_MAX) notes.push(`The data folder's path is long: a terminal socket inside it would be ${socketBytes} bytes, over macOS's ${SOCKET_MAX}. Fine for now; a shorter AIRPOCKET_DIR avoids trouble later.`);

  let chosen = null;
  if (f.serve) {
    const want = { app: Number(ctx.env.AIRPOCKET_PUBLIC_PORT) || 0, file: Number(ctx.env.AIRPOCKET_PUBLIC_FILE_PORT) || 0 };
    chosen = ts.choosePorts(f.serve, ctx.targets, want);
    if (chosen.problem) problems.push(`Tailscale: ${chosen.problem}. Airpocket won't replace what another program published. Nothing was changed.`);
  }
  if (problems.length) return { problems, notes, checks, steps };

  // 2. The steps.
  const install = f.install || { hooks: {} };
  const record = () => ({
    version: 1, airpocket: f.version, installedAt: ctx.now().toISOString(), node: ctx.node, label: ctx.label,
    app: ctx.paths.appDir, plist: ctx.paths.plist,
    ports: { app: ctx.ports.app, file: ctx.ports.file, hook: ctx.ports.hook, publicApp: chosen.app, publicFile: chosen.file },
    serve: install.serve || [], hooks: install.hooks || {}, dataDirCreated: install.dataDirCreated ?? !f.dataDirExists,
    ...(install.aliases ? { aliases: install.aliases } : {}),
  });
  const state = record();
  const save = () => saveInstall(ctx, state);

  steps.push({
    title: "Data folder",
    lines: [`${t(ctx.paths.dataDir)}${f.dataDirExists ? " (there already; made private: 0700)" : " (new, 0700)"}`, `install record: ${t(ctx.paths.install)} (0600)`],
    apply() {
      for (const dir of [ctx.paths.dataDir, path.dirname(ctx.paths.logFile)]) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); }
      save();
    },
  });

  const sameCopy = realpathOr(ctx.root) === realpathOr(ctx.paths.appDir);
  steps.push({
    title: "Airpocket itself",
    lines: sameCopy ? [`runs from ${t(ctx.paths.appDir)} already`]
      : [`copy airpocket ${f.version} to ${t(ctx.paths.appDir)}${f.appVersion ? ` (replaces ${f.appVersion})` : ""}`, "the hooks and the login item run this copy"],
    apply() { if (!sameCopy) copyApp(ctx.root, ctx.paths.appDir); },
  });

  const hookFile = path.join(ctx.paths.appDir, "src", "hook.js");
  for (const agent of agents) {
    const { file, read } = f.agents[agent];
    const command = cfg.hookCommand({ node: ctx.node, hook: hookFile, agent, dataDir: ctx.env.AIRPOCKET_DIR ? ctx.paths.dataDir : "" });
    const merged = cfg.addHooks(read.config, agent, command);
    const name = agent === "claude" ? "Claude Code hooks" : "Codex hooks";
    if (!merged.changes.length) {
      steps.push({ title: name, lines: [`${t(file)}: already has Airpocket's hooks (${cfg.EVENTS[agent].join(", ")})`], apply() {} });
      continue;
    }
    const added = merged.changes.filter((c) => c.action === "added").map((c) => c.event);
    const updated = merged.changes.filter((c) => c.action === "updated").map((c) => c.event);
    const text = cfg.serialize(merged.config, read.indent);
    const lines = [
      `${t(file)}: ${read.exists ? "merge into it, every other key and hook left as it is" : "create it"}`,
      ...(added.length ? [`add ${added.join(", ")}`] : []),
      ...(updated.length ? [`update ${updated.join(", ")} (Airpocket's own entries)`] : []),
      `command: ${command}`,
      ...(read.exists && read.text.trim() ? [`backup first: ${t(file)}.airpocket-backup-<time>`] : []),
    ];
    if (agent === "codex") lines.push("Codex asks you to review new hooks before they run: when it says hooks need review, open /hooks and trust Airpocket's");
    steps.push({
      title: name, lines,
      apply(done) {
        const prev = state.hooks[file] || {};
        state.hooks[file] = {
          agent,
          createdFile: prev.createdFile ?? !read.exists,
          createdHooks: !!prev.createdHooks || merged.created.hooks,
          createdEvents: [...new Set([...(prev.createdEvents || []), ...merged.created.events])],
        };
        save();                                              // recorded before the file changes, so uninstall knows
        if (read.exists && read.text.trim()) done.push(`backup ${t(cfg.backup(file, read.text, ctx.now()))}`);
        cfg.writeConfig(file, text, { expect: read.exists ? read.text : "", mode: read.mode });
      },
    });
  }
  for (const agent of ["claude", "codex"].filter((a) => !f.agents[a].present)) {
    notes.push(`${agent === "claude" ? "Claude Code" : "Codex"} isn't set up for this user (no ${t(path.dirname(f.agents[agent].file))}); its hooks are skipped. Run setup again after you start using it.`);
  }

  const passEnv = {};
  for (const k of ["AIRPOCKET_PORT", "AIRPOCKET_FILE_PORT", "AIRPOCKET_HOOK_PORT", "CODEX_HOME"]) if (ctx.env[k]) passEnv[k] = ctx.env[k];
  const item = li.loginItem({ label: ctx.label, node: ctx.node, appDir: ctx.paths.appDir, dataDir: ctx.paths.dataDir, logFile: ctx.paths.logFile, env: passEnv });
  steps.push({
    title: "Login item",
    lines: [`${t(ctx.paths.plist)}${f.plistOurs ? " (replaces the one there)" : ""}`,
      `runs: ${item.def.ProgramArguments.join(" ")}`,
      `starts at login, restarts after a crash (not more often than every ${li.THROTTLE_S} s), logs to ${t(ctx.paths.logFile)}`,
      f.job.loaded ? "restarts the service now, to run the new copy" : "loaded now, then checked: running, holding the data folder, answering on 127.0.0.1"],
    async apply(done) {
      fs.mkdirSync(path.dirname(ctx.paths.plist), { recursive: true });
      writeAtomic(ctx.paths.plist, item.xml);
      fs.chmodSync(ctx.paths.plist, 0o644);
      // A running copy stops first, and lets go of the data folder, so the new one doesn't wait for it.
      if (await li.unloadAndWait(ctx.run, ctx.uid, ctx.label)) {
        for (let i = 0; i < 40; i++) { const l = readLock(ctx); if (!l || !l.alive) break; await new Promise((r) => setTimeout(r, 250)); }
      }
      const r = await li.load(ctx.run, ctx.uid, ctx.paths.plist, ctx.label);
      if (!r.ok) throw new Error(r.why);
      const up = await waitForService(ctx);
      if (!up.ok) throw new Error(up.why);
      done.push(`running as process ${up.pid}`);
    },
  });

  const toServe = [["app", chosen.app], ["file", chosen.file]].filter(([role, port]) => !ts.oursOn(f.serve, port, ctx.targets[role]));
  const address = ts.addressOf(f.tailscale.dns, chosen.app);
  const taken = chosen.taken.length ? ` (${chosen.taken.join(" and ")} ${chosen.taken.length > 1 ? "are" : "is"} taken by something else)` : "";
  steps.push({
    title: "Tailscale",
    lines: [
      `https://${f.tailscale.dns}:${chosen.app} -> ${ctx.targets.app.replace("http://", "")}   the app${taken}`,
      `https://${f.tailscale.dns}:${chosen.file} -> ${ctx.targets.file.replace("http://", "")}   the file-only origin`,
      toServe.length ? `with tailscale serve, inside your tailnet only (never funnel)` : "published like this already",
    ],
    apply(done) {
      state.ports.publicApp = chosen.app; state.ports.publicFile = chosen.file;
      for (const [role, port] of toServe) {
        state.serve = [...state.serve.filter((s) => s.port !== port), { port, target: ctx.targets[role] }];
        save();
        const r = ts.serveOn(ctx.tailscaleBin, port, ctx.targets[role], ctx.run);
        if (r.status !== 0) throw new Error(`tailscale serve on port ${port} failed: ${(r.stderr || r.stdout).trim().split("\n")[0] || r.status}`);
      }
      for (const [role, port] of [["app", chosen.app], ["file", chosen.file]]) {
        if (!state.serve.some((s) => s.port === port)) state.serve.push({ port, target: ctx.targets[role] });
      }
      save();
      const after = ts.serveStatus(ctx.tailscaleBin, ctx.run);
      for (const [role, port] of [["app", chosen.app], ["file", chosen.file]]) {
        if (!after || !ts.oursOn(after, port, ctx.targets[role])) throw new Error(`Tailscale doesn't show port ${port} publishing ${ctx.targets[role]} after serve.`);
      }
      done.push(`the phone opens ${address}`);
    },
  });

  const aliases = planAliases(f, opts.alias ?? null, state, save);
  notes.push(...aliases.notes);
  if (aliases.step) steps.push(aliases.step);

  steps.push({
    title: "Pairing",
    lines: ["a six-digit code and its QR, for ten minutes and five tries"],
    apply() {
      const { code, expiresAt } = createStore(ctx.paths.dataDir).newCode();
      for (const line of pairingLines({ code, expiresAt, url: address, color: ctx.color })) ctx.out(line);
    },
  });
  return { problems, notes, checks, steps, address, chosen };
}

/**
 * The shell aliases step, or none: { step, notes }. `decision` is true (--alias),
 * false (--no-alias) or null (ask on a terminal, skip without one).
 */
function planAliases(f, decision, state, save) {
  const { ctx } = f;
  const t = ctx.t, notes = [];
  const agents = ["claude", "codex"].filter((a) => f.agents[a].present);
  const { shell, file, read } = f.profile;
  if (decision === false || !agents.length) return { notes };
  if (!file) {
    if (decision === null && !ctx.tty) return { notes };
    notes.push(`Your shell is ${shell}, so setup adds no aliases. To have the phone answer, start agents with: airpocket run claude (or codex)`);
    return { notes };
  }
  if (read.problem) { notes.push(`${t(file)} ${read.problem}, so setup adds no aliases to it.`); return { notes }; }
  if (decision === null && !ctx.tty) {
    notes.push("To start claude and codex where the phone can answer, add shell aliases: airpocket setup --alias");
    return { notes };
  }
  // Double quotes read better inside the alias's single quotes, where nothing in the path needs escaping.
  const quote = (p) => (/^[^"$`\\!']+$/.test(p) ? `"${p}"` : cfg.shellQuote(p));
  const runner = f.onPath ? "airpocket" : `${quote(ctx.node)} ${quote(path.join(ctx.paths.appDir, "src", "cli.js"))}`;
  const want = agents.map((agent) => ({ agent, line: sa.aliasLine(agent, runner) }));
  const merged = sa.addAliases(read.text, want);
  for (const s of merged.skipped) notes.push(`${t(file)} already defines ${s.agent} (${s.line}), so setup leaves it. Start it with airpocket run ${s.agent} to have the phone answer.`);
  const change = [...merged.added, ...merged.updated];
  if (!change.length) {
    return { notes, step: merged.same.length ? { title: "Shell aliases", lines: [`${t(file)}: has them already (${merged.same.join(", ")})`], apply() {} } : null };
  }
  const ask = decision === null;
  const lines = [
    `${t(file)}${read.exists ? "" : " (new)"}: ${ask ? "asks first, then " : ""}${merged.added.length ? "adds at the end" : "updates Airpocket's own lines"}:`,
    ...want.filter((w) => change.includes(w.agent)).map((w) => "  " + w.line),
    ...(read.exists && read.text ? [`backup first: ${t(file)}.airpocket-backup-<time>`] : []),
    ...(f.tmux && f.tmuxOk ? [] : [`they need tmux: ${own.INSTALL_TMUX}`]),
  ];
  const step = {
    title: "Shell aliases", lines,
    async apply(done) {
      if (ask) {
        const yes = await ctx.ask(`\nAdd these to ${t(file)}, so typing ${change.join(" or ")} starts it where your phone can answer?\n${want.filter((w) => change.includes(w.agent)).map((w) => "  " + w.line).join("\n")}\n`);
        if (!yes) { done.push("not added; airpocket setup --alias adds them later"); return; }
      }
      const prev = state.aliases || {};
      state.aliases = { file, createdFile: prev.file === file ? !!prev.createdFile : !read.exists,
        newlineAdded: (prev.file === file && !!prev.newlineAdded) || merged.newlineAdded };
      save();                                                // recorded before the file changes, so uninstall knows
      if (read.exists && read.text) done.push(`backup ${t(cfg.backup(file, read.text, ctx.now()))}`);
      cfg.writeConfig(file, merged.text, { expect: read.text, mode: read.mode });
      done.push(`${change.join(" and ")} in ${t(file)}; open a new terminal window to use ${change.length > 1 ? "them" : "it"}`);
    },
  };
  return { notes, step };
}

/** Is `airpocket` itself on this PATH (and not in npx's temporary cache)? */
function airpocketOnPath(ctx) {
  for (const dir of String(ctx.env.PATH || "").split(":")) {
    if (!path.isAbsolute(dir) || dir.includes("/_npx/")) continue;
    try { fs.accessSync(path.join(dir, "airpocket"), fs.constants.X_OK); return true; } catch {}
  }
  return false;
}

const realpathOr = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

/** Copy Airpocket's files into the data folder, whole: into a new folder first, then swapped in. */
function copyApp(from, to) {
  const tmp = `${to}.new-${crypto.randomBytes(4).toString("hex")}`;
  const walk = (src, dst) => {
    const st = fs.lstatSync(src);
    if (st.isDirectory()) {
      fs.mkdirSync(dst, { mode: 0o700 });
      for (const name of fs.readdirSync(src)) if (name !== ".DS_Store" && !name.endsWith(".tmp")) walk(path.join(src, name), path.join(dst, name));
    } else if (st.isFile()) {
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, st.mode & 0o755);
    }                                                        // links and anything else are left out
  };
  try {
    fs.mkdirSync(tmp, { mode: 0o700 });
    for (const name of COPY) if (exists(path.join(from, name))) walk(path.join(from, name), path.join(tmp, name));
    const old = `${to}.old-${crypto.randomBytes(4).toString("hex")}`;
    if (exists(to)) fs.renameSync(to, old);
    fs.renameSync(tmp, to);
    fs.rmSync(old, { recursive: true, force: true });
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

/** Wait until the login item runs, holds the data folder's lock and answers on its port. */
async function waitForService(ctx) {
  const until = Date.now() + ctx.waitMs;
  let job = null, lock = null;
  while (Date.now() < until) {
    job = li.jobStatus(ctx.run, ctx.uid, ctx.label);
    lock = readLock(ctx);
    if (job.pid && lock && lock.pid === job.pid && (await probe(ctx.ports.app, "/manifest.webmanifest")) === 200 && exists(ctx.paths.hookFile)) {
      return { ok: true, pid: job.pid };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const why = !job || !job.loaded ? "launchd didn't keep the login item loaded"
    : !job.pid ? `the service isn't running (last exit code ${job.exit ?? "unknown"})`
    : lock && lock.alive && lock.pid !== job.pid ? `process ${lock.pid} holds the data folder, so the service is waiting for it`
    : `the service (process ${job.pid}) didn't answer on 127.0.0.1:${ctx.ports.app}`;
  return { ok: false, why: `${why}. The last lines of ${ctx.t(ctx.paths.logFile)}:\n${tail(ctx.paths.logFile, 6)}` };
}
function tail(file, n) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    const len = Math.min(st.size, 8192);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString("utf8").trimEnd().split("\n").slice(-n).map((l) => "    " + l).join("\n") || "    (empty)";
  } catch { return "    (no log yet)"; }
}

/** The pairing code, the QR and what to do with them. */
function pairingLines({ code, expiresAt, url, color }) {
  const lines = ["", `  Pairing code   ${code.slice(0, 3)} ${code.slice(3)}`, ""];
  if (url) {
    for (const line of QR.toTerminal(QR.encode(QR.pairPayload(url, code), "M"), { color })) lines.push("  " + line);
    lines.push("", "  In the Airpocket app: Scan the code on your Mac, or enter the six digits.");
  }
  lines.push(`  Good until ${new Date(expiresAt).toLocaleTimeString()}, five tries, one phone.`);
  lines.push(url ? `  On the phone, with Tailscale on, open ${url} and enter it.` : "  Airpocket isn't published in your tailnet yet: run airpocket setup.");
  lines.push("");
  return lines;
}

function printPlan(ctx, plan, dryRun) {
  const out = ctx.out;
  out(dryRun ? "Airpocket setup, dry run: nothing will be changed." : "Airpocket setup");
  out("");
  out("Checks");
  for (const c of plan.checks) out(`  ok  ${c}`);
  for (const p of plan.problems) out(`  NO  ${p}`);
  for (const n of plan.notes) out(`  --  ${n}`);
  if (plan.problems.length) return;
  out("");
  out(dryRun ? "What setup would do" : "What setup does");
  plan.steps.forEach((s, i) => {
    out(`  ${i + 1}. ${s.title}`);
    for (const l of s.lines) out(`       ${l}`);
  });
}

/** airpocket setup [--dry-run] [--alias | --no-alias]. Resolves to an exit code. */
async function runSetup(ctx, argv = []) {
  const dryRun = flag(argv, "dry-run");
  if (flag(argv, "alias") && flag(argv, "no-alias")) { ctx.out("Choose one: --alias or --no-alias."); return 2; }
  const plan = planSetup(await survey(ctx), { alias: flag(argv, "alias") ? true : flag(argv, "no-alias") ? false : null });
  printPlan(ctx, plan, dryRun);
  if (plan.problems.length) {
    ctx.out("");
    ctx.out("Setup stopped before changing anything.");
    return 1;
  }
  if (dryRun) {
    ctx.out("");
    ctx.out("Nothing was changed. Run airpocket setup to do it.");
    return 0;
  }
  ctx.out("");
  for (const [i, step] of plan.steps.entries()) {
    const done = [];
    try {
      await step.apply(done);
    } catch (err) {
      ctx.out(`  ${i + 1}. ${step.title}: FAILED`);
      ctx.out(`       ${String(err.message).split("\n").join("\n       ")}`);
      ctx.out("");
      ctx.out(i ? "Setup stopped. What it did so far is recorded; airpocket uninstall removes it, or fix the above and run setup again."
                : "Setup stopped before changing anything.");
      return 1;
    }
    if (step.title !== "Pairing") ctx.out(`  ${i + 1}. ${step.title}: done${done.length ? " (" + done.join("; ") + ")" : ""}`);
  }
  ctx.out(`Airpocket is set up. Check it any time with: airpocket doctor`);
  return 0;
}

// ---------------------------------------------------------------- uninstall

/** What uninstall would remove: { steps, notes }. */
function planUninstall(f) {
  const { ctx } = f;
  const t = ctx.t;
  const steps = [], notes = [];
  const install = f.install || { hooks: {} };

  if (f.job.loaded || f.plistOurs) {
    steps.push({
      title: "Login item",
      lines: [`${f.job.loaded ? "stop and unload it" : "not loaded"}${f.plistOurs ? `; remove ${t(ctx.paths.plist)}` : ""}`],
      async apply() {
        await li.unloadAndWait(ctx.run, ctx.uid, ctx.label);
        if (f.plistOurs) fs.unlinkSync(ctx.paths.plist);
      },
    });
  }

  // Tailscale: every port that publishes only Airpocket's loopback targets, whichever ports setup picked.
  if (ctx.tailscaleBin && f.serve) {
    const targets = new Set([ctx.targets.app, ctx.targets.file, ...(install.serve || []).map((s) => s.target)]);
    const ports = [...new Set([...targets].flatMap((target) => ts.portsServing(f.serve, target)))];
    if (ports.length) {
      steps.push({
        title: "Tailscale",
        lines: ports.map((p) => `stop publishing HTTPS port ${p} (${ts.handlersOn(f.serve, p).join(", ")})`),
        apply() {
          for (const p of ports) {
            const r = ts.serveOff(ctx.tailscaleBin, p, ctx.run);
            if (r.status !== 0) throw new Error(`tailscale serve --https=${p} off failed: ${(r.stderr || r.stdout).trim().split("\n")[0] || r.status}`);
          }
        },
      });
    }
  } else if (install.serve && install.serve.length) {
    notes.push("Couldn't ask Tailscale what it publishes, so its addresses were left. Run airpocket uninstall again once Tailscale is running.");
  }

  const files = [...new Set([ctx.paths.claude, ctx.paths.codex, ...Object.keys(install.hooks || {})])];
  for (const file of files) {
    const read = cfg.readConfig(file);
    if (!read.exists) continue;
    if (read.problem) {
      if (read.text && read.text.includes(cfg.MARKER)) notes.push(`${t(file)} ${read.problem}, so it was left alone. Remove the lines with "${cfg.MARKER}" yourself.`);
      continue;
    }
    if (!cfg.hasAnyOurs(read.config)) continue;
    const created = install.hooks && install.hooks[file] ? { hooks: !!install.hooks[file].createdHooks, events: install.hooks[file].createdEvents || [] } : null;
    const { config, removed } = cfg.removeHooks(read.config, created);
    const empty = !Object.keys(config).length;
    const drop = empty && install.hooks && install.hooks[file] && install.hooks[file].createdFile;
    const codex = path.basename(file) === "hooks.json";
    const shifted = codex ? cfg.hooksAfterOurs(read.config) : [];
    if (shifted.length) notes.push(`In ${t(file)}, your own ${shifted.join(", ")} hook${shifted.length > 1 ? "s come" : " comes"} after Airpocket's. Codex remembers trusted hooks by position, so it will ask you to review ${shifted.length > 1 ? "them" : "it"} again.`);
    steps.push({
      title: codex ? "Codex hooks" : "Claude Code hooks",
      kind: "config",
      lines: [`${t(file)}: remove Airpocket's ${removed.join(", ")}${drop ? "; the file only held those, so it goes (setup created it)" : ", nothing else"}`,
        `backup first: ${t(file)}.airpocket-backup-<time>`],
      apply(done) {
        done.push(`backup ${t(cfg.backup(file, read.text, ctx.now()))}`);
        if (drop) cfg.removeConfig(file, read.text);
        else cfg.writeConfig(file, cfg.serialize(config, read.indent), { expect: read.text, mode: read.mode });
      },
    });
  }

  const profiles = [...new Set([install.aliases && install.aliases.file, ctx.paths.profile.file].filter(Boolean))];
  for (const file of profiles) {
    const read = sa.readProfile(file);
    if (read.problem || !sa.hasOurs(read.text)) continue;
    const rec = install.aliases && install.aliases.file === file ? install.aliases : {};
    const { text, removed } = sa.removeAliases(read.text, { newlineAdded: !!rec.newlineAdded });
    const drop = !text && !!rec.createdFile;
    steps.push({
      title: "Shell aliases",
      kind: "config",
      lines: [`${t(file)}: remove Airpocket's ${removed.join(" and ")} alias${removed.length > 1 ? "es" : ""}${drop ? "; the file only held those, so it goes (setup created it)" : ", nothing else"}`,
        `backup first: ${t(file)}.airpocket-backup-<time>`],
      apply(done) {
        done.push(`backup ${t(cfg.backup(file, read.text, ctx.now()))}`);
        if (drop) cfg.removeConfig(file, read.text);
        else cfg.writeConfig(file, text, { expect: read.text, mode: read.mode });
      },
    });
  }

  if (versionOf(ctx.paths.appDir)) {
    steps.push({ title: "Airpocket itself", last: true, lines: [`remove the copy in ${t(ctx.paths.appDir)}`], apply() { fs.rmSync(ctx.paths.appDir, { recursive: true, force: true }); } });
  }
  if (exists(ctx.paths.install)) {
    steps.push({ title: "Install record", last: true, lines: [`remove ${t(ctx.paths.install)}`], apply() { fs.rmSync(ctx.paths.install, { force: true }); } });
  }
  return { steps, notes };
}

/** airpocket uninstall [--dry-run] [--keep-data | --remove-data]. Resolves to an exit code. */
async function runUninstall(ctx, argv = []) {
  const dryRun = flag(argv, "dry-run");
  const f = await survey(ctx);
  const plan = planUninstall(f);
  const out = ctx.out, t = ctx.t;
  out(dryRun ? "Airpocket uninstall, dry run: nothing will be changed." : "Airpocket uninstall");
  out("");
  const dataThere = exists(ctx.paths.dataDir);
  if (!plan.steps.length) out("Nothing of Airpocket's setup is installed here.");
  plan.steps.forEach((s, i) => { out(`  ${i + 1}. ${s.title}`); for (const l of s.lines) out(`       ${l}`); });
  for (const n of plan.notes) out(`  --  ${n}`);
  if (dryRun) {
    if (dataThere) out(`\n  The data folder ${t(ctx.paths.dataDir)} stays unless you say so (it holds the paired phones).`);
    out("\nNothing was changed.");
    return 0;
  }
  let failed = false;
  if (plan.steps.length) out("");
  for (const [i, step] of plan.steps.entries()) {
    // After a failure, the copy the hooks run and the record of what setup added stay, so the
    // hooks keep working and the next uninstall still knows what to remove.
    if (step.last && failed) { out(`  kept: ${step.title} (something above didn't come off; run airpocket uninstall again)`); continue; }
    const done = [];
    try { await step.apply(done); out(`  removed: ${step.title}${done.length ? " (" + done.join("; ") + ")" : ""}`); }
    catch (err) { failed = true; out(`  ${i + 1}. ${step.title}: FAILED: ${err.message}`); }
  }

  if (dataThere) {
    const phones = createStore(ctx.paths.dataDir).devices().length;
    const lock = readLock(ctx);
    let remove = flag(argv, "remove-data") ? true : flag(argv, "keep-data") ? false : null;
    if (remove === null) {
      remove = ctx.tty
        ? await ctx.ask(`\nAlso remove the data folder ${t(ctx.paths.dataDir)}? It holds ${phones} paired phone${phones === 1 ? "" : "s"}, which would need pairing again.`)
        : false;
      if (!ctx.tty) out(`\n  Kept the data folder ${t(ctx.paths.dataDir)}. To remove it too: airpocket uninstall --remove-data`);
    }
    const unsafe = unsafeDataDir(ctx.paths.dataDir, ctx.home);
    let running = [];
    const strangers = (() => { try { return fs.readdirSync(ctx.paths.dataDir).filter((n) => !OWN_ENTRY.test(n)); } catch { return []; } })();
    if (remove && (unsafe || strangers.length)) {
      out(`  Kept the data folder ${t(ctx.paths.dataDir)}: it ${unsafe || `holds things that aren't Airpocket's (${strangers.slice(0, 3).join(", ")})`}. Remove what you want yourself.`);
      failed = true;
    } else if (remove && (running = ownSessions(ctx)).length) {
      out(`  Kept the data folder: ${running.length} agent${running.length === 1 ? "" : "s"} started with airpocket run still run${running.length === 1 ? "s" : ""} there (${running.join(", ")}). End ${running.length === 1 ? "it" : "them"}, then run airpocket uninstall --remove-data.`);
      failed = true;
    } else if (remove && lock && lock.alive) {
      out(`  Kept the data folder: Airpocket is still running there as process ${lock.pid}. Stop it, then run airpocket uninstall --remove-data.`);
      failed = true;
    } else if (remove) {
      fs.rmSync(ctx.paths.dataDir, { recursive: true, force: true });
      out(`  removed: the data folder ${t(ctx.paths.dataDir)} (${phones} paired phone${phones === 1 ? "" : "s"})`);
    } else if (ctx.tty || flag(argv, "keep-data")) {
      out(`  Kept the data folder ${t(ctx.paths.dataDir)}.`);
    }
  }
  const backups = listBackups(ctx);
  if (backups.length) out(`\n  Backups of your config files stay where they are:\n${backups.map((b) => "    " + t(b)).join("\n")}`);
  out(failed ? "\nUninstall didn't finish; see above." : plan.steps.length ? "\nAirpocket is uninstalled." : "");
  return failed ? 1 : 0;
}

/** The agents running on Airpocket's own tmux socket, by name. */
function ownSessions(ctx) {
  const tmux = ctx.tmuxBins.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  if (!tmux) return [];
  const o = own.context({ env: ctx.env, home: ctx.home, uid: ctx.uid, run: ctx.run, tmuxBins: ctx.tmuxBins });
  return own.listSessions(o, tmux).filter((s) => !s.ended).map((s) => s.name);
}

function listBackups(ctx) {
  const out = [];
  for (const file of [ctx.paths.claude, ctx.paths.codex, ctx.paths.profile.file].filter(Boolean)) {
    try { for (const n of fs.readdirSync(path.dirname(file))) if (n.startsWith(path.basename(file) + ".airpocket-backup-")) out.push(path.join(path.dirname(file), n)); } catch {}
  }
  return out.sort();
}

module.exports = { context, stableNode, survey, planSetup, runSetup, planUninstall, runUninstall, pairingLines, readLock, readInstall,
  probe, listening, versionOf, majorOf, SOCKET_MAX, copyApp, tail, unsafeDataDir, ownSessions };

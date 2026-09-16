"use strict";
// airpocket doctor: one screen of real checks, each PASS or FAIL with what to
// do about it (WARN and INFO for what doesn't break anything). Exits 1 when
// anything FAILs, so a script can use it. Changes nothing.
const fs = require("fs");
const path = require("path");
const cfg = require("./agentconfig");
const ts = require("./tailscale");
const li = require("./loginitem");
const { survey, readLock, probe, versionOf, majorOf, SOCKET_MAX } = require("./setup");

const SNAKE = (event) => event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

async function checks(ctx) {
  const f = await survey(ctx);
  const t = ctx.t, P = ctx.paths;
  const list = [];
  const add = (level, name, detail, fix) => list.push({ level, name, detail, fix });
  const install = f.install;

  // This Mac.
  if (f.mac) add("PASS", "macOS", f.macVersion || "");
  else add("FAIL", "macOS", `this is ${ctx.platform}`, "Airpocket runs on macOS only.");
  if (f.nodeOk) add("PASS", "Node", `${ctx.nodeVersion} (${ctx.execPath})`);
  else add("FAIL", "Node", ctx.nodeVersion, "Install Node 20 or newer (brew install node).");
  const serviceNode = install && install.node;
  if (serviceNode) {
    const r = ctx.run(serviceNode, ["--version"], { timeout: 5000 });
    const v = r.status === 0 ? r.stdout.trim() : "";
    if (majorOf(v) >= 20) add("PASS", "Node for the service", `${v} (${serviceNode})`);
    else add("FAIL", "Node for the service", v ? `${serviceNode} is ${v}` : `${serviceNode} is gone`, "Run airpocket setup again with Node 20 or newer.");
  }

  // The data folder.
  let dirMode = null;
  try { dirMode = fs.statSync(P.dataDir).mode & 0o777; } catch {}
  if (dirMode === null) add("FAIL", "Data folder", `${t(P.dataDir)} doesn't exist`, "Run airpocket setup.");
  else {
    const loose = looseFiles(P.dataDir);
    if (dirMode !== 0o700) add("FAIL", "Data folder", `${t(P.dataDir)} is ${dirMode.toString(8)}, not 700`, `chmod 700 "${P.dataDir}"`);
    else if (loose.length) add("FAIL", "Data folder", `readable by others: ${loose.slice(0, 3).map((x) => path.relative(P.dataDir, x.file) + " " + x.mode.toString(8)).join(", ")}`, `chmod go-rwx on those, or run airpocket setup again`);
    else add("PASS", "Data folder", `${t(P.dataDir)} 700, private files 600`);
  }
  const socketBytes = Buffer.byteLength(P.socket) + 1;
  if (socketBytes <= SOCKET_MAX) add("PASS", "Socket path", `${socketBytes} of ${SOCKET_MAX} bytes (${t(P.socket)})`);
  else add("FAIL", "Socket path", `${socketBytes} bytes, over macOS's ${SOCKET_MAX}`, "Use a shorter AIRPOCKET_DIR.");

  // The service: the lock, the login item, the ports.
  const lock = f.lock;
  if (!lock) add("FAIL", "Lock", "no airpocket.lock: the service isn't running", `Start it: launchctl kickstart gui/${ctx.uid}/${ctx.label}`);
  else if (!lock.alive) add("FAIL", "Lock", `stale: process ${lock.pid || "?"} is gone`, `The service takes a stale lock over when it starts: launchctl kickstart -k gui/${ctx.uid}/${ctx.label}`);
  else add("PASS", "Lock", `held by process ${lock.pid}`);

  if (!f.plistOurs) add("FAIL", "Login item", `${t(P.plist)} is missing`, "Run airpocket setup.");
  else if (!f.job.loaded) add("FAIL", "Login item", "installed but not loaded", `launchctl bootstrap gui/${ctx.uid} "${P.plist}"`);
  else if (!f.job.pid) add("FAIL", "Login item", `loaded, not running (last exit code ${f.job.exit ?? "unknown"}, ${f.job.runs} runs)`, `See ${t(P.logFile)}`);
  else if (lock && lock.alive && lock.pid !== f.job.pid) add("FAIL", "Login item", `process ${f.job.pid} is waiting: process ${lock.pid} holds the data folder`, `Stop process ${lock.pid} (an Airpocket started by hand?); the login item takes over.`);
  else add("PASS", "Login item", `running as process ${f.job.pid}${f.job.runs > 1 ? `, started ${f.job.runs} times` : ""}`);

  const up = lock && lock.alive;
  const appStatus = await probe(ctx.ports.app, "/manifest.webmanifest");
  if (appStatus === 200) add("PASS", "App port", `127.0.0.1:${ctx.ports.app} answers`);
  else add("FAIL", "App port", `127.0.0.1:${ctx.ports.app} ${appStatus ? "answers " + appStatus : "doesn't answer"}`, up ? `The service runs but doesn't serve; see ${t(P.logFile)}` : "Start the service (see Lock).");
  const fileStatus = await probe(ctx.ports.file, "/");
  if (fileStatus) add("PASS", "File port", `127.0.0.1:${ctx.ports.file} answers`);
  else add("FAIL", "File port", `127.0.0.1:${ctx.ports.file} doesn't answer`, up ? `See ${t(P.logFile)}` : "Start the service (see Lock).");
  const hook = readHookJson(P.hookFile);
  const hookStatus = await probe(ctx.ports.hook, "/hook/touch", "POST");
  if (hookStatus === 401 && hook && hook.port === ctx.ports.hook) add("PASS", "Hook port", `127.0.0.1:${ctx.ports.hook} answers, hook.json matches`);
  else add("FAIL", "Hook port", hookStatus === 401 ? `hook.json ${hook ? `says port ${hook.port}` : "is missing"}` : `127.0.0.1:${ctx.ports.hook} ${hookStatus ? "answers " + hookStatus : "doesn't answer"}`,
    up ? `Restart the service: launchctl kickstart -k gui/${ctx.uid}/${ctx.label}` : "Start the service (see Lock).");

  // The hooks.
  const hookJs = path.join(P.appDir, "src", "hook.js");
  for (const agent of ["claude", "codex"]) {
    const name = agent === "claude" ? "Claude Code hooks" : "Codex hooks";
    const { file, present, read } = f.agents[agent];
    if (!present) { add("INFO", name, `${agent === "claude" ? "Claude Code" : "Codex"} isn't set up for this user`); continue; }
    if (!read.exists) { add("FAIL", name, `${t(file)} doesn't exist`, "Run airpocket setup."); continue; }
    if (read.problem) { add("FAIL", name, `${t(file)} ${read.problem}`, "Fix the file, then run airpocket setup."); continue; }
    const state = cfg.hookState(read.config, agent);
    const missing = cfg.EVENTS[agent].filter((e) => state[e].count === 0);
    const doubled = cfg.EVENTS[agent].filter((e) => state[e].count > 1);
    const broken = cfg.EVENTS[agent].filter((e) => state[e].count && !commandWorks(state[e].at.command, hookJs));
    if (missing.length) add("FAIL", name, `${t(file)} is missing ${missing.join(", ")}`, "Run airpocket setup.");
    else if (doubled.length) add("FAIL", name, `${t(file)} has more than one Airpocket entry for ${doubled.join(", ")}`, "Run airpocket setup (it keeps one).");
    else if (broken.length) add("FAIL", name, `the command for ${broken.join(", ")} runs a node or hook.js that isn't there`, "Run airpocket setup.");
    else add("PASS", name, `${t(file)}: ${cfg.EVENTS[agent].join(", ")}`);
    if (agent === "codex" && !missing.length) {
      const untrusted = codexUntrusted(ctx, file, state);
      if (untrusted === null) add("INFO", "Codex hook review", "couldn't read Codex's config.toml to see whether you trusted them");
      else if (untrusted.length) add("WARN", "Codex hook review", `not reviewed yet: ${untrusted.join(", ")}`, "Codex runs new hooks only once you trust them: start Codex, open /hooks, trust Airpocket's.");
      else add("PASS", "Codex hook review", "trusted in Codex");
    }
  }

  // Tailscale.
  if (!ctx.tailscaleBin) add("FAIL", "Tailscale", "not installed", "Install it from https://tailscale.com/download/mac and sign in.");
  else if (!f.tailscale || !f.tailscale.running) add("FAIL", "Tailscale", f.tailscale ? `not signed in (${f.tailscale.state})` : "didn't answer", "Open the Tailscale app and sign in.");
  else if (!f.serve) add("FAIL", "Tailscale", "couldn't read what it publishes", "Open the Tailscale app, then try again.");
  else {
    const ports = install && install.ports;
    if (!ports || !ports.publicApp) add("FAIL", "Tailscale addresses", "setup hasn't chosen any", "Run airpocket setup.");
    else {
      const bad = [["app", ports.publicApp], ["file", ports.publicFile]].filter(([role, port]) => !ts.oursOn(f.serve, port, ctx.targets[role]));
      const dns = f.tailscale.dns || "<this Mac>";
      if (bad.length) add("FAIL", "Tailscale addresses", bad.map(([role, port]) => `port ${port} doesn't publish the ${role} (${ts.handlersOn(f.serve, port).join(", ") || "nothing"})`).join("; "), "Run airpocket setup.");
      else add("PASS", "Tailscale addresses", `${ts.addressOf(dns, ports.publicApp)} (app), https://${dns}:${ports.publicFile} (files)`);
    }
  }

  // Optional and informational.
  add("INFO", "tmux", f.tmux ? f.tmux : "not found: sessions in tmux can't be reached (Superset works without it)");
  if (f.appVersion && f.version && f.appVersion !== f.version) add("WARN", "Version", `the service runs airpocket ${f.appVersion}, this command is ${f.version}`, "Run airpocket setup to update the copy the service runs.");
  return list;
}

/** Private files in the data folder that others could read (the app copy is code, and is left out). */
function looseFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n);
      if (depth === 0 && n === "app") continue;
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isDirectory()) { if (st.mode & 0o077) out.push({ file: p, mode: st.mode & 0o777 }); if (depth < 2) walk(p, depth + 1); }
      else if (st.isFile() && st.mode & 0o077) out.push({ file: p, mode: st.mode & 0o777 });
    }
  };
  walk(dir, 0);
  return out;
}

function readHookJson(file) {
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return Number.isInteger(j.port) ? j : null; } catch { return null; }
}

/** Does a hook command of ours name a node and a hook.js that exist? */
function commandWorks(command, expectHook) {
  const quoted = [...String(command).matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) => m[1].replace(/'\\''/g, "'"));
  const [node, hook] = quoted.slice(-2);
  if (!node || !hook) return false;
  try { fs.accessSync(node, fs.constants.X_OK); fs.accessSync(hook, fs.constants.R_OK); } catch { return false; }
  return !expectHook || fs.realpathSync(hook) === (() => { try { return fs.realpathSync(expectHook); } catch { return expectHook; } })();
}

/**
 * Codex remembers each hook you trusted in config.toml, under
 * [hooks.state."<hooks.json>:<event>:<group>:<hook>"] with a trusted_hash. This
 * reads only those headers: the events whose entry of ours has none. null when
 * config.toml can't be read. (A trusted hash for a changed command isn't
 * caught: that would need Codex's own hashing.)
 */
function codexUntrusted(ctx, file, state) {
  let text;
  try { text = fs.readFileSync(path.join(path.dirname(file), "config.toml"), "utf8"); } catch (err) { return err.code === "ENOENT" ? cfg.EVENTS.codex.slice() : null; }
  return cfg.EVENTS.codex.filter((event) => {
    const at = state[event].at;
    const key = `${file}:${SNAKE(event)}:${at.group}:${at.index}`;
    const i = text.indexOf(`[hooks.state.${JSON.stringify(key)}]`);
    if (i < 0) return true;
    const body = text.slice(i).split("\n").slice(1).join("\n").split(/\n\[/)[0];
    return !/^\s*trusted_hash\s*=/m.test(body) || /^\s*enabled\s*=\s*false/m.test(body);
  });
}

/** airpocket doctor. Resolves to an exit code. */
async function runDoctor(ctx) {
  const list = await checks(ctx);
  const width = Math.max(...list.map((c) => c.name.length));
  ctx.out("Airpocket doctor");
  ctx.out("");
  for (const c of list) {
    ctx.out(`${c.level.padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`);
    if (c.fix && c.level !== "PASS") ctx.out(`${" ".repeat(width + 8)}${c.fix}`);
  }
  const failed = list.filter((c) => c.level === "FAIL").length;
  ctx.out("");
  ctx.out(failed ? `${failed} problem${failed === 1 ? "" : "s"}.` : "Everything checks out.");
  return failed ? 1 : 0;
}

module.exports = { checks, runDoctor, codexUntrusted, commandWorks, looseFiles };

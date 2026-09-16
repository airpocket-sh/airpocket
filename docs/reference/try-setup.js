"use strict";
// Try setup, doctor and uninstall from the npm package, with the real launchd.
//
// `npm pack`s this repo, installs the tarball into a temporary prefix, and runs
// that installed copy's setup against a temporary HOME holding Claude Code and
// Codex configs with hooks of their own. launchd is the real one, under a
// throwaway label (sh.airpocket.trial) with its plist in the temp HOME and its
// own ports, so it can't meet a real Airpocket. Tailscale is stood in for (a
// table in memory): changing what this Mac publishes needs the owner's OK. The
// real ~/.claude/settings.json and ~/.codex/hooks.json are checked untouched.
//
//   setup: hooks merged (other hooks kept, backups written), login item running
//   the copy, both addresses on free ports; the hook command reaches it;
//   doctor passes; launchd restarts a killed service; with the data folder
//   held by someone else it waits instead of looping, and takes over after;
//   setup again adds nothing; uninstall gives back the original files.
//
//   node docs/reference/try-setup.js
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..", "..");
const LABEL = "sh.airpocket.trial";
const TS = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const DNS = "mac.tail1234.ts.net";
const REAL = [path.join(os.homedir(), ".claude", "settings.json"), path.join(os.homedir(), ".codex", "hooks.json")];
const mtimes = () => REAL.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } });
const realBefore = mtimes();

const tmp = fs.realpathSync(fs.mkdtempSync("/tmp/airpocket-try-setup-"));
const home = path.join(tmp, "home");
const t0 = Date.now();
const say = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { say(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };
async function until(fn, secs) { const end = Date.now() + secs * 1000; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(250); } }

const claudeText = JSON.stringify({ model: "sonnet", hooks: { Stop: [{ hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Hero.aiff" }] }],
  PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }] } }, null, 2) + "\n";
const codexText = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Glass.aiff" }] }] } }, null, 2) + "\n";

async function freeBase() {
  const free = (port) => new Promise((resolve) => { const s = net.createServer(); s.once("error", () => resolve(false)); s.listen(port, "127.0.0.1", () => s.close(() => resolve(true))); });
  for (let base = 48871; ; base += 10) if ((await free(base)) && (await free(base + 1)) && (await free(base + 2))) return base;
}

async function main() {
  // The package, installed from its tarball.
  execFileSync("npm", ["pack", "--pack-destination", tmp], { cwd: REPO, stdio: "ignore", env: { ...process.env, npm_config_cache: path.join(tmp, "npm") } });
  const tgz = fs.readdirSync(tmp).find((n) => n.endsWith(".tgz"));
  execFileSync("npm", ["install", "-g", "--prefix", path.join(tmp, "prefix"), path.join(tmp, tgz)], { stdio: "ignore", env: { ...process.env, npm_config_cache: path.join(tmp, "npm") } });
  const pkg = path.join(tmp, "prefix", "lib", "node_modules", "airpocket");
  check(fs.existsSync(path.join(tmp, "prefix", "bin", "airpocket")) && !fs.existsSync(path.join(pkg, "test")), `installed ${tgz} into a temp prefix (bin linked, no tests shipped)`);
  const setup = require(path.join(pkg, "src", "setup.js"));
  const doctor = require(path.join(pkg, "src", "doctor.js"));
  const li = require(path.join(pkg, "src", "loginitem.js"));

  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), claudeText);
  fs.writeFileSync(path.join(home, ".codex", "hooks.json"), codexText);

  // Tailscale, stood in for: 443 and 8443 publish something else, as on this Mac.
  const table = { TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } }, Web: {
    [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:47821" } } }, [`${DNS}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:47822" } } } } };
  const tsCalls = [];
  const real = require(path.join(pkg, "src", "tailscale.js")).runReal;
  const run = (bin, args, opts) => {
    if (bin !== TS) {
      if (bin === li.LAUNCHCTL && args.some((a) => a.includes("sh.airpocket.service"))) throw new Error("the trial must never touch the real label");
      return real(bin, args, opts);
    }
    tsCalls.push(args.join(" "));
    const ok = (s = "") => ({ status: 0, stdout: s, stderr: "" });
    if (args[0] === "status") return ok(JSON.stringify({ BackendState: "Running", Version: "1.102.4", Self: { DNSName: DNS + "." }, CertDomains: [DNS] }));
    if (args[1] === "status") return ok(JSON.stringify(table));
    const port = Number(args.find((a) => a.startsWith("--https=")).split("=")[1]);
    if (args[args.length - 1] === "off") { delete table.TCP[port]; delete table.Web[`${DNS}:${port}`]; return ok(); }
    table.TCP[port] = { HTTPS: true };
    table.Web[`${DNS}:${port}`] = { Handlers: { "/": { Proxy: args[args.length - 1] } } };
    return ok();
  };

  const base = await freeBase();
  const lines = [];
  const env = { HOME: home, PATH: process.env.PATH, AIRPOCKET_PORT: String(base) };
  const uid = process.getuid();
  const ctx = setup.context({ env, home, run, tailscaleBin: TS, label: LABEL, tty: false, color: false, root: pkg, waitMs: 30000,
    out: (l = "") => lines.push(l) });
  const P = ctx.paths;
  const flush = (indent = "    ") => { const t = lines.splice(0).join("\n"); return t.split("\n").map((l) => indent + l).join("\n"); };
  const print = () => launchctl(["print", `gui/${uid}/${LABEL}`]);
  const launchctl = (args) => spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  const job = () => li.jobStatus(run, uid, LABEL);

  try {
    // Setup.
    const code = await setup.runSetup(ctx);
    const out = flush();
    console.log("\n  --- airpocket setup (temp HOME) ---\n" + out.replace(/(Pairing code {3})\d{3} \d{3}/, "$1### ###") + "\n");
    check(code === 0, "setup finished");
    const redact = (t) => t.split(tmp).join("<tmp>");
    console.log("  --- what setup wrote: ~/.codex/hooks.json ---\n" + redact(fs.readFileSync(P.codex, "utf8")).replace(/^/gm, "    "));
    console.log("  --- ~/Library/LaunchAgents/" + LABEL + ".plist ---\n" + redact(fs.readFileSync(P.plist, "utf8")).replace(/^/gm, "    "));
    console.log("  --- install.json ---\n" + redact(fs.readFileSync(P.install, "utf8")).replace(/^/gm, "    "));
    console.log("  --- the data folder ---\n" + redact(spawnSync("/bin/ls", ["-la", P.dataDir], { encoding: "utf8" }).stdout).replace(/^/gm, "    "));
    const claude = JSON.parse(fs.readFileSync(P.claude, "utf8"));
    check(claude.model === "sonnet" && claude.hooks.Stop[0].hooks[0].command.startsWith("afplay") && claude.hooks.PreToolUse[0].hooks[0].command === "rtk hook claude"
      && claude.hooks.Stop.length === 2 && /# airpocket-hook$/.test(claude.hooks.Stop[1].hooks[0].command), "Claude's other hooks kept in place, ours appended");
    const backups = (f) => fs.readdirSync(path.dirname(f)).filter((n) => n.includes(".airpocket-backup-"));
    check(backups(P.claude).length === 1 && backups(P.codex).length === 1, "a backup of each file");
    const j = job();
    check(j.loaded && j.pid > 0 && setup.readLock(ctx).pid === j.pid, `real launchd runs the service (process ${j.pid}) and it holds the data folder`);
    check(table.Web[`${DNS}:443`].Handlers["/"].Proxy === "http://127.0.0.1:47821" && tsCalls.some((c) => c.includes("--https=4443")), "443 and 8443 left to their owner; 4443 and 5443 chosen");
    check(!tsCalls.some((c) => c.includes("funnel")), "never funnel");

    // The hook command as written, run the way the agent runs it.
    const sid = "7e1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const r = spawnSync("/bin/sh", ["-c", claude.hooks.SessionStart[0].hooks[0].command], { input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sid, cwd: tmp }),
      env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    check(r.status === 0 && !r.stdout && !r.stderr && !!(await until(() => fs.existsSync(path.join(P.dataDir, "sessions", sid + ".json")), 5)), "the Claude hook command, run by sh, reaches the login item's service");

    // Doctor.
    const dcode = await doctor.runDoctor(ctx);
    const report = flush();
    console.log("\n  --- airpocket doctor ---\n" + report + "\n");
    check(dcode === 0, "doctor passes");

    // A crash: launchd starts it again.
    const pid1 = j.pid;
    process.kill(pid1, "SIGKILL");
    say("killed the service; launchd waits ThrottleInterval (30 s) before starting it again");
    const back = await until(async () => { const x = job(); return x.pid && x.pid !== pid1 && (await setup.probe(base, "/manifest.webmanifest")) === 200 ? x : null; }, 45);
    check(!!back, `restarted after a crash (process ${back && back.pid}, runs ${back && back.runs})`);

    // Someone else holds the data folder: it waits, it doesn't loop.
    launchctl(["bootout", `gui/${uid}/${LABEL}`]);
    await until(() => !job().loaded, 10);
    fs.writeFileSync(P.lock, `${process.pid} ${require(path.join(pkg, "src", "proc.js")).startTimeOf(process.pid)}`, { mode: 0o600 });
    launchctl(["bootstrap", `gui/${uid}`, P.plist]);
    say("the data folder is held by this trial; watching launchd for 40 s");
    await sleep(40000);
    const w = job();
    const runs = /runs = (\d+)/.exec(print().stdout);
    check(w.pid > 0 && runs && Number(runs[1]) === 1, `held folder: one run, still waiting (process ${w.pid}, runs ${runs && runs[1]})`);
    check(/Waiting for it to stop/.test(fs.readFileSync(P.logFile, "utf8")), "the log says it waits");
    fs.unlinkSync(P.lock);
    const took = await until(async () => (setup.readLock(ctx) || {}).pid === w.pid && (await setup.probe(base, "/manifest.webmanifest")) === 200, 70);
    check(!!took, "the lock freed: the same process took the folder over");

    // Setup again: nothing new.
    await setup.runSetup(ctx);
    const again = flush();
    const claude2 = JSON.parse(fs.readFileSync(P.claude, "utf8"));
    check(/already has Airpocket's hooks/.test(again) && claude2.hooks.Stop.length === 2 && backups(P.claude).length === 1, "setup twice: one entry each, no new backup");

    // Uninstall.
    const before = { claude: fs.readFileSync(P.claude, "utf8"), codex: fs.readFileSync(P.codex, "utf8") };
    const ucode = await setup.runUninstall(ctx, ["--keep-data"]);
    const gone = flush();
    console.log("\n  --- airpocket uninstall --keep-data ---\n" + gone + "\n");
    check(ucode === 0 && !job().loaded && !fs.existsSync(P.plist), "the login item is unloaded and its plist gone");
    check(fs.readFileSync(P.claude, "utf8") === claudeText && fs.readFileSync(P.codex, "utf8") === codexText, "both config files are byte for byte what they were before setup");
    check(Object.keys(table.Web).length === 2 && table.Web[`${DNS}:443`], "only our two addresses were turned off");
    console.log("  --- settings.json while installed, then after uninstall (diff) ---");
    fs.writeFileSync(path.join(tmp, "installed.json"), before.claude);
    console.log(spawnSync("/usr/bin/diff", ["-u", path.join(tmp, "installed.json"), P.claude], { encoding: "utf8" }).stdout.replace(new RegExp(tmp, "g"), "<tmp>").split("\n").map((l) => "    " + l).join("\n"));
    const u2 = await setup.runUninstall(ctx, ["--keep-data"]);
    check(u2 === 0 && /Nothing of Airpocket's setup is installed here/.test(flush()), "uninstall twice is harmless");
  } finally {
    launchctl(["bootout", `gui/${uid}/${LABEL}`]);
    check(JSON.stringify(mtimes()) === JSON.stringify(realBefore), "the real ~/.claude/settings.json and ~/.codex/hooks.json are untouched");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} failed` : "\nall passed");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`]); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(1); });

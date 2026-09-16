"use strict";
// airpocket setup, doctor and uninstall, run for real against a temporary HOME.
//
// Two things are stood in for, because they are this Mac's own and shared:
//   - launchctl: a small launchd that reads the plist setup wrote (with plutil),
//     starts the real service from its ProgramArguments and environment, keeps
//     it alive the way KeepAlive/SuccessfulExit says, and stops it on bootout.
//   - Tailscale: an in-memory `serve` table answering status and serve commands.
// Every test's HOME, data folder and ports are its own. The real
// ~/.claude/settings.json and ~/.codex/hooks.json are never read or written:
// the last test checks their modification times.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const setup = require("../src/setup");
const doctor = require("../src/doctor");
const cfg = require("../src/agentconfig");
const li = require("../src/loginitem");
const ts = require("../src/tailscale");
const { startTimeOf } = require("../src/proc");

const ROOT = path.join(__dirname, "..");
const TS = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const DNS = "mac.tail1234.ts.net";
const REAL_HOME = os.userInfo().homedir;
const REAL_FILES = [path.join(REAL_HOME, ".claude", "settings.json"), path.join(REAL_HOME, ".codex", "hooks.json"),
  path.join(REAL_HOME, ".zshrc"), path.join(REAL_HOME, ".bash_profile")];
const mtimes = () => REAL_FILES.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } });
const REAL_BEFORE = mtimes();

const temps = [];
const cleanups = [];
// Under /tmp rather than the per-user temp folder, whose long path would put the data folder's socket over macOS's 104 bytes.
const tempDir = (p = "airpocket-setup-") => { const d = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", p))); temps.push(d); return d; };
test.after(async () => {
  for (const c of cleanups.reverse()) await c();
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out: " + what); await wait(100); }
}

/** Three free loopback ports in a row, for one test's app, file and hook servers. */
async function freeBase() {
  const free = (port) => new Promise((resolve) => { const s = net.createServer(); s.once("error", () => resolve(false)); s.listen(port, "127.0.0.1", () => s.close(() => resolve(true))); });
  for (;;) {
    const base = 49200 + Math.floor(Math.random() * 12000);
    if ((await free(base)) && (await free(base + 1)) && (await free(base + 2))) return base;
  }
}

/** Every file and folder under a root, with its content, for "nothing changed" checks. */
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n), st = fs.lstatSync(p);
      out[path.relative(root, p)] = st.isDirectory() ? "dir" : fs.readFileSync(p, "utf8") + ` (${(st.mode & 0o777).toString(8)})`;
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

/**
 * A stand-in for this Mac's launchctl and Tailscale. launchd's part starts the real
 * service. `throttleMs` stands for ThrottleInterval, shortened.
 */
function fakeMac({ serve = { TCP: {}, Web: {} }, backend = "Running", certs = true, throttleMs = 150, serveFails = 0, neverServed = false } = {}) {
  const calls = [];
  const jobs = new Map();                      // label -> { def, child, pid, runs, exit, stopped }
  const table = JSON.parse(JSON.stringify(serve));
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const no = (status, stderr) => ({ status, stdout: "", stderr });

  function startJob(job) {
    const [bin, ...args] = job.def.ProgramArguments;
    const log = fs.openSync(job.def.StandardOutPath, "a", 0o600);
    job.child = spawn(bin, args, { cwd: job.def.WorkingDirectory, env: { ...job.def.EnvironmentVariables, HOME: job.home }, stdio: ["ignore", log, log] });
    fs.closeSync(log);
    job.pid = job.child.pid;
    job.runs++;
    job.child.on("exit", (code) => {
      job.pid = 0;
      job.exit = code ?? 128;
      // KeepAlive { SuccessfulExit: false }: start it again after an error, never after a clean exit or a bootout.
      if (!job.stopped && job.def.KeepAlive && job.def.KeepAlive.SuccessfulExit === false && code !== 0) {
        setTimeout(() => { if (!job.stopped) startJob(job); }, throttleMs);
      }
    });
  }
  function stopJob(job) {
    job.stopped = true;
    if (!job.pid) return;
    const pid = job.pid;
    process.kill(pid, "SIGTERM");
    // Wait for it to exit (a zombie counts as exited: node reaps it later).
    spawnSync("/bin/sh", ["-c", `for i in $(seq 1 100); do s=$(ps -o stat= -p ${pid}); case "$s" in ""|Z*) exit 0;; esac; sleep 0.05; done`]);
  }

  function run(bin, args, opts = {}) {
    calls.push([bin, ...args]);
    if (args.includes("funnel")) throw new Error("funnel must never run");
    if (bin === "/usr/bin/sw_vers") return ok("26.0\n");
    if (bin === li.LAUNCHCTL) {
      const [verb, a, b] = args;
      const label = (verb === "bootstrap" ? "" : a.split("/").pop());
      if (verb === "print") {
        const job = jobs.get(label);
        if (!job || job.stopped) return no(113, `Could not find service "${label}"`);
        return ok(`${a} = {\n\tstate = ${job.pid ? "running" : "not running"}\n\truns = ${job.runs}\n${job.pid ? `\tpid = ${job.pid}\n` : ""}${job.exit !== null ? `\tlast exit code = ${job.exit}\n` : ""}}\n`);
      }
      if (verb === "bootout") {
        const job = jobs.get(label);
        if (!job || job.stopped) return no(3, "Boot-out failed: 3: No such process");
        stopJob(job);
        jobs.delete(label);
        return ok();
      }
      if (verb === "bootstrap") {
        const r = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", b], { encoding: "utf8" });
        if (r.status !== 0) return no(5, "Bootstrap failed: 5: Input/output error");
        const def = JSON.parse(r.stdout);
        if (jobs.has(def.Label)) return no(5, "Bootstrap failed: 5: Input/output error");
        const job = { def, home: fakeMac.home, child: null, pid: 0, runs: 0, exit: null, stopped: false };
        jobs.set(def.Label, job);
        if (def.RunAtLoad) startJob(job);
        return ok();
      }
      return no(1, "unknown");
    }
    if (bin === TS) {
      if (args[0] === "status") {
        return ok(JSON.stringify({ BackendState: backend, Version: "1.102.4-tabc", Self: { DNSName: backend === "Running" ? DNS + "." : "" }, CertDomains: certs ? [DNS] : null }));
      }
      // A Mac that never published anything prints "null".
      if (args[0] === "serve" && args[1] === "status") return ok(neverServed && !Object.keys(table.TCP).length ? "null\n" : JSON.stringify(table));
      if (args[0] === "serve") {
        const https = args.find((x) => x.startsWith("--https="));
        const port = Number(https.split("=")[1]);
        if (args[args.length - 1] === "off") {
          delete table.TCP[port];
          delete table.Web[`${DNS}:${port}`];
          return ok();
        }
        assert.ok(args.includes("--bg"), "serve runs in the background");
        if (serveFails && serveFails-- > 0) return no(1, "serve: something went wrong");
        table.TCP[port] = { HTTPS: true };
        table.Web[`${DNS}:${port}`] = { Handlers: { "/": { Proxy: args[args.length - 1] } } };
        return ok();
      }
      return no(1, "unknown");
    }
    return ts.runReal(bin, args, opts);            // node --version and anything else harmless
  }
  const mac = { run, calls, jobs, table, stopAll: () => { for (const job of jobs.values()) stopJob(job); } };
  cleanups.push(() => mac.stopAll());
  return mac;
}

/** A temporary HOME with Claude Code and Codex folders, and a context pointed at it and at a fake Mac. */
async function world({ claude, codex, mac: macOpts, env: extraEnv = {} } = {}) {
  const home = tempDir("airpocket-home-");
  fs.mkdirSync(path.join(home, ".claude"));
  fs.mkdirSync(path.join(home, ".codex"));
  if (claude !== undefined) fs.writeFileSync(path.join(home, ".claude", "settings.json"), claude);
  if (codex !== undefined) fs.writeFileSync(path.join(home, ".codex", "hooks.json"), codex);
  const mac = fakeMac(macOpts);
  fakeMac.home = home;
  const base = await freeBase();
  const lines = [];
  const env = { HOME: home, PATH: process.env.PATH, AIRPOCKET_PORT: String(base), ...extraEnv };
  const ctx = setup.context({ env, home, run: mac.run, tailscaleBin: TS, tty: false, color: false, uid: 501, waitMs: 15000,
    out: (l = "") => lines.push(l), tmuxBins: ["/nonexistent/tmux"] });
  assert.ok(!ctx.paths.claude.startsWith(REAL_HOME + "/"), "never the real home");
  const output = () => { const t = lines.join("\n"); lines.length = 0; return t; };
  return { home, mac, ctx, output, base };
}
async function setupOk(w) { const code = await setup.runSetup(w.ctx); const out = w.output(); assert.equal(code, 0, out); return out; }
const json = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const mutations = (mac) => mac.calls.filter(([bin, ...a]) => (bin === li.LAUNCHCTL && a[0] !== "print") || (bin === TS && a[0] === "serve" && a[1] !== "status"));

test("dry run: prints every change and touches nothing", async () => {
  const w = await world({ claude: '{"model":"opus"}\n' });
  const before = snapshot(w.home);
  assert.equal(await setup.runSetup(w.ctx, ["--dry-run"]), 0);
  const out = w.output();
  for (const want of ["dry run", "Data folder", "copy airpocket", "~/.claude/settings.json: merge into it", "~/.codex/hooks.json: create it",
    "add SessionStart, UserPromptSubmit, Stop, Notification, SessionEnd", "add SessionStart, UserPromptSubmit, Stop, PermissionRequest, Interrupt, SessionEnd",
    "sh.airpocket.service.plist", "--login-item", `https://${DNS}:443 -> 127.0.0.1:${w.base}`, `https://${DNS}:8443 -> 127.0.0.1:${w.base + 1}`,
    "never funnel", "Nothing was changed"]) {
    assert.ok(out.includes(want), `dry run mentions ${want}\n${out}`);
  }
  assert.deepEqual(snapshot(w.home), before, "HOME unchanged");
  assert.deepEqual(mutations(w.mac), [], "no launchctl or serve changes");
});

test("setup stops before changing anything when a requirement is missing", async () => {
  const cases = [
    [{ platform: "linux" }, /runs on macOS/],
    [{ nodeVersion: "18.19.0" }, /needs Node 20 or newer/],
    [{ tailscaleBin: null }, /Tailscale is not installed/],
    [{ mac: { backend: "NeedsLogin" } }, /not signed in \(it says NeedsLogin\)/],
    [{ mac: { certs: false } }, /no HTTPS certificates/],
  ];
  for (const [opts, want] of cases) {
    const w = await world({ mac: opts.mac });
    const ctx = setup.context({ ...w.ctx, env: w.ctx.env, home: w.home, run: w.mac.run, out: w.ctx.out, tty: false, uid: 501, tmuxBins: w.ctx.tmuxBins,
      tailscaleBin: "tailscaleBin" in opts ? opts.tailscaleBin : TS, platform: opts.platform, nodeVersion: opts.nodeVersion });
    const before = snapshot(w.home);
    assert.equal(await setup.runSetup(ctx), 1);
    const out = w.output();
    assert.match(out, want);
    assert.match(out, /stopped before changing anything/);
    assert.deepEqual(snapshot(w.home), before);
    assert.deepEqual(mutations(w.mac), []);
  }
});

test("a config that is not valid JSON is refused, and nothing at all is written", async () => {
  const broken = '{\n  "model": "opus",\n  "hooks": { oops }\n';
  const w = await world({ claude: broken, codex: '{"hooks":{}}' });
  const before = snapshot(w.home);
  assert.equal(await setup.runSetup(w.ctx), 1);
  const out = w.output();
  assert.match(out, /~\/\.claude\/settings\.json is not valid JSON/);
  assert.match(out, /won't change a file it can't read as JSON/);
  assert.deepEqual(snapshot(w.home), before, "not even the other agent's file or a data folder");
  assert.equal(fs.readFileSync(path.join(w.home, ".claude", "settings.json"), "utf8"), broken);
  assert.deepEqual(mutations(w.mac), []);
});

test("fresh install: hooks, a running login item, two addresses, a pairing code; doctor passes; uninstall leaves nothing", async () => {
  const w = await world();
  const P = w.ctx.paths;
  const out = await setupOk(w);
  assert.match(out, /Pairing code {3}\d{3} \d{3}/);
  assert.match(out, new RegExp(`open https://${DNS.replace(/\./g, "\\.")} and enter it`), "443 was free: no port in the address");
  assert.match(out, /Airpocket is set up/);

  // The data folder and install record.
  assert.equal(fs.statSync(P.dataDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(P.install).mode & 0o777, 0o600);
  const install = json(P.install);
  assert.deepEqual(install.ports, { app: w.base, file: w.base + 1, hook: w.base + 2, publicApp: 443, publicFile: 8443 });
  assert.ok(fs.existsSync(path.join(P.appDir, "src", "hook.js")), "the copy is there");
  assert.equal(fs.existsSync(path.join(P.appDir, "test")), false, "only what runs is copied");
  assert.ok(fs.existsSync(path.join(P.dataDir, "pairing.json")));

  // The hooks, in files setup created.
  const claude = json(P.claude), codex = json(P.codex);
  assert.deepEqual(Object.keys(claude.hooks), cfg.EVENTS.claude);
  assert.deepEqual(Object.keys(codex.hooks), cfg.EVENTS.codex);
  assert.match(claude.hooks.Stop[0].hooks[0].command, /'\/.*\/Library\/Application Support\/Airpocket\/app\/src\/hook\.js' claude # airpocket-hook$/);
  assert.equal(install.hooks[P.claude].createdFile, true);

  // The login item: a real service, from the plist, holding the lock and answering.
  assert.equal(spawnSync("/usr/bin/plutil", ["-lint", P.plist]).status, 0);
  const def = JSON.parse(spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", P.plist], { encoding: "utf8" }).stdout);
  assert.deepEqual(def.KeepAlive, { SuccessfulExit: false });
  assert.equal(def.ThrottleInterval, 30);
  assert.equal(def.RunAtLoad, true);
  assert.equal(def.ProgramArguments[2], "--login-item");
  assert.equal(def.StandardErrorPath, P.logFile);
  const job = w.mac.jobs.get(li.LABEL);
  assert.ok(job.pid, "running");
  assert.equal(setup.readLock(w.ctx).pid, job.pid);
  assert.equal(await setup.probe(w.base, "/manifest.webmanifest"), 200);

  // The hook command, as the agent's shell runs it, reaches the service.
  const sid = "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const r = spawnSync("/bin/sh", ["-c", claude.hooks.SessionStart[0].hooks[0].command], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sid, cwd: w.home }), env: { HOME: w.home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, "", "silent");
  await until("the session is recorded", () => fs.existsSync(path.join(P.dataDir, "sessions", sid + ".json")));

  // Tailscale: serve only, on the two ports.
  assert.ok(ts.oursOn(w.mac.table, 443, `http://127.0.0.1:${w.base}`));
  assert.ok(ts.oursOn(w.mac.table, 8443, `http://127.0.0.1:${w.base + 1}`));
  assert.ok(!w.mac.calls.some((c) => c.includes("funnel")));

  // Doctor: everything passes (Codex's hook review is a warning: nobody trusted them in a fake Codex).
  const code = await doctor.runDoctor(w.ctx);
  const report = w.output();
  assert.equal(code, 0, report);
  assert.doesNotMatch(report, /^FAIL/m);
  for (const name of ["Data folder", "Socket path", "Lock", "Login item", "App port", "File port", "Hook port", "Claude Code hooks", "Codex hooks", "Tailscale addresses"]) {
    assert.match(report, new RegExp(`^PASS  ${name}`, "m"), name);
  }
  assert.match(report, /^WARN  Codex hook review +not reviewed yet/m);
  assert.match(report, /^WARN  tmux +not installed: airpocket run and sessions in tmux need it\n +brew install tmux$/m);

  // Uninstall, removing the data folder too.
  assert.equal(await setup.runUninstall(w.ctx, ["--remove-data"]), 0);
  const gone = w.output();
  for (const want of ["removed: Login item", "removed: Tailscale", "removed: Claude Code hooks", "removed: Codex hooks", "removed: Airpocket itself", "removed: the data folder"]) {
    assert.ok(gone.includes(want), `${want}\n${gone}`);
  }
  assert.equal(fs.existsSync(P.plist), false);
  assert.equal(fs.existsSync(P.dataDir), false);
  assert.equal(fs.existsSync(P.claude), false, "setup created it, and it held only our hooks");
  assert.equal(fs.existsSync(P.codex), false);
  assert.deepEqual(w.mac.table, { TCP: {}, Web: {} });
  assert.equal(w.mac.jobs.size, 0);
  assert.equal(await setup.probe(w.base, "/manifest.webmanifest"), 0, "the service stopped");

  // Twice is harmless.
  assert.equal(await setup.runUninstall(w.ctx, ["--remove-data"]), 0);
  assert.match(w.output(), /Nothing of Airpocket's setup is installed here/);
});

test("over an existing config: other hooks survive, setup twice adds nothing, uninstall gives back the original", async () => {
  const claudeText = JSON.stringify({
    model: "opus", env: { FOO: "1" },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }],
      Stop: [{ hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Hero.aiff" }] }],
      Notification: [{ hooks: [{ type: "command", command: "$HOME/.claude/hooks/attention.sh", timeout: 10 }] }],
    },
    statusLine: { type: "command", command: "line.sh" },
  }, null, 4) + "\n";
  const codexText = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"afplay x"}]}],"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"check.sh","statusMessage":"Checking"}]}]}}';
  // 443 and 8443 are published by another program, as on Öncel's Mac.
  const serve = { TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } }, Web: {
    [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:47821" } } },
    [`${DNS}:8443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:47822" } } } } };
  const w = await world({ claude: claudeText, codex: codexText, mac: { serve } });
  const P = w.ctx.paths;

  const out = await setupOk(w);
  assert.match(out, /:4443 -> .* the app \(443 and 8443 are taken by something else\)/);
  assert.match(out, new RegExp(`open https://${DNS.replace(/\./g, "\\.")}:4443 and enter it`));
  assert.deepEqual(w.mac.table.Web[`${DNS}:443`], serve.Web[`${DNS}:443`], "the other program's address is untouched");
  assert.deepEqual(w.mac.table.Web[`${DNS}:8443`], serve.Web[`${DNS}:8443`]);
  assert.equal(json(P.install).ports.publicFile, 5443);

  // Everything that was there is still there, in its place; ours come after.
  const claude = json(P.claude), original = JSON.parse(claudeText);
  assert.deepEqual({ ...claude, hooks: undefined }, { ...original, hooks: undefined });
  assert.deepEqual(claude.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.deepEqual(claude.hooks.Stop[0], original.hooks.Stop[0]);
  assert.deepEqual(claude.hooks.Notification[0], original.hooks.Notification[0]);
  assert.ok(cfg.isOurs(claude.hooks.Stop[1].hooks[0]));
  assert.match(fs.readFileSync(P.claude, "utf8"), /^\{\n {4}"model"/, "kept its four-space indent");
  const codex = json(P.codex);
  assert.deepEqual(codex.hooks.PreToolUse, JSON.parse(codexText).hooks.PreToolUse);
  assert.equal(codex.hooks.Stop[0].hooks[0].command, "afplay x", "the user's Codex hook keeps position 0, so Codex's trust in it stays");

  // Backups, written before the change, hold the original text.
  const backups = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(path.basename(file) + ".airpocket-backup-")).map((n) => path.join(path.dirname(file), n));
  assert.equal(backups(P.claude).length, 1);
  assert.equal(fs.readFileSync(backups(P.claude)[0], "utf8"), claudeText);
  assert.equal(fs.readFileSync(backups(P.codex)[0], "utf8"), codexText);

  // Setup again: one of each, no new backup, the same addresses, the service restarted from the new copy.
  const firstPid = w.mac.jobs.get(li.LABEL).pid;
  const again = await setupOk(w);
  assert.match(again, /already has Airpocket's hooks/);
  assert.match(again, /published like this already/);
  for (const [file, agent] of [[P.claude, "claude"], [P.codex, "codex"]]) {
    for (const [event, s] of Object.entries(cfg.hookState(json(file), agent))) assert.equal(s.count, 1, `${agent} ${event}`);
    assert.equal(backups(file).length, 1, "nothing changed, so no second backup");
  }
  assert.equal(Object.keys(w.mac.table.Web).length, 4);
  assert.notEqual(w.mac.jobs.get(li.LABEL).pid, firstPid);
  assert.equal(await setup.probe(w.base, "/manifest.webmanifest"), 200);

  // Uninstall, keeping the data folder: the files equal what they were before setup, but for formatting.
  assert.equal(await setup.runUninstall(w.ctx, ["--keep-data"]), 0);
  const gone = w.output();
  assert.match(gone, /Kept the data folder/);
  assert.match(gone, /Backups of your config files stay where they are/);
  assert.deepEqual(json(P.claude), JSON.parse(claudeText));
  assert.deepEqual(json(P.codex), JSON.parse(codexText));
  assert.equal(fs.readFileSync(P.claude, "utf8"), claudeText, "the same indent, so here even byte for byte");
  assert.deepEqual(w.mac.table, serve, "only our two addresses went");
  assert.ok(fs.existsSync(path.join(P.dataDir, "pairing.json")), "the data folder stays");
  assert.equal(fs.existsSync(P.appDir), false);
  assert.equal(fs.existsSync(P.install), false);

  assert.equal(await setup.runUninstall(w.ctx, ["--keep-data"]), 0);
  assert.match(w.output(), /Nothing of Airpocket's setup is installed here/);
});

test("setup refuses when another Airpocket already runs, or a port is taken", async () => {
  const w = await world();
  fs.mkdirSync(w.ctx.paths.dataDir, { recursive: true });
  fs.writeFileSync(w.ctx.paths.lock, `${process.pid} ${startTimeOf(process.pid)}`);
  assert.equal(await setup.runSetup(w.ctx), 1);
  assert.match(w.output(), new RegExp(`already running as process ${process.pid}, not as the login item`));
  fs.unlinkSync(w.ctx.paths.lock);

  const blocker = net.createServer().listen(w.base + 1, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  cleanups.push(() => new Promise((r) => blocker.close(r)));
  assert.equal(await setup.runSetup(w.ctx), 1);
  assert.match(w.output(), new RegExp(`Port ${w.base + 1} on 127.0.0.1 \\(file\\) is already taken`));
  assert.deepEqual(mutations(w.mac), []);
});

test("the login item never restart-loops on a data folder another Airpocket holds", async () => {
  const w = await world();
  const P = w.ctx.paths;
  fs.mkdirSync(path.dirname(P.logFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(P.lock, `${process.pid} ${startTimeOf(process.pid)}`);   // held by a live process: this test
  const item = (args) => {
    const { xml } = li.loginItem({ node: process.execPath, appDir: ROOT, dataDir: P.dataDir, logFile: P.logFile,
      env: { AIRPOCKET_PORT: String(w.base), AIRPOCKET_LOCK_RETRY_MS: "300" }, label: "sh.airpocket.test" });
    const file = path.join(w.home, "item.plist");
    fs.writeFileSync(file, args ? xml : xml.replace("<string>--login-item</string>", "<string>--by-hand</string>"));
    return file;
  };

  // Started by hand, it exits with its own code at once.
  const byHand = spawnSync(process.execPath, [path.join(ROOT, "src", "server.js")], { env: { PATH: process.env.PATH, HOME: w.home, AIRPOCKET_DIR: P.dataDir, AIRPOCKET_PORT: String(w.base) }, encoding: "utf8", timeout: 10000 });
  assert.equal(byHand.status, li.EXIT_LOCKED);
  assert.match(byHand.stderr, /already running/);

  // Without --login-item, launchd's KeepAlive would start it again and again: the loop this avoids.
  assert.equal(w.mac.run(li.LAUNCHCTL, ["bootstrap", "gui/501", item(false)]).status, 0);
  await wait(1500);
  const looping = w.mac.jobs.get("sh.airpocket.test");
  assert.ok(looping.runs >= 3, `started ${looping.runs} times`);
  w.mac.run(li.LAUNCHCTL, ["bootout", "gui/501/sh.airpocket.test"]);

  // As the login item: started once, still there, waiting; nothing written but its log.
  fs.writeFileSync(P.logFile, "");
  assert.equal(w.mac.run(li.LAUNCHCTL, ["bootstrap", "gui/501", item(true)]).status, 0);
  await wait(1500);
  const job = w.mac.jobs.get("sh.airpocket.test");
  assert.equal(job.runs, 1, "started once");
  assert.ok(job.pid, "still running");
  assert.match(fs.readFileSync(P.logFile, "utf8"), /already running .* Waiting for it to stop/);
  assert.equal(fs.existsSync(P.hookFile), false, "it holds nothing yet");
  assert.equal(await setup.probe(w.base, "/manifest.webmanifest"), 0);

  // The other one stops: the login item takes the folder over.
  fs.unlinkSync(P.lock);
  await until("the login item takes over", async () => setup.readLock(w.ctx) && setup.readLock(w.ctx).pid === job.pid && (await setup.probe(w.base, "/manifest.webmanifest")) === 200);
  assert.equal(job.runs, 1);
  assert.match(fs.readFileSync(P.logFile, "utf8"), /took it over/);
  w.mac.run(li.LAUNCHCTL, ["bootout", "gui/501/sh.airpocket.test"]);
  await until("it exits", () => job.exit !== null);
  assert.equal(job.exit, 0, "a bootout is a clean exit, so launchd leaves it stopped");
});

test("doctor: a broken service, a missing hook and a stale lock each fail, with what to do", async () => {
  const w = await world();
  await setupOk(w);
  const P = w.ctx.paths;
  const report = async () => { const code = await doctor.runDoctor(w.ctx); return { code, text: w.output() }; };

  // A missing hook.
  const claude = json(P.claude);
  delete claude.hooks.Stop;
  fs.writeFileSync(P.claude, JSON.stringify(claude, null, 2));
  let r = await report();
  assert.equal(r.code, 1);
  assert.match(r.text, /^FAIL  Claude Code hooks +~\/\.claude\/settings\.json is missing Stop\n +Run airpocket setup\./m);

  // A broken service: the job runs, but its ports don't answer (stopped by a signal launchd doesn't see).
  const job = w.mac.jobs.get(li.LABEL);
  process.kill(job.pid, "SIGSTOP");
  cleanups.push(() => { try { process.kill(job.pid, "SIGCONT"); } catch {} });
  r = await report();
  assert.equal(r.code, 1);
  assert.match(r.text, /^PASS  Lock +held by process/m);
  assert.match(r.text, new RegExp(`^FAIL  App port +127\\.0\\.0\\.1:${w.base} doesn't answer`, "m"));
  assert.match(r.text, /^FAIL  Hook port/m);
  process.kill(job.pid, "SIGCONT");

  // A stale lock: the service is gone and its lock left behind.
  w.mac.run(li.LAUNCHCTL, ["bootout", `gui/501/${li.LABEL}`]);
  fs.writeFileSync(P.lock, "999999 1700000000000", { mode: 0o600 });
  r = await report();
  assert.equal(r.code, 1);
  assert.match(r.text, /^FAIL  Lock +stale: process 999999 is gone\n +The service takes a stale lock over when it starts/m);
  assert.match(r.text, /^FAIL  Login item +installed but not loaded/m);

  // Another program on the file port: it answers, but it isn't the service.
  const impostor = require("http").createServer((req, res) => { res.writeHead(404); res.end(); }).listen(w.base + 1, "127.0.0.1");
  await new Promise((ok) => impostor.once("listening", ok));
  r = await report();
  assert.match(r.text, new RegExp(`^FAIL  File port +127\\.0\\.0\\.1:${w.base + 1} is answered by process ${process.pid}, not the service holding the lock`, "m"));
  await new Promise((ok) => impostor.close(ok));

  // Loose permissions and a Tailscale address that went away.
  fs.chmodSync(P.install, 0o644);
  ts.serveOff(TS, 8443, w.mac.run);
  r = await report();
  assert.match(r.text, /^FAIL  Data folder +readable by others: install\.json 644/m);
  assert.match(r.text, /^FAIL  Tailscale addresses +port 8443 doesn't publish the file/m);
  assert.match(r.text, /problems\.$/);
});

test("doctor reads Codex's trust in our hooks from config.toml", () => {
  const home = tempDir();
  const file = path.join(home, ".codex", "hooks.json");
  fs.mkdirSync(path.dirname(file));
  const cmd = cfg.hookCommand({ node: "/n", hook: "/h", agent: "codex" });
  const config = cfg.addHooks({ hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } }, "codex", cmd).config;
  const state = cfg.hookState(config, "codex");
  const ctx = { paths: { codex: file } };
  assert.deepEqual(doctor.codexUntrusted(ctx, file, state), [...cfg.EVENTS.codex], "no config.toml: nothing trusted");
  const toml = cfg.EVENTS.codex.filter((e) => e !== "Interrupt").map((e) => {
    const snake = e.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
    const at = state[e].at;
    return `[hooks.state."${file}:${snake}:${at.group}:${at.index}"]\ntrusted_hash = "sha256:00"\n`;
  }).join("\n");
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), `model = "x"\n\n[hooks.state]\n\n${toml}`);
  assert.equal(state.Stop.at.group, 1, "ours come after the user's Stop hook");
  assert.deepEqual(doctor.codexUntrusted(ctx, file, state), ["Interrupt"]);
});

test("a Mac that never used tailscale serve (status prints null) sets up, and uninstalls", async () => {
  const w = await world({ mac: { neverServed: true } });
  await setupOk(w);
  assert.ok(ts.oursOn(w.mac.table, 443, `http://127.0.0.1:${w.base}`));
  assert.equal(await setup.runUninstall(w.ctx, ["--remove-data"]), 0);
  assert.match(w.output(), /removed: Tailscale/);
  assert.deepEqual(w.mac.table, { TCP: {}, Web: {} });
});

test("a setup that stopped half way is still removed whole by uninstall", async () => {
  const claudeText = '{\n  "theme": "dark"\n}\n';
  const w = await world({ claude: claudeText, mac: { serveFails: 1 } });
  const P = w.ctx.paths;
  assert.equal(await setup.runSetup(w.ctx), 1);
  const out = w.output();
  assert.match(out, /6\. Tailscale: FAILED\n +tailscale serve on port 443 failed: serve: something went wrong/);
  assert.match(out, /airpocket uninstall removes it/);
  assert.ok(w.mac.jobs.get(li.LABEL).pid, "the steps before it were done");
  assert.equal(await setup.runUninstall(w.ctx, ["--remove-data"]), 0);
  w.output();
  assert.equal(fs.readFileSync(P.claude, "utf8"), claudeText);
  assert.equal(fs.existsSync(P.codex), false);
  assert.equal(fs.existsSync(P.plist), false);
  assert.equal(fs.existsSync(P.dataDir), false);
  assert.deepEqual(w.mac.table, { TCP: {}, Web: {} });
});

test("uninstall: a config that changes meanwhile isn't overwritten, and the copy and the record stay for the next try", async () => {
  const w = await world({ claude: '{"model":"opus"}' });
  const P = w.ctx.paths;
  await setupOk(w);
  // Claude Code writes its settings just as uninstall is about to (the plan is printed, then applied).
  let touched = false;
  const ctx = setup.context({ env: w.ctx.env, home: w.home, run: w.mac.run, tailscaleBin: TS, tty: false, color: false, uid: 501, tmuxBins: w.ctx.tmuxBins,
    out: (l = "") => { if (!touched && /Claude Code hooks/.test(l)) { touched = true; const c = json(P.claude); c.effortLevel = "high"; fs.writeFileSync(P.claude, JSON.stringify(c)); } } });
  assert.equal(await setup.runUninstall(ctx, ["--keep-data"]), 1);
  assert.equal(json(P.claude).effortLevel, "high", "Claude's own write survives");
  assert.ok(fs.existsSync(path.join(P.appDir, "src", "hook.js")), "the hooks still point at a copy that exists");
  assert.ok(fs.existsSync(P.install), "and the record stays");
  assert.equal(await setup.runUninstall(w.ctx, ["--keep-data"]), 0);
  w.output();
  assert.deepEqual(json(P.claude), { model: "opus", effortLevel: "high" });
  assert.equal(fs.existsSync(P.install), false);
});

test("the data folder can't be the home folder, and uninstall never deletes a folder holding other things", async () => {
  const w = await world({ env: {} });
  const ctx = setup.context({ env: { ...w.ctx.env, AIRPOCKET_DIR: w.home }, home: w.home, run: w.mac.run, tailscaleBin: TS, tty: false, color: false, uid: 501,
    tmuxBins: w.ctx.tmuxBins, out: w.ctx.out });
  assert.equal(await setup.runSetup(ctx), 1);
  assert.match(w.output(), /is your home folder or holds it/);
  assert.equal(setup.unsafeDataDir("/", "/Users/me"), "is the root folder");
  assert.equal(setup.unsafeDataDir("/Users", "/Users/me"), "is your home folder or holds it");
  assert.equal(setup.unsafeDataDir("/Users/me/ap", "/Users/me"), "");
  assert.equal(await setup.runUninstall(ctx, ["--remove-data"]), 1);
  assert.match(w.output(), /Kept the data folder ~: it is your home folder or holds it/);
  assert.ok(fs.existsSync(path.join(w.home, ".claude")));

  await setupOk(w);
  fs.writeFileSync(path.join(w.ctx.paths.dataDir, "notes.txt"), "mine");
  assert.equal(await setup.runUninstall(w.ctx, ["--remove-data"]), 1);
  assert.match(w.output(), /Kept the data folder .*: it holds things that aren't Airpocket's \(notes\.txt\)/);
  assert.ok(fs.existsSync(path.join(w.ctx.paths.dataDir, "notes.txt")));
});

test("uninstall warns when removing ours moves the user's own Codex hooks", async () => {
  const w = await world();
  await setupOk(w);
  const codex = json(w.ctx.paths.codex);
  codex.hooks.Stop.push({ hooks: [{ type: "command", command: "added later" }] });
  fs.writeFileSync(w.ctx.paths.codex, JSON.stringify(codex));
  assert.deepEqual(cfg.hooksAfterOurs(codex), ["Stop"]);
  assert.equal(await setup.runUninstall(w.ctx, ["--keep-data"]), 0);
  assert.match(w.output(), /your own Stop hook comes after Airpocket's\. Codex remembers trusted hooks by position, so it will ask you to review it again/);
  assert.deepEqual(json(w.ctx.paths.codex), { hooks: { Stop: [{ hooks: [{ type: "command", command: "added later" }] }] } });
});

test("shell aliases: --alias adds them to ~/.zshrc, twice adds nothing, doctor checks them and tmux, uninstall gives the file back byte for byte", async () => {
  // A profile whose last line has no newline, with a codex function of the user's own.
  const zshrc = 'export PATH="$HOME/bin:$PATH"\ncodex() { command codex --yolo "$@"; }\n# end';
  const w = await world({ env: { SHELL: "/bin/zsh" } });
  const P = w.ctx.paths;
  const file = path.join(w.home, ".zshrc");
  fs.writeFileSync(file, zshrc, { mode: 0o640 });

  const dry = snapshot(w.home);
  assert.equal(await setup.runSetup(w.ctx, ["--dry-run", "--alias"]), 0);
  const plan = w.output();
  assert.match(plan, /7\. Shell aliases\n {7}~\/\.zshrc: adds at the end:\n {9}alias claude='.*run claude' # airpocket-alias\n {7}backup first/);
  assert.match(plan, /~\/\.zshrc already defines codex \(codex\(\) \{ command codex --yolo "\$@"; \}\), so setup leaves it/);
  assert.match(plan, /they need tmux: brew install tmux/);
  assert.deepEqual(snapshot(w.home), dry, "the dry run changed nothing");

  const out = await setup.runSetup(w.ctx, ["--alias"]).then((code) => { const o = w.output(); assert.equal(code, 0, o); return o; });
  assert.match(out, /7\. Shell aliases: done \(backup ~\/\.zshrc\.airpocket-backup-\d{8}-\d{6}; claude in ~\/\.zshrc; open a new terminal window to use it\)/);
  const text = fs.readFileSync(file, "utf8");
  // airpocket isn't on this PATH, so the alias runs the copy setup made.
  assert.equal(text, zshrc + `\nalias claude='"${w.ctx.node}" "${path.join(P.appDir, "src", "cli.js")}" run claude' # airpocket-alias\n`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640, "its mode kept");
  assert.deepEqual(json(P.install).aliases, { file, createdFile: false, newlineAdded: true });
  const backups = () => fs.readdirSync(w.home).filter((n) => n.startsWith(".zshrc.airpocket-backup-"));
  assert.equal(fs.readFileSync(path.join(w.home, backups()[0]), "utf8"), zshrc);
  // The alias, as zsh reads it, runs the copy's cli.js.
  const z = spawnSync("/bin/zsh", ["-f", "-c", `source ${JSON.stringify(file)} 2>/dev/null; alias claude`], { encoding: "utf8", env: { HOME: w.home, PATH: "/usr/bin:/bin" } });
  assert.equal(z.stdout.trim(), `claude='"${w.ctx.node}" "${path.join(P.appDir, "src", "cli.js")}" run claude'`);

  // Again: nothing added, no new backup, the record unchanged.
  const again = await setup.runSetup(w.ctx, ["--alias"]).then((code) => { const o = w.output(); assert.equal(code, 0, o); return o; });
  assert.match(again, /~\/\.zshrc: has them already \(claude\)/);
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.equal(backups().length, 1);
  assert.deepEqual(json(P.install).aliases, { file, createdFile: false, newlineAdded: true });

  // Doctor: the alias is there, and tmux isn't, which the alias needs: a failure, with the fix.
  assert.equal(await doctor.runDoctor(w.ctx), 1);
  const report = w.output();
  assert.match(report, /^FAIL  tmux +not installed: your claude alias and airpocket run need it\n +brew install tmux$/m);
  assert.match(report, /^PASS  Shell aliases +~\/\.zshrc: claude start with airpocket run$/m);

  // Uninstall: the file is byte for byte what it was, and a backup of it is listed.
  assert.equal(await setup.runUninstall(w.ctx, ["--keep-data"]), 0);
  const gone = w.output();
  assert.match(gone, /Shell aliases\n {7}~\/\.zshrc: remove Airpocket's claude alias, nothing else/);
  assert.match(gone, /removed: Shell aliases \(backup ~\/\.zshrc\.airpocket-backup-/);
  assert.match(gone, / {4}~\/\.zshrc\.airpocket-backup-/);
  assert.equal(fs.readFileSync(file, "utf8"), zshrc);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
});

test("shell aliases: asked on a terminal, a note without one, --no-alias quiet; bash's file created and removed whole", async () => {
  const w = await world({ env: { SHELL: "/bin/bash" } });
  const file = path.join(w.home, ".bash_profile");

  // No terminal, no flag: nothing added, and a note says how.
  await setupOk(w);
  assert.equal(fs.existsSync(file), false);
  // (setupOk consumed the output; the note is in the plan)
  assert.match((await setup.runSetup(w.ctx, ["--dry-run"]), w.output()), /add shell aliases: airpocket setup --alias/);
  assert.doesNotMatch((await setup.runSetup(w.ctx, ["--dry-run", "--no-alias"]), w.output()), /alias/i);
  assert.equal(await setup.runSetup(w.ctx, ["--alias", "--no-alias"]), 2);
  w.output();

  // On a terminal it asks; no leaves everything as it was.
  w.ctx.tty = true;
  const asked = [];
  w.ctx.ask = async (q) => { asked.push(q); return false; };
  await setupOk(w);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Add these to ~\/\.bash_profile, so typing claude or codex starts it where your phone can answer\?\n {2}alias claude=.*\n {2}alias codex=/);
  assert.equal(fs.existsSync(file), false);

  // Yes: the file is created with both.
  w.ctx.ask = async () => true;
  const out = await setupOk(w);
  assert.match(out, /Shell aliases: done \(claude and codex in ~\/\.bash_profile/);
  assert.equal(fs.readFileSync(file, "utf8").split("\n").filter((l) => l.endsWith("# airpocket-alias")).length, 2);
  assert.deepEqual(json(w.ctx.paths.install).aliases, { file, createdFile: true, newlineAdded: false });
  const bash = spawnSync("/bin/bash", ["-c", `shopt -s expand_aliases; source ${JSON.stringify(file)}; alias codex`], { encoding: "utf8", env: { HOME: w.home, PATH: "/usr/bin:/bin" } });
  assert.match(bash.stdout, /^alias codex='".*" ".*\/app\/src\/cli\.js" run codex'$/m);

  // Uninstall: setup made the file and it holds only ours, so it goes.
  w.ctx.tty = false;
  assert.equal(await setup.runUninstall(w.ctx, ["--remove-data"]), 0);
  assert.match(w.output(), /~\/\.bash_profile: remove Airpocket's claude and codex aliases; the file only held those, so it goes/);
  assert.equal(fs.existsSync(file), false);
});

test("shell aliases: a shell other than zsh and bash gets a note, and airpocket on PATH is used by name", async () => {
  let w = await world({ env: { SHELL: "/opt/homebrew/bin/fish" } });
  assert.equal(await setup.runSetup(w.ctx, ["--dry-run", "--alias"]), 0);
  assert.match(w.output(), /Your shell is fish, so setup adds no aliases\. To have the phone answer, start agents with: airpocket run claude/);

  const bin = tempDir("airpocket-bin-");
  fs.writeFileSync(path.join(bin, "airpocket"), "#!/bin/sh\n", { mode: 0o755 });
  w = await world({ env: { SHELL: "/bin/zsh", PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(await setup.runSetup(w.ctx, ["--dry-run", "--alias"]), 0);
  const out = w.output();
  assert.match(out, /^ {9}alias claude='airpocket run claude' # airpocket-alias$/m);
  assert.match(out, /^ {9}alias codex='airpocket run codex' # airpocket-alias$/m);
});

test("doctor's tmux line: installed and new enough, too old, missing", async () => {
  const w = await world();
  const bin = tempDir("airpocket-tmux-");
  const tmuxAt = (version) => { const p = path.join(bin, `tmux-${version}`); fs.writeFileSync(p, `#!/bin/sh\necho 'tmux ${version}'\n`, { mode: 0o755 }); return p; };
  const line = async (bins) => { w.ctx.tmuxBins = bins; return (await doctor.checks(w.ctx)).find((c) => c.name === "tmux"); };
  const ok = await line([tmuxAt("3.6a")]);
  assert.equal(ok.level, "PASS");
  assert.equal(ok.detail, `3.6a (${path.join(bin, "tmux-3.6a")})`);
  const old = await line([tmuxAt("3.1c")]);
  assert.deepEqual([old.level, old.detail, old.fix], ["WARN", "3.1c is older than 3.2: airpocket run and sessions in tmux need it", "brew upgrade tmux"]);
  const none = await line(["/nonexistent/tmux"]);
  assert.deepEqual([none.level, none.detail, none.fix], ["WARN", "not installed: airpocket run and sessions in tmux need it", "brew install tmux"]);
});

test("the real ~/.claude/settings.json, ~/.codex/hooks.json, ~/.zshrc and ~/.bash_profile were not touched by these tests", () => {
  assert.deepEqual(mtimes(), REAL_BEFORE);
});

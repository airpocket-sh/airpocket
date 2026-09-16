"use strict";
// airpocket run and airpocket attach. Where a terminal is needed, `spawn` is
// stood in for: `run` gets its tmux session started detached (-d) instead of
// attached, and `attach` only records what it would run. tmux itself is real
// where installed, on a socket in a temporary data folder, never the user's
// own tmux server; its tests are skipped without tmux.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawnSync } = require("child_process");
const own = require("../src/ownterm");
const { TMUX_BINS } = require("../src/bridges");

const TMUX = TMUX_BINS.find((p) => fs.existsSync(p)) || "";
const temps = [];
const servers = [];
// Under /tmp: the per-user temp folder's long path would put the socket over macOS's 104 bytes.
const tempDir = (p = "ap-own-") => { const d = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", p))); temps.push(d); return d; };
test.after(() => {
  for (const s of servers) spawnSync(TMUX, ["-S", s, "kill-server"], { stdio: "ignore" });
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

/** A temporary HOME and data folder, a stand-in agent on PATH, and a context with every call recorded. */
function world({ env: extra = {}, tty = true, tmuxBins, script, choose } = {}) {
  const home = tempDir();
  const data = path.join(home, "d");
  const bin = path.join(home, "bin");
  const work = path.join(home, "My Project");
  fs.mkdirSync(bin);
  fs.mkdirSync(work);
  // The stand-in agent writes down its arguments and environment, then stays running.
  for (const agent of ["claude", "codex"]) {
    fs.writeFileSync(path.join(bin, agent), script || `#!/bin/sh\nprintf '%s\\n' "$@" > "$HOME/${agent}.args"\nenv > "$HOME/${agent}.env"\nexec sleep 60\n`, { mode: 0o755 });
  }
  const spawned = [], errs = [], outs = [];
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, AIRPOCKET_DIR: data, LANG: "en_US.UTF-8", ...extra };
  const ctx = own.context({
    env, home, cwd: work, tty, tmuxBins: tmuxBins || (TMUX ? [TMUX] : ["/nonexistent/tmux"]),
    err: (l) => errs.push(l), out: (l = "") => outs.push(l), choose: choose || (async () => 0),
    spawn: async (file, args, o) => {
      spawned.push({ file, args, env: o.env, cwd: o.cwd });
      if (file !== TMUX) return 0;
      // A terminal can't be attached here: start the session detached instead, and attach nothing.
      if (args.includes("attach-session")) return 0;
      const i = args.indexOf("new-session");
      const r = spawnSync(file, [...args.slice(0, i + 1), "-d", "-x", "80", "-y", "24", ...args.slice(i + 1)], { env: o.env, cwd: o.cwd, encoding: "utf8" });
      return r.status;
    },
  });
  if (TMUX) servers.push(ctx.socket);
  const tmux = (...args) => spawnSync(TMUX, ["-S", ctx.socket, ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
  return { home, data, bin, work, ctx, spawned, errs, outs, tmux };
}
const until = async (what, fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out: " + what); await new Promise((r) => setTimeout(r, 50)); }
};

test("inside tmux or a Superset terminal, run starts the agent directly and says so in one line", async () => {
  for (const [extra, where] of [[{ TMUX: "/tmp/tmux-501/default,123,0", TMUX_PANE: "%3" }, "tmux"], [{ SUPERSET_TERMINAL_ID: "t1", SUPERSET_WORKSPACE_ID: "w1" }, "Superset"]]) {
    const w = world({ env: extra });
    assert.equal(await own.runAgent(w.ctx, ["claude", "--model", "haiku", "fix the bug"]), 0);
    assert.equal(w.spawned.length, 1);
    assert.deepEqual(w.spawned[0].file, path.join(w.bin, "claude"));
    assert.deepEqual(w.spawned[0].args, ["--model", "haiku", "fix the bug"], "everything after the agent's name passes through");
    assert.equal(w.spawned[0].env, w.ctx.env, "its environment as it is");
    assert.deepEqual(w.errs, [`Already in ${where}, where Airpocket can reach it: starting claude here.`]);
    assert.equal(fs.existsSync(path.join(w.data, "tmux")), false, "no tmux folder, no server");
  }
});

test("run starts the agent directly, silently, off a terminal or for a command that prints and exits", async () => {
  const cases = [
    [{ tty: false }, "claude", ["hello"]],
    [{}, "claude", ["-p", "say hi"]],
    [{}, "claude", ["--version"]],
    [{}, "claude", ["mcp", "list"]],
    [{}, "codex", ["exec", "say hi"]],
    [{}, "codex", ["login"]],
  ];
  for (const [opts, agent, args] of cases) {
    const w = world(opts);
    assert.equal(await own.runAgent(w.ctx, [agent, ...args]), 0);
    assert.deepEqual(w.spawned.map((s) => [s.file, s.args]), [[path.join(w.bin, agent), args]], `${agent} ${args.join(" ")}`);
    assert.deepEqual(w.errs, []);
  }
  assert.equal(own.oneShot("codex", ["resume", "--last"]), false, "codex resume is a session");
  assert.equal(own.oneShot("claude", ["explain", "mcp"]), false, "a prompt isn't a command");
});

test("run without tmux says so and how to fix it; a wrong agent or one not on PATH is refused", async () => {
  let w = world({ tmuxBins: ["/nonexistent/tmux"] });
  assert.equal(await own.runAgent(w.ctx, ["claude"]), 1);
  assert.deepEqual(w.errs, ["tmux isn't installed, and airpocket run needs it. Install it with: brew install tmux"]);
  assert.deepEqual(w.spawned, [], "the agent doesn't start somewhere the phone can't reach");

  w = world();
  assert.equal(await own.runAgent(w.ctx, ["aider"]), 2);
  assert.match(w.errs[0], /Usage: airpocket run claude\|codex/);
  w = world();
  w.ctx.env.PATH = "/usr/bin:/bin";
  assert.equal(await own.runAgent(w.ctx, ["codex"]), 127);
  assert.deepEqual(w.errs, ["codex isn't on your PATH."]);

  // An old tmux (a stand-in that says 3.1).
  w = world();
  const old = path.join(w.bin, "tmux");
  fs.writeFileSync(old, "#!/bin/sh\necho 'tmux 3.1c'\n", { mode: 0o755 });
  w.ctx.tmuxBins = [old];
  w.ctx.run = (file, args) => { const r = spawnSync(file, args, { encoding: "utf8" }); return { status: r.status, stdout: r.stdout, stderr: r.stderr }; };
  assert.equal(await own.runAgent(w.ctx, ["claude"]), 1);
  assert.match(w.errs[0], /tmux 3\.1c is too old for airpocket run \(it needs 3\.2 or later\)\. Update it with: brew upgrade tmux/);
  assert.equal(own.versionAtLeast("3.6a", own.MIN_TMUX), true);
  assert.equal(own.versionAtLeast("next-3.7", own.MIN_TMUX), true);
  assert.equal(own.versionAtLeast("2.9", own.MIN_TMUX), false);
});

test("run refuses a socket path over macOS's limit, and a tmux folder that is a link", async () => {
  let w = world({ env: { AIRPOCKET_DIR: "/tmp/" + "x".repeat(100) } });
  assert.equal(await own.runAgent(w.ctx, ["claude"]), 1);
  assert.match(w.errs[0], /bytes, over macOS's 104\. Use a shorter AIRPOCKET_DIR/);

  w = world();
  fs.mkdirSync(w.data, { mode: 0o700 });
  fs.symlinkSync(tempDir(), path.join(w.data, "tmux"));
  assert.equal(await own.runAgent(w.ctx, ["claude"]), 1);
  assert.match(w.errs[0], /tmux isn't a folder of yours/);
  assert.deepEqual(w.spawned, []);
});

test("run: a private tmux server on Airpocket's socket, with its config, the agent as the pane's process, this shell's environment", { skip: !TMUX && "tmux isn't installed" }, async () => {
  const w = world({ env: { TRIAL_VALUE: "it's \"quoted\"\nand two lines", TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" } });
  // A ~/.tmux.conf of the user's own must not count.
  fs.writeFileSync(path.join(w.home, ".tmux.conf"), "set -g status-left 'USER CONFIG'\nset -g escape-time 500\n");
  const args = ["--model", "haiku", "two words", "it's"];
  assert.equal(await own.runAgent(w.ctx, ["claude", ...args]), 0);
  assert.deepEqual(w.errs, []);

  const [call] = w.spawned;
  assert.equal(call.file, TMUX);
  assert.deepEqual(call.args.slice(0, 7), ["-u", "-S", path.join(w.data, "tmux", "sock"), "-f", own.CONF, "new-session", "-s"]);
  assert.equal(call.args[7], "claude-My-Project");
  assert.equal(call.cwd, w.work);

  const dir = path.join(w.data, "tmux");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.ok(fs.lstatSync(w.ctx.socket).isSocket());
  await until("the agent started", () => fs.existsSync(path.join(w.home, "claude.env")) && fs.readFileSync(path.join(w.home, "claude.env"), "utf8").includes("TMUX_PANE"));
  assert.deepEqual(fs.readdirSync(dir), ["sock"], "the start script deleted itself");
  assert.deepEqual(fs.readFileSync(path.join(w.home, "claude.args"), "utf8").split("\n").slice(0, -1), args, "arguments exactly as given");

  // The pane's process is the agent itself (sh exec'd env, which exec'd it), and it runs where it was started.
  const pane = w.tmux("display-message", "-p", "-t", "=claude-My-Project:", "#{pane_pid} #{pane_current_path}").stdout.trim();
  const [pid, cwd] = [pane.split(" ")[0], pane.slice(pane.indexOf(" ") + 1)];
  assert.match(spawnSync("/bin/ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).stdout, /sleep 60/);
  assert.equal(fs.realpathSync(cwd), w.work);

  // Its environment: this shell's, with tmux's own terminal variables.
  const env = fs.readFileSync(path.join(w.home, "claude.env"), "utf8");
  assert.ok(env.includes(`TRIAL_VALUE=it's "quoted"\nand two lines\n`), "a value with quotes and a newline survives");
  assert.match(env, new RegExp(`^TMUX=${w.ctx.socket.replace(/[.]/g, "\\.")},\\d+,\\d+$`, "m"), "the hook finds the socket and server in $TMUX");
  assert.match(env, /^TMUX_PANE=%\d+$/m);
  assert.match(env, /^TERM=tmux-256color$/m);
  assert.match(env, /^TERM_PROGRAM=tmux$/m);
  assert.doesNotMatch(env, /Apple_Terminal|xterm-256color/);

  // Airpocket's tmux.conf, not the user's.
  const show = (...a) => w.tmux("show-options", ...a).stdout.trim();
  assert.equal(show("-s", "escape-time"), "escape-time 0");
  assert.equal(show("-s", "extended-keys"), "extended-keys always");
  assert.equal(show("-s", "extended-keys-format"), "extended-keys-format csi-u");
  assert.equal(show("-s", "set-clipboard"), "set-clipboard on");
  assert.equal(show("-g", "status"), "status off");
  assert.equal(show("-g", "mouse"), "mouse on");
  assert.equal(show("-g", "history-limit"), "history-limit 50000");
  assert.equal(show("-g", "prefix"), "prefix None");
  assert.doesNotMatch(show("-g", "status-left"), /USER CONFIG/);

  // A second agent in the same folder gets its own session, with the environment of the shell that started it.
  w.ctx.env = { ...w.ctx.env, TRIAL_VALUE: "second" };
  fs.rmSync(path.join(w.home, "claude.env"));
  assert.equal(await own.runAgent(w.ctx, ["claude"]), 0);
  assert.equal(w.spawned[1].args[7], "claude-My-Project-2");
  await until("the second agent started", () => fs.existsSync(path.join(w.home, "claude.env")) && fs.readFileSync(path.join(w.home, "claude.env"), "utf8").includes("TMUX_PANE"));
  assert.match(fs.readFileSync(path.join(w.home, "claude.env"), "utf8"), /^TRIAL_VALUE=second$/m, "not the server's first environment");
});

test("attach: none, one, several, a name, an ended agent", { skip: !TMUX && "tmux isn't installed" }, async () => {
  let picked = 0;
  const w = world({ choose: async (q, n) => { assert.equal(n, 2); return picked; } });
  const attachCalls = () => w.spawned.filter((s) => s.args.includes("attach-session")).map((s) => s.args.slice(-1)[0]);

  // None: no socket yet.
  assert.equal(await own.attach(w.ctx, []), 1);
  assert.deepEqual(w.errs.splice(0), ["No agents started with airpocket run are running."]);
  assert.equal(await own.attach(w.ctx, ["claude-My-Project"]), 1);
  assert.deepEqual(w.errs.splice(0), ["No agent called claude-My-Project is running. It may have ended."]);

  // One: attached straight away.
  await own.runAgent(w.ctx, ["claude"]);
  assert.equal(await own.attach(w.ctx, []), 0);
  assert.deepEqual(attachCalls(), ["=claude-My-Project"]);
  const call = w.spawned[w.spawned.length - 1];
  assert.deepEqual(call.args.slice(0, 4), ["-u", "-S", w.ctx.socket, "attach-session"]);

  // Several: a list; off a terminal it ends there, on one it asks.
  await own.runAgent(w.ctx, ["codex"]);
  w.ctx.tty = false;
  assert.equal(await own.attach(w.ctx, []), 2);
  const listed = w.outs.splice(0);
  assert.equal(listed[0], "Agents started with airpocket run:");
  assert.match(listed[1], /^ {2}1\. claude-My-Project {3}~\/My Project {3}started \d\d:\d\d$/);
  assert.match(listed[2], /^ {2}2\. codex-My-Project /);
  assert.equal(listed[3], "Attach one with: airpocket attach <name>");
  w.ctx.tty = true;
  picked = 2;
  assert.equal(await own.attach(w.ctx, []), 0);
  assert.deepEqual(attachCalls().slice(-1), ["=codex-My-Project"]);
  picked = 0;
  assert.equal(await own.attach(w.ctx, []), 1);
  assert.equal(w.outs.pop(), "Nothing attached.");

  // A name.
  assert.equal(await own.attach(w.ctx, ["claude-My-Project"]), 0);
  assert.deepEqual(attachCalls().slice(-1), ["=claude-My-Project"]);
  assert.equal(await own.attach(w.ctx, ["claude-Other"]), 1);
  assert.deepEqual(w.errs.splice(0), ["No agent called claude-Other is running. It may have ended. Running now: claude-My-Project, codex-My-Project"]);

  // Inside tmux, attaching would nest: refused, with what to do.
  w.ctx.env = { ...w.ctx.env, TMUX: "/tmp/x,1,0" };
  assert.equal(await own.attach(w.ctx, ["codex-My-Project"]), 1);
  assert.deepEqual(w.errs.splice(0), ["This terminal is inside tmux already. Open a new window and run: airpocket attach codex-My-Project"]);
  delete w.ctx.env.TMUX;

  // An agent that exited, while its pane is still open (something else holds the terminal): not offered, and said to have ended.
  const codexPid = Number(w.tmux("display-message", "-p", "-t", "=codex-My-Project:", "#{pane_pid}").stdout.trim());
  w.ctx.alive = (pid) => pid !== codexPid;
  const before = attachCalls().length;
  assert.equal(await own.attach(w.ctx, []), 0, "one left: attached without a list");
  assert.deepEqual(attachCalls().slice(before), ["=claude-My-Project"]);
  assert.equal(await own.attach(w.ctx, ["codex-My-Project"]), 1);
  assert.deepEqual(w.errs.splice(0), ["codex-My-Project has ended: its agent exited."]);

  // When the agent really exits, its session closes with it.
  process.kill(codexPid, "SIGTERM");
  await until("the codex session closed", () => !w.tmux("list-sessions", "-F", "#{session_name}").stdout.includes("codex-My-Project"));
  w.ctx.alive = () => true;
  assert.deepEqual(own.listSessions(w.ctx, TMUX).map((s) => s.name), ["claude-My-Project"]);
});

test("attach: an agent open in another window is attached when it's the only one; two open ones make a list", async () => {
  // A stand-in tmux answering list-sessions, on a real socket file (the socket must be a socket this user owns).
  const w = world({ tmuxBins: [TMUX || "/bin/echo"] });
  fs.mkdirSync(path.dirname(w.ctx.socket), { recursive: true, mode: 0o700 });
  const srv = net.createServer();
  await new Promise((r) => srv.listen(w.ctx.socket, r));
  let rows = "";
  w.ctx.run = (file, args) => (args[0] === "-V" ? { status: 0, stdout: "tmux 3.6a\n" } : { status: 0, stdout: rows });
  w.ctx.alive = () => true;
  rows = "claude-a\t1\t4242\t0\t1789000000\t/tmp/a\n";
  assert.equal(await own.attach(w.ctx, []), 0);
  rows += "claude-b\t2\t4243\t0\t1789000000\t/tmp/b\ncodex-c\t0\t4244\t1\t1789000000\t/tmp/c\n";
  w.ctx.tty = false;
  assert.equal(await own.attach(w.ctx, []), 2);
  assert.equal(w.outs.length, 4, "two listed; the ended one isn't");
  assert.match(w.outs[1], /claude-a .*\(open in another window\)$/);
  rows = "codex-c\t0\t4244\t1\t1789000000\t/tmp/c\n";
  assert.equal(await own.attach(w.ctx, []), 1);
  assert.deepEqual(w.errs.splice(0), ["The session started with airpocket run has ended."]);
  srv.close();
});

test("session names: agent and folder, safe for tmux, numbered when taken", () => {
  assert.equal(own.sessionName("claude", "/Users/a/site.com v2", []), "claude-site-com-v2");
  assert.equal(own.sessionName("codex", "/", []), "codex-root");
  assert.equal(own.sessionName("claude", "/x/app", ["claude-app", "claude-app-2"]), "claude-app-3");
  assert.ok(own.sessionName("claude", "/x/" + "y".repeat(80), []).length <= 40);
});

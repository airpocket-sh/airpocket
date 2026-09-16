"use strict";
// npm run smoke   (CI runs it after the tests)
// Starts the real app the way `npm start` does, on loopback, with a temporary
// data folder and a temporary HOME, and checks from outside that:
//   - the app, file and hook servers listen on 127.0.0.1 and nowhere else
//   - /api/hello without a token, or with a wrong one, answers 401
//   - the hook endpoint refuses a non-loopback Host (403), even with the right
//     secret, while the same request with a loopback Host gets past that check
// Then stops it and checks that no process, port, lock or folder is left.
// Ports: AIRPOCKET_SMOKE_PORT (default 47971) and the next two.
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.AIRPOCKET_SMOKE_PORT) || 47971;
const PORTS = { app: PORT, file: PORT + 1, hook: PORT + 2 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "airpocket-smoke-"));
const dataDir = path.join(tmp, "data");
const home = path.join(tmp, "home");
fs.mkdirSync(home);

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failed++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolves true if something accepts a TCP connection at host:port. */
function connects(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const end = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(2000, () => end(false));
    s.on("connect", () => end(true));
    s.on("error", () => end(false));
  });
}

/** One HTTP request to 127.0.0.1; resolves the status code. */
function request(port, { method = "GET", pathname = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

/** Pids in a process group (empty when none is left). */
function groupPids(pgid) {
  const r = spawnSync("pgrep", ["-g", String(pgid)], { encoding: "utf8" });
  return r.stdout.split("\n").filter(Boolean);
}

async function main() {
  for (const [name, p] of Object.entries(PORTS)) {
    if (await connects("127.0.0.1", p)) throw new Error(`port ${p} (${name}) is already taken; set AIRPOCKET_SMOKE_PORT`);
  }

  // Its own process group, so every child it starts can be found and stopped.
  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    cwd: tmp,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir(), AIRPOCKET_DIR: dataDir, AIRPOCKET_PORT: String(PORTS.app),
           AIRPOCKET_FILE_PORT: String(PORTS.file), AIRPOCKET_HOOK_PORT: String(PORTS.hook), CODEX_HOME: path.join(home, ".codex") },
  });
  let output = "";
  child.stdout.on("data", (c) => { output += c; });
  child.stderr.on("data", (c) => { output += c; });
  let exited = false;
  const exit = new Promise((r) => child.on("exit", (code, signal) => { exited = true; r({ code, signal }); }));

  try {
    // Listening: all three ports answer and hook.json is written (it is written only once the hook endpoint listens).
    const hookFile = path.join(dataDir, "hook.json");
    const deadline = Date.now() + 15000;
    let up = false;
    while (!up && !exited && Date.now() < deadline) {
      up = fs.existsSync(hookFile) && (await connects("127.0.0.1", PORTS.app)) && (await connects("127.0.0.1", PORTS.file))
        && (await connects("127.0.0.1", PORTS.hook));
      if (!up) await wait(100);
    }
    check(up, "the app, file and hook servers listen on 127.0.0.1");
    if (!up) throw new Error(`the app did not start:\n${output}`);

    // Nothing on any other address of this machine.
    const others = Object.values(os.networkInterfaces()).flat().filter((a) => a && !a.internal && a.family === "IPv4").map((a) => a.address);
    if (!others.length) console.log("SKIP no non-loopback IPv4 address to try");
    for (const addr of others) {
      for (const [name, p] of Object.entries(PORTS)) check(!(await connects(addr, p)), `${name} port not reachable on ${addr}`);
    }

    check(await request(PORTS.app, { pathname: "/api/hello" }) === 401, "/api/hello without a token: 401");
    check(await request(PORTS.app, { pathname: "/api/hello", headers: { Authorization: "Bearer " + "0".repeat(64) } }) === 401,
      "/api/hello with a wrong token: 401");

    const { secret } = JSON.parse(fs.readFileSync(hookFile, "utf8"));
    const hook = (host) => request(PORTS.hook, { method: "POST", pathname: "/hook/touch", body: "{}",
      headers: { Host: host, Authorization: `Bearer ${secret}`, "Content-Type": "application/json" } });
    check(await hook("attacker.example") === 403, "hook endpoint, non-loopback Host: 403");
    check(await hook(`attacker.example:${PORTS.hook}`) === 403, "hook endpoint, non-loopback Host with port: 403");
    check(await hook("100.100.100.100") === 403, "hook endpoint, tailnet IP as Host: 403");
    const control = await hook(`127.0.0.1:${PORTS.hook}`);
    check(control !== 403 && control !== 401, `hook endpoint, loopback Host and the secret get past the Host check (${control})`);
  } finally {
    // Stop it the way launchd or Ctrl-C would.
    if (!exited) child.kill("SIGTERM");
    const res = await Promise.race([exit, wait(5000).then(() => null)]);
    check(!!res, `the app stops on SIGTERM${res ? ` (${res.signal || `exit ${res.code}`})` : ""}`);
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    await wait(200);
    check(groupPids(child.pid).length === 0, "no process left behind");
    for (const [name, p] of Object.entries(PORTS)) check(!(await connects("127.0.0.1", p)), `${name} port closed`);
    check(!fs.existsSync(path.join(dataDir, "airpocket.lock")), "lock released");
    fs.rmSync(tmp, { recursive: true, force: true });
    check(!fs.existsSync(tmp), "temporary folder removed");
  }
}

main().then(() => {
  console.log(failed ? `${failed} check(s) failed` : "smoke test passed");
  process.exit(failed ? 1 : 0);
}, (err) => {
  console.error(err.message);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});

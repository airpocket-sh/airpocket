"use strict";
// Where Airpocket listens. Every server binds 127.0.0.1 only; setup publishes
// the first two inside the tailnet with `tailscale serve`, never `funnel`.
//
//   47871  the app and its API
//   47872  the file-only origin: two-minute links to one PDF or page
//   47873  the hook endpoint: this Mac's own hooks only, never published
//
// The tailnet HTTPS ports are what the phone sees. Setup picks two that nothing
// else on this Mac publishes (443 and 8443 when they are free) and keeps them in
// install.json in the data folder, so the service and the CLI agree on them.
const fs = require("fs");
const os = require("os");
const path = require("path");

/** The data folder: $AIRPOCKET_DIR, or ~/Library/Application Support/Airpocket. */
function dataDirFor(env = process.env, home = os.homedir()) {
  return env.AIRPOCKET_DIR && path.isAbsolute(env.AIRPOCKET_DIR) ? env.AIRPOCKET_DIR : path.join(home, "Library", "Application Support", "Airpocket");
}

/** The ports for an environment; each one can be moved with its AIRPOCKET_* variable. */
function portsFrom(env = {}) {
  const num = (v, d) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : d; };
  const app = num(env.AIRPOCKET_PORT, 47871);
  return {
    app,
    file: num(env.AIRPOCKET_FILE_PORT, app + 1),
    hook: num(env.AIRPOCKET_HOOK_PORT, app + 2),
    publicApp: num(env.AIRPOCKET_PUBLIC_PORT, 443),
    publicFile: num(env.AIRPOCKET_PUBLIC_FILE_PORT, 8443),
  };
}

/** The tailnet ports setup chose, as the variables that would set them ({} when setup hasn't run). */
function savedPorts(dir) {
  try {
    const { ports = {} } = JSON.parse(fs.readFileSync(path.join(dir, "install.json"), "utf8")) || {};
    const out = {};
    if (Number.isInteger(ports.publicApp)) out.AIRPOCKET_PUBLIC_PORT = ports.publicApp;
    if (Number.isInteger(ports.publicFile)) out.AIRPOCKET_PUBLIC_FILE_PORT = ports.publicFile;
    return out;
  } catch { return {}; }
}

/** The ports in effect: the environment first, then what setup chose, then the defaults. */
const currentPorts = (env = process.env, home = os.homedir()) => portsFrom({ ...savedPorts(dataDirFor(env, home)), ...env });

module.exports = { dataDirFor, portsFrom, savedPorts, currentPorts, PORTS: currentPorts() };

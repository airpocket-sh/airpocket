"use strict";
// Where Airpocket listens. Every server binds 127.0.0.1 only; `airpocket serve`
// publishes the first two inside the tailnet with `tailscale serve`, never `funnel`.
//
//   47871  the app and its API
//   47872  the file-only origin: two-minute links to one PDF or page
//   47873  the hook endpoint: this Mac's own hooks only, never published
//
// The tailnet HTTPS ports are what the phone sees. They are provisional until
// the public ports are settled (build step 13).

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

module.exports = { portsFrom, PORTS: portsFrom(process.env) };

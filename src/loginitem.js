"use strict";
// The login item: a launchd agent in ~/Library/LaunchAgents that starts the
// service when you log in and brings it back if it crashes.
//
// Restart rules. launchd restarts the service only when it exits with an error
// (KeepAlive/SuccessfulExit false), at most every 30 s (ThrottleInterval). A
// deliberate stop (SIGTERM from `launchctl bootout`) exits 0 and stays stopped.
// One case would loop forever: another Airpocket already holding the data
// folder, where every start refuses at once. launchd can't be told to spare one
// exit code, so the service started as a login item (`--login-item`) doesn't
// exit then: it waits, trying the lock again with a growing pause, and takes the
// folder over when the other one stops. Started by hand, it exits with its own
// code (EXIT_LOCKED) instead.
const fs = require("fs");
const path = require("path");

const LABEL = "sh.airpocket.service";
const EXIT_LOCKED = 3;
const THROTTLE_S = 30;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plistValue = (v, pad) => {
  if (v === true || v === false) return `${pad}<${v}/>`;
  if (Number.isInteger(v)) return `${pad}<integer>${v}</integer>`;
  if (typeof v === "string") return `${pad}<string>${esc(v)}</string>`;
  if (Array.isArray(v)) return [`${pad}<array>`, ...v.map((x) => plistValue(x, pad + "  ")), `${pad}</array>`].join("\n");
  const lines = [`${pad}<dict>`];
  for (const [k, x] of Object.entries(v)) lines.push(`${pad}  <key>${esc(k)}</key>`, plistValue(x, pad + "  "));
  lines.push(`${pad}</dict>`);
  return lines.join("\n");
};

/** The launchd agent's definition, as an object (for the dry run and the tests) and as plist XML. */
function loginItem({ label = LABEL, node, appDir, dataDir, logFile, env = {} }) {
  const def = {
    Label: label,
    ProgramArguments: [node, path.join(appDir, "src", "server.js"), "--login-item"],
    WorkingDirectory: appDir,
    EnvironmentVariables: {
      // The service runs tmux, ps and the Superset CLI by absolute path; node's own folder is there for scripts that use env node.
      PATH: [path.dirname(node), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
      AIRPOCKET_DIR: dataDir,
      ...env,
    },
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: THROTTLE_S,
    ProcessType: "Standard",
    Umask: 0o077,
    StandardOutPath: logFile,
    StandardErrorPath: logFile,
  };
  const xml = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">', plistValue(def, ""), "</plist>", ""].join("\n");
  return { def, xml };
}

const LAUNCHCTL = "/bin/launchctl";
const domain = (uid) => `gui/${uid}`;

/**
 * What launchd says about the job: { loaded, pid, state, runs, exit }, from
 * `launchctl print`. Not loaded when launchd doesn't know it.
 */
function jobStatus(run, uid, label = LABEL) {
  const r = run(LAUNCHCTL, ["print", `${domain(uid)}/${label}`], { timeout: 8000 });
  if (r.status !== 0) return { loaded: false, pid: 0, state: "", runs: 0, exit: null };
  const field = (name) => { const m = new RegExp(`^\\s*${name} = (.+)$`, "m").exec(r.stdout); return m ? m[1].trim() : ""; };
  const exit = field("last exit code");
  return { loaded: true, pid: Number(field("pid")) || 0, state: field("state"), runs: Number(field("runs")) || 0,
           exit: /^\d+$/.test(exit) ? Number(exit) : null };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Load the job, or say why not. An older copy is unloaded first and waited for:
 * right after a bootout, launchd often refuses to load the same label again
 * ("5: Input/output error") while the old process is still stopping. So a
 * refused load is tried a few more times before it counts.
 */
async function load(run, uid, plistFile, label = LABEL, { tries = 4, gapMs = 1000 } = {}) {
  await unloadAndWait(run, uid, label);
  let r;
  for (let i = 0; i < tries; i++) {
    r = run(LAUNCHCTL, ["bootstrap", domain(uid), plistFile], { timeout: 15000 });
    if (r.status === 0) return { ok: true };
    await pause(gapMs);
  }
  const text = (r.stderr || r.stdout || "").trim();
  // 5: Input/output error, which is also what a login item switched off in System Settings gives.
  const hint = r.status === 5 || /Input\/output error/i.test(text)
    ? " If Airpocket is switched off in System Settings > General > Login Items & Extensions, switch it on and run setup again." : "";
  return { ok: false, why: `launchctl bootstrap failed ${tries} times (${r.status}): ${text.split("\n")[0] || "no message"}.${hint}` };
}

/** Unload the job if it is loaded, and wait (up to 15 s) until launchd no longer has it. True if it was loaded. */
async function unloadAndWait(run, uid, label = LABEL) {
  if (!jobStatus(run, uid, label).loaded) return false;
  run(LAUNCHCTL, ["bootout", `${domain(uid)}/${label}`], { timeout: 15000 });
  for (let i = 0; i < 60 && jobStatus(run, uid, label).loaded; i++) await pause(250);
  return true;
}

/** Unload the job; true if it was loaded. */
function unload(run, uid, label = LABEL) {
  if (!jobStatus(run, uid, label).loaded) return false;
  run(LAUNCHCTL, ["bootout", `${domain(uid)}/${label}`], { timeout: 15000 });
  return true;
}

/** Is this plist ours (by label)? Reads at most 64 KB. */
function isOurPlist(file, label = LABEL) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 64 * 1024) return false;
    return fs.readFileSync(file, "utf8").includes(`<string>${esc(label)}</string>`);
  } catch { return false; }
}

module.exports = { LABEL, EXIT_LOCKED, THROTTLE_S, LAUNCHCTL, loginItem, jobStatus, load, unload, unloadAndWait, isOurPlist };

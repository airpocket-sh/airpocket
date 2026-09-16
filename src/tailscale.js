"use strict";
// Tailscale, as setup, doctor, uninstall and the CLI see it. Everything runs the
// CLI by its real path through `run(bin, args)` (a seam for the tests), reads
// JSON, and publishes only with `tailscale serve`, never `funnel`: serve stays
// inside your tailnet, funnel would put Airpocket on the public internet.
const fs = require("fs");
const { execFileSync, spawnSync } = require("child_process");

// Ports tried for the two addresses, in order. 443 first, so a Mac with nothing
// else published gets addresses without a port; then others that read as HTTPS.
const CANDIDATE_PORTS = Object.freeze([443, 8443, 4443, 5443, 6443, 7443, 9443, 10443]);

/** A command's result, the same shape whether it ran for real or in a test. */
function runReal(bin, args, { timeout = 15000, input } = {}) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout, input, env: process.env });
  return { status: r.error ? -1 : r.status, stdout: r.stdout || "", stderr: r.stderr || (r.error ? String(r.error.message) : "") };
}

// Run the CLI that ships inside the app bundle, by its real path. Called through
// the /usr/local/bin/tailscale symlink it aborted with "bundleIdentifier is
// unknown to the registry" (Tailscale 1.102, 2026-09-14).
function tailscaleBin({ exists = executable } = {}) {
  const found = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
  try { const p = execFileSync("/usr/bin/which", ["tailscale"], { encoding: "utf8" }).trim(); if (p) found.push(p); } catch {}
  found.push("/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale");
  for (const p of found) { const real = exists(p); if (real) return real; }
  return null;
}
function executable(p) {
  try { const real = fs.realpathSync(p); fs.accessSync(real, fs.constants.X_OK); return real; } catch { return null; }
}

const parse = (s) => { try { return JSON.parse(String(s).trim() || "{}"); } catch { return null; } };

/**
 * What Tailscale says about this Mac: { running, state, dns, https, version }, or
 * null when it can't be asked. `https` is false when the tailnet has no HTTPS
 * certificates, which `serve` needs. From a launchd process DNSName is empty
 * (the server takes the name from the Host header instead); from a terminal it is there.
 */
function tailscaleStatus(bin, run = runReal) {
  if (!bin) return null;
  const r = run(bin, ["status", "--json"], { timeout: 8000 });
  const st = r.status === 0 || r.stdout ? parse(r.stdout) : null;
  if (!st || typeof st !== "object") return null;
  const self = st.Self || {};
  const dns = String(self.DNSName || "").replace(/\.$/, "");
  const certs = Array.isArray(st.CertDomains) ? st.CertDomains : [];
  return { running: st.BackendState === "Running", state: String(st.BackendState || "unknown"), dns,
           https: certs.length > 0, version: String(st.Version || "").split("-")[0] };
}

/** What `tailscale serve` already publishes on this Mac, or null when it can't say. */
function serveStatus(bin, run = runReal) {
  if (!bin) return null;
  const r = run(bin, ["serve", "status", "--json"], { timeout: 8000 });
  if (r.status !== 0) return null;
  const st = parse(r.stdout);
  return st && typeof st === "object" ? st : null;
}

const proxyOf = (h) => String((h && h.Proxy) || "").replace(/\/+$/, "");

/** Every handler Tailscale serves on one HTTPS port, as proxy targets ("" for something that isn't a proxy). */
function handlersOn(status, port) {
  const out = [];
  let web = false;
  for (const [hostPort, conf] of Object.entries((status && status.Web) || {})) {
    if (!hostPort.endsWith(":" + port)) continue;
    web = true;
    const handlers = Object.values((conf && conf.Handlers) || {});
    if (!handlers.length) out.push("");
    for (const h of handlers) out.push(proxyOf(h));
  }
  const tcp = status && status.TCP ? status.TCP[String(port)] : null;
  if (tcp && tcp.TCPForward) out.push("tcp " + tcp.TCPForward);
  else if (tcp && !web) out.push("");
  return out;
}

/**
 * What else is published on a tailnet port: every target there that is not ours.
 * Airpocket never replaces or removes something another program published.
 */
function othersOn(status, port, target) {
  return handlersOn(status, port).filter((p) => p !== target).map((p) => p || "something else");
}
/** Is this port published, and only for this target? */
const oursOn = (status, port, target) => { const h = handlersOn(status, port); return h.length > 0 && h.every((p) => p === target); };

/** Every HTTPS port that publishes only this target. */
function portsServing(status, target) {
  const ports = new Set();
  for (const hostPort of Object.keys((status && status.Web) || {})) ports.add(Number(hostPort.split(":").pop()));
  for (const p of Object.keys((status && status.TCP) || {})) ports.add(Number(p));
  return [...ports].filter((p) => Number.isInteger(p) && oursOn(status, p, target)).sort((a, b) => a - b);
}

/**
 * The two tailnet HTTPS ports for the app and the file-only origin. A port that
 * already publishes Airpocket's target is kept; otherwise the first free
 * candidate. A port chosen with AIRPOCKET_PUBLIC_PORT / _FILE_PORT is used as
 * asked, or refused if something else is on it. Returns { app, file, taken, problem }.
 */
function choosePorts(status, targets, { app: wantApp, file: wantFile } = {}) {
  const taken = [];
  const pick = (target, want, not) => {
    if (want) return othersOn(status, want, target).length ? { problem: `HTTPS port ${want} already publishes ${othersOn(status, want, target).join(", ")}` } : { port: want };
    const mine = portsServing(status, target).filter((p) => p !== not);
    if (mine.length) return { port: mine[0] };
    for (const p of CANDIDATE_PORTS) {
      if (p === not) continue;
      if (handlersOn(status, p).length) { if (!taken.includes(p)) taken.push(p); continue; }
      return { port: p };
    }
    return { problem: "no free HTTPS port among " + CANDIDATE_PORTS.join(", ") };
  };
  const a = pick(targets.app, wantApp, 0);
  const f = pick(targets.file, wantFile, a.port);
  const problem = a.problem || f.problem || (a.port === f.port ? "the app and the file-only origin can't share a port" : "");
  return { app: a.port || 0, file: f.port || 0, taken, problem };
}

/** The address a phone opens: https://<name>, with the port unless it is 443. */
const addressOf = (dns, port) => (dns ? `https://${dns}${port === 443 ? "" : ":" + port}` : "");

/** Publish one loopback target on a tailnet HTTPS port. `serve` only. */
function serveOn(bin, port, target, run = runReal) {
  return run(bin, ["serve", "--bg", `--https=${port}`, target], { timeout: 30000 });
}
/** Stop publishing one tailnet HTTPS port. */
function serveOff(bin, port, run = runReal) {
  return run(bin, ["serve", `--https=${port}`, "off"], { timeout: 30000 });
}

module.exports = { CANDIDATE_PORTS, runReal, tailscaleBin, tailscaleStatus, serveStatus, handlersOn, othersOn, oursOn, portsServing,
  choosePorts, addressOf, serveOn, serveOff };

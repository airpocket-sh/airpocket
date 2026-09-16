#!/usr/bin/env node
"use strict";
// Airpocket, operator side:
//
//   airpocket pair            a six-digit code for one phone, and a QR of it: ten minutes, five tries
//   airpocket devices         the phones paired with this Mac
//   airpocket revoke <id>     cut a phone off; its token stops working at once
//   airpocket serve           publish Airpocket inside your tailnet
//   airpocket unserve         stop publishing it
//   airpocket status          is it running, is it published, at which address
//
// During the build, run it from the repo as `node src/cli.js <command>`.
const fs = require("fs");
const http = require("http");
const { execFileSync } = require("child_process");
const { createStore } = require("./store");
const { PORTS } = require("./ports");
const QR = require("./public/qr");

// The file-only origin (two-minute links to PDFs and pages) runs next to the app
// and is published on its own HTTPS port, so a file can never share the app's origin.
const TARGETS = [
  { public: PORTS.publicApp, target: `http://127.0.0.1:${PORTS.app}` },
  { public: PORTS.publicFile, target: `http://127.0.0.1:${PORTS.file}` },
];

// Run the CLI that ships inside the app bundle, by its real path. Called through
// the /usr/local/bin/tailscale symlink it aborted with "bundleIdentifier is
// unknown to the registry" (Tailscale 1.102, 2026-09-14).
function tailscaleBin() {
  const found = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
  try { const p = execFileSync("/usr/bin/which", ["tailscale"], { encoding: "utf8" }).trim(); if (p) found.push(p); } catch {}
  found.push("/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale");
  for (const p of found) {
    try { const real = fs.realpathSync(p); fs.accessSync(real, fs.constants.X_OK); return real; } catch {}
  }
  return null;
}
function tailnetAddress(bin) {
  if (!bin) return null;
  try {
    const st = JSON.parse(execFileSync(bin, ["status", "--json"], { encoding: "utf8", timeout: 8000 }));
    const dns = st && st.Self && st.Self.DNSName ? String(st.Self.DNSName).replace(/\.$/, "") : "";
    return dns ? `https://${dns}${PORTS.publicApp === 443 ? "" : ":" + PORTS.publicApp}` : null;
  } catch { return null; }
}
/** What `tailscale serve` already publishes on this Mac, or null when it can't say. */
function serveStatus(bin) {
  try { return JSON.parse(execFileSync(bin, ["serve", "status", "--json"], { encoding: "utf8", timeout: 8000 }).trim() || "{}"); }
  catch { return null; }
}
/**
 * What else is published on a tailnet port: every target there that is not ours.
 * `serve` refuses such a port and `unserve` leaves it alone, so Airpocket never
 * replaces or removes something another program published.
 */
function othersOn(status, port, target) {
  const others = [];
  for (const [hostPort, conf] of Object.entries((status && status.Web) || {})) {
    if (!hostPort.endsWith(":" + port)) continue;
    const handlers = Object.values((conf && conf.Handlers) || {});
    if (!handlers.length) others.push("something else");
    for (const h of handlers) {
      const proxy = String((h && h.Proxy) || "").replace(/\/+$/, "");
      if (proxy !== target) others.push(proxy || "something else");
    }
  }
  const tcp = status && status.TCP ? status.TCP[String(port)] : null;
  if (tcp && tcp.TCPForward) others.push("tcp " + tcp.TCPForward);
  return others;
}
const publishedOn = (status, port) => !!(status && status.TCP && status.TCP[String(port)]);
/** One line per Airpocket port: published for Airpocket, taken by something else, or not published. */
function serveLines(status) {
  return TARGETS.map((t) => {
    const others = othersOn(status, t.public, t.target);
    const ours = Object.entries((status && status.Web) || {}).some(([hostPort, conf]) => hostPort.endsWith(":" + t.public) &&
      Object.values((conf && conf.Handlers) || {}).some((h) => String((h && h.Proxy) || "").replace(/\/+$/, "") === t.target));
    const state = others.length ? "taken by " + others.join(", ") : ours ? "published for Airpocket" : "not published";
    return `https ${String(t.public).padEnd(5)} -> ${t.target.replace("http://", "")}  ${state}`;
  });
}
function localUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORTS.app, path: "/manifest.webmanifest", timeout: 2000 }, (res) => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}
const fail = (...lines) => { for (const l of lines) console.error(l); process.exit(1); };
const noTailscale = () => fail("Tailscale is not installed on this Mac. Install it from https://tailscale.com/download/mac,",
  "sign in, then run this again.");

async function main([cmd, arg]) {
  const store = createStore();
  switch (cmd) {
    case "pair": {
      const up = await localUp();
      const { code, expiresAt } = store.newCode();
      const url = tailnetAddress(tailscaleBin());
      console.log(`\n  Pairing code   ${code.slice(0, 3)} ${code.slice(3)}\n`);
      // The same code and this Mac's address, for the app's camera. Scanning it pairs exactly like typing the code.
      if (url) {
        for (const line of QR.toTerminal(QR.encode(QR.pairPayload(url, code), "M"), { color: !!process.stdout.isTTY })) console.log("  " + line);
        console.log("\n  In the Airpocket app: Scan the code on your Mac, or enter the six digits.");
      }
      console.log(`  Good until ${new Date(expiresAt).toLocaleTimeString()}, five tries, one phone.`);
      console.log(url ? `  On the phone, with Tailscale on, open ${url} and enter it.`
                      : "  Tailscale isn't set up here yet: install it, sign in, then run airpocket serve.");
      if (!up) console.log(`\n  Airpocket is not answering on 127.0.0.1:${PORTS.app}. Start it with npm start.`);
      console.log("");
      break;
    }
    case "devices": {
      const list = store.devices();
      if (!list.length) { console.log("No phones paired with this Mac."); break; }
      for (const d of list) console.log(`${d.id}  ${d.name.padEnd(20)}  paired ${d.createdAt.slice(0, 10)}  last seen ${d.lastSeen ? d.lastSeen.replace("T", " ").slice(0, 16) : "never"}`);
      console.log("\nRevoke one with: airpocket revoke <id>");
      break;
    }
    case "revoke": {
      if (!arg) { console.error("Usage: airpocket revoke <id>   (ids from airpocket devices)"); process.exit(2); }
      console.log(store.revoke(arg) ? `Revoked ${arg}. That phone can't reach this Mac any more.` : `No paired phone with id ${arg}.`);
      break;
    }
    case "serve": {
      const bin = tailscaleBin();
      if (!bin) noTailscale();
      const status = serveStatus(bin);
      if (!status) fail("Couldn't read what Tailscale already publishes here. Nothing was changed.");
      const clash = TARGETS.map((t) => [t, othersOn(status, t.public, t.target)]).filter(([, o]) => o.length);
      if (clash.length) {
        fail(...clash.map(([t, o]) => `HTTPS port ${t.public} already publishes ${o.join(", ")}.`),
          "Airpocket won't replace it. Choose other ports with AIRPOCKET_PUBLIC_PORT and AIRPOCKET_PUBLIC_FILE_PORT.",
          "Nothing was changed.");
      }
      // `serve` publishes inside your tailnet only. Never `funnel`: that would put
      // this on the public internet.
      for (const t of TARGETS) execFileSync(bin, ["serve", `--https=${t.public}`, "--bg", t.target], { stdio: "inherit" });
      const url = tailnetAddress(bin);
      if (url) console.log(`\nPublished inside your tailnet at ${url}\nNext: airpocket pair`);
      break;
    }
    case "unserve": {
      const bin = tailscaleBin();
      if (!bin) noTailscale();
      const status = serveStatus(bin);
      if (!status) fail("Couldn't read what Tailscale publishes here. Nothing was changed.");
      let off = 0;
      for (const t of TARGETS) {
        if (!publishedOn(status, t.public)) continue;
        if (othersOn(status, t.public, t.target).length) { console.log(`Left HTTPS port ${t.public} alone: it publishes something else.`); continue; }
        execFileSync(bin, ["serve", `--https=${t.public}`, "off"], { stdio: "inherit" });
        off++;
      }
      console.log(off ? "No longer published. Airpocket still runs on 127.0.0.1 only." : "Airpocket wasn't published.");
      break;
    }
    case "status": {
      const up = await localUp();
      const bin = tailscaleBin();
      const url = tailnetAddress(bin);
      console.log(`airpocket      ${up ? "running on 127.0.0.1:" + PORTS.app : "not answering on 127.0.0.1:" + PORTS.app}`);
      console.log(`tailscale      ${bin ? (url ? "signed in as " + url.replace("https://", "") : "installed, not signed in") : "not installed"}`);
      if (bin) {
        const st = serveStatus(bin);
        console.log(st ? serveLines(st).map((l) => "  " + l).join("\n") : "  couldn't read what Tailscale publishes here");
      }
      console.log(`paired phones  ${store.devices().length}`);
      break;
    }
    default:
      console.log("Usage: airpocket pair | devices | revoke <id> | serve | unserve | status");
      process.exit(cmd ? 2 : 0);
  }
}

module.exports = { othersOn, serveLines };

if (require.main === module) main(process.argv.slice(2));

#!/usr/bin/env node
"use strict";
// Phone access, operator side. Run inside ~/Developer/claude-overlay/overlay:
//
//   npm run mobile:pair              a six-digit code for one phone: ten minutes, five tries
//   npm run mobile:devices           the phones paired with this Mac
//   npm run mobile:revoke -- <id>    cut a phone off; its token stops working at once
//   npm run mobile:serve             publish the phone server inside your tailnet
//   npm run mobile:unserve           stop publishing it
//   npm run mobile:status            is it running, is it published, at which address
const fs = require("fs");
const http = require("http");
const { execFileSync } = require("child_process");
const { createStore } = require("./store");

const PORT = Number(process.env.PANEL_MOBILE_PORT) || 47821;
// The file-only origin (two-minute links to PDFs and pages) runs next to it and is
// published on its own HTTPS port, so a file can never share the app's origin.
const FILE_PORT = PORT + 1;
const FILE_PUBLIC_PORT = 8443;
const store = createStore();

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
    return dns ? `https://${dns}` : null;
  } catch { return null; }
}
function localUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/manifest.webmanifest", timeout: 2000 }, (res) => {
      res.resume(); resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}
const noTailscale = () => {
  console.error("Tailscale is not installed on this Mac. Install it from https://tailscale.com/download/mac,");
  console.error("sign in, then run this again.");
  process.exit(1);
};

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "pair": {
      const up = await localUp();
      const { code, expiresAt } = store.newCode();
      const url = tailnetAddress(tailscaleBin());
      console.log(`\n  Pairing code   ${code.slice(0, 3)} ${code.slice(3)}\n`);
      console.log(`  Good until ${new Date(expiresAt).toLocaleTimeString()}, five tries, one phone.`);
      console.log(url ? `  On the phone, with Tailscale on, open ${url} and enter it.`
                      : "  Tailscale isn't set up here yet, see the README section \"Phone\".");
      if (!up) console.log(`\n  The phone server is not answering on 127.0.0.1:${PORT}. Is the panel running?`);
      console.log("");
      break;
    }
    case "devices": {
      const list = store.devices();
      if (!list.length) { console.log("No phones paired with this Mac."); break; }
      for (const d of list) console.log(`${d.id}  ${d.name.padEnd(20)}  paired ${d.createdAt.slice(0, 10)}  last seen ${d.lastSeen ? d.lastSeen.replace("T", " ").slice(0, 16) : "never"}`);
      console.log("\nRevoke one with: npm run mobile:revoke -- <id>");
      break;
    }
    case "revoke": {
      if (!arg) { console.error("Usage: npm run mobile:revoke -- <id>   (ids from npm run mobile:devices)"); process.exit(2); }
      console.log(store.revoke(arg) ? `Revoked ${arg}. That phone can't reach this Mac any more.` : `No paired phone with id ${arg}.`);
      break;
    }
    case "serve": {
      const bin = tailscaleBin();
      if (!bin) noTailscale();
      // `serve` publishes inside your tailnet only. Never `funnel`: that would put
      // this on the public internet.
      execFileSync(bin, ["serve", "--https=443", "--bg", `http://127.0.0.1:${PORT}`], { stdio: "inherit" });
      execFileSync(bin, ["serve", `--https=${FILE_PUBLIC_PORT}`, "--bg", `http://127.0.0.1:${FILE_PORT}`], { stdio: "inherit" });
      const url = tailnetAddress(bin);
      if (url) console.log(`\nPublished inside your tailnet at ${url}\nNext: npm run mobile:pair`);
      break;
    }
    case "unserve": {
      const bin = tailscaleBin();
      if (!bin) noTailscale();
      execFileSync(bin, ["serve", "--https=443", "off"], { stdio: "inherit" });
      try { execFileSync(bin, ["serve", `--https=${FILE_PUBLIC_PORT}`, "off"], { stdio: "inherit" }); } catch {}
      console.log("No longer published. The phone server still runs on 127.0.0.1 only.");
      break;
    }
    case "status": {
      const up = await localUp();
      const bin = tailscaleBin();
      const url = tailnetAddress(bin);
      console.log(`phone server   ${up ? "running on 127.0.0.1:" + PORT : "not answering on 127.0.0.1:" + PORT}`);
      console.log(`tailscale      ${bin ? (url ? "signed in as " + url.replace("https://", "") : "installed, not signed in") : "not installed"}`);
      if (bin) { try { console.log("\n" + execFileSync(bin, ["serve", "status"], { encoding: "utf8", timeout: 8000 }).trim()); } catch {} }
      console.log(`paired phones  ${store.devices().length}`);
      break;
    }
    default:
      console.log("Usage: node mobile/cli.js pair | devices | revoke <id> | serve | unserve | status");
      process.exit(cmd ? 2 : 0);
  }
})();

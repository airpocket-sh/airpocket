#!/usr/bin/env node
"use strict";
// Airpocket, operator side:
//
//   airpocket setup [--dry-run]        hooks, login item, Tailscale addresses, then a pairing code
//   airpocket doctor                   check everything; exits 1 when something is broken
//   airpocket uninstall [--dry-run]    remove exactly what setup added; asks about the data folder
//             [--keep-data | --remove-data]
//   airpocket pair                     a six-digit code for one phone, and a QR of it: ten minutes, five tries
//   airpocket devices                  the phones paired with this Mac
//   airpocket revoke <id>              cut a phone off; its token stops working at once
//   airpocket status                   is it running, is it published, at which address
//
// From the repo: `node src/cli.js <command>`.
const { createStore } = require("./store");
const { currentPorts } = require("./ports");
const ts = require("./tailscale");
const setup = require("./setup");

/** One line per Airpocket port: published for Airpocket, taken by something else, or not published. */
function serveLines(status, ports = currentPorts()) {
  return [[ports.publicApp, `http://127.0.0.1:${ports.app}`], [ports.publicFile, `http://127.0.0.1:${ports.file}`]].map(([port, target]) => {
    const others = ts.othersOn(status, port, target);
    const state = others.length ? "taken by " + others.join(", ") : ts.oursOn(status, port, target) ? "published for Airpocket" : "not published";
    return `https ${String(port).padEnd(5)} -> ${target.replace("http://", "")}  ${state}`;
  });
}

const USAGE = "Usage: airpocket setup [--dry-run] | doctor | uninstall [--dry-run] [--keep-data|--remove-data] | pair | devices | revoke <id> | status";

async function main([cmd, ...rest]) {
  switch (cmd) {
    case "setup": return setup.runSetup(setup.context(), rest);
    case "uninstall": return setup.runUninstall(setup.context(), rest);
    case "doctor": return require("./doctor").runDoctor(setup.context());
    case "pair": {
      const ports = currentPorts();
      const up = (await setup.probe(ports.app, "/manifest.webmanifest")) === 200;
      const { code, expiresAt } = createStore().newCode();
      // The address only when Tailscale really publishes Airpocket there: a QR must never point at another program.
      const bin = ts.tailscaleBin();
      const st = ts.tailscaleStatus(bin);
      const serve = st && st.running ? ts.serveStatus(bin) : null;
      const url = serve && ts.oursOn(serve, ports.publicApp, `http://127.0.0.1:${ports.app}`) ? ts.addressOf(st.dns, ports.publicApp) : "";
      for (const line of setup.pairingLines({ code, expiresAt, url, color: !!process.stdout.isTTY })) console.log(line);
      if (!up) console.log(`  Airpocket is not answering on 127.0.0.1:${ports.app}. Check it with: airpocket doctor\n`);
      return 0;
    }
    case "devices": {
      const list = createStore().devices();
      if (!list.length) { console.log("No phones paired with this Mac."); return 0; }
      for (const d of list) console.log(`${d.id}  ${d.name.padEnd(20)}  paired ${d.createdAt.slice(0, 10)}  last seen ${d.lastSeen ? d.lastSeen.replace("T", " ").slice(0, 16) : "never"}`);
      console.log("\nRevoke one with: airpocket revoke <id>");
      return 0;
    }
    case "revoke": {
      const [id] = rest;
      if (!id) { console.error("Usage: airpocket revoke <id>   (ids from airpocket devices)"); return 2; }
      console.log(createStore().revoke(id) ? `Revoked ${id}. That phone can't reach this Mac any more.` : `No paired phone with id ${id}.`);
      return 0;
    }
    case "status": {
      const ports = currentPorts();
      const up = (await setup.probe(ports.app, "/manifest.webmanifest")) === 200;
      const bin = ts.tailscaleBin();
      const st = ts.tailscaleStatus(bin);
      console.log(`airpocket      ${up ? "running on 127.0.0.1:" + ports.app : "not answering on 127.0.0.1:" + ports.app}`);
      console.log(`tailscale      ${bin ? (st && st.running ? "signed in, this Mac is " + (st.dns || "unnamed") : "installed, not signed in") : "not installed"}`);
      if (bin && st && st.running) {
        const serve = ts.serveStatus(bin);
        console.log(serve ? serveLines(serve, ports).map((l) => "  " + l).join("\n") : "  couldn't read what Tailscale publishes here");
        if (serve && ts.oursOn(serve, ports.publicApp, `http://127.0.0.1:${ports.app}`)) console.log(`address        ${ts.addressOf(st.dns, ports.publicApp)}`);
      }
      console.log(`paired phones  ${createStore().devices().length}`);
      return 0;
    }
    default:
      console.log(USAGE);
      return cmd ? 2 : 0;
  }
}

module.exports = { othersOn: ts.othersOn, serveLines, main };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(err.stack || err); process.exitCode = 1; });
}

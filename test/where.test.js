"use strict";
// Pairing only inside the installed app: iOS keeps a Home Screen app's storage
// apart from Safari's, so a token saved in a tab would never reach the app.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { installed, pairingScreen } = require("../src/public/where");

const win = ({ standalone, display, throws } = {}) => ({
  navigator: standalone === undefined ? {} : { standalone },
  matchMedia: display === undefined && !throws ? undefined : (q) => {
    if (throws) throw new Error("no media queries");
    return { matches: q === "(display-mode: standalone)" && display === "standalone" };
  },
});

test("from the Home Screen: the pairing form", () => {
  assert.equal(pairingScreen(win({ standalone: true })), "pair", "iOS says it was opened from the Home Screen");
  assert.equal(pairingScreen(win({ display: "standalone" })), "pair", "the manifest's standalone display mode");
  assert.equal(pairingScreen(win({ standalone: false, display: "standalone" })), "pair");
  assert.equal(installed(win({ standalone: true })), true);
});

test("in a browser tab: the add-to-home-screen steps, never the form", () => {
  assert.equal(pairingScreen(win({ standalone: false, display: "browser" })), "install", "Safari on iOS");
  assert.equal(pairingScreen(win({ display: "browser" })), "install", "a browser without iOS's flag");
  assert.equal(pairingScreen(win({ display: "minimal-ui" })), "install");
  assert.equal(pairingScreen(win({})), "install", "nothing to go on");
  assert.equal(pairingScreen(win({ throws: true })), "install", "a media query that fails");
  assert.equal(pairingScreen(null), "install");
  assert.equal(pairingScreen({ navigator: { standalone: "yes" } }), "install", "only a real true counts");
});

test("the app asks before every pairing form it shows", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.js"), "utf8");
  const calls = app.match(/\brenderPair\(/g) || [];
  assert.equal(calls.length, 2, "defined once, called once");
  assert.match(app, /AirpocketWhere\.pairingScreen\(window\) === "pair" \? renderPair\(/, "and that one call is behind the check");
});

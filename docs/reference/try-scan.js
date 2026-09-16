"use strict";
// Pairing by scanning, end to end in a browser: a throwaway Airpocket on
// loopback makes a code, the QR code `airpocket pair` would print is put in
// front of Chrome's fake camera (turned, keystoned, noisy, as a phone sees a
// screen), and the app, opened as if from the Home Screen, scans it.
//
//   the scan pairs: the phone keeps a token, the Mac lists the phone;
//   a scanned code counts as a try like a typed one, and a used code is gone;
//   a QR code that isn't a pairing code leaves pairing alone.
//
// What this can't show is an iPhone's camera in a Home Screen web app: that
// needs the phone itself.
//
//   node docs/reference/try-scan.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { launch, sleep } = require("./cdp");
const { createServer } = require("../../src/server");
const { createStore } = require("../../src/store");
const QR = require("../../src/public/qr");

const T = fs.mkdtempSync(path.join(os.tmpdir(), "airpocket-scan-"));
const W = 640, H = 480;
let failed = 0;
const check = (ok, what) => { console.log((ok ? "PASS " : "FAIL ") + what); if (!ok) failed++; };

/** A Y4M video (Chrome's fake camera) of one QR code on a busy, noisy background, a little turned. */
function video(file, text, { angle = 0.18, keystone = 0.08 } = {}) {
  const m = QR.encode(text, "M"), n = m.length + 8, size = 300;
  const y = Buffer.alloc(W * H), uv = Buffer.alloc((W / 2) * (H / 2), 128);
  let r = 7;
  const rand = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const cx = W / 2, cy = H / 2, cos = Math.cos(angle), sin = Math.sin(angle);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      // Back from the picture to the code: undo the turn, then a keystone that narrows the top.
      const dx = px - cx, dy = py - cy;
      let u = cos * dx + sin * dy, v = -sin * dx + cos * dy;
      u /= 1 - keystone * (0.5 - (v + size / 2) / size);
      const mx = Math.floor(((u + size / 2) / size) * n) - 4, my = Math.floor(((v + size / 2) / size) * n) - 4;
      const inCode = u >= -size / 2 && u < size / 2 && v >= -size / 2 && v < size / 2;
      const dark = inCode ? mx >= 0 && my >= 0 && mx < m.length && my < m.length && m[my][mx] === 1
        : ((Math.floor(px / 29) + Math.floor(py / 23)) % 3 === 0);
      y[py * W + px] = Math.max(16, Math.min(235, (dark ? 40 : 210) + (rand() - 0.5) * 50));
    }
  }
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`);
  const frame = Buffer.concat([Buffer.from("FRAME\n"), y, uv, uv]);
  fs.writeFileSync(file, Buffer.concat([header, frame, frame]));
}

(async () => {
  const store = createStore(path.join(T, "store"));
  const app = createServer({ store, log: () => {}, hostLabel: "Studio", homeDir: T, claudeDir: path.join(T, ".claude"), codexHome: path.join(T, ".codex"),
    claudeProjects: path.join(T, "projects"), knownSessions: () => [], getQueue: () => [], dequeue: () => 0, hasSuperset: () => false, superset: async () => "{}" });
  await new Promise((ok) => app.server.listen(0, "127.0.0.1", ok));
  const base = "http://127.0.0.1:" + app.server.address().port;

  const run = async (name, payload, then) => {
    const file = path.join(T, name + ".y4m");
    video(file, payload);
    const chrome = await launch({ width: 390, height: 844, scale: 2, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--use-file-for-fake-video-capture=" + file] });
    try {
      await chrome.cmd("Page.addScriptToEvaluateOnNewDocument", { source: "Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true })" });
      await chrome.go(base + "/", 1500);
      await chrome.js(`(() => { const b = [...document.querySelectorAll("button")].find((x) => /Scan the code/.test(x.textContent)); b.click(); return true; })()`);
      await then(chrome);
    } finally { chrome.close(); await sleep(900); }
  };

  // 1. The code the Mac printed, with its address: it pairs.
  let { code } = store.newCode();
  await run("good", QR.pairPayload(base, code), async (c) => {
    let paired = false;
    for (let i = 0; i < 40 && !paired; i++) { await sleep(250); paired = await c.js(`!!document.querySelector(".okring")`); }
    check(paired, "the scan pairs, and the paired screen shows");
    const hosts = JSON.parse(await c.js(`localStorage.getItem("airpocket.hosts.v1")`) || "[]");
    check(hosts.length === 1 && hosts[0].base === "" && /^[A-Za-z0-9_-]{32,}$/.test(hosts[0].token), "the phone keeps a token for this Mac (its own address, so no base)");
    check(store.devices().length === 1, "the Mac lists the phone");
    check(await c.js(`!document.querySelector("video") || !document.querySelector("video").srcObject`), "the camera is off once it has paired");
  });
  check(!fs.existsSync(path.join(store.dir, "pairing.json")), "the code is used up");

  // 2. A wrong code by scan counts as a try, like a typed one, and says so the same way.
  ({ code } = store.newCode());
  const wrong = String((Number(code) + 1) % 1000000).padStart(6, "0");
  await run("wrong", QR.pairPayload(base, wrong), async (c) => {
    let msg = "";
    for (let i = 0; i < 40 && !msg; i++) { await sleep(250); msg = await c.js(`(document.querySelector(".err[role=alert]") || {}).textContent || ""`); }
    check(/Wrong code · 4 tries left/.test(msg), "a wrong scanned code is a wrong try: " + JSON.stringify(msg));
    check(await c.js(`document.querySelector(".digits input").value`) === wrong, "and the code screen shows what was scanned");
  });
  const pending = JSON.parse(fs.readFileSync(path.join(store.dir, "pairing.json"), "utf8"));
  check(pending.attempts === 1, "the Mac counted one try, as for typing");

  // 3. Some other QR code: nothing is sent.
  await run("other", "https://example.com/not-airpocket", async (c) => {
    let note = "";
    for (let i = 0; i < 40 && !note; i++) { await sleep(250); note = await c.js(`(document.querySelector(".vmsg") || {}).textContent || ""`); }
    check(/isn't an Airpocket pairing code/.test(note), "another QR code is named as such: " + JSON.stringify(note));
  });
  check(JSON.parse(fs.readFileSync(path.join(store.dir, "pairing.json"), "utf8")).attempts === 1, "and costs no try");

  app.server.close();
  fs.rmSync(T, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : "all passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

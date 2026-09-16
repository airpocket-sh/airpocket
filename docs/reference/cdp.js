"use strict";
// Headless Chrome over the DevTools protocol, through --remote-debugging-pipe:
// no port, no websocket package. Used by the screenshot and icon scripts.
//
//   const chrome = await launch({ width: 390, height: 844, scale: 2 });
//   await chrome.go("http://127.0.0.1:47871/");
//   await chrome.shot("out.png");
//   chrome.close();
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch({ width = 390, height = 844, scale = 2, mobile = true, args = [] } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "airpocket-chrome-"));
  const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profile}`, "--hide-scrollbars", ...args, "about:blank"], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const toChrome = proc.stdio[3], fromChrome = proc.stdio[4];
  let id = 0, buf = "";
  const waiters = new Map(), listeners = [];
  fromChrome.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let at;
    while ((at = buf.indexOf("\0")) >= 0) {
      const msg = JSON.parse(buf.slice(0, at));
      buf = buf.slice(at + 1);
      if (msg.id && waiters.has(msg.id)) { const w = waiters.get(msg.id); waiters.delete(msg.id); msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result); }
      else for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const i = ++id;
    waiters.set(i, { resolve, reject });
    toChrome.write(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find((t) => t.type === "page");
  const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  const cmd = (method, params) => send(method, params, sessionId);
  await cmd("Page.enable");
  await cmd("Runtime.enable");
  const logs = [];
  listeners.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Runtime.consoleAPICalled") logs.push(m.params.type + ": " + m.params.args.map((a) => a.value ?? a.description).join(" "));
    if (m.method === "Runtime.exceptionThrown") logs.push("exception: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  });
  const size = (w, h, s = scale) => cmd("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: s, mobile });
  await size(width, height);
  const js = async (expression) => {
    const r = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return {
    cmd, js, logs, size, sleep,
    async go(url, wait = 1200) { await cmd("Page.navigate", { url }); await sleep(wait); },
    async shot(file, clip) {
      const r = await cmd("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    },
    close() { try { proc.kill(); } catch {} setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }, 800); },
  };
}

module.exports = { launch, sleep };

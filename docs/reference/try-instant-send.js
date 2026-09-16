"use strict";
// Try sending from the phone: the message shows the moment send is tapped, and
// the conversation's own copy takes its place without a jump.
//
// The real app in headless Chrome (cdp.js) at 390x844, against one throwaway
// Airpocket phone server on loopback with a temporary data folder, a temporary
// pairing store and one invented Claude session. Its terminal is a stand-in
// Superset: a send is held for 600 ms, like the real CLI, then written into
// the session's temporary transcript, the way Claude records a prompt. Nothing
// reaches a real terminal, a real session, the user's agents or their files.
//
//   a sent message is on screen within 60 ms, dashed, with the box empty; a
//   poll while it waits leaves its node alone; the transcript's copy replaces
//   it once, with the scroll position unchanged, and no "Sent" toast;
//   a photo: the tray empties at once, the bubble reads "[1 photo]" before and
//   after, the Mac typed the uploads path, and no path is on the page;
//   a failed send takes the bubble back and returns the words and the photo;
//   scrolled up reading, a send leaves the page where it is and NEW BELOW shows;
//   switching to the terminal and back drops a waiting bubble, and the real
//   message still arrives once;
//   a message the transcript never records is still there at 29 s and gone
//   after 30 s.
//
//   node docs/reference/try-instant-send.js [screenshot folder]
//
// Needs Google Chrome in /Applications. Takes about 45 seconds, most of it the
// 30-second wait at the end. With a folder, it saves three shots there: the
// bubble mid-send, after a photo message, and after a failed send.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

// ports.js reads the data folder when it loads: give it an empty one, never a real Airpocket's.
const T = fs.mkdtempSync(path.join(os.tmpdir(), "airpocket-try-instant-send-"));
process.env.AIRPOCKET_DIR = path.join(T, "data");
for (const k of ["AIRPOCKET_PUBLIC_PORT", "AIRPOCKET_PUBLIC_FILE_PORT"]) delete process.env[k];

const { launch, sleep } = require("./cdp");
const { createServer } = require("../../src/server");
const { createStore } = require("../../src/store");
const { startTimeOf, processInfo } = require("../../src/proc");

const REPO = path.resolve(__dirname, "..", "..");
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : "";
const J = JSON.stringify;
const ME = startTimeOf(process.pid);

// ---- one Claude session, its transcript in the temp folder -----------------------------------------
const HOME = path.join(T, "home"), ROOT = path.join(HOME, "shop-web");
const claudeDir = path.join(T, ".claude"), projects = path.join(claudeDir, "projects"), codexHome = path.join(T, ".codex");
for (const d of [ROOT, path.join(projects, "-shop-web"), codexHome]) fs.mkdirSync(d, { recursive: true });
const ID = "0c0ffee0-0000-4000-8000-000000000002";
const TRANSCRIPT = path.join(projects, "-shop-web", ID + ".jsonl");
let uid = 0;
const user = (text) => J({ type: "user", uuid: "u" + ++uid, timestamp: new Date().toISOString(), cwd: ROOT, message: { role: "user", content: text } });
const say = (text) => J({ type: "assistant", uuid: "a" + ++uid, effort: "high", message: { id: "m" + uid, model: "claude-opus-5", role: "assistant", content: [{ type: "text", text }] } });
const lines = [user("Fix the failing checkout tests.")];
// Long enough to scroll.
for (let i = 1; i <= 14; i++) lines.push(say(`Step ${i}: looked at part ${i} of the suite and it reads fine. Moving on to the next file in the checkout folder.`));
fs.writeFileSync(TRANSCRIPT, lines.join("\n") + "\n");

// ---- the Mac: a phone server whose terminal is a stand-in --------------------------------------------
const store = createStore(path.join(T, "store"));
const typed = [];
// fail: the terminal refuses; recordMs: how long after typing the transcript has it (Infinity: never).
const mac = { fail: false, typeMs: 600, recordMs: 80 };
const sessions = [{ session_id: ID, bridge_id: "session_try", agent: "claude", title: "Refactor auth", cwd: ROOT, pid: process.pid, started: ME,
  last_seen: Math.floor(Date.now() / 1000), terminal: "t1", workspace: "w1", transcript: TRANSCRIPT }];
const app = createServer({ store, log: () => {}, hostLabel: "Studio", homeDir: HOME, claudeDir, codexHome, claudeProjects: projects,
  knownSessions: () => sessions, getQueue: () => [], dequeue: () => 0, hasSuperset: () => true, typeGap: () => 0, unseenAgents: () => ({}),
  fileBase: async () => "http://127.0.0.1:47999",
  // This process stands in for the agent, in the foreground of a stand-in terminal.
  inspectAgent: (pid) => { const i = processInfo(pid); return i && { ...i, tty: "ttys990", pgid: 9, tpgid: 9 }; },
  superset: async (args) => {
    if (args[1] === "read") return J({ text: "● Done\n\n╭──╮\n│ ❯  │\n╰──╯" });
    if (args[1] === "send") {
      const text = args[args.indexOf("--text") + 1];
      await sleep(mac.typeMs);
      if (mac.fail) throw new Error("the stand-in terminal refused");
      typed.push(text);
      if (text && !args.includes("--no-submit") && Number.isFinite(mac.recordMs)) setTimeout(() => fs.appendFileSync(TRANSCRIPT, user(text) + "\n"), mac.recordMs);
    }
    return "{}";
  } });

const results = [];
const check = (ok, what) => { results.push((ok ? "PASS " : "FAIL ") + what); console.log(results[results.length - 1]); };

async function pair(base) {
  const code = store.newCode().code;
  return new Promise((ok, no) => {
    const r = http.request(base + "/api/pair", { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { try { ok(JSON.parse(b).token); } catch (e) { no(e); } });
    });
    r.on("error", no);
    r.end(J({ code, name: "try-instant-send" }));
  });
}

async function main() {
  if (OUT) fs.mkdirSync(OUT, { recursive: true });
  const port = await new Promise((ok) => app.server.listen(0, "127.0.0.1", () => ok(app.server.address().port)));
  const base = "http://127.0.0.1:" + port;
  const token = await pair(base);

  const chrome = await launch({ width: 390, height: 844, scale: 2 });
  const { cmd, js } = chrome;
  try {
    // A Home Screen app, paired with this Mac, opened on the session.
    await cmd("Page.addScriptToEvaluateOnNewDocument", { source: "Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true })" });
    await chrome.go(base + "/manifest.webmanifest", 300);
    await js(`localStorage.clear(); localStorage.setItem("airpocket.hosts.v1", ${J(J([{ id: "h1", name: "Studio", base: "", token, deviceId: "d1" }]))}); localStorage.setItem("airpocket.prefs.v1", ${J(J({ wrap: true }))}); true`);
    await chrome.go(base + "/#/s/h1/" + ID, 3000);

    const type = (v) => js(`(() => { const el = document.querySelector("textarea.input"); el.focus(); el.value = ${J(v)}; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    const send = () => js(`document.querySelector("button.send").click(), true`);
    const bubbles = () => js(`[...document.querySelectorAll(".msg.user")].map((b) => ({ t: b.firstChild.textContent, p: b.classList.contains("pending") }))`);
    const last = async () => (await bubbles()).slice(-1)[0] || {};
    const boxValue = () => js(`document.querySelector("textarea.input").value`);
    const toast = () => js(`(() => { const t = document.getElementById("toast"); return t && !t.hidden ? t.textContent : ""; })()`);
    const settle = async () => { for (let i = 0; i < 40 && (await last()).p; i++) await sleep(100); };
    const addPhoto = async () => {
      const { root } = await cmd("DOM.getDocument", {});
      const { nodeId } = await cmd("DOM.querySelector", { nodeId: root.nodeId, selector: "input.picker" });
      await cmd("DOM.setFileInputFiles", { nodeId, files: [path.join(REPO, "src", "public", "icon-180.png")] });
      for (let i = 0; i < 40 && !(await js(`!!document.querySelector(".tray .chip:not(.busy)")`)); i++) await sleep(100);
    };
    const shot = (name) => (OUT ? chrome.shot(path.join(OUT, name)) : null);

    // 1. A message shows at once, then the transcript's copy takes its place.
    await type("run the auth tests only");
    const t0 = Date.now();
    await send(); await sleep(60);
    let b = await last();
    check(b.p && b.t === "run the auth tests only", "the message is on screen within 60 ms, marked as on its way");
    check((await boxValue()) === "", "the box emptied at once");
    const y0 = await js(`scrollY`);
    await shot("instant-send-1-pending.png");
    await js(`(window.__pending = document.querySelector(".msg.user.pending"), true)`);
    await sleep(400);
    check(await js(`window.__pending === document.querySelector(".msg.user.pending")`), "a redraw while it waits leaves its node alone");
    await settle();
    b = await last();
    check(!b.p && b.t === "run the auth tests only", `the transcript's copy took its place, ${Date.now() - t0} ms after the tap`);
    check((await bubbles()).filter((x) => x.t === "run the auth tests only").length === 1, "the message shows once");
    check(Math.abs((await js(`scrollY`)) - y0) < 2, "the swap didn't move the page");
    check(!/Sent/.test(await toast()), "no Sent toast over the bubble");

    // 2. A photo: its path goes to the terminal, never to the page.
    await addPhoto();
    await type("what is wrong here?");
    await send(); await sleep(60);
    b = await last();
    check(b.p && b.t === "what is wrong here?\n[1 photo]", "a photo message is on screen at once, as a count");
    check(await js(`document.querySelector(".tray").hidden`), "the photo tray emptied at once");
    await settle(); await sleep(300);
    b = await last();
    check(!b.p && b.t === "what is wrong here?\n[1 photo]", "the transcript's copy reads the same");
    check(/"\/.*\/uploads\/[^"]+\.png"$/.test(typed[typed.length - 1] || ""), "the Mac typed the photo's path");
    check(!(await js(`document.body.innerText.includes("uploads")`)), "no path on the page");
    await shot("instant-send-2-photo.png");

    // 3. A failed send puts everything back.
    mac.fail = true;
    await addPhoto();
    await type("this one won't go");
    await send(); await sleep(60);
    check((await last()).p, "on its way while the Mac tries");
    await sleep(1500);
    check(!(await bubbles()).some((x) => x.p || x.t.startsWith("this one")), "the bubble went when it failed");
    check((await boxValue()) === "this one won't go", "the words came back");
    check((await js(`document.querySelectorAll(".tray .chip").length`)) === 1 && !(await js(`document.querySelector(".tray").hidden`)), "the photo came back");
    check((await toast()) !== "", "the toast says why");
    await shot("instant-send-3-failed.png");
    mac.fail = false;
    await js(`document.querySelector(".tray .chip .x").click(), true`);
    await type("");

    // 4. Scrolled up reading: a send doesn't pull the page down.
    await js(`window.scrollTo(0, 0), true`); await sleep(300);
    mac.recordMs = 2000;
    await type("read further up");
    await send(); await sleep(100);
    check((await js(`scrollY`)) < 5, "reading further up, the page stays where it is");
    check(!(await js(`document.querySelector(".newer").hidden`)), "and NEW BELOW shows");

    // 5. Switching to the terminal and back drops a waiting bubble.
    const seg = (label) => js(`[...document.querySelectorAll(".seg button")].find((x) => x.textContent === ${J(label)}).click(), true`);
    await seg("TERM"); await sleep(500);
    await seg("CHAT"); await sleep(300);
    check(!(await bubbles()).some((x) => x.p), "switching views drops a waiting bubble");
    await sleep(2500);
    check((await bubbles()).filter((x) => x.t === "read further up").length === 1, "the real message still arrives, once");

    // 6. A message the transcript never records goes after half a minute.
    mac.recordMs = Infinity;
    await js(`window.scrollTo(0, document.documentElement.scrollHeight), true`);
    await type("never recorded");
    await send(); await sleep(200);
    check((await last()).p, "a message the transcript doesn't have waits");
    await sleep(29000);
    check((await last()).p, "still there at 29 s");
    await sleep(2000);
    check(!(await bubbles()).some((x) => x.p), "gone after 30 s");

    check(!chrome.logs.some((l) => /^(error|exception)/.test(l)), "no errors in the page" + (chrome.logs.length ? ": " + J(chrome.logs) : ""));
  } finally {
    chrome.close();
    const closed = new Promise((ok) => app.server.close(ok));
    app.server.closeAllConnections();
    await closed;
  }
}

main().catch((err) => { check(false, "the trial ran to the end: " + (err && err.stack || err)); }).finally(() => {
  setTimeout(() => {
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
    const failed = results.filter((r) => r.startsWith("FAIL")).length;
    console.log(failed ? `${failed} of ${results.length} failed` : `all ${results.length} passed`);
    process.exit(failed ? 1 : 0);
  }, 900);
});

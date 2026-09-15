// Reference harness from the private tool: phone-size screenshots over the Chrome DevTools
// protocol. Adapt the paths and steps; it expects the ws package and Google Chrome.
// Phone-size screenshots of file viewing. usage: node shoot4.js <base> <token> <outDir> <sessionId>
const WebSocket = require(process.env.HOME + "/Developer/claude-overlay/overlay/node_modules/ws");
const { spawn } = require("child_process");
const fs = require("fs"), http = require("http");
const [base, token, out, sid] = process.argv.slice(2);
const PORT = 9349;
const prof = fs.mkdtempSync("/tmp/panel-shoot4-");
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, "--window-size=390,844", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJSON = (p) => new Promise((res, rej) => http.get({ host: "127.0.0.1", port: PORT, path: p }, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on("error", rej));
async function done(code) { chrome.kill(); await sleep(800); try { fs.rmSync(prof, { recursive: true, force: true }); } catch {} process.exit(code); }
(async () => {
  let targets = [];
  for (let i = 0; i < 40; i++) { try { targets = await getJSON("/json"); if (targets.length) break; } catch {} await sleep(250); }
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  let id = 0; const waiters = new Map();
  ws.on("message", (m) => { const d = JSON.parse(m); if (d.id && waiters.has(d.id)) { waiters.get(d.id)(d); waiters.delete(d.id); } });
  const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; waiters.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expression) => (await cmd("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;
  const shot = async (name) => { const r = await cmd("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`${out}/${name}.png`, Buffer.from(r.result.data, "base64")); console.log("saved", name); };
  await cmd("Page.enable"); await cmd("Runtime.enable");
  await cmd("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cmd("Page.navigate", { url: base + "/" }); await sleep(1500);
  await js(`localStorage.setItem("panel.hosts.v1", JSON.stringify([{id:"h1",name:"Studio",base:"",token:${JSON.stringify(token)},deviceId:"x"}]))`);
  await cmd("Page.reload", { ignoreCache: true }); await sleep(2500);
  await js(`location.hash = ${JSON.stringify("#/s/h1/" + encodeURIComponent(sid))}`); await sleep(6000);
  await shot("1-chat-with-files");
  console.log("chips:", await js(`[...document.querySelectorAll(".attchip")].map((b) => b.textContent).slice(0, 6).join(" | ")`));
  console.log("step links:", await js(`document.querySelectorAll(".step.link").length`));
  await js(`document.querySelector('[aria-label="Files"]').click()`); await sleep(2500);
  await shot("2-files-list");
  console.log("rows:", await js(`[...document.querySelectorAll(".frow b")].map((b) => b.textContent).slice(0, 8).join(" | ")`));
  const clicked = await js(`(() => { const r = [...document.querySelectorAll(".frow")].find((x) => /\\.pdf$/i.test(x.querySelector("b").textContent)); if (r) { r.click(); return r.querySelector("b").textContent; } return ""; })()`);
  console.log("opened pdf:", clicked); await sleep(2000);
  await shot("3-pdf-card");
  console.log("link ok:", await js(`(() => { const a = document.querySelector(".openlink"); return a ? [a.target, a.rel, /\\/f\\/[A-Za-z0-9_-]{43}\\//.test(a.href)].join(" ") : "none"; })()`));
  await js(`[...document.querySelectorAll(".viewer")].pop().querySelector(".vh .ib").click()`); await sleep(400);
  const md = await js(`(() => { const r = [...document.querySelectorAll(".frow")].find((x) => /\\.(md|csv|txt|json)$/i.test(x.querySelector("b").textContent)); if (r) { r.click(); return r.querySelector("b").textContent; } return ""; })()`);
  console.log("opened text:", md); await sleep(2500);
  await shot("4-text-file");
  await js(`[...document.querySelectorAll(".viewer")].pop().querySelector(".vh .ib").click()`); await sleep(400);
  const png = await js(`(() => { const r = [...document.querySelectorAll(".frow")].find((x) => /\\.png$/i.test(x.querySelector("b").textContent)); if (r) { r.click(); return r.querySelector("b").textContent; } return ""; })()`);
  console.log("opened image:", png); await sleep(3000);
  console.log("image shown:", await js(`(() => { const i = document.querySelector(".fileimg"); return i ? [i.src.slice(0, 5), i.naturalWidth > 0].join(" ") : "none"; })()`));
  await shot("5-image");
  ws.close(); await done(0);
})().catch(async (e) => { console.error(e); await done(1); });

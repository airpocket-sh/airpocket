"use strict";
// Renders the launch page's share images from their committed sources, with the page's own fonts
// and map: og.png (1200x630, from og.html) and icon-180.png (the PNG fallback and Apple touch icon,
// from icon.svg on the dark ground, square, since iOS rounds the corners itself).
// A build step, run by hand when the card or the icon changes; the PNGs are committed.
//
//   node site/render-card.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { launch } = require("../docs/reference/cdp");

const SITE = __dirname;

// Chat apps give up on large previews; stay well under.
const LIMIT = 300 * 1024;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "airpocket-card-"));
  const page = path.join(tmp, "icon.html");
  const chrome = await launch({ width: 1200, height: 630, scale: 1, mobile: false, args: ["--allow-file-access-from-files"] });
  const render = async (url, w, h, out) => {
    await chrome.size(w, h, 1);
    await chrome.go(url, 900);
    await chrome.js("document.fonts.ready.then(() => true)");
    await chrome.sleep(200);
    const r = await chrome.cmd("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 }, captureBeyondViewport: false });
    fs.writeFileSync(out, Buffer.from(r.data, "base64"));
    const size = fs.statSync(out).size;
    console.log(path.relative(process.cwd(), out), size, "bytes");
    if (chrome.logs.length) throw new Error("console: " + chrome.logs.join("; "));
    return size;
  };
  try {
    const card = await render(pathToFileURL(path.join(SITE, "og.html")).href, 1200, 630, path.join(SITE, "og.png"));
    if (card > LIMIT) throw new Error(`og.png is ${card} bytes, over ${LIMIT}`);
    fs.writeFileSync(page, `<!doctype html><html><body style="margin:0;background:#0A0D08"><img src="${pathToFileURL(path.join(SITE, "icon.svg")).href}" width="180" height="180" style="display:block"></body></html>`);
    await render(pathToFileURL(page).href, 180, 180, path.join(SITE, "icon-180.png"));
  } finally {
    chrome.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });

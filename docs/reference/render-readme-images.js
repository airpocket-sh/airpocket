"use strict";
// Renders the README's pictures from their committed sources in docs/images, with the launch
// page's fonts, map and screenshots: banner.png (1280x360, from banner.html), phones.png
// (1600x1150, from phones.html) and social-preview.png (1280x640, from social.html, uploaded
// by hand in the repository's settings). The banner is drawn at twice its size, 2560x720, so its type stays
// sharp on a high-density screen; the phones picture is wide enough as it is.
// A build step, run by hand when a source, the shots or the look change; the PNGs are committed.
// Same approach as site/render-card.js.
//
//   node docs/reference/render-readme-images.js
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { launch } = require("./cdp");

const IMAGES = path.join(__dirname, "..", "images");

// Every clone downloads these, and so does every visitor to the README: keep each one small.
const LIMIT = 400 * 1024;

const PICTURES = [
  { source: "banner.html", out: "banner.png", width: 1280, height: 360, scale: 2 },
  { source: "phones.html", out: "phones.png", width: 1600, height: 1150, scale: 1 },
  // GitHub's own size for the picture a shared repository link shows. Uploaded by hand in
  // Settings, under Social preview: GitHub has no API for it.
  { source: "social.html", out: "social-preview.png", width: 1280, height: 640, scale: 1 },
  // The square picture a profile wants: Workspace, X, a GitHub organisation, Gravatar.
  { source: "avatar.html", out: "avatar.png", width: 1024, height: 1024, scale: 1 },
];

(async () => {
  const chrome = await launch({ width: 1280, height: 360, scale: 1, mobile: false, args: ["--allow-file-access-from-files"] });
  try {
    for (const p of PICTURES) {
      await chrome.size(p.width, p.height, p.scale);
      await chrome.go(pathToFileURL(path.join(IMAGES, p.source)).href, 900);
      await chrome.js("document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode()))).then(() => true)");
      await chrome.sleep(200);
      const r = await chrome.cmd("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: p.width, height: p.height, scale: 1 }, captureBeyondViewport: false });
      const out = path.join(IMAGES, p.out);
      fs.writeFileSync(out, Buffer.from(r.data, "base64"));
      const size = fs.statSync(out).size;
      console.log(path.relative(process.cwd(), out), size, "bytes");
      if (chrome.logs.length) throw new Error("console: " + chrome.logs.join("; "));
      if (size > LIMIT) throw new Error(`${p.out} is ${size} bytes, over ${LIMIT}`);
    }
  } finally {
    chrome.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });

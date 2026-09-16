"use strict";
// Renders the app icons and the iOS launch images from the design pack's own
// markup (docs/design/screens-c.html, I1 and L1), with the app's fonts and map.
// A build step, run by hand when the design changes; the PNGs are committed.
//
//   node docs/reference/render-icons.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launch } = require("./cdp");

const ROOT = path.join(__dirname, "..", "..");
const PUBLIC = path.join(ROOT, "src", "public");
const css = fs.readFileSync(path.join(PUBLIC, "app.css"), "utf8");
const TOKENS = /:root\s*\{[^}]*--ground[^}]*\}/.exec(css)[0];
const FONTS = css.match(/@font-face\s*\{[^}]*\}/g).join("\n");

// The iPhone screens a launch image is made for: CSS size and pixel ratio, portrait.
const LAUNCH = [
  [375, 667, 2], [414, 736, 3], [375, 812, 3], [414, 896, 2], [414, 896, 3], [390, 844, 3], [428, 926, 3],
  [393, 852, 3], [430, 932, 3], [402, 874, 3], [440, 956, 3], [420, 912, 3],
];

// Launch images are photos of a dark gradient: JPEG keeps them a tenth of PNG's size.
const QUALITY = Number(process.env.QUALITY) || 86;

const page = (body, extra = "") => `<!doctype html><html><head><meta charset="utf-8"><style>${TOKENS}\n${FONTS}
html,body{margin:0;background:transparent}*{box-sizing:border-box}${extra}</style></head><body>${body}</body></html>`;

// I1, 256 px, and its 60 px version with the heavier stroke. `round` keeps the pack's corner; the others are full-bleed.
const icon = (size, round) => {
  const big = size === 256;
  return `<div id="i" style="width:${size}px;height:${size}px;${round ? `border-radius:${big ? 57 : 13}px;` : ""}background:var(--map-ink);position:relative;overflow:hidden">
<div style="position:absolute;inset:-12%;background:var(--map) 70% 78%/230% auto no-repeat;filter:brightness(2.1) contrast(1.3) saturate(1.1)"></div>
<div style="position:absolute;inset:0;background-image:linear-gradient(rgba(231,233,222,${big ? ".05" : ".06"}) 1px,transparent 1px),linear-gradient(90deg,rgba(231,233,222,${big ? ".05" : ".06"}) 1px,transparent 1px);background-size:12.5% 12.5%"></div>
<div style="position:absolute;inset:0;background:radial-gradient(circle at 50% 50%,transparent 40%,rgba(10,13,8,.55) 100%)"></div>
${big ? `<div style="position:absolute;left:50%;top:0;bottom:0;width:2px;background:rgba(215,196,158,.18);transform:translateX(-50%)"></div><div style="position:absolute;top:50%;left:0;right:0;height:2px;background:rgba(215,196,158,.18);transform:translateY(-50%)"></div>` : ""}
<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#D7C49E" stroke-width="${big ? ".9" : "1.4"}" stroke-linejoin="round" style="position:absolute;inset:0${big ? ";filter:drop-shadow(0 0 6px rgba(215,196,158,.7))" : ""}"><path d="M5.5 18.5l13-6.5-13-6.5v4.2l7 2.3-7 2.3z"/></svg></div>`;
};

// L1 without the device chrome: map crop, corner marks, the ring with its sweep stopped, the dart, the name.
const launchScreen = (w, h) => `<div id="i" style="position:relative;width:${w}px;height:${h}px;overflow:hidden;background:var(--ground) var(--map) ${-Math.min(330, 780 - w)}px ${-Math.min(820, 1688 - h)}px/780px 1688px no-repeat;display:flex;align-items:center;justify-content:center">
<div style="position:absolute;left:24px;top:80px;width:20px;height:20px;border-left:1px solid var(--stroke-2);border-top:1px solid var(--stroke-2)"></div><div style="position:absolute;right:24px;top:80px;width:20px;height:20px;border-right:1px solid var(--stroke-2);border-top:1px solid var(--stroke-2)"></div><div style="position:absolute;left:24px;bottom:60px;width:20px;height:20px;border-left:1px solid var(--stroke-2);border-bottom:1px solid var(--stroke-2)"></div><div style="position:absolute;right:24px;bottom:60px;width:20px;height:20px;border-right:1px solid var(--stroke-2);border-bottom:1px solid var(--stroke-2)"></div>
<div style="position:absolute;left:50%;top:50%;width:200px;height:200px;border-radius:50%;border:1px dashed rgba(215,196,158,.3);transform:translate(-50%,-50%);overflow:hidden"><div style="position:absolute;inset:0;background:conic-gradient(from 0deg,rgba(215,196,158,.28),transparent 90deg)"></div></div>
<svg width="96" height="96" viewBox="0 0 24 24" fill="none" stroke="#D7C49E" stroke-width="1" style="position:relative;filter:drop-shadow(0 0 8px rgba(215,196,158,.5))"><path d="M4 20l16-8L4 4v5l9 3-9 3z"/></svg>
<div style="position:absolute;bottom:80px;left:0;right:0;text-align:center;font-family:var(--font-mono);font-size:13px;letter-spacing:.14em;color:var(--fg-2)">AIRPOCKET</div></div>`;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "airpocket-icons-"));
  fs.cpSync(path.join(PUBLIC, "fonts"), path.join(tmp, "fonts"), { recursive: true });
  fs.copyFileSync(path.join(PUBLIC, "map.svg"), path.join(tmp, "map.svg"));
  const chrome = await launch({ width: 600, height: 600, scale: 1, mobile: false, args: ["--allow-file-access-from-files"] });
  const render = async (name, html, w, h, scale, out) => {
    const file = path.join(tmp, name + ".html");
    fs.writeFileSync(file, page(html));
    await chrome.size(w, h, scale);
    await chrome.go("file://" + file, 900);
    await chrome.js("document.fonts.ready.then(() => true)");
    await chrome.sleep(200);
    const jpeg = out.endsWith(".jpg");
    const r = await chrome.cmd("Page.captureScreenshot", { format: jpeg ? "jpeg" : "png", ...(jpeg ? { quality: QUALITY } : { omitBackground: true }),
      clip: { x: 0, y: 0, width: w, height: h, scale: 1 }, captureBeyondViewport: false });
    fs.writeFileSync(out, Buffer.from(r.data, "base64"));
    console.log(path.relative(ROOT, out), fs.statSync(out).size, "bytes");
  };
  try {
    await chrome.cmd("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    await render("icon-180", icon(60, false), 60, 60, 3, path.join(PUBLIC, "icon-180.png"));
    await render("icon-512", icon(256, true), 256, 256, 2, path.join(PUBLIC, "icon-512.png"));
    await render("icon-maskable", icon(256, false), 256, 256, 2, path.join(PUBLIC, "icon-maskable-512.png"));
    if (process.argv[2] !== "icons") {
      fs.mkdirSync(path.join(PUBLIC, "launch"), { recursive: true });
      for (const [w, h, s] of LAUNCH) await render(`l-${w}x${h}`, launchScreen(w, h), w, h, s, path.join(PUBLIC, "launch", `${w}x${h}@${s}.jpg`));
    }
  } finally {
    chrome.close();
    setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 1000);
  }
})().catch((e) => { console.error(e); process.exit(1); });

module.exports = { LAUNCH };

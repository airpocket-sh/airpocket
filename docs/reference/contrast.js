"use strict";
// Contrast of the app's text and lights over its glass, measured where the map
// is brightest. Two ways:
//
//   worst case  the brightest pixel of map.svg itself, with the pane's colour laid
//               over it. Blur only averages the map, so nothing behind a pane is
//               brighter than this.
//   rendered    the same panes drawn by Chrome, with their real blur and saturation,
//               over that brightest part of the map; the pane's own pixel is read back.
//
// WCAG 2 contrast ratios. Text wants 4.5:1, a control's border 3:1.
//
//   node docs/reference/contrast.js
const fs = require("fs");
const path = require("path");
const http = require("http");
const { launch } = require("./cdp");

const PUBLIC = path.join(__dirname, "..", "..", "src", "public");
const css = fs.readFileSync(path.join(PUBLIC, "app.css"), "utf8");
const tokens = {};
for (const block of css.match(/:root\s*\{[^}]*\}/g)) for (const m of block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;}]+)/g)) tokens[m[1]] = m[2].trim();
const color = (v) => {
  v = String(v).trim();
  const ref = /^var\(--([a-z0-9-]+)\)$/.exec(v);
  if (ref) return color(tokens[ref[1]]);
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (m) { const p = m[1].split(",").map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; }
  throw new Error("not a colour: " + v);
};
const over = (top, under) => top.slice(0, 3).map((c, i) => c * top[3] + under[i] * (1 - top[3]));
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const hex = (rgb) => "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("").toUpperCase();

// What sits on the glass: the text and lights, the size they come in, what they must reach.
const INK = [
  ["body text (--fg), 15-16px", "fg", 4.5], ["secondary (--fg-2), 13-15px", "fg-2", 4.5], ["meta (--fg-3), 11px", "fg-3", 4.5],
  ["sand: buttons, links, soft keys", "sand", 4.5], ["green light and working", "green", 4.5], ["amber light and caution", "amber", 4.5],
  ["red light and errors", "red", 4.5], ["control border (--stroke-2)", "stroke-2", 3],
];
const FILLED = [["NEEDS PERMISSION: --on-amber on --amber", "on-amber", "amber"], ["active choice: --on-sand on --sand", "on-sand", "sand"],
  ["Clear, Remove: --on-red on --red-solid", "on-red", "red-solid"]];

(async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === "/map.svg") { res.writeHead(200, { "Content-Type": "image/svg+xml" }); return res.end(fs.readFileSync(path.join(PUBLIC, "map.svg"))); }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<body style='margin:0'></body>");
  }).listen(0, "127.0.0.1");
  await new Promise((ok) => srv.on("listening", ok));
  const origin = "http://127.0.0.1:" + srv.address().port;
  const chrome = await launch({ width: 780, height: 1688, scale: 1, mobile: false });
  await chrome.go(origin + "/", 400);
  // The brightest point of the map, drawn at its own size.
  const peak = await chrome.js(`new Promise((ok) => { const img = new Image(); img.onload = () => {
    const c = document.createElement("canvas"); c.width = 780; c.height = 1688; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, 780, 1688).data; let best = -1, at = 0;
    const L = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * L(d[i]) + 0.7152 * L(d[i + 1]) + 0.0722 * L(d[i + 2]); if (l > best) { best = l; at = i / 4; } }
    ok({ x: at % 780, y: Math.floor(at / 780), rgb: [d[at * 4], d[at * 4 + 1], d[at * 4 + 2]] }); }; img.src = "/map.svg"; })`);
  // Rendered: each glass as a 200x200 pane over the map, placed so the brightest point is under the pane's middle.
  const rendered = {};
  for (const [name, bg] of [["glass", tokens.glass], ["glass-2", tokens["glass-2"]]]) {
    await chrome.size(400, 400, 1);
    await chrome.js(`(() => { document.body.innerHTML = ""; document.body.style.cssText = "margin:0;background:${tokens.ground} url(/map.svg) ${200 - peak.x}px ${200 - peak.y}px/780px 1688px no-repeat";
      const p = document.createElement("div"); p.style.cssText = "position:absolute;left:100px;top:100px;width:200px;height:200px;background:${bg};backdrop-filter:${tokens.blur};-webkit-backdrop-filter:${tokens.blur}";
      document.body.append(p); return true; })()`);
    await chrome.sleep(500);
    const file = path.join(require("os").tmpdir(), "airpocket-contrast-" + name + ".png");
    const shot = await chrome.cmd("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 400, height: 400, scale: 1 } });
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    rendered[name] = await chrome.js(`new Promise((ok) => { const img = new Image(); img.onload = () => { const c = document.createElement("canvas"); c.width = 400; c.height = 400;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0); let best = [0, 0, 0], bl = -1; const d = g.getImageData(110, 110, 180, 180).data;
      const L = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * L(d[i]) + 0.7152 * L(d[i + 1]) + 0.0722 * L(d[i + 2]); if (l > bl) { bl = l; best = [d[i], d[i + 1], d[i + 2]]; } }
      ok(best); }; img.src = "data:image/png;base64,${shot.data}"; })`);
    fs.rmSync(file, { force: true });
  }
  chrome.close();
  srv.close();

  const map = peak.rgb;
  const backs = [
    ["bare map", map],
    ["--glass (.55), worst case", over(color(tokens.glass), map)], ["--glass (.55), rendered", rendered.glass],
    ["--glass-2 (.74), worst case", over(color(tokens["glass-2"]), map)], ["--glass-2 (.74), rendered", rendered["glass-2"]],
  ];
  console.log(`Brightest point of map.svg: ${hex(map)} at (${peak.x}, ${peak.y})`);
  console.log(backs.map(([n, c]) => `  ${n.padEnd(30)} ${hex(c)}`).join("\n"));
  // The bare map carries text too: first run and pairing sit straight on it.
  const cols = backs.map(([n]) => n.replace(" worst case", " worst").replace(" rendered", " drawn"));
  console.log("\n" + "".padEnd(36) + cols.map((c) => c.padEnd(24)).join(""));
  let low = 0;
  for (const [label, token, need] of INK) {
    const vals = backs.map(([, bg]) => ratio(color(tokens[token]), bg));
    if (vals.some((v) => v < need)) low++;
    console.log(label.padEnd(36) + vals.map((v) => (v.toFixed(1) + ":1" + (v < need ? " LOW" : "")).padEnd(24)).join(""));
  }
  console.log("\nFilled (opaque, so the map doesn't matter):");
  for (const [label, fg, bg] of FILLED) {
    const v = ratio(color(tokens[fg]), color(tokens[bg]));
    if (v < 4.5) low++;
    console.log("  " + label.padEnd(44) + v.toFixed(1) + ":1");
  }
  console.log(low ? `\n${low} below what they need somewhere: the bare map carries only first run's text (--fg, --fg-2, --fg-3); pairing sits on --glass.`
    : "\nall above 4.5:1 for text and 3:1 for borders");
})().catch((e) => { console.error(e); process.exit(1); });

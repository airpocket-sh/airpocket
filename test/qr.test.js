"use strict";
// QR codes for pairing: the encoder `airpocket pair` draws with, and the scanner
// the phone reads it with. Both are checked against each other, against an
// independent encoder's output (test/fixtures/qr-independent.json, made with
// Python's qrcode package), and against pictures the way a camera sees them:
// turned, keystoned, low contrast, noisy, light on dark.
const test = require("node:test");
const assert = require("node:assert/strict");
const Q = require("../src/public/qr");

const PAIR = "AIRPOCKET:PAIR:481207:HTTPS://STUDIO.TAIL1234.TS.NET";

test("every level and size round-trips, alphanumeric and bytes, versions 1 to 10", () => {
  const seen = new Set();
  for (const level of "LMQH") {
    for (let len = 1; len <= 230; len += 11) {
      for (const text of ["A1 $%*+-./:".repeat(30).slice(0, len), Array.from({ length: len }, (_, i) => String.fromCharCode(33 + ((i * 7) % 90))).join("")]) {
        let m;
        try { m = Q.encode(text, level); } catch { continue; }
        seen.add((m.length - 17) / 4);
        assert.equal(Q.decodeMatrix(m), text, `${level} ${len}`);
      }
    }
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(Q.decodeMatrix(Q.encode("Öncel · ş ğ ı → ✓")), "Öncel · ş ğ ı → ✓", "UTF-8 in byte mode");
  assert.throws(() => Q.encode("x".repeat(400), "H"), /Too long/);
});

test("codes from an independent encoder decode, with every mask", () => {
  const f = require("./fixtures/qr-independent.json");
  const masks = new Set();
  for (const c of f.codes) {
    masks.add(c.mask);
    assert.equal(Q.decodeMatrix(c.rows.map((r) => [...r].map(Number))), c.text, `${c.level} v${c.version} mask ${c.mask}`);
  }
  assert.equal(masks.size, 8);
});

test("Reed-Solomon fixes up to half its check bytes and refuses more", () => {
  const { divisor, remainder } = Q._internal;
  const data = Array.from({ length: 43 }, (_, i) => (i * 37 + 11) & 255);
  const msg = [...data, ...remainder(data, divisor(24))];
  const hit = (n) => { const m = msg.slice(); for (let i = 0; i < n; i++) m[(i * 29) % m.length] ^= 0x5a + i; return m; };
  for (let n = 0; n <= 12; n++) assert.deepEqual(Q.correct(hit(n), 24), msg, `${n} bad bytes`);
  assert.equal(Q.correct(hit(13), 24), null);
  // Modules in a symbol: a smudge over a corner of the data still reads.
  const m = Q.encode(PAIR, "M");
  for (let y = 20; y < 25; y++) for (let x = 20; x < 25; x++) m[y][x] ^= 1;
  assert.equal(Q.decodeMatrix(m), PAIR);
  assert.equal(Q.decodeMatrix([[1, 0], [0, 1]]), null, "not a symbol");
});

/** A grey picture of a symbol, mapped by `place` (module space -> picture), 2x2 supersampled. */
function picture(m, { w = 480, h = 400, place, dark = 30, light = 220, noise = 0, seed = 7 }) {
  const n = m.length, quiet = 4, full = n + 2 * quiet;
  const back = Q._internal.homography(place.map((p) => p), [[0, 0], [full, 0], [full, full], [0, full]]);
  let r = seed;
  const rand = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const [u, v] = back(x + sx, y + sy);
        const mx = Math.floor(u) - quiet, my = Math.floor(v) - quiet;
        const inside = u >= 0 && v >= 0 && u < full && v < full;
        const bit = inside && mx >= 0 && my >= 0 && mx < n && my < n ? m[my][mx] : 0;
        // Outside the code: a busy background of light and dark blocks.
        const bg = !inside && ((Math.floor(x / 23) * 7 + Math.floor(y / 17) * 3) % 5 === 0);
        sum += bit || bg ? dark : light;
      }
      const g = sum / 4 + (noise ? (rand() - 0.5) * noise : 0);
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = g; data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

test("the scanner reads a picture: straight, turned, keystoned, dim, noisy, light on dark", () => {
  const m = Q.encode(PAIR, "M");
  const cases = {
    straight: [[100, 60], [364, 60], [364, 324], [100, 324]],
    turned: [[150, 30], [390, 110], [310, 350], [70, 270]],
    keystoned: [[130, 70], [350, 90], [380, 340], [90, 320]],
    small: [[180, 130], [330, 130], [330, 280], [180, 280]],
  };
  for (const [name, place] of Object.entries(cases)) assert.equal(Q.scan(picture(m, { place })), PAIR, name);
  const place = cases.keystoned;
  assert.equal(Q.scan(picture(m, { place, dark: 90, light: 160 })), PAIR, "low contrast");
  assert.equal(Q.scan(picture(m, { place, noise: 60 })), PAIR, "noisy");
  assert.equal(Q.scan(picture(m, { place, dark: 230, light: 25 })), PAIR, "light modules on a dark terminal");
  const big = Q.encode("x".repeat(120), "M");
  assert.equal(Q.scan(picture(big, { w: 640, h: 560, place: [[80, 40], [560, 60], [580, 520], [60, 500]] })), "x".repeat(120), "version 7, with version bits");
  const blank = picture(m, { place: [[-900, -900], [-800, -900], [-800, -800], [-900, -800]], noise: 90 });
  assert.equal(Q.scan(blank), null, "nothing there");
});

test("the pairing payload: the address and the code, nothing else", () => {
  assert.equal(Q.pairPayload("https://studio.tail1234.ts.net", "481207"), PAIR);
  assert.deepEqual(Q.readPair(PAIR), { code: "481207", address: "https://studio.tail1234.ts.net" });
  assert.deepEqual(Q.readPair("AIRPOCKET:PAIR:000001:HTTPS://MAC.TAIL-9.TS.NET:8443"), { code: "000001", address: "https://mac.tail-9.ts.net:8443" });
  assert.deepEqual(Q.readPair("AIRPOCKET:PAIR:000001:HTTP://127.0.0.1:47871"), { code: "000001", address: "http://127.0.0.1:47871" });
  for (const bad of ["AIRPOCKET:PAIR:48120:HTTPS://STUDIO.TAIL1234.TS.NET", "AIRPOCKET:PAIR:481207:HTTPS://EVIL.EXAMPLE.COM",
    "AIRPOCKET:PAIR:481207:HTTP://STUDIO.TAIL1234.TS.NET", "AIRPOCKET:PAIR:481207:HTTPS://STUDIO.TS.NET.EVIL.COM", "https://studio.tail1234.ts.net",
    "AIRPOCKET:PAIR:481207:HTTPS://STUDIO.TAIL1234.TS.NET/PATH", "", null]) {
    assert.equal(Q.readPair(bad), null, String(bad));
  }
  assert.equal(Q.encode(PAIR).length, 29, "alphanumeric keeps it small: version 3");
});

test("the terminal drawing is the same symbol, in colour and without", () => {
  const m = Q.encode(PAIR, "M");
  const esc = String.fromCharCode(27);
  const colour = Q.toTerminal(m);
  assert.equal(colour.length, Math.ceil((m.length + 8) / 2));
  // Read the colours back: the upper half block's colour is the top module, the background the bottom one.
  const back = [];
  for (const line of colour) {
    const top = [], bottom = [];
    let fg = 0, bg = 0;
    for (const part of line.split(esc + "[").slice(1)) {
      const [codes, rest] = part.split("m");
      for (const c of codes.split(";").map(Number)) { if (c === 30) fg = 1; if (c === 97) fg = 0; if (c === 40) bg = 1; if (c === 107) bg = 0; }
      for (const ch of rest) if (ch === "▀") { top.push(fg); bottom.push(bg); }
    }
    back.push(top, bottom);
  }
  const grid = back.slice(4, 4 + m.length).map((row) => row.slice(4, 4 + m.length));
  assert.equal(Q.decodeMatrix(grid), PAIR);
  const plain = Q.toTerminal(m, { color: false });
  assert.ok(plain.every((l) => l.length === m.length + 8 && !l.includes(esc)));
});

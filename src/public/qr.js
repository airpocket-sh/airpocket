"use strict";
// QR codes for pairing, both ends, without a library. `airpocket pair` draws one
// in the terminal (encode); the phone reads it from its camera (scan). The code
// carries the Mac's address and the same six-digit code the Mac prints, so a
// scan pairs exactly like typing it: the same code, tries and expiry.
//
// Versions 1 to 10, all four error-correction levels, numeric, alphanumeric and
// byte segments. Error correction is Reed-Solomon over GF(256), as the standard
// has it. The scanner follows the usual steps: an adaptive threshold, the three
// finder patterns, the alignment pattern near the fourth corner, a perspective
// grid, then the format bits, unmasking and correction.
(function (root, make) {
  const api = make();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AirpocketQR = api;
})(typeof self !== "undefined" ? self : globalThis, () => {
  // ---- GF(256), primitive polynomial 0x11D -------------------------------------
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  const div = (a, b) => (a ? EXP[LOG[a] + 255 - LOG[b]] : 0);

  // ---- tables: per version, per level L M Q H: [ec per block, blocks, data each, blocks, data each]
  const BLOCKS = [null,
    [[7, 1, 19, 0, 0], [10, 1, 16, 0, 0], [13, 1, 13, 0, 0], [17, 1, 9, 0, 0]],
    [[10, 1, 34, 0, 0], [16, 1, 28, 0, 0], [22, 1, 22, 0, 0], [28, 1, 16, 0, 0]],
    [[15, 1, 55, 0, 0], [26, 1, 44, 0, 0], [18, 2, 17, 0, 0], [22, 2, 13, 0, 0]],
    [[20, 1, 80, 0, 0], [18, 2, 32, 0, 0], [26, 2, 24, 0, 0], [16, 4, 9, 0, 0]],
    [[26, 1, 108, 0, 0], [24, 2, 43, 0, 0], [18, 2, 15, 2, 16], [22, 2, 11, 2, 12]],
    [[18, 2, 68, 0, 0], [16, 4, 27, 0, 0], [24, 4, 19, 0, 0], [28, 4, 15, 0, 0]],
    [[20, 2, 78, 0, 0], [18, 4, 31, 0, 0], [18, 2, 14, 4, 15], [26, 4, 13, 1, 14]],
    [[24, 2, 97, 0, 0], [22, 2, 38, 2, 39], [22, 4, 18, 2, 19], [26, 4, 14, 2, 15]],
    [[30, 2, 116, 0, 0], [22, 3, 36, 2, 37], [20, 4, 16, 4, 17], [24, 4, 12, 4, 13]],
    [[18, 2, 68, 2, 69], [26, 4, 43, 1, 44], [24, 6, 19, 2, 20], [28, 6, 15, 2, 16]],
  ];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const LEVEL_BITS = [1, 0, 3, 2];                       // L M Q H, as the format information writes them
  const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  const blocksOf = (v, level) => {
    const [ec, n1, d1, n2, d2] = BLOCKS[v][level];
    return { ec, sizes: [...Array(n1).fill(d1), ...Array(n2).fill(d2)] };
  };

  // ---- the fixed parts of a symbol, and where the rest goes --------------------------
  // Matrices are rows of columns: m[y][x], 1 = dark.
  function template(v) {
    const size = 17 + 4 * v;
    const m = Array.from({ length: size }, () => new Array(size).fill(0));
    const f = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { m[y][x] = dark ? 1 : 0; f[y][x] = true; };
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
    const al = ALIGN[v], last = al.length - 1;
    for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    const [a, b] = formatSpots(size);
    for (const [x, y] of [...a, ...b]) set(x, y, false);
    set(8, size - 8, true);
    if (v >= 7) for (const [x, y] of versionSpots(size)) set(x, y, false);
    return { size, m, f };
  }
  /** Where the 15 format bits go, twice: bit i at a[i] and at b[i], as [x, y]. */
  function formatSpots(size) {
    const a = [], b = [];
    for (let i = 0; i <= 5; i++) a.push([8, i]);
    a.push([8, 7], [8, 8], [7, 8]);
    for (let i = 9; i < 15; i++) a.push([14 - i, 8]);
    for (let i = 0; i < 8; i++) b.push([size - 1 - i, 8]);
    for (let i = 8; i < 15; i++) b.push([8, size - 15 + i]);
    return [a, b];
  }
  function versionSpots(size) {
    const out = [];
    for (let i = 0; i < 18; i++) { const a = size - 11 + (i % 3), b = Math.floor(i / 3); out.push([a, b], [b, a]); }
    return out;
  }
  /** The data modules in reading order: two columns at a time, up and down from the right. */
  function dataSpots(size, f) {
    const out = [];
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
          if (!f[y][x]) out.push([x, y]);
        }
      }
    }
    return out;
  }
  const formatCode = (level, mask) => {
    const data = (LEVEL_BITS[level] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  };
  const versionCode = (v) => {
    let rem = v;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (v << 12) | rem;
  };

  // ---- Reed-Solomon ---------------------------------------------------------------
  function divisor(degree) {
    const r = new Array(degree).fill(0);
    r[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) { r[j] = mul(r[j], root); if (j + 1 < degree) r[j] ^= r[j + 1]; }
      root = mul(root, 2);
    }
    return r;
  }
  function remainder(data, div0) {
    const r = new Array(div0.length).fill(0);
    for (const byte of data) {
      const factor = byte ^ r.shift();
      r.push(0);
      for (let i = 0; i < r.length; i++) r[i] ^= mul(div0[i], factor);
    }
    return r;
  }
  const evalAt = (msg, x) => { let s = 0; for (let i = 0; i < msg.length; i++) s = mul(s, x) ^ msg[i]; return s; };
  /** A block (data then check bytes) with its errors corrected, or null when there are too many. */
  function correct(msg, nsym) {
    const n = msg.length, synd = [];
    let clean = true;
    for (let j = 0; j < nsym; j++) { synd.push(evalAt(msg, EXP[j])); if (synd[j]) clean = false; }
    if (clean) return msg.slice();
    // Berlekamp-Massey: the error locator.
    let C = [1], B = [1], L = 0, m = 1, b = 1;
    for (let r = 0; r < nsym; r++) {
      let d = synd[r];
      for (let i = 1; i <= L; i++) d ^= mul(C[i] || 0, synd[r - i]);
      if (d === 0) { m++; continue; }
      const T = C.slice(), coef = div(d, b);
      while (C.length < B.length + m) C.push(0);
      for (let i = 0; i < B.length; i++) C[i + m] ^= mul(coef, B[i]);
      if (2 * L <= r) { L = r + 1 - L; B = T; b = d; m = 1; } else m++;
    }
    if (2 * L > nsym) return null;
    // Chien search: which bytes.
    const where = [];
    for (let p = 0; p < n; p++) {
      const xinv = EXP[(255 - ((n - 1 - p) % 255)) % 255];
      let s = 0;
      for (let k = C.length - 1; k >= 0; k--) s = mul(s, xinv) ^ C[k];
      if (s === 0) where.push(p);
    }
    if (where.length !== L) return null;
    // Forney: by how much.
    const omega = new Array(nsym).fill(0);
    for (let i = 0; i < nsym; i++) for (let k = 0; k < C.length && i + k < nsym; k++) omega[i + k] ^= mul(synd[i], C[k]);
    const out = msg.slice();
    for (const p of where) {
      const e = (n - 1 - p) % 255, X = EXP[e], xinv = EXP[(255 - e) % 255];
      let om = 0;
      for (let k = nsym - 1; k >= 0; k--) om = mul(om, xinv) ^ omega[k];
      let dl = 0;
      for (let k = 1; k < C.length; k += 2) dl ^= mul(C[k], EXP[(LOG[xinv] * (k - 1)) % 255]);
      if (!dl) return null;
      out[p] ^= mul(X, div(om, dl));
    }
    for (let j = 0; j < nsym; j++) if (evalAt(out, EXP[j])) return null;
    return out;
  }

  // ---- encode ---------------------------------------------------------------------
  /** The smallest symbol (version 1 to 10) holding `text`, as rows of 0 and 1. */
  function encode(text, levelName = "M") {
    const level = "LMQH".indexOf(levelName);
    if (level < 0) throw new Error("level is one of L M Q H");
    const alnum = [...text].every((c) => ALNUM.includes(c));
    const bytes = alnum ? null : Array.from(new TextEncoder().encode(text));
    for (let v = 1; v <= 10; v++) {
      const { ec, sizes } = blocksOf(v, level);
      const capacity = sizes.reduce((s, n) => s + n, 0) * 8;
      const bits = [];
      const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
      if (alnum) {
        put(2, 4); put(text.length, v < 10 ? 9 : 11);
        for (let i = 0; i < text.length; i += 2) {
          if (i + 1 < text.length) put(ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11);
          else put(ALNUM.indexOf(text[i]), 6);
        }
      } else {
        put(4, 4); put(bytes.length, v < 10 ? 8 : 16);
        for (const byte of bytes) put(byte, 8);
      }
      if (bits.length > capacity) continue;
      put(0, Math.min(4, capacity - bits.length));
      while (bits.length % 8) bits.push(0);
      const data = [];
      for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, x) => (a << 1) | x, 0));
      for (let pad = 0xec; data.length < capacity / 8; pad ^= 0xec ^ 0x11) data.push(pad);
      // Split into blocks, add each block's check bytes, interleave.
      const gen = divisor(ec), blocks = [];
      let at = 0;
      for (const n of sizes) { const d = data.slice(at, at + n); at += n; blocks.push([d, remainder(d, gen)]); }
      const words = [];
      for (let i = 0; i < Math.max(...sizes); i++) for (const [d] of blocks) if (i < d.length) words.push(d[i]);
      for (let i = 0; i < ec; i++) for (const [, e] of blocks) words.push(e[i]);
      return place(v, level, words);
    }
    throw new Error("Too long for a QR code this small");
  }
  function place(v, level, words) {
    const { size, m, f } = template(v);
    const spots = dataSpots(size, f);
    spots.forEach(([x, y], i) => { m[y][x] = i < words.length * 8 ? (words[i >> 3] >> (7 - (i & 7))) & 1 : 0; });
    const [a, b] = formatSpots(size);
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const t = m.map((row) => row.slice());
      for (const [x, y] of spots) if (MASKS[mask](x, y)) t[y][x] ^= 1;
      const fc = formatCode(level, mask);
      for (let i = 0; i < 15; i++) { const bit = (fc >>> i) & 1; t[a[i][1]][a[i][0]] = bit; t[b[i][1]][b[i][0]] = bit; }
      if (v >= 7) {
        const vc = versionCode(v);
        versionSpots(size).forEach(([x, y], k) => { t[y][x] = (vc >>> (k >> 1)) & 1; });
      }
      const p = penalty(t);
      if (!best || p < best.p) best = { p, t };
    }
    return best.t;
  }
  function penalty(t) {
    const n = t.length;
    let p = 0, dark = 0;
    const lines = [];
    for (let i = 0; i < n; i++) { lines.push(t[i]); lines.push(t.map((row) => row[i])); }
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i <= n; i++) {
        if (i < n && line[i] === line[i - 1]) run++;
        else { if (run >= 5) p += run - 2; run = 1; }
      }
      const s = line.join("");
      for (const pat of ["10111010000", "00001011101"]) for (let k = s.indexOf(pat); k >= 0; k = s.indexOf(pat, k + 1)) p += 40;
    }
    for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
      const c = t[y][x];
      if (c === t[y][x + 1] && c === t[y + 1][x] && c === t[y + 1][x + 1]) p += 3;
    }
    for (const row of t) for (const c of row) dark += c;
    return p + Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
  }

  // ---- decode a grid of modules -----------------------------------------------------
  function readFormat(bits, size) {
    const [a, b] = formatSpots(size);
    const read = (spots) => spots.reduce((acc, [x, y], i) => acc | (bits[y][x] << i), 0);
    const got = [read(a), read(b)];
    let best = null;
    for (let level = 0; level < 4; level++) for (let mask = 0; mask < 8; mask++) {
      const code = formatCode(level, mask);
      for (const g of got) {
        let d = 0;
        for (let x = code ^ g; x; x &= x - 1) d++;
        if (d <= 3 && (!best || d < best.d)) best = { level, mask, d };
      }
    }
    return best;
  }
  /** The text in a grid of modules (rows of 0 and 1), or null. */
  function decodeMatrix(bits) {
    const size = bits.length, v = (size - 17) / 4;
    if (!Number.isInteger(v) || v < 1 || v > 10 || bits.some((row) => row.length !== size)) return null;
    const fmt = readFormat(bits, size);
    if (!fmt) return null;
    const { f } = template(v);
    const spots = dataSpots(size, f);
    const { ec, sizes } = blocksOf(v, fmt.level);
    const total = sizes.reduce((s, n) => s + n + ec, 0);
    const words = new Array(total).fill(0);
    for (let i = 0; i < total * 8; i++) {
      const [x, y] = spots[i];
      words[i >> 3] |= (bits[y][x] ^ (MASKS[fmt.mask](x, y) ? 1 : 0)) << (7 - (i & 7));
    }
    const blocks = sizes.map(() => []);
    let k = 0;
    for (let i = 0; i < Math.max(...sizes); i++) sizes.forEach((n, j) => { if (i < n) blocks[j].push(words[k++]); });
    for (let i = 0; i < ec; i++) blocks.forEach((bl) => bl.push(words[k++]));
    const data = [];
    for (let j = 0; j < blocks.length; j++) {
      const fixed = correct(blocks[j], ec);
      if (!fixed) return null;
      data.push(...fixed.slice(0, sizes[j]));
    }
    return segments(data, v);
  }
  function segments(data, v) {
    const total = data.length * 8;
    let pos = 0, out = "", bytes = [];
    const take = (n) => {
      if (n < 0 || pos + n > total) throw new RangeError("short");
      let x = 0;
      for (let i = 0; i < n; i++, pos++) x = (x << 1) | ((data[pos >> 3] >> (7 - (pos & 7))) & 1);
      return x;
    };
    const flush = () => { if (bytes.length) { out += new TextDecoder().decode(Uint8Array.from(bytes)); bytes = []; } };
    try {
      while (pos + 4 <= total) {
        const mode = take(4);
        if (mode === 0) break;
        if (mode === 4) { for (let n = take(v < 10 ? 8 : 16); n > 0; n--) bytes.push(take(8)); continue; }
        flush();
        if (mode === 2) {
          let n = take(v < 10 ? 9 : 11);
          for (; n >= 2; n -= 2) { const x = take(11); if (x >= 45 * 45) return null; out += ALNUM[Math.floor(x / 45)] + ALNUM[x % 45]; }
          if (n) { const x = take(6); if (x >= 45) return null; out += ALNUM[x]; }
        } else if (mode === 1) {
          let n = take(v < 10 ? 10 : 12);
          for (; n >= 3; n -= 3) out += String(take(10)).padStart(3, "0");
          if (n === 2) out += String(take(7)).padStart(2, "0");
          else if (n === 1) out += String(take(4));
        } else if (mode === 7) {
          const first = take(8);
          if (first & 0x80) take(first & 0x40 ? 16 : 8);
        } else return null;
      }
    } catch { return null; }
    flush();
    return out;
  }

  // ---- scan a picture ------------------------------------------------------------------
  /** Light (0) or dark (1) for each pixel, against the brightness around it. */
  function binarize(gray, w, h) {
    const R = 8, cols = Math.ceil(w / R), rows = Math.ceil(h / R);
    const black = new Float32Array(cols * rows);
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        let min = 255, max = 0;
        for (let y = by * R; y < Math.min(h, (by + 1) * R); y++) {
          for (let x = bx * R; x < Math.min(w, (bx + 1) * R); x++) { const g = gray[y * w + x]; if (g < min) min = g; if (g > max) max = g; }
        }
        let avg = (min + max) / 2;
        if (max - min <= 24) {
          avg = min / 2;
          if (by > 0 && bx > 0) {
            const nb = (black[(by - 1) * cols + bx] + 2 * black[by * cols + bx - 1] + black[(by - 1) * cols + bx - 1]) / 4;
            if (min < nb) avg = nb;
          }
        }
        black[by * cols + bx] = avg;
      }
    }
    const out = new Uint8Array(w * h);
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        let sum = 0, n = 0;
        for (let yy = Math.max(0, by - 2); yy <= Math.min(rows - 1, by + 2); yy++) {
          for (let xx = Math.max(0, bx - 2); xx <= Math.min(cols - 1, bx + 2); xx++) { sum += black[yy * cols + xx]; n++; }
        }
        const t = sum / n;
        for (let y = by * R; y < Math.min(h, (by + 1) * R); y++) {
          for (let x = bx * R; x < Math.min(w, (bx + 1) * R); x++) out[y * w + x] = gray[y * w + x] <= t ? 1 : 0;
        }
      }
    }
    return out;
  }

  // Finder patterns: runs of dark, light, dark, light, dark in the ratio 1:1:3:1:1, across and down.
  function crossRatio(s) {
    const total = s[0] + s[1] + s[2] + s[3] + s[4];
    if (total < 7) return false;
    const ms = total / 7, v = ms / 2;
    return Math.abs(ms - s[0]) < v && Math.abs(ms - s[1]) < v && Math.abs(3 * ms - s[2]) < 3 * v && Math.abs(ms - s[3]) < v && Math.abs(ms - s[4]) < v;
  }
  const centerFromEnd = (s, end) => end - s[4] - s[3] - s[2] / 2;
  function findFinders(dark, w, h) {
    const found = [];
    // Along one line through a candidate centre: `at(i)` is dark at step i; returns the refined centre or NaN.
    const cross = (at, start, limit, maxCount, originalTotal) => {
      const s = [0, 0, 0, 0, 0];
      let i = start;
      while (i >= 0 && at(i)) { s[2]++; i--; }
      if (i < 0) return NaN;
      while (i >= 0 && !at(i) && s[1] <= maxCount) { s[1]++; i--; }
      if (i < 0 || s[1] > maxCount) return NaN;
      while (i >= 0 && at(i) && s[0] <= maxCount) { s[0]++; i--; }
      if (s[0] > maxCount) return NaN;
      i = start + 1;
      while (i < limit && at(i)) { s[2]++; i++; }
      if (i === limit) return NaN;
      while (i < limit && !at(i) && s[3] < maxCount) { s[3]++; i++; }
      if (i === limit || s[3] >= maxCount) return NaN;
      while (i < limit && at(i) && s[4] < maxCount) { s[4]++; i++; }
      if (s[4] >= maxCount) return NaN;
      const total = s[0] + s[1] + s[2] + s[3] + s[4];
      if (5 * Math.abs(total - originalTotal) >= 2 * originalTotal) return NaN;
      return crossRatio(s) ? centerFromEnd(s, i) : NaN;
    };
    const candidate = (s, y, endX) => {
      const total = s[0] + s[1] + s[2] + s[3] + s[4];
      let cx = centerFromEnd(s, endX);
      const cy = cross((i) => dark(Math.floor(cx), i), y, h, s[2], total);
      if (Number.isNaN(cy)) return false;
      cx = cross((i) => dark(i, Math.floor(cy)), Math.floor(cx), w, s[2], total);
      if (Number.isNaN(cx)) return false;
      const size = total / 7;
      for (const c of found) {
        if (Math.abs(cy - c.y) <= size && Math.abs(cx - c.x) <= size) {
          const diff = Math.abs(size - c.size);
          if (diff <= 1 || diff <= c.size) {
            const n = c.count + 1;
            c.x = (c.x * c.count + cx) / n; c.y = (c.y * c.count + cy) / n; c.size = (c.size * c.count + size) / n; c.count = n;
            return true;
          }
        }
      }
      found.push({ x: cx, y: cy, size, count: 1 });
      return true;
    };
    const skip = Math.max(1, Math.floor(h / 240));
    for (let y = skip - 1; y < h; y += skip) {
      const s = [0, 0, 0, 0, 0];
      let state = 0;
      for (let x = 0; x < w; x++) {
        if (dark(x, y)) {
          if (state & 1) state++;
          s[state]++;
        } else if (!(state & 1)) {
          if (state === 4) {
            if (crossRatio(s) && candidate(s, y, x)) { s.fill(0); state = 0; continue; }
            s[0] = s[2]; s[1] = s[3]; s[2] = s[4]; s[3] = 1; s[4] = 0; state = 3;
          } else s[++state]++;
        } else s[state]++;
      }
      if (crossRatio(s)) candidate(s, y, w);
    }
    return found;
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  /** Likely [topLeft, topRight, bottomLeft] triples, best first. */
  function triples(found) {
    const sure = found.filter((c) => c.count >= 2);
    const pool = (sure.length >= 3 ? sure : found).sort((a, b) => b.count - a.count).slice(0, 10);
    const out = [];
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) for (let k = j + 1; k < pool.length; k++) {
      let [p, q, r] = [pool[i], pool[j], pool[k]];
      const sizes = [p.size, q.size, r.size];
      const spread = Math.max(...sizes) / Math.min(...sizes);
      if (spread > 1.5) continue;
      // The top-left corner is opposite the longest side.
      const dpq = dist(p, q), dqr = dist(q, r), dpr = dist(p, r);
      let tl, a, b;
      if (dqr >= dpq && dqr >= dpr) [tl, a, b] = [p, q, r];
      else if (dpr >= dpq && dpr >= dqr) [tl, a, b] = [q, p, r];
      else [tl, a, b] = [r, p, q];
      // Screen coordinates run down: top-right is the one clockwise from bottom-left.
      if ((a.x - tl.x) * (b.y - tl.y) - (a.y - tl.y) * (b.x - tl.x) < 0) [a, b] = [b, a];
      const l1 = dist(tl, a), l2 = dist(tl, b), ms = (p.size + q.size + r.size) / 3;
      if (Math.min(l1, l2) / ms < 10) continue;
      const ratio = Math.max(l1, l2) / Math.min(l1, l2);
      const hyp = dist(a, b), right = Math.abs(hyp * hyp - l1 * l1 - l2 * l2) / (l1 * l1 + l2 * l2);
      if (ratio > 2 || right > 0.6) continue;
      out.push({ tl, tr: a, bl: b, ms, score: (ratio - 1) + right + (spread - 1) });
    }
    return out.sort((x, y) => x.score - y.score).slice(0, 6);
  }
  /** Solve for the projective map taking four [x, y] points to four others. */
  function homography(src, dst) {
    const A = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [X, Y] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X, X]);
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y, Y]);
    }
    for (let c = 0; c < 8; c++) {
      let piv = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      if (Math.abs(A[piv][c]) < 1e-12) return null;
      [A[c], A[piv]] = [A[piv], A[c]];
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const k = A[r][c] / A[c][c];
        for (let j = c; j < 9; j++) A[r][j] -= k * A[c][j];
      }
    }
    const hm = A.map((row, i) => row[8] / row[i]);
    return (x, y) => { const d = hm[6] * x + hm[7] * y + 1; return [(hm[0] * x + hm[1] * y + hm[2]) / d, (hm[3] * x + hm[4] * y + hm[5]) / d]; };
  }
  /** The alignment pattern near where it should be, by matching its 5x5 shape along the symbol's own axes. */
  function findAlignment(dark, w, h, ex, ey, ux, uy, ms) {
    const R = Math.ceil(6 * ms), step = Math.max(1, ms / 4);
    let best = 0, hits = [];
    for (let dy = -R; dy <= R; dy += step) {
      for (let dx = -R; dx <= R; dx += step) {
        const cx = ex + dx, cy = ey + dy;
        let score = 0;
        for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
          const px = Math.round(cx + i * ux[0] + j * uy[0]), py = Math.round(cy + i * ux[1] + j * uy[1]);
          if (px >= 0 && py >= 0 && px < w && py < h && dark(px, py) === (Math.max(Math.abs(i), Math.abs(j)) !== 1)) score++;
        }
        if (score > best) { best = score; hits = []; }
        if (score === best) hits.push([cx, cy, dx * dx + dy * dy]);
      }
    }
    if (best < 23 || !hits.length) return null;
    hits.sort((p, q) => p[2] - q[2]);
    const [nx, ny] = hits[0], near = hits.filter(([x, y]) => Math.abs(x - nx) <= ms && Math.abs(y - ny) <= ms);
    return { x: near.reduce((s, p) => s + p[0], 0) / near.length, y: near.reduce((s, p) => s + p[1], 0) / near.length };
  }
  function sampleGrid(dark, w, h, t, dim) {
    const { tl, tr, bl, ms } = t, v = (dim - 17) / 4, span = dim - 7;
    const ux = [(tr.x - tl.x) / span, (tr.y - tl.y) / span], uy = [(bl.x - tl.x) / span, (bl.y - tl.y) / span];
    let br = { x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y }, brAt = dim - 3.5;
    if (v >= 2) {
      const ex = tl.x + (span - 3) * (ux[0] + uy[0]), ey = tl.y + (span - 3) * (ux[1] + uy[1]);
      const al = findAlignment(dark, w, h, ex, ey, ux, uy, ms);
      if (al) { br = al; brAt = dim - 6.5; }
    }
    const map = homography([[3.5, 3.5], [dim - 3.5, 3.5], [brAt, brAt], [3.5, dim - 3.5]],
      [[tl.x, tl.y], [tr.x, tr.y], [br.x, br.y], [bl.x, bl.y]]);
    if (!map) return null;
    const grid = [];
    for (let r = 0; r < dim; r++) {
      const row = [];
      for (let c = 0; c < dim; c++) {
        const [x, y] = map(c + 0.5, r + 0.5), px = Math.floor(x), py = Math.floor(y);
        row.push(px >= 0 && py >= 0 && px < w && py < h && dark(px, py) ? 1 : 0);
      }
      grid.push(row);
    }
    return grid;
  }
  const transpose = (g) => g.map((row, y) => row.map((_, x) => g[x][y]));

  /** The text of a QR code in a picture ({ data: RGBA bytes, width, height }), or null. */
  function scan(img) {
    const { data, width: w, height: h } = img;
    const gray = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    const bin = binarize(gray, w, h);
    for (const inverted of [0, 1]) {
      const dark = (x, y) => (bin[y * w + x] ^ inverted) === 1;
      for (const t of triples(findFinders(dark, w, h))) {
        const est = (dist(t.tl, t.tr) + dist(t.tl, t.bl)) / 2 / t.ms + 7;
        const v0 = Math.round((est - 17) / 4);
        for (const v of [v0, v0 - 1, v0 + 1]) {
          if (v < 1 || v > 10) continue;
          const grid = sampleGrid(dark, w, h, t, 17 + 4 * v);
          if (!grid) continue;
          const text = decodeMatrix(grid) ?? decodeMatrix(transpose(grid));
          if (text !== null) return text;
        }
      }
    }
    return null;
  }

  // ---- the pairing payload -------------------------------------------------------------
  // Upper case so it fits the compact alphanumeric mode; the phone lower-cases the address.
  const PAYLOAD = /^AIRPOCKET:PAIR:(\d{6}):((?:HTTPS:\/\/[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.TS\.NET|HTTP:\/\/(?:127\.0\.0\.1|LOCALHOST))(?::\d{1,5})?)$/i;
  const pairPayload = (address, code) => `AIRPOCKET:PAIR:${code}:${String(address).toUpperCase()}`;
  const readPair = (text) => {
    const m = PAYLOAD.exec(String(text || "").trim());
    return m ? { code: m[1], address: m[2].toLowerCase() } : null;
  };

  /** Rows of half blocks for a terminal: each character is one module wide and two tall, with a quiet zone. */
  function toTerminal(m, { color = true, quiet = 4 } = {}) {
    const n = m.length + 2 * quiet;
    const at = (x, y) => { x -= quiet; y -= quiet; return x >= 0 && y >= 0 && x < m.length && y < m.length ? m[y][x] : 0; };
    const lines = [];
    for (let y = 0; y < n; y += 2) {
      let line = "", pen = "";
      for (let x = 0; x < n; x++) {
        const top = at(x, y), bottom = y + 1 < n ? at(x, y + 1) : 0;
        if (color) {
          // The upper half block in the top module's colour over the bottom one's: black and bright white, whatever the theme.
          const next = `\x1b[${top ? 30 : 97};${bottom ? 40 : 107}m`;
          line += (next === pen ? "" : next) + "▀";
          pen = next;
        } else line += top && bottom ? " " : top ? "▄" : bottom ? "▀" : "█";     // light drawn as ink, for a dark terminal
      }
      lines.push(color ? line + "\x1b[0m" : line);
    }
    return lines;
  }

  return { encode, decodeMatrix, scan, correct, pairPayload, readPair, toTerminal, _internal: { template, dataSpots, formatSpots, BLOCKS, divisor, remainder, homography } };
});

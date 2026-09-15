"use strict";
// Where the phone's credentials live: outside the repo, readable only by you.
//
//   devices.json   one entry per paired phone: {id, name, hash, createdAt, lastSeen}.
//                  `hash` is the SHA-256 of that device's token. The token itself
//                  exists only on the phone; this file cannot be replayed.
//   pairing.json   the one pending six-digit code: {hash, expiresAt, attempts}.
//                  Only someone at this Mac can create it (npm run mobile:pair).
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const DEFAULT_DIR = path.join(os.homedir(), "Library", "Application Support", "claude-overlay", "mobile");
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const TOUCH_EVERY_MS = 5 * 60 * 1000;

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/** Constant-time comparison of two SHA-256 hex digests. */
function sameDigest(a, b) {
  const x = Buffer.from(String(a), "hex"), y = Buffer.from(String(b), "hex");
  return x.length === 32 && y.length === 32 && crypto.timingSafeEqual(x, y);
}

function createStore(dir = process.env.PANEL_MOBILE_DIR || DEFAULT_DIR) {
  const file = (n) => path.join(dir, n);
  const read = (n, fallback) => {
    try { return JSON.parse(fs.readFileSync(file(n), "utf8")); } catch { return fallback; }
  };
  const write = (n, value) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file(n)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file(n));
  };
  const remove = (n) => { try { fs.unlinkSync(file(n)); } catch {} };
  const lastTouch = new Map();

  const store = {
    dir,

    devices() {
      const list = read("devices.json", []);
      return Array.isArray(list) ? list : [];
    },

    /** Issue a fresh six-digit code. An earlier pending code stops working. */
    newCode() {
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      const expiresAt = Date.now() + CODE_TTL_MS;
      write("pairing.json", { hash: sha256(code), expiresAt, attempts: 0 });
      return { code, expiresAt };
    },

    /**
     * Check a code typed on the phone. One code, five tries, ten minutes.
     * Returns "ok" | "none" | "expired" | "locked" | { wrong: attemptsLeft }.
     */
    useCode(code) {
      const p = read("pairing.json", null);
      if (!p || typeof p.hash !== "string") return "none";
      if (Date.now() > p.expiresAt) { remove("pairing.json"); return "expired"; }
      if (p.attempts >= MAX_ATTEMPTS) { remove("pairing.json"); return "locked"; }
      const digits = String(code ?? "").replace(/\D/g, "");
      if (digits.length === 6 && sameDigest(sha256(digits), p.hash)) { remove("pairing.json"); return "ok"; }
      p.attempts += 1;
      if (p.attempts >= MAX_ATTEMPTS) remove("pairing.json"); else write("pairing.json", p);
      return { wrong: Math.max(0, MAX_ATTEMPTS - p.attempts) };
    },

    /** Register a phone. The token is returned once and never written down here. */
    addDevice(name) {
      const token = crypto.randomBytes(32).toString("base64url");
      const device = {
        id: crypto.randomBytes(4).toString("hex"),
        name: String(name || "Phone").slice(0, 40),
        hash: sha256(token),
        createdAt: new Date().toISOString(),
        lastSeen: null,
      };
      write("devices.json", [...store.devices(), device]);
      return { token, device };
    },

    /** The device a bearer token belongs to, or null. Checks every entry. */
    deviceFor(token) {
      if (typeof token !== "string" || token.length < 32 || token.length > 128) return null;
      const h = sha256(token);
      let hit = null;
      for (const d of store.devices()) if (sameDigest(h, d.hash)) hit = d;
      return hit;
    },

    /** Record that a device was seen, at most every few minutes. */
    touch(id) {
      const now = Date.now();
      if (now - (lastTouch.get(id) || 0) < TOUCH_EVERY_MS) return;
      lastTouch.set(id, now);
      const list = store.devices();
      const d = list.find((x) => x.id === id);
      if (!d) return;
      d.lastSeen = new Date(now).toISOString();
      write("devices.json", list);
    },

    /** Remove a device; its token stops working on the next request. */
    revoke(id) {
      const list = store.devices();
      const keep = list.filter((d) => d.id !== id);
      if (keep.length === list.length) return false;
      write("devices.json", keep);
      return true;
    },
  };
  return store;
}

module.exports = { createStore, sha256, DEFAULT_DIR, CODE_TTL_MS, MAX_ATTEMPTS };

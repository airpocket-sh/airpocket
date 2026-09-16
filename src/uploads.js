"use strict";
// Photos the phone sends to a session.
//
// They land in Airpocket's own data folder, never in the project the agent is
// working in:
//
//   <dataDir>/uploads/20260916-143102-a1b2c3.jpg    0600, inside a 0700 folder
//
// The phone never learns where they are. An upload answers with a ref — 16
// random bytes, held in this process and nowhere else — and /api/send turns
// the refs back into quoted paths as it types the message, the same way file
// links keep paths on the Mac. A ref this process has forgotten (a restart, a
// swept file) is refused rather than guessed at.
//
// Only what the agents can actually read back is accepted, and the bytes
// decide: the declared type has to match the file's own magic number.
//
// Old photos are swept on every upload: nothing older than a week, and never
// more than forty on disk.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_BYTES = 8 * 1024 * 1024;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_FILES = 40;

const KINDS = [
  { ext: "png", type: "image/png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: "jpg", type: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { ext: "gif", type: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] },
  { ext: "webp", type: "image/webp", magic: [0x52, 0x49, 0x46, 0x46], at8: [0x57, 0x45, 0x42, 0x50] },
];
const TYPES = KINDS.map((k) => k.type);

/** What these bytes really are, whatever the request called them. */
function kindOf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  for (const k of KINDS) {
    if (!k.magic.every((b, i) => buf[i] === b)) continue;
    if (k.at8 && !k.at8.every((b, i) => buf[8 + i] === b)) continue;
    return k;
  }
  return null;
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

function createUploads({ dir, log = () => {} } = {}) {
  const root = path.join(dir, "uploads");
  const refs = new Map();                       // ref -> absolute path, this process only

  const files = () => {
    let names = [];
    try { names = fs.readdirSync(root); } catch { return []; }
    const out = [];
    for (const n of names) {
      const file = path.join(root, n);
      let st;
      try { st = fs.lstatSync(file); } catch { continue; }
      if (st.isFile()) out.push({ file, at: st.mtimeMs });
    }
    return out.sort((a, b) => a.at - b.at);
  };

  const drop = (file) => {
    try { fs.unlinkSync(file); } catch {}
    for (const [ref, f] of refs) if (f === file) refs.delete(ref);
  };

  const uploads = {
    dir: root,
    maxBytes: MAX_BYTES,
    types: TYPES,
    kindOf,

    /** Delete what is too old, then what is over the count. */
    sweep() {
      const now = Date.now();
      const left = [];
      for (const f of files()) (now - f.at > KEEP_MS ? drop(f.file) : left.push(f));
      for (const f of left.slice(0, Math.max(0, left.length - KEEP_FILES))) drop(f.file);
      for (const [ref, file] of refs) if (!fs.existsSync(file)) refs.delete(ref);
    },

    /**
     * Write one photo. Returns { ref, name, bytes, type } or an { error } the
     * caller can answer with.
     */
    save(buf, declaredType) {
      if (!Buffer.isBuffer(buf) || !buf.length) return { error: "empty" };
      if (buf.length > MAX_BYTES) return { error: "too_large" };
      const kind = kindOf(buf);
      if (!kind) return { error: "not_an_image" };
      if (declaredType && String(declaredType).split(";")[0].trim().toLowerCase() !== kind.type) return { error: "type_mismatch" };
      const name = `${stamp(new Date())}-${crypto.randomBytes(3).toString("hex")}.${kind.ext}`;
      const file = path.join(root, name);
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      fs.chmodSync(root, 0o700);
      fs.writeFileSync(file, buf, { mode: 0o600, flag: "wx" });
      fs.chmodSync(file, 0o600);
      const ref = crypto.randomBytes(16).toString("base64url");
      refs.set(ref, file);
      uploads.sweep();
      log(`photo ${name} (${buf.length} bytes)`);
      return { ref, name, bytes: buf.length, type: kind.type };
    },

    /** The path behind a ref, or null once this process has forgotten it. */
    pathFor(ref) {
      if (typeof ref !== "string") return null;
      const file = refs.get(ref);
      if (!file) return null;
      if (!fs.existsSync(file)) { refs.delete(ref); return null; }
      return file;
    },

    /** Everything this process handed out, for tests. */
    count() { return refs.size; },
  };
  return uploads;
}

module.exports = { createUploads, kindOf, MAX_BYTES, KEEP_MS, KEEP_FILES, TYPES };

"use strict";
// Is this Mac running an older Airpocket than the folder setup copied it from?
//
// The service runs the copy setup made in the data folder (<data>/app). Pulling
// the clone, or updating the package, changes the source and nothing else until
// `airpocket setup` runs again, and the phone would show none of it. Setup keeps
// the source's path in install.json (`source`); this compares the time setup ran
// (`installedAt`) with the newest file under the source's src/. Version numbers
// are not enough: a pull changes the version only when someone bumps it.
//
// The answer the phone gets is { behind: true } and, when they differ, the two
// version strings, `running` and `available`. Never the path, and no field named
// like it: `source` is the path, so the version found there is `available`. A
// source that is gone, moved, unreadable, or is the very folder the service runs
// from gives no answer at all.
const fs = require("fs");
const path = require("path");

const CACHE_MS = 60 * 1000;
const MAX_ENTRIES = 5000;             // a src/ larger than this isn't a clone of Airpocket
const MAX_DEPTH = 8;

const versionAt = (dir) => {
  try { const v = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version; return typeof v === "string" && v.length <= 40 ? v : ""; }
  catch { return ""; }
};

/** The newest mtime (ms) of a regular file under dir, links not followed; null when anything can't be read. */
function newestUnder(dir) {
  let newest = 0, seen = 0;
  const walk = (d, depth) => {
    if (depth > MAX_DEPTH) return false;
    let names;
    try { names = fs.readdirSync(d); } catch { return false; }
    for (const name of names) {
      if (++seen > MAX_ENTRIES) return false;
      if (name === ".DS_Store" || name.endsWith(".tmp")) continue;   // what setup leaves out of the copy
      let st;
      try { st = fs.lstatSync(path.join(d, name)); } catch { return false; }
      if (st.isDirectory()) { if (!walk(path.join(d, name), depth + 1)) return false; }
      else if (st.isFile()) newest = Math.max(newest, st.mtimeMs);
    }
    return true;
  };
  return walk(dir, 0) ? newest : null;
}

/**
 * The check itself, uncached: undefined when there is nothing to say, else
 * { behind: true, running?, available? } with both versions only when they differ.
 * `dataDir` holds install.json; `root` is the folder this service runs from.
 */
function behindSource(dataDir, root) {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(path.join(dataDir, "install.json"), "utf8")); } catch { return undefined; }
  if (!rec || typeof rec !== "object" || typeof rec.source !== "string" || !path.isAbsolute(rec.source)) return undefined;
  const installed = Date.parse(rec.installedAt);
  if (!Number.isFinite(installed)) return undefined;
  let source, src;
  try {
    source = fs.realpathSync(rec.source);
    src = path.join(source, "src");
    if (!fs.lstatSync(src).isDirectory()) return undefined;
  } catch { return undefined; }
  let running;
  try { running = fs.realpathSync(root); } catch { running = root; }
  if (source === running) return undefined;          // the service runs the source itself: a restart, not setup, picks it up
  const newest = newestUnder(src);
  if (newest == null || newest <= installed) return undefined;
  const now = versionAt(root), then = versionAt(source);
  return { behind: true, ...(now && then && now !== then ? { running: now, available: then } : {}) };
}

/** behindSource, asked at most once a minute however often the phone polls. */
function createBehindCheck({ dataDir, root = path.join(__dirname, ".."), cacheMs = CACHE_MS, now = Date.now } = {}) {
  let cached = null;
  return () => {
    if (cached && now() - cached.at < cacheMs) return cached.value;
    let value;
    try { value = behindSource(dataDir, root); } catch { value = undefined; }
    cached = { at: now(), value };
    return value;
  };
}

module.exports = { behindSource, createBehindCheck, newestUnder, CACHE_MS };

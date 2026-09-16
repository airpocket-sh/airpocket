"use strict";
// Whether a Mac runs an older copy than the folder setup copied it from (src/behind.js),
// and what the phone app says about it, about a first open and about a Mac that is away.
// Everything in temp folders; no real install record is read.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { behindSource, createBehindCheck, newestUnder } = require("../src/behind");

const temps = [];
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const tempDir = (p) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); temps.push(d); return d; };
const HOUR = 3600 * 1000;

/** A data folder with an install record, a source folder (a clone) and the copy the service runs. */
function world({ version = "0.1.0", sourceVersion = version, record = {} } = {}) {
  const data = tempDir("airpocket-behind-data-");
  const source = tempDir("airpocket-behind-clone-");
  const app = path.join(data, "app");
  const installedAt = Date.now() - HOUR;
  for (const [dir, v] of [[source, sourceVersion], [app, version]]) {
    fs.mkdirSync(path.join(dir, "src", "public"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "airpocket", version: v }));
    for (const f of ["src/server.js", "src/public/app.js"]) {
      fs.writeFileSync(path.join(dir, f), "// " + f);
      fs.utimesSync(path.join(dir, f), new Date(installedAt - HOUR), new Date(installedAt - HOUR));
    }
  }
  const rec = { version: 1, airpocket: version, installedAt: new Date(installedAt).toISOString(), app, source, ...record };
  fs.writeFileSync(path.join(data, "install.json"), JSON.stringify(rec));
  // A pull: one file in the clone is now newer than the install.
  const pull = (f = "src/public/app.js", at = installedAt + 60000) => fs.utimesSync(path.join(source, f), new Date(at), new Date(at));
  return { data, source, app, installedAt, pull };
}

test("the copy is behind only once something under the source's src/ is newer than the install", () => {
  const w = world();
  assert.equal(behindSource(w.data, w.app), undefined, "nothing changed since setup");
  fs.writeFileSync(path.join(w.source, "README.md"), "changed");
  assert.equal(behindSource(w.data, w.app), undefined, "only src/ counts");
  w.pull();
  assert.deepEqual(behindSource(w.data, w.app), { behind: true }, "same version: no version strings");
  fs.writeFileSync(path.join(w.source, "package.json"), JSON.stringify({ version: "0.2.0" }));
  assert.deepEqual(behindSource(w.data, w.app), { behind: true, running: "0.1.0", available: "0.2.0" }, "the versions ride along when they differ");
});

test("a newer file deep in src/ counts; links and setup's own leftovers don't", () => {
  const w = world();
  const deep = path.join(w.source, "src", "public", "fonts");
  fs.mkdirSync(deep);
  fs.writeFileSync(path.join(deep, "x.woff2"), "");
  assert.deepEqual(behindSource(w.data, w.app), { behind: true });
  fs.utimesSync(path.join(deep, "x.woff2"), new Date(w.installedAt - HOUR), new Date(w.installedAt - HOUR));
  fs.utimesSync(deep, new Date(w.installedAt - HOUR), new Date(w.installedAt - HOUR));
  assert.equal(behindSource(w.data, w.app), undefined);
  fs.writeFileSync(path.join(w.source, "src", ".DS_Store"), "");
  fs.writeFileSync(path.join(w.source, "src", "store.json.tmp"), "");
  fs.symlinkSync(path.join(w.source, "package.json"), path.join(w.source, "src", "link.json"));
  assert.equal(behindSource(w.data, w.app), undefined, "what the copy leaves out doesn't make it behind");
});

test("an older install record, or a source that is gone, moved or unreadable, says nothing at all", () => {
  const w = world();
  w.pull();
  assert.deepEqual(behindSource(w.data, w.app), { behind: true });

  const rec = JSON.parse(fs.readFileSync(path.join(w.data, "install.json"), "utf8"));
  const write = (r) => fs.writeFileSync(path.join(w.data, "install.json"), typeof r === "string" ? r : JSON.stringify(r));
  const { source, ...older } = rec;
  for (const [r, why] of [[older, "a record from before setup kept the source"], [{ ...rec, source: "relative/clone" }, "a relative source"],
    [{ ...rec, source: 42 }, "not a string"], [{ ...rec, installedAt: "yesterday" }, "no install time"], ["{not json", "a broken record"],
    ["null", "null"], [{ ...rec, source: path.join(w.source, "gone") }, "a folder that isn't there"]]) {
    write(r);
    assert.equal(behindSource(w.data, w.app), undefined, why);
  }
  fs.rmSync(path.join(w.data, "install.json"));
  assert.equal(behindSource(w.data, w.app), undefined, "no record");
  assert.equal(behindSource(path.join(w.data, "nowhere"), w.app), undefined, "no data folder");

  write(rec);
  fs.renameSync(w.source, w.source + "-moved");
  assert.equal(behindSource(w.data, w.app), undefined, "moved");
  fs.renameSync(w.source + "-moved", w.source);
  fs.chmodSync(path.join(w.source, "src", "public"), 0o000);
  try { assert.equal(behindSource(w.data, w.app), undefined, "a folder under src/ that can't be read"); }
  finally { fs.chmodSync(path.join(w.source, "src", "public"), 0o755); }
  fs.rmSync(path.join(w.source, "src"), { recursive: true });
  fs.writeFileSync(path.join(w.source, "src"), "");
  assert.equal(behindSource(w.data, w.app), undefined, "src is not a folder");
});

test("a service that runs from the source itself is never behind it", () => {
  const w = world();
  w.pull();
  assert.equal(behindSource(w.data, w.source), undefined);
  const link = path.join(tempDir("airpocket-behind-link-"), "clone");
  fs.symlinkSync(w.source, link);
  assert.equal(behindSource(w.data, link), undefined, "compared by real path");
});

test("the check walks the tree at most once a minute", () => {
  const w = world();
  let clock = 1000;
  const check = createBehindCheck({ dataDir: w.data, root: w.app, now: () => clock });
  assert.equal(check(), undefined);
  w.pull();
  clock += 59000;
  assert.equal(check(), undefined, "still the cached answer");
  clock += 1000;
  assert.deepEqual(check(), { behind: true }, "asked again after a minute");
  fs.rmSync(w.source, { recursive: true });
  assert.deepEqual(check(), { behind: true });
  clock += 60000;
  assert.equal(check(), undefined, "gone: silence");
});

test("newestUnder gives up on a tree too large to be a clone's src/", () => {
  const dir = tempDir("airpocket-behind-big-");
  for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(dir, `f${i}`), "");
  assert.equal(newestUnder(dir), null);
  fs.rmSync(path.join(dir, "f0"));
  assert.ok(newestUnder(dir) > 0);
});

// ---- the phone app: the pieces that decide what it says, taken out of app.js as written.
const APP = fs.readFileSync(path.join(__dirname, "..", "src", "public", "app.js"), "utf8");
function fromApp(name) {
  const m = new RegExp(`\\n( *)function ${name}\\([\\s\\S]*?\\n\\1\\}\\n`).exec(APP);
  assert.ok(m, `app.js has ${name}`);
  return new Function(`${m[0]}; return ${name};`)();
}

test("the app says when an away Mac last answered: the time today, a date before that, nothing when never", () => {
  const answeredWhen = fromApp("answeredWhen");
  const now = new Date(2026, 8, 17, 18, 30).getTime();
  const today = answeredWhen(new Date(2026, 8, 17, 14, 2).getTime(), now);
  assert.match(today, /^at \d{1,2}[:.]02( [AP]M)?$/, today);
  const yesterday = answeredWhen(new Date(2026, 8, 16, 23, 59).getTime(), now);
  assert.match(yesterday, /^on .*16.* at /, yesterday);
  assert.doesNotMatch(yesterday, /2026/, "this year's dates leave the year out");
  assert.match(answeredWhen(new Date(2025, 11, 31, 9, 0).getTime(), now), /2025/, "last year's say so");
  for (const never of [undefined, null, 0, NaN, "12", -5]) assert.equal(answeredWhen(never, now), "", String(never));
});

test("the app says a Mac is behind only for a true flag, and shows versions only when both came", () => {
  const behindLine = fromApp("behindLine");
  assert.equal(behindLine("Studio", undefined), "");
  assert.equal(behindLine("Studio", null), "");
  assert.equal(behindLine("Studio", { behind: "yes" }), "", "only a real true");
  assert.equal(behindLine("Studio", {}), "");
  assert.equal(behindLine("Studio", { behind: true }),
    "Studio runs an older Airpocket than the folder it was set up from. Run airpocket setup on that Mac to bring it up to date.");
  assert.match(behindLine("Studio", { behind: true, running: "0.1.0", available: "0.2.0" }), /from \(0\.1\.0; the folder has 0\.2\.0\)\. Run/);
  assert.doesNotMatch(behindLine("Studio", { behind: true, running: "0.1.0" }), /\(/);
});

test("the app keeps what a Mac has shown on its record, and the first-run note gives way to the unseen lines", () => {
  const saved = [];
  const answered = new Function("saveHosts", `${/\n( *)function answered\([\s\S]*?\n\1\}\n/.exec(APP)[0]}; return answered;`)(() => saved.push(1));
  const host = {};
  answered(host, false);
  assert.ok(host.answeredAt > 0 && !host.hadSessions);
  assert.equal(saved.length, 1, "a first answer is stored");
  answered(host, false);
  assert.equal(saved.length, 1, "the next poll within a minute isn't");
  answered(host, true);
  assert.equal(host.hadSessions, true);
  assert.equal(saved.length, 2, "its first session is stored at once");
  answered(host, false);
  assert.equal(host.hadSessions, true, "an empty list later doesn't forget it");
  host.answeredAt -= 61000;
  answered(host, false);
  assert.equal(saved.length, 3, "a minute on, the time is stored again");

  const first = /\n *const FIRST_RUN = ([\s\S]*?);\n/.exec(APP);
  assert.ok(first, "app.js has its FIRST_RUN note");
  const note = new Function(`return ${first[1]};`)();
  assert.match(note, /Carry on as you normally would/);
  assert.match(note, /Claude Code session joins the list the next time you prompt it/);
  assert.match(note, /Codex session that was already running needs restarting once, because Codex takes its hooks at launch/);
  assert.match(APP, /if \(!l\.agents\.length && !r\.host\.hadSessions\) notes\.agents\.push\(onMac\(r, FIRST_RUN\)\);/,
    "shown only for a Mac that has never listed a session here, and not beside that Mac's unseen lines");
  assert.match(APP, /answered\(host, \(d\.sessions \|\| \[\]\)\.length > 0\);/, "every list answer is remembered");
});

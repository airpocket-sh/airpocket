"use strict";
// Merging Airpocket's hooks into the agents' config files, and taking them out
// again: pure functions plus the file writes, all in temp folders.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cfg = require("../src/agentconfig");

const temps = [];
const tempDir = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "airpocket-cfg-"))); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const CMD = cfg.hookCommand({ node: "/opt/homebrew/bin/node", hook: "/Users/me/Library/Application Support/Airpocket/app/src/hook.js", agent: "claude" });
const OTHER = () => ({
  model: "opus",
  permissions: { allow: ["Bash(ls)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }],
    Stop: [{ hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Hero.aiff" }] }],
    Notification: [{ hooks: [{ type: "command", command: "notify.sh", timeout: 10 }] }],
  },
  statusLine: { type: "command", command: "status.sh" },
});

test("the hook command quotes paths with spaces and quotes, and carries the marker", () => {
  assert.equal(CMD, `'/opt/homebrew/bin/node' '/Users/me/Library/Application Support/Airpocket/app/src/hook.js' claude # airpocket-hook`);
  const odd = cfg.hookCommand({ node: "/n", hook: "/it's/hook.js", agent: "codex", dataDir: "/d ir" });
  assert.equal(odd, `AIRPOCKET_DIR='/d ir' '/n' '/it'\\''s/hook.js' codex # airpocket-hook`);
  assert.ok(cfg.isOurs({ command: odd }));
  assert.ok(!cfg.isOurs({ command: "echo '# airpocket-hook' then more" }), "only at the end");
});

test("config paths follow CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
  assert.deepEqual(cfg.configPaths({}, "/h"), { claude: "/h/.claude/settings.json", codex: "/h/.codex/hooks.json" });
  assert.deepEqual(cfg.configPaths({ CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x" }, "/h"), { claude: "/c/settings.json", codex: "/x/hooks.json" });
  assert.deepEqual(cfg.configPaths({ CLAUDE_CONFIG_DIR: "rel" }, "/h").claude, "/h/.claude/settings.json", "a relative folder is ignored");
});

test("add: every other key and hook stays, ours go at the end of each event", () => {
  const before = OTHER();
  const { config, changes, created } = cfg.addHooks(before, "claude", CMD);
  assert.deepEqual(before, OTHER(), "the input is not modified");
  assert.deepEqual(changes.map((c) => c.event), cfg.EVENTS.claude);
  assert.deepEqual(created, { hooks: false, events: ["SessionStart", "UserPromptSubmit", "SessionEnd"] });
  // Everything that was there is still there, in the same place.
  assert.equal(config.model, "opus");
  assert.deepEqual(config.permissions, before.permissions);
  assert.deepEqual(config.statusLine, before.statusLine);
  assert.deepEqual(config.hooks.PreToolUse, before.hooks.PreToolUse);
  assert.deepEqual(config.hooks.Stop[0], before.hooks.Stop[0], "the user's Stop hook keeps position 0 (Codex trusts hooks by position)");
  assert.deepEqual(config.hooks.Stop[1], { hooks: [{ type: "command", command: CMD, timeout: 3 }] });
  assert.deepEqual(Object.keys(config), Object.keys(before), "key order kept");
});

test("add twice: one entry per event; a moved Airpocket is updated in place; duplicates are dropped", () => {
  const once = cfg.addHooks(OTHER(), "claude", CMD).config;
  const twice = cfg.addHooks(once, "claude", CMD);
  assert.deepEqual(twice.changes, []);
  assert.deepEqual(twice.config, once);
  for (const s of Object.values(cfg.hookState(twice.config, "claude", CMD))) assert.equal(s.count, 1);

  const moved = CMD.replace("/opt/homebrew/bin/node", "/usr/local/bin/node");
  const m = cfg.addHooks(once, "claude", moved);
  assert.deepEqual(m.changes.map((c) => c.action), cfg.EVENTS.claude.map(() => "updated"));
  assert.equal(m.config.hooks.Stop.length, 2, "updated where it stands, not added");
  assert.equal(m.config.hooks.Stop[1].hooks[0].command, moved);

  // Two copies (someone ran an older setup by hand): one stays, and a group left empty goes.
  const doubled = JSON.parse(JSON.stringify(once));
  doubled.hooks.Stop.push({ hooks: [{ type: "command", command: CMD, timeout: 3 }] });
  doubled.hooks.Notification[0].hooks.push({ type: "command", command: CMD });
  const fixed = cfg.addHooks(doubled, "claude", CMD);
  assert.equal(fixed.config.hooks.Stop.length, 2);
  assert.deepEqual(fixed.config.hooks.Notification[0].hooks.map((h) => h.command), ["notify.sh", CMD]);
  assert.equal(fixed.config.hooks.Notification.length, 1, "the second copy, left alone in its group, went with it");
  for (const s of Object.values(cfg.hookState(fixed.config, "claude"))) assert.equal(s.count, 1);
});

test("remove: after add then remove, the config equals the original", () => {
  for (const original of [OTHER(), {}, { hooks: {} }, { hooks: { Stop: [] } }, { theme: "dark" }]) {
    const { config, created } = cfg.addHooks(original, "codex", CMD.replace(" claude ", " codex "));
    const back = cfg.removeHooks(config, created);
    assert.deepEqual(back.config, original, JSON.stringify(original));
    assert.deepEqual(back.removed.sort(), [...cfg.EVENTS.codex].sort());
  }
  // Without install.json's record, whatever is left empty goes (the common case, and the only safe guess).
  const { config } = cfg.addHooks({ model: "x" }, "claude", CMD);
  assert.deepEqual(cfg.removeHooks(config).config, { model: "x" });
  // A hook of ours sharing a group with the user's own: only ours goes.
  const shared = { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "mine" }, { type: "command", command: CMD }] }] } };
  assert.deepEqual(cfg.removeHooks(shared).config, { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "mine" }] }] } });
  assert.deepEqual(cfg.removeHooks(OTHER()).removed, [], "nothing of ours: nothing removed");
});

test("read: invalid JSON and odd shapes are problems, never fixed; missing and empty files are empty configs", () => {
  const dir = tempDir();
  const f = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
  assert.match(cfg.readConfig(f("a.json", "{ not json")).problem, /not valid JSON/);
  assert.match(cfg.readConfig(f("b.json", "[1,2]")).problem, /not an object/);
  assert.match(cfg.readConfig(f("c.json", '{"hooks": []}')).problem, /"hooks" that is not an object/);
  assert.match(cfg.readConfig(f("d.json", '{"hooks": {"Stop": {}}}')).problem, /hooks.Stop that is not a list/);
  assert.match(cfg.readConfig(f("e.json", '{"hooks": {"Stop": [1]}}')).problem, /unknown shape/);
  assert.deepEqual(cfg.readConfig(path.join(dir, "missing.json")).config, {});
  assert.equal(cfg.readConfig(path.join(dir, "missing.json")).exists, false);
  assert.deepEqual(cfg.readConfig(f("g.json", "  \n")).config, {});
  assert.equal(cfg.readConfig(dir).problem, "is not a file");
  assert.equal(cfg.readConfig(f("h.json", '{\n    "a": 1\n}\n')).indent, 4);
  assert.equal(cfg.readConfig(f("i.json", '{\n\t"a": 1\n}\n')).indent, "\t");
});

test("write: a linked settings file stays a link, the mode stays, and a file that changed meanwhile isn't overwritten", () => {
  const dir = tempDir();
  const real = path.join(dir, "dotfiles", "settings.json");
  fs.mkdirSync(path.dirname(real));
  fs.writeFileSync(real, '{"a":1}', { mode: 0o644 });
  const link = path.join(dir, "settings.json");
  fs.symlinkSync(real, link);
  const read = cfg.readConfig(link);
  cfg.writeConfig(link, '{"a":2}\n', { expect: read.text, mode: read.mode });
  assert.ok(fs.lstatSync(link).isSymbolicLink(), "still a link");
  assert.equal(fs.readFileSync(real, "utf8"), '{"a":2}\n');
  assert.equal(fs.statSync(real).mode & 0o777, 0o644);

  assert.throws(() => cfg.writeConfig(link, '{"a":3}\n', { expect: read.text }), { code: "ECHANGED" });
  assert.equal(fs.readFileSync(real, "utf8"), '{"a":2}\n', "untouched");
  assert.deepEqual(fs.readdirSync(path.dirname(real)), ["settings.json"], "no temporary file left");

  const b = cfg.backup(link, "old text", new Date("2026-09-16T10:20:30Z"));
  assert.equal(path.basename(b), "settings.json.airpocket-backup-20260916-102030");
  assert.equal(fs.statSync(b).mode & 0o777, 0o600);
  assert.notEqual(cfg.backup(link, "x", new Date("2026-09-16T10:20:30Z")), b, "a second backup in the same second gets its own name");
});

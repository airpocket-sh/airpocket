"use strict";
// Airpocket's hook entries in the agents' own config files:
//
//   Claude Code   $CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json
//   Codex         $CODEX_HOME/hooks.json, else ~/.codex/hooks.json
//
// Both keep hooks the same way: { "hooks": { "<Event>": [ { "matcher"?, "hooks":
// [ { "type": "command", "command", "timeout" } ] } ] } }. Airpocket adds one
// group per event, at the end, and knows its own entries by the marker at the
// end of the command (a shell comment, so it changes nothing when it runs).
//
// The rules: merge, never rewrite. Every other key and every other hook stays
// exactly as it was; a file that isn't valid JSON, or whose hooks aren't shaped
// as above, is refused and left alone, never "fixed". A timestamped copy of the
// file is written next to it before it changes. Adding twice leaves one entry.
// Removing takes out our entries only, and the containers setup itself created.
//
// Groups are appended, never inserted, because Codex remembers which hooks you
// trusted by their position (<file>:<event>:<group>:<hook> in config.toml):
// putting ours in front would ask you to review your own hooks again.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MARKER = "# airpocket-hook";
const OURS = /(^|\s)# airpocket-hook\s*$/;
const EVENTS = Object.freeze({
  claude: Object.freeze(["SessionStart", "UserPromptSubmit", "Stop", "Notification", "SessionEnd"]),
  codex: Object.freeze(["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest", "Interrupt", "SessionEnd"]),
});
// The hook gives up after 1.5 s on its own. Codex caps some events at 3 s and warns on every start about a longer one.
const TIMEOUT_S = 3;
const MAX_FILE = 16 * 1024 * 1024;

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isOurs = (h) => isObject(h) && typeof h.command === "string" && OURS.test(h.command);

/** A string the shell reads back as exactly itself. */
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * The command an agent runs: node and the hook by absolute path, the data folder
 * when it isn't the default one, and the marker.
 */
function hookCommand({ node, hook, agent, dataDir }) {
  const env = dataDir ? `AIRPOCKET_DIR=${shellQuote(dataDir)} ` : "";
  return `${env}${shellQuote(node)} ${shellQuote(hook)} ${agent} ${MARKER}`;
}

/** Where each agent keeps its hooks, for an environment and a home folder. */
function configPaths(env, home) {
  return {
    claude: path.join(env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(home, ".claude"), "settings.json"),
    codex: path.join(env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, ".codex"), "hooks.json"),
  };
}

/**
 * Read a config file: { exists, text, config, indent, mode, problem }. A missing
 * file is an empty config; an empty one too. Anything else that isn't a JSON
 * object with well-formed hooks has a `problem`, and must not be written.
 */
function readConfig(file) {
  let st;
  try { st = fs.statSync(file); } catch (err) {
    if (err.code === "ENOENT") return { exists: false, text: "", config: {}, indent: 2, mode: 0o600 };
    return { exists: false, problem: `can't be read (${err.code})` };
  }
  if (!st.isFile()) return { exists: true, problem: "is not a file" };
  if (st.size > MAX_FILE) return { exists: true, problem: "is too big to be a config file" };
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (err) { return { exists: true, problem: `can't be read (${err.code})` }; }
  const base = { exists: true, text, mode: st.mode & 0o777, indent: indentOf(text) };
  if (!text.trim()) return { ...base, config: {} };
  let config;
  try { config = JSON.parse(text); } catch (err) { return { ...base, problem: `is not valid JSON (${err.message})` }; }
  if (!isObject(config)) return { ...base, problem: "is JSON, but not an object" };
  const shape = shapeProblem(config);
  return shape ? { ...base, problem: shape } : { ...base, config };
}

/** How a file indents, so a merged file looks like the one it came from. */
function indentOf(text) {
  const m = /^\{\s*\n([ \t]+)"/.exec(text);
  if (!m) return 2;
  return m[1].includes("\t") ? "\t" : Math.min(m[1].length, 8);
}

/** Why a config's hooks can't be merged into, or "". */
function shapeProblem(config) {
  if (!("hooks" in config)) return "";
  if (!isObject(config.hooks)) return `has "hooks" that is not an object`;
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) return `has hooks.${event} that is not a list`;
    for (const g of groups) if (!isObject(g) || ("hooks" in g && !Array.isArray(g.hooks))) return `has a hooks.${event} entry of an unknown shape`;
  }
  return "";
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * Airpocket's hooks merged into a config. Returns { config, changes, created }:
 * changes lists { event, action: "added" | "updated" }, and created says which
 * containers didn't exist before ({ hooks: bool, events: [...] }), so they can be
 * removed again. An entry of ours with another command (Airpocket moved, or a
 * newer node) is updated where it stands; a second copy of ours is dropped.
 */
function addHooks(config, agent, command) {
  const next = clone(config);
  const created = { hooks: !isObject(next.hooks), events: [] };
  if (created.hooks) next.hooks = {};
  const changes = [];
  for (const event of EVENTS[agent]) {
    if (!Array.isArray(next.hooks[event])) { next.hooks[event] = []; created.events.push(event); }
    let found = false, changed = false;
    const thinned = new Set();                          // groups a duplicate of ours was taken out of
    for (const g of next.hooks[event]) {
      if (!Array.isArray(g.hooks)) continue;
      g.hooks = g.hooks.filter((h) => {
        if (!isOurs(h)) return true;
        if (found) { changed = true; thinned.add(g); return false; }
        found = true;
        if (h.command !== command || h.type !== "command" || h.timeout !== TIMEOUT_S) {
          h.type = "command"; h.command = command; h.timeout = TIMEOUT_S; changed = true;
        }
        return true;
      });
    }
    next.hooks[event] = next.hooks[event].filter((g) => !(thinned.has(g) && g.hooks.length === 0));
    if (!found) {
      next.hooks[event].push({ hooks: [{ type: "command", command, timeout: TIMEOUT_S }] });
      changes.push({ event, action: "added" });
    } else if (changed) {
      changes.push({ event, action: "updated" });
    }
  }
  return { config: next, changes, created };
}

/**
 * Airpocket's hooks taken out of a config. Returns { config, removed } (events).
 * A group left empty goes; so does an event list, and the "hooks" object, when
 * it is left empty and setup created it (`created`, from install.json). Without
 * that record, anything left empty by removing ours goes.
 */
function removeHooks(config, created = null) {
  const next = clone(config);
  const removed = [];
  if (!isObject(next.hooks)) return { config: next, removed };
  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) continue;
    let hit = false;
    const kept = [];
    for (const g of groups) {
      if (!isObject(g) || !Array.isArray(g.hooks) || !g.hooks.some(isOurs)) { kept.push(g); continue; }
      hit = true;
      const rest = g.hooks.filter((h) => !isOurs(h));
      if (rest.length) kept.push({ ...g, hooks: rest });
    }
    if (!hit) continue;
    removed.push(event);
    const madeByUs = created ? (created.events || []).includes(event) : true;
    if (kept.length || !madeByUs) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (removed.length && !Object.keys(next.hooks).length && (created ? created.hooks : true)) delete next.hooks;
  return { config: next, removed };
}

/** Which of an agent's events have our hook, and whether each has exactly one, with this command. */
function hookState(config, agent, command) {
  const out = {};
  for (const event of EVENTS[agent]) {
    const groups = isObject(config.hooks) && Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    const ours = [];
    groups.forEach((g, gi) => { if (isObject(g) && Array.isArray(g.hooks)) g.hooks.forEach((h, hi) => { if (isOurs(h)) ours.push({ group: gi, index: hi, command: h.command }); }); });
    out[event] = { count: ours.length, same: ours.length === 1 && (!command || ours[0].command === command), at: ours[0] || null };
  }
  return out;
}
const hasAnyOurs = (config) => isObject(config.hooks) && Object.values(config.hooks).some((gs) => Array.isArray(gs) && gs.some((g) => isObject(g) && Array.isArray(g.hooks) && g.hooks.some(isOurs)));

const serialize = (config, indent) => JSON.stringify(config, null, indent) + "\n";

/** A timestamped copy next to the file, private to this user. Returns its path. */
function backup(file, text, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  for (let i = 0; i < 100; i++) {
    const name = `${file}.airpocket-backup-${stamp}${i ? "-" + i : ""}`;
    try { fs.writeFileSync(name, text, { flag: "wx", mode: 0o600 }); return name; } catch (err) { if (err.code !== "EEXIST") throw err; }
  }
  throw new Error(`couldn't write a backup of ${file}`);
}

/**
 * Write a config file whole: next to the real file (a linked settings.json stays
 * a link), same mode, flushed, renamed into place. `expect` is the text the
 * change was made from: if the file changed since (the agent wrote it meanwhile),
 * nothing is written and this throws, so nobody's edit is lost.
 */
function writeConfig(file, text, { expect, mode = 0o600 } = {}) {
  let target = file;
  try { target = fs.realpathSync(file); } catch {}
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.airpocket-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    fs.chmodSync(tmp, mode);
    let now = "";
    try { now = fs.readFileSync(target, "utf8"); } catch (err) { if (err.code !== "ENOENT") throw err; }
    if (expect !== undefined && now !== expect) {
      const err = new Error(`${file} changed while Airpocket was editing it; nothing was written. Run the command again.`);
      err.code = "ECHANGED";
      throw err;
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/** Remove a file setup created, if it still holds exactly what we expect. */
function removeConfig(file, expect) {
  const now = fs.readFileSync(file, "utf8");
  if (now !== expect) {
    const err = new Error(`${file} changed while Airpocket was editing it; nothing was removed. Run the command again.`);
    err.code = "ECHANGED";
    throw err;
  }
  fs.unlinkSync(file);
}

module.exports = { MARKER, EVENTS, TIMEOUT_S, isOurs, shellQuote, hookCommand, configPaths, readConfig, addHooks, removeHooks, hookState,
  hasAnyOurs, serialize, backup, writeConfig, removeConfig };

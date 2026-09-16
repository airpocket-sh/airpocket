"use strict";
// The shell aliases setup offers, so typing `claude` or `codex` starts the agent
// where the phone can answer (see ownterm.js):
//
//   alias claude='airpocket run claude' # airpocket-alias
//   alias codex='airpocket run codex' # airpocket-alias
//
// in ~/.zshrc (or $ZDOTDIR/.zshrc) for zsh, ~/.bash_profile for bash: the login
// shell's own file, nothing for any other shell.
//
// The same rules as the hooks (agentconfig.js): added to the end of the file,
// found again by the trailing marker, backed up first, never twice, and never
// over an alias or function of the user's own with that name. Removing takes
// out our lines and, if setup had to end the file's last line to add them, that
// newline too, so the file is byte for byte what it was.
const fs = require("fs");
const path = require("path");
const { shellQuote } = require("./agentconfig");

const MARKER = "# airpocket-alias";
const OURS = /^alias (claude|codex)=.* # airpocket-alias$/;
const MAX_FILE = 4 * 1024 * 1024;

/** The profile file for this user's login shell: { shell, file }, file "" for a shell Airpocket doesn't write. */
function profileFor(env, home) {
  const shell = path.basename(String(env.SHELL || ""));
  if (shell === "zsh") return { shell, file: path.join(env.ZDOTDIR && path.isAbsolute(env.ZDOTDIR) ? env.ZDOTDIR : home, ".zshrc") };
  if (shell === "bash") return { shell, file: path.join(home, ".bash_profile") };
  return { shell: shell || "unknown", file: "" };
}

/** The line for one agent. `runner` is how to start Airpocket: "airpocket", or quoted node and cli.js paths. */
function aliasLine(agent, runner) {
  return `alias ${agent}=${shellQuote(`${runner} run ${agent}`)} ${MARKER}`;
}

/** Read a profile: { exists, text, mode, problem }. A missing file is empty. */
function readProfile(file) {
  let st;
  try { st = fs.statSync(file); } catch (err) {
    return err.code === "ENOENT" ? { exists: false, text: "", mode: 0o644 } : { exists: false, problem: `can't be read (${err.code})` };
  }
  if (!st.isFile()) return { exists: true, problem: "is not a file" };
  if (st.size > MAX_FILE) return { exists: true, problem: "is too big to be a shell profile" };
  try { return { exists: true, text: fs.readFileSync(file, "utf8"), mode: st.mode & 0o777 }; } catch (err) { return { exists: true, problem: `can't be read (${err.code})` }; }
}

const lines = (text) => (text ? text.split(/(?<=\n)/) : []);           // each line keeps its "\n"
const bare = (l) => l.replace(/\r?\n$/, "");

/** The user's own line that defines `name` as an alias or a function, or "". */
function ownDefinition(text, name) {
  const alias = new RegExp(`^\\s*alias\\s+(?:-\\S+\\s+)*(?:[^\\s=]+=\\S*\\s+)*${name}=`);
  const fn = new RegExp(`^\\s*(?:function\\s+${name}\\b|${name}\\s*\\(\\s*\\))`);
  for (const l of lines(text).map(bare)) {
    if (OURS.test(l) || /^\s*#/.test(l)) continue;
    if (alias.test(l) || fn.test(l)) return l.trim();
  }
  return "";
}

/**
 * Our aliases merged into a profile's text. `want` is [{ agent, line }].
 * Returns { text, added, updated, same, skipped: [{ agent, line }], newlineAdded }.
 */
function addAliases(text, want) {
  let out = lines(text);
  const added = [], updated = [], same = [], skipped = [];
  const append = [];
  for (const { agent, line } of want) {
    const at = out.findIndex((l) => OURS.test(bare(l)) && bare(l).startsWith(`alias ${agent}=`));
    if (at >= 0) {
      if (bare(out[at]) === line) same.push(agent);
      else { out[at] = line + "\n"; updated.push(agent); }
      continue;
    }
    const own = ownDefinition(text, agent);
    if (own) { skipped.push({ agent, line: own }); continue; }
    append.push(line + "\n");
    added.push(agent);
  }
  let newlineAdded = false;
  if (append.length) {
    if (out.length && !out[out.length - 1].endsWith("\n")) { out[out.length - 1] += "\n"; newlineAdded = true; }
    out = out.concat(append);
  }
  return { text: out.join(""), added, updated, same, skipped, newlineAdded };
}

/** Our aliases taken out again. Returns { text, removed }. */
function removeAliases(text, { newlineAdded = false } = {}) {
  const all = lines(text);
  const removed = [];
  const kept = [];
  let lastOurs = -1, lastOther = -1;
  all.forEach((l, i) => {
    const m = OURS.exec(bare(l));
    if (m) { removed.push(m[1]); lastOurs = i; } else { kept.push(l); lastOther = i; }
  });
  let out = kept.join("");
  // The newline setup added ended the user's last line; it goes only if nothing was written after ours since.
  if (removed.length && newlineAdded && lastOurs > lastOther && out.endsWith("\n")) out = out.slice(0, -1);
  return { text: out, removed };
}

const hasOurs = (text) => lines(text).some((l) => OURS.test(bare(l)));
const oursIn = (text) => lines(text).map((l) => OURS.exec(bare(l))).filter(Boolean).map((m) => m[1]);

module.exports = { MARKER, profileFor, aliasLine, readProfile, ownDefinition, addAliases, removeAliases, hasOurs, oursIn };

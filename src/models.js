"use strict";
// Which models each agent offers, and what to call them, from the agents' own
// files, so the lists don't go stale when a new model ships:
//
//   Codex   $CODEX_HOME/models_cache.json, the list Codex fetches for its own
//           /model picker. Only entries with visibility "list" are in that
//           picker; the others ("hide": codex-auto-review, gpt-reserve) are
//           Codex's internal models. Each lists its reasoning levels.
//   Claude  ~/.claude/cache/model-catalog/<account>-cc.json, the catalog
//           Claude Code fetches for its own /model picker ("cc" is Claude
//           Code's surface), with each model's effort levels. Only that
//           folder, by its real path: never another config folder (some
//           people keep one per account elsewhere), never ~/.claude.json.
//
// Both are read fresh (a stat on every call, parsed again when they change),
// with a size cap, and only ids, names and effort levels are taken. When a
// file is missing or malformed, the built-in lists below stand in. Claude's
// are its aliases, which always mean the newest model of each family.
const fs = require("fs");
const path = require("path");

const CAP = Object.freeze({ claude: 1024 * 1024, codex: 4 * 1024 * 1024 });
// An id goes into "/model <id>" and "--model <id>": letters, digits, dots and dashes, and Claude's "[1m]".
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\[1m\])?$/;
const EFFORT = /^[a-z]{1,12}$/;
const MAX_MODELS = 40;
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const CATALOG_FILE = /^[A-Za-z0-9-]{1,160}-cc\.json$/;

const CLAUDE_ALIASES = Object.freeze(["opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku", "fable", "fable[1m]", "opusplan"]);
const CLAUDE_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
const CODEX_MODELS = Object.freeze(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
const CODEX_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh"]);

const clip = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * A Claude model's name, by rule rather than from a table, so a new model needs
 * no update: "claude-fable-5-1" -> "Fable 5.1", "claude-haiku-4-5-20251001" ->
 * "Haiku 4.5", "opus[1m]" -> "Opus 1M", "opusplan" -> "Opus Plan". Something
 * that is already a name ("Fable 5.1") stays as it is.
 */
function claudeName(id) {
  let s = clip(id, 64);
  if (!s || s.startsWith("<")) return "";                    // "<synthetic>": not a model
  if (/\s|[A-Z]/.test(s)) return s.slice(0, 40);
  const oneM = /\[1m\]$/i.test(s);
  s = s.replace(/\[1m\]$/i, "");
  const out = [];
  for (const part of s.split("-")) {
    if (!part || part === "claude" || part === "latest" || /^\d{8}$/.test(part)) continue;   // the dated snapshot
    if (/^\d+$/.test(part) && /^\d+(\.\d+)*$/.test(out[out.length - 1] || "")) out[out.length - 1] += "." + part;
    else out.push(...part.replace(/^([a-z]+?)plan$/, "$1 plan").split(" "));
  }
  const name = out.map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
  return clip((name || s) + (oneM ? " 1M" : ""), 40);
}

const effortsOf = (list) => [...new Set(list.filter((x) => typeof x === "string" && EFFORT.test(x)))];
const byOrder = (a, b) => (EFFORT_ORDER.indexOf(a) + 1 || 99) - (EFFORT_ORDER.indexOf(b) + 1 || 99);
const unionOf = (models) => [...new Set(models.flatMap((m) => m.efforts))].sort(byOrder);

/** Codex's models_cache.json -> { list, names }: what its picker shows (by its priority), and every model's display name. */
function parseCodex(data) {
  const all = data && Array.isArray(data.models) ? data.models : null;
  if (!all) return null;
  const names = new Map();
  const shown = [];
  for (const [i, m] of all.entries()) {
    if (!m || typeof m !== "object" || typeof m.slug !== "string" || !MODEL_ID.test(m.slug)) continue;
    const name = clip(typeof m.display_name === "string" ? m.display_name : "", 40) || m.slug;
    names.set(m.slug, name);
    if (m.visibility !== "list") continue;
    const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((l) => l && l.effort) : [];
    shown.push({ i, priority: Number.isFinite(m.priority) ? m.priority : Infinity,
      model: { id: m.slug, name, efforts: effortsOf(levels),
               ...(EFFORT.test(String(m.default_reasoning_level || "")) ? { effort: m.default_reasoning_level } : {}) } });
  }
  const list = shown.sort((a, b) => a.priority - b.priority || a.i - b.i).slice(0, MAX_MODELS).map((x) => x.model);
  return list.length ? { list, names } : null;
}

/** Claude Code's model catalog -> the models its picker offers, each with its effort levels. */
function parseClaude(data) {
  const config = data && data.catalog && data.catalog.config;
  const all = config && Array.isArray(config.models) ? config.models : null;
  if (!all || (data.catalog.surface && data.catalog.surface !== "cc")) return null;
  const list = [];
  for (const m of all) {
    if (!m || typeof m !== "object" || typeof m.id !== "string" || !MODEL_ID.test(m.id) || list.some((x) => x.id === m.id)) continue;
    const t = m.thinking && typeof m.thinking === "object" ? m.thinking : {};
    const levels = t.type === "effort" && Array.isArray(t.effort_options) ? t.effort_options.map((o) => o && o.id) : [];
    list.push({ id: m.id, name: claudeName(m.id), efforts: effortsOf(levels) });
    if (list.length >= MAX_MODELS) break;
  }
  return list.length ? { list } : null;
}

/** A JSON file of at most `cap` bytes, read in one go (a file that grows past the cap meanwhile is refused too). */
function readJsonCapped(file, cap) {
  const fd = fs.openSync(file, "r");
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > cap) throw new Error("too big");
    const buf = Buffer.alloc(cap + 1);
    const n = fs.readSync(fd, buf, 0, cap + 1, 0);
    if (n > cap) throw new Error("too big");
    return JSON.parse(buf.toString("utf8", 0, n));
  } finally { fs.closeSync(fd); }
}

/**
 * The model lists, from `claudeDir` (~/.claude) and `codexHome` ($CODEX_HOME).
 * lists() -> { claude: { models, efforts, from }, codex: { ... } }, where each
 * model is { id, name, efforts[, effort] } and `from` says where the list came
 * from ("claude code", "codex" or "built-in"). nameOf(agent, id) is a model's
 * readable name.
 */
function createModels({ claudeDir, codexHome }) {
  const memo = new Map();
  function cached(file, cap, parse) {
    let st;
    try { st = fs.statSync(file); } catch { memo.delete(file); return null; }
    const hit = memo.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.ino === st.ino) return hit.value;
    let value = null;
    try { value = parse(readJsonCapped(file, cap)); } catch { value = null; }
    memo.set(file, { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, value });
    return value;
  }

  const codex = () => cached(path.join(codexHome, "models_cache.json"), CAP.codex, parseCodex);

  // The newest catalog in Claude Code's own cache folder, and only there: the
  // folder must really be <claudeDir>/cache/model-catalog, not a link elsewhere.
  function claudeCatalog() {
    const dir = path.join(claudeDir, "cache", "model-catalog");
    let names;
    try {
      if (fs.realpathSync(dir) !== path.join(fs.realpathSync(claudeDir), "cache", "model-catalog")) return null;
      names = fs.readdirSync(dir).filter((n) => CATALOG_FILE.test(n));
    } catch { return null; }
    let best = null;
    for (const n of names) {
      try {
        const st = fs.lstatSync(path.join(dir, n));
        if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) best = { file: path.join(dir, n), mtimeMs: st.mtimeMs };
      } catch {}
    }
    return best ? cached(best.file, CAP.claude, parseClaude) : null;
  }

  function lists() {
    const c = claudeCatalog(), x = codex();
    const claude = c ? c.list : CLAUDE_ALIASES.map((id) => ({ id, name: claudeName(id), efforts: [...CLAUDE_EFFORTS] }));
    const codexList = x ? x.list : CODEX_MODELS.map((id) => ({ id, name: id, efforts: [...CODEX_EFFORTS] }));
    return {
      claude: { models: claude, efforts: c ? unionOf(claude) : [...CLAUDE_EFFORTS], from: c ? "claude code" : "built-in" },
      codex: { models: codexList, efforts: x ? unionOf(codexList) : [...CODEX_EFFORTS], from: x ? "codex" : "built-in" },
    };
  }

  function nameOf(agent, id) {
    if (!id) return "";
    if (agent !== "codex") return claudeName(id);
    const x = codex();
    return (x && x.names.get(id)) || clip(id, 40);
  }

  return { lists, nameOf };
}

module.exports = { createModels, claudeName, parseCodex, parseClaude, CLAUDE_ALIASES, CLAUDE_EFFORTS, CODEX_MODELS, CODEX_EFFORTS, CAP };

"use strict";
// Model, effort, mode and status from what the agents record themselves, and
// model lists from the agents' own files. The fixtures in test/fixtures have
// the shapes of real files (entry types, field names, nesting) with invented
// content: a Claude transcript, a Codex session file, Codex's models_cache.json
// and Claude Code's model catalog. Everything runs in temp folders.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createModels, claudeName, CAP, CLAUDE_ALIASES, CODEX_MODELS } = require("../src/models");
const { createServer, claudeItems, mergeInfo, claudeMode, codexContext } = require("../src/server");
const { createStore } = require("../src/store");
const { startTimeOf } = require("../src/proc");

const ME = startTimeOf(process.pid);
const FIX = path.join(__dirname, "fixtures");
const fixture = (n) => fs.readFileSync(path.join(FIX, n), "utf8");
const J = (o) => JSON.stringify(o);
const CATALOG = "0000aaaa-1111-2222-3333-444455556666-cc.json";
const temps = [];
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "airpocket-models-")); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

/** A home with a Claude folder and a CODEX_HOME, holding the catalog and the cache given. */
function homes({ catalog, cache } = {}) {
  const d = tempDir();
  const claudeDir = path.join(d, ".claude"), codexHome = path.join(d, ".codex");
  fs.mkdirSync(path.join(claudeDir, "cache", "model-catalog"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  if (catalog !== undefined) fs.writeFileSync(path.join(claudeDir, "cache", "model-catalog", CATALOG), catalog);
  if (cache !== undefined) fs.writeFileSync(path.join(codexHome, "models_cache.json"), cache);
  return { d, claudeDir, codexHome };
}

test("Claude model names by rule, so a new model needs no table", () => {
  for (const [id, name] of [["claude-opus-5", "Opus 5"], ["claude-fable-5-1", "Fable 5.1"], ["claude-haiku-4-5-20251001", "Haiku 4.5"],
    ["claude-fable-5-1[1m]", "Fable 5.1 1M"], ["claude-opus-4-8", "Opus 4.8"], ["claude-nova-6", "Nova 6"], ["opus", "Opus"],
    ["opus[1m]", "Opus 1M"], ["opusplan", "Opus Plan"], ["Fable 5.1", "Fable 5.1"], ["<synthetic>", ""], ["", ""]]) {
    assert.equal(claudeName(id), name, id);
  }
});

test("Codex: only what its picker shows, in its order, each with its reasoning levels; hidden ones still have names", () => {
  const m = createModels(homes({ cache: fixture("codex-models_cache.json") }));
  const c = m.lists().codex;
  assert.equal(c.from, "codex");
  assert.deepEqual(c.models.map((x) => [x.id, x.name, x.efforts.join(" ")]), [
    ["gpt-9-mini", "GPT-9-Mini", "low medium high"],
    ["gpt-9-nova", "GPT-9-Nova", "low medium high xhigh max ultra"],
    ["gpt-9-tiny", "GPT-9-Tiny", "low medium"],
  ], "visibility 'list' only; a slug that isn't an id is dropped, and so is a level that isn't a word");
  assert.deepEqual(c.efforts, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(m.nameOf("codex", "codex-auto-review"), "Codex Auto Review");
  assert.equal(m.nameOf("codex", "gpt-unknown"), "gpt-unknown");
});

test("Codex: read fresh; a missing, malformed or oversized cache falls back to the built-in list", () => {
  const h = homes();
  const m = createModels(h);
  assert.equal(m.lists().codex.from, "built-in");
  assert.deepEqual(m.lists().codex.models.map((x) => x.id), CODEX_MODELS);
  const file = path.join(h.codexHome, "models_cache.json");
  fs.writeFileSync(file, fixture("codex-models_cache.json"));
  assert.equal(m.lists().codex.from, "codex", "picked up without a restart");
  for (const bad of ["{ not json", J({ models: "nope" }), J({ models: [] }), J([1, 2]), J({ models: [{ slug: "gpt-x", visibility: "hide" }] })]) {
    fs.writeFileSync(file, bad);
    assert.equal(m.lists().codex.from, "built-in", bad);
  }
  fs.writeFileSync(file, J({ ...JSON.parse(fixture("codex-models_cache.json")), padding: "x".repeat(CAP.codex) }));
  assert.equal(m.lists().codex.from, "built-in", "over the size cap");
  fs.rmSync(file);
  assert.equal(m.lists().codex.from, "built-in", "gone again");
});

test("Claude: the models Claude Code's own catalog offers, with their effort levels; its aliases without one", () => {
  const c = createModels(homes({ catalog: fixture("claude-model-catalog.json") })).lists().claude;
  assert.equal(c.from, "claude code");
  assert.deepEqual(c.models.map((x) => [x.id, x.name, x.efforts.join(" ")]), [
    ["claude-nova-6", "Nova 6", "low medium high max"], ["claude-lyra-6-1", "Lyra 6.1", "low high"], ["claude-wren-5-20260101", "Wren 5", ""]]);
  assert.deepEqual(c.efforts, ["low", "medium", "high", "max"]);
  const none = createModels(homes()).lists().claude;
  assert.equal(none.from, "built-in");
  assert.deepEqual(none.models.map((x) => x.id), CLAUDE_ALIASES, "the aliases, which always mean the newest models");
  assert.equal(none.models.find((x) => x.id === "opus[1m]").name, "Opus 1M");
});

test("Claude: a malformed, oversized or linked catalog isn't used, nor anything else in that folder", () => {
  const good = fixture("claude-model-catalog.json");
  for (const bad of ["{", J({ catalog: { surface: "claude-ai", config: { models: [{ id: "claude-x-1" }] } } }), J({ catalog: { config: { models: [] } } }),
                     J({ padding: "x".repeat(CAP.claude), ...JSON.parse(good) })]) {
    assert.equal(createModels(homes({ catalog: bad })).lists().claude.from, "built-in", bad.slice(0, 40));
  }
  const other = homes({ catalog: good });
  const linkedDir = homes();
  fs.rmSync(path.join(linkedDir.claudeDir, "cache", "model-catalog"), { recursive: true });
  fs.symlinkSync(path.join(other.claudeDir, "cache", "model-catalog"), path.join(linkedDir.claudeDir, "cache", "model-catalog"));
  assert.equal(createModels(linkedDir).lists().claude.from, "built-in", "the folder is a link to another config folder");
  const linkedFile = homes();
  fs.symlinkSync(path.join(other.claudeDir, "cache", "model-catalog", CATALOG), path.join(linkedFile.claudeDir, "cache", "model-catalog", "linked-cc.json"));
  assert.equal(createModels(linkedFile).lists().claude.from, "built-in", "a file linked into the folder");
  const otherName = homes();
  fs.writeFileSync(path.join(otherName.claudeDir, "cache", "model-catalog", "x-web.json"), good);
  assert.equal(createModels(otherName).lists().claude.from, "built-in", "not a Claude Code catalog by its name");
});

test("Claude's transcript: the latest model, effort and permission mode it recorded, and when a turn last ended", () => {
  const lines = fixture("claude-transcript.jsonl").split("\n");
  const upTo = (uuid) => { const info = {}; claudeItems(lines.slice(0, lines.findIndex((l) => l.includes(`"uuid":"${uuid}"`)) + 1), info); return info; };
  assert.deepEqual(upTo("a1"), { mode: "default", model: "claude-opus-5", effort: "high" });
  assert.deepEqual(upTo("u3"), { mode: "default", model: "Fable 5.1", effort: "xhigh", ended: Date.parse("2026-09-15T10:00:05.000Z") },
    "what /model just set, before the next reply; the turn's end");
  const info = {};
  const items = claudeItems(lines, info);
  assert.deepEqual(info, { mode: "bypassPermissions", model: "claude-fable-5-1", effort: "xhigh", ended: Date.parse("2026-09-15T10:02:09.000Z") },
    "a helper's reply and an API error's <synthetic> model don't count; the interruption ends the turn");
  assert.ok(items.some((it) => it.type === "agent" && it.text === "Sorting now."));
  assert.ok(!J(items).includes("Set model to") && !J(items).includes("helper chatter"), "command output and helpers stay out of the chat");
  const broken = {};
  claudeItems(["{ broken", '{"type":"assistant","message":{"model":7}}', '{"type":"permission-mode","permissionMode":"bad mode!"}', lines[4].slice(0, 60)], broken);
  assert.deepEqual(broken, {}, "wrong types, odd values and a half-written line give nothing");
});

test("Codex's session file: turn_context, then settings changed between turns win", () => {
  const lines = fixture("codex-rollout.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const first = codexContext(lines.find((d) => d.type === "turn_context").payload);
  assert.deepEqual(first, { model: "gpt-9-mini", effort: "medium", mode: "default", access: "asks first" });
  const next = codexContext(lines.find((d) => d.payload && d.payload.type === "thread_settings_applied").payload.thread_settings, first);
  assert.deepEqual(next, { model: "gpt-9-nova", effort: "xhigh", mode: "plan", access: "full access", fast: true });
  assert.deepEqual(codexContext({ model: "gpt-9-mini" }, next), { ...next, model: "gpt-9-mini" }, "what a line doesn't say stays");
  assert.deepEqual(codexContext(null, next), next);
});

test("what the phone shows: the session's own file first, the screen for the rest, and for Claude's mode", () => {
  const { nameOf } = createModels(homes({ cache: fixture("codex-models_cache.json") }));
  assert.deepEqual(mergeInfo("claude", { model: "claude-fable-5-1", effort: "xhigh", mode: "bypassPermissions" }, { effort: "low" }, nameOf),
    { model: "claude-fable-5-1", name: "Fable 5.1", effort: "xhigh", mode: "bypass permissions" }, "/effort and /model are in the transcript at once");
  assert.equal(mergeInfo("claude", { mode: "bypassPermissions" }, { mode: "plan mode" }, nameOf).mode, "plan mode",
    "Shift+Tab reaches the transcript only with the next prompt: the screen's mode line wins");
  assert.equal(mergeInfo("claude", { mode: "auto" }, { mode: "default" }, nameOf).mode, "default", "a footer with no mode line is the default mode");
  assert.deepEqual(mergeInfo("claude", {}, { model: "Opus 5", effort: "medium" }, nameOf), { model: "Opus 5", name: "Opus 5", effort: "medium" },
    "no transcript: the screen; a picker over the footer says nothing about the mode");
  assert.deepEqual(mergeInfo("claude", { model: "claude-opus-5" }, null, nameOf), { model: "claude-opus-5", name: "Opus 5" }, "no screen: no guess at the mode");
  assert.deepEqual(mergeInfo("codex", { model: "gpt-9-nova", effort: "xhigh", mode: "plan", access: "full access", fast: false }, { model: "gpt-9-mini", fast: true }, nameOf),
    { model: "gpt-9-mini", name: "GPT-9-Mini", effort: "xhigh", fast: true, mode: "plan", access: "full access" },
    "Codex writes a /model or /fast into its file only when the next turn starts: its status line is newer");
  assert.deepEqual(mergeInfo("codex", { model: "gpt-9-mini", fast: true }, { model: "gpt-9-mini", effort: "low" }, nameOf), { model: "gpt-9-mini", name: "GPT-9-Mini", effort: "low" },
    "a status line without \"fast\": fast mode is off");
  assert.deepEqual(mergeInfo("codex", { model: "gpt-9-mini", fast: true }, {}, nameOf), { model: "gpt-9-mini", name: "GPT-9-Mini", fast: true }, "no status line: the file");
  assert.deepEqual(["default", "plan", "acceptEdits", "bypassPermissions", "auto"].map(claudeMode), ["default", "plan mode", "accept edits", "bypass permissions", "auto mode"]);
});

// ---- through the phone's API ----
const PROJ = "11111111-aaaa-4aaa-8aaa-111111111111", WS = "22222222-bbbb-4bbb-8bbb-222222222222";
const CLAUDE_RO = "0c0ffee0-1111-4222-8333-444455556666", CLAUDE_T = "0c0ffee0-1111-4222-8333-777777777777";
const CODEX_RO = "01a0b000-0000-7000-8000-00000000abcd", CODEX_DONE = "01a0b000-0000-7000-8000-00000000dcba";

async function serve(sessions, h, screen) {
  const store = createStore(tempDir());
  const calls = [];
  const app = createServer({ store, log: () => {}, homeDir: h.d, claudeDir: h.claudeDir, codexHome: h.codexHome, claudeProjects: path.join(h.claudeDir, "projects"),
    knownSessions: () => sessions, getQueue: () => [], dequeue: () => 0, hasSuperset: () => true, typeGap: () => 0,
    superset: async (args) => {
      calls.push(args);
      if (args[0] === "projects") return J([{ id: PROJ, name: "Shop" }]);
      if (args[0] === "workspaces") return J([{ id: WS, projectId: PROJ, name: "main", branch: "main", type: "main" }]);
      if (args[0] === "agents") return J([{ presetId: "claude", label: "Claude" }, { presetId: "codex", label: "Codex" }]);
      if (args[1] === "read") return J({ text: screen });
      return "{}";
    } });
  await new Promise((ok) => app.server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, p, body, token) => {
    const res = await fetch(base + p, { method, body: body ? J(body) : undefined,
      headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(body ? { "Content-Type": "application/json" } : {}) } });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const token = (await call("POST", "/api/pair", { code: store.newCode().code })).json.token;
  return { calls, get: (p) => call("GET", p, undefined, token), post: (p, b) => call("POST", p, b, token), close: () => app.server.close() };
}

test("read-only sessions still show model, effort, mode and working or idle, from their files and the hooks", async () => {
  const h = homes({ cache: fixture("codex-models_cache.json") });
  const proj = path.join(h.claudeDir, "projects", "-Users-someone-proj");
  fs.mkdirSync(proj, { recursive: true });
  const transcript = path.join(proj, CLAUDE_RO + ".jsonl");
  fs.writeFileSync(transcript, fixture("claude-transcript.jsonl"));
  const day = path.join(h.codexHome, "sessions", "2026", "09", "15");
  fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-2026-09-15T09-00-00-${CODEX_RO}.jsonl`);
  fs.writeFileSync(rollout, fixture("codex-rollout.jsonl"));
  const doneFile = path.join(day, `rollout-2026-09-15T09-00-00-${CODEX_DONE}.jsonl`);
  fs.writeFileSync(doneFile, fixture("codex-rollout.jsonl").split("\n").slice(0, 7).join("\n") + "\n");     // up to task_complete
  const now = Math.floor(Date.now() / 1000);
  const claude = { session_id: CLAUDE_RO, bridge_id: "local:" + CLAUDE_RO, agent: "claude", title: "ro", cwd: "/Users/someone/proj", transcript,
                   pid: process.pid, started: ME, last_seen: now, working_since: Date.now() - 185000 };
  const sessions = [claude,
    { session_id: CODEX_RO, bridge_id: "codex:" + CODEX_RO, agent: "codex", title: "cx", transcript: rollout, pid: process.pid, started: ME, last_seen: now },
    { session_id: CODEX_DONE, bridge_id: "codex:" + CODEX_DONE, agent: "codex", title: "cx2", transcript: doneFile, pid: process.pid, started: ME, last_seen: now,
      working_since: Date.now() - 5000 }];
  const s = await serve(sessions, h, "");
  try {
    let d = (await s.get("/api/screen?id=" + CLAUDE_RO)).json;
    assert.equal(d.can.bridge, null, "no terminal");
    assert.deepEqual(d.info, { model: "claude-fable-5-1", name: "Fable 5.1", effort: "xhigh", mode: "bypass permissions" });
    assert.equal(d.live.state, "working", "the hooks say a prompt started a turn");
    assert.match(d.live.elapsed, /^3m 0\ds$/);
    claude.working_since = Date.parse("2026-09-15T10:02:05.000Z");
    d = (await s.get("/api/screen?id=" + CLAUDE_RO)).json;
    assert.equal(d.live.state, "idle", "interrupted after that prompt (no hook fires then): the transcript says so");
    claude.working_since = 0;
    assert.equal((await s.get("/api/screen?id=" + CLAUDE_RO)).json.live.state, "idle", "Stop ended it");
    claude.started = ME - 60;
    d = (await s.get("/api/screen?id=" + CLAUDE_RO)).json;
    assert.equal(d.live, null, "its agent has exited: neither");
    assert.equal(d.info.name, "Fable 5.1", "what it ran with is still there");
    claude.started = ME;

    d = (await s.get("/api/screen?id=" + CODEX_RO)).json;
    assert.deepEqual(d.info, { model: "gpt-9-nova", name: "GPT-9-Nova", effort: "xhigh", fast: true, mode: "plan", access: "full access" },
      "the settings applied after the last turn, named from Codex's own list");
    assert.equal(d.live.state, "working", "a turn started and hasn't finished in its file");
    d = (await s.get("/api/screen?id=" + CODEX_DONE)).json;
    assert.equal(d.live.state, "idle", "the file knows the turn finished, whatever the hooks last said");
    assert.deepEqual([d.info.model, d.info.effort, d.info.access], ["gpt-9-mini", "medium", "asks first"]);
  } finally { s.close(); }
});

test("Codex: settings from before a long tail are found, reading back for them alone", async () => {
  const h = homes({ cache: fixture("codex-models_cache.json") });
  const ID = "01a0b000-0000-7000-8000-00000000eeee";
  const head = fixture("codex-rollout.jsonl").split("\n").slice(0, 3);          // session_meta, task_started, turn_context
  const big = J({ timestamp: "2026-09-15T09:00:02.000Z", type: "response_item", payload: { type: "function_call_output", output: "z".repeat(200000) } });
  const step = (i) => J({ timestamp: "2026-09-15T09:10:00.000Z", type: "event_msg", payload: { type: "item_completed", thread_id: ID, turn_id: "t1",
    item: { type: "AgentMessage", id: "m" + i, phase: "commentary", content: [{ type: "Text", text: "step " + i }] } } });
  const day = path.join(h.codexHome, "sessions", "2026", "09", "15");
  fs.mkdirSync(day, { recursive: true });
  const file = path.join(day, `rollout-2026-09-15T09-00-00-${ID}.jsonl`);
  fs.writeFileSync(file, [...head, ...Array(30).fill(big), ...Array.from({ length: 45 }, (_, i) => step(i))].join("\n") + "\n");
  const s = await serve([{ session_id: ID, bridge_id: "codex:" + ID, agent: "codex", title: "long", transcript: file, pid: process.pid, started: ME, last_seen: 1e10 }], h, "");
  try {
    const d = (await s.get("/api/screen?id=" + ID)).json;
    assert.ok(d.items.length >= 40, "the tail holds the conversation");
    assert.deepEqual(d.info, { model: "gpt-9-mini", name: "GPT-9-Mini", effort: "medium", access: "asks first" }, "the turn_context 6 MB back");
  } finally { s.close(); }
});

test("a transcript bigger than its tail, or a broken one, still answers", async () => {
  const h = homes();
  const proj = path.join(h.claudeDir, "projects", "-p");
  fs.mkdirSync(proj, { recursive: true });
  const filler = J({ type: "attachment", uuid: "f", attachment: { type: "filler", content: "y".repeat(1000) } }) + "\n";
  const big = path.join(proj, CLAUDE_RO + ".jsonl");
  const pad = filler.repeat(Math.ceil((5 * 1024 * 1024) / filler.length));
  fs.writeFileSync(big, pad + fixture("claude-transcript.jsonl"));
  const early = path.join(proj, CLAUDE_T + ".jsonl");
  fs.writeFileSync(early, fixture("claude-transcript.jsonl") + pad + "{ half a line");
  const rec = (sid, transcript) => ({ session_id: sid, bridge_id: "local:" + sid, agent: "claude", title: "t", transcript, pid: process.pid, started: ME, last_seen: 1e10 });
  const s = await serve([rec(CLAUDE_RO, big), rec(CLAUDE_T, early)], h, "");
  try {
    assert.equal((await s.get("/api/screen?id=" + CLAUDE_RO)).json.info.name, "Fable 5.1", "the latest settings are at the end, in the tail");
    const r = await s.get("/api/screen?id=" + CLAUDE_T);
    assert.equal(r.status, 200);
    assert.equal(r.json.info, undefined, "settings only before the tail: nothing is made up");
    assert.equal(r.json.live.state, "idle");
  } finally { s.close(); }
});

test("Controls and New offer the agents' own lists, and take nothing else", async () => {
  const h = homes({ catalog: fixture("claude-model-catalog.json"), cache: fixture("codex-models_cache.json") });
  const inTerminal = { session_id: CLAUDE_T, bridge_id: "local:" + CLAUDE_T, agent: "claude", title: "t", pid: process.pid, started: ME, last_seen: 1e10,
                       terminal: "term-1", workspace: "ws-1" };
  const s = await serve([inTerminal], h, "❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)");
  try {
    const m = (await s.get("/api/models")).json;
    assert.deepEqual([m.claude.from, m.codex.from], ["claude code", "codex"]);
    assert.deepEqual(m.claude.models[0], { id: "claude-nova-6", name: "Nova 6", efforts: ["low", "medium", "high", "max"] });
    assert.deepEqual((await s.get("/api/screen?id=" + CLAUDE_T)).json.info, { mode: "accept edits" }, "no transcript: the screen's mode line");

    const sent = () => s.calls.filter((a) => a[1] === "send").map((a) => a[7]).filter(Boolean);
    assert.equal((await s.post("/api/command", { id: CLAUDE_T, cmd: "model", arg: "claude-nova-6" })).status, 200);
    assert.equal((await s.post("/api/command", { id: CLAUDE_T, cmd: "model", arg: "default" })).status, 200);
    for (const arg of ["opus", "claude-nova-6; rm -rf ~", "claude-nova-7"]) {
      assert.equal((await s.post("/api/command", { id: CLAUDE_T, cmd: "model", arg })).json.error, "bad_arg", arg);
    }
    assert.deepEqual(sent(), ["/model claude-nova-6", "/model default"], "only names from the list are typed");

    const o = (await s.get("/api/new/options")).json;
    assert.deepEqual(o.models.codex.map((x) => x.id), ["gpt-9-mini", "gpt-9-nova", "gpt-9-tiny"]);
    assert.deepEqual(o.efforts.claude, ["low", "medium", "high", "max"]);
    const start = (body) => s.post("/api/new", { workspace: WS, prompt: "go", ...body });
    assert.equal((await start({ agent: "codex", model: "gpt-9-mini", effort: "high" })).status, 200);
    assert.deepEqual(s.calls.at(-1).slice(6, 10), ["--model", "gpt-9-mini", "--effort", "high"]);
    assert.equal((await start({ agent: "codex", effort: "ultra" })).status, 200, "no model picked: any level the agent offers");
    for (const body of [{ agent: "codex", model: "gpt-9-mini", effort: "xhigh" }, { agent: "codex", model: "codex-auto-review" },
                        { agent: "claude", model: "claude-wren-5-20260101", effort: "low" }, { agent: "claude", model: "opus" }, { agent: "claude", effort: "ultra" }]) {
      assert.equal((await start(body)).status, 400, J(body));
    }
  } finally { s.close(); }
});

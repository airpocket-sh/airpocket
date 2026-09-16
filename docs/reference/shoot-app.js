"use strict";
// Every screen of the design pack, from the real app against stand-in Macs, at
// 390x844, 375x667 and 430x932 (scale 2), with checks on each shot:
//
//   no horizontal scroll;
//   every control reachable in a 44px target (its own box, or a hit area around it);
//   nothing tappable under the status bar or the home indicator (safe areas set to the phone's);
//   the content glass meets the top strip and the deck exactly, so no bare map shows between them.
//
// Three throwaway Airpocket servers on loopback, each with a temporary pairing
// store, invented sessions and a stand-in Superset that only returns screens:
// nothing reaches a real terminal, a real session or the user's files.
//
//   node docs/reference/shoot-app.js <out dir> [only-this-screen]
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { launch, sleep } = require("./cdp");
const { createServer } = require("../../src/server");
const { createStore } = require("../../src/store");
const { startTimeOf, processInfo } = require("../../src/proc");

const OUT = path.resolve(process.argv[2] || path.join(os.tmpdir(), "airpocket-shots"));
const ONLY = process.argv[3] || "";
const ME = startTimeOf(process.pid);
const J = (o) => JSON.stringify(o);
const T = fs.mkdtempSync(path.join(os.tmpdir(), "airpocket-shoot-"));
const now = Math.floor(Date.now() / 1000);
const SIZES = [
  { name: "390x844", w: 390, h: 844, top: 47, bottom: 34 },
  { name: "375x667", w: 375, h: 667, top: 20, bottom: 0 },
  { name: "430x932", w: 430, h: 932, top: 59, bottom: 34 },
];

// ---- a home with a project, and the agents' own model lists ----------------------------------------
const HOME = path.join(T, "home"), ROOT = path.join(HOME, "shop-web");
const put = (rel, data) => { const p = path.join(ROOT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
const fixture = [
  "import { Cart } from '../../src/cart'", "import { regionalTax } from '../../src/tax'", "",
  "export function cartFixture(region = 'EU'): Cart {", "  const items = [", "    { sku: 'tee-01', qty: 2, unit: 1900 },", "    { sku: 'cap-03', qty: 1, unit: 2400 },", "  ]",
  "  const subtotal = items.reduce((s, i) => s + i.qty * i.unit, 0)", "  return {", "    items,", "    subtotal,", "    tax: regionalTax(subtotal, region),", "  }", "}", "",
  "// Kept for the legacy checkout suite; the new factory in cart.factory.ts builds the same cart with the tax rules applied per region.",
  ...Array.from({ length: 44 }, (_, i) => `export const fixture${i + 1} = cartFixture(${i % 2 ? "'US'" : "'EU'"})`)].join("\n") + "\n";
const F = {
  fixture: put("tests/fixtures/cart.fixture.ts", fixture),
  spec: put("tests/checkout.spec.ts", "describe('checkout', () => {\n  it('adds tax', () => {})\n})\n".repeat(20)),
  rules: put("docs/TAX-RULES.md", "# Tax rules\n\nRegional tax applies to the **subtotal**.\n"),
  pdf: put("docs/legal/vat-notice-2026.pdf", "%PDF-1.7\n" + "x".repeat(800000) + "\n%%EOF\n"),
  shot: put("shots/checkout-after.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(900, 1)])),
  changelog: put("CHANGELOG.md", "# 2.4.0\n"),
};
function homes(name) {
  const claudeDir = path.join(T, name, ".claude"), codexHome = path.join(T, name, ".codex");
  fs.mkdirSync(path.join(claudeDir, "cache", "model-catalog"), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, "projects", "-shop-web"), { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  const levels = (ids) => ({ type: "effort", effort_options: ids.map((id) => ({ id, name: id })) });
  fs.writeFileSync(path.join(claudeDir, "cache", "model-catalog", "0000aaaa-1111-2222-3333-444455556666-cc.json"), J({ version: 2, catalog: { surface: "cc", config: { id: "cc", models: [
    { id: "claude-fable-5-1", name: "Fable 5.1", section: "main", thinking: levels(["low", "medium", "high", "xhigh", "max"]) },
    { id: "claude-opus-5", name: "Opus 5", section: "main", thinking: levels(["low", "medium", "high", "xhigh", "max"]) },
    { id: "claude-sonnet-5", name: "Sonnet 5", section: "main", thinking: levels(["low", "medium", "high", "xhigh", "max"]) },
    { id: "claude-haiku-4-5", name: "Haiku 4.5", section: "main", thinking: { type: "none" } }] } } }));
  fs.writeFileSync(path.join(codexHome, "models_cache.json"), J({ models: [
    { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list", priority: 1, supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map((effort) => ({ effort })) },
    { slug: "gpt-6", display_name: "GPT-6", visibility: "list", priority: 2, supported_reasoning_levels: ["low", "medium", "high"].map((effort) => ({ effort })) }] }));
  return { claudeDir, codexHome, projects: path.join(claudeDir, "projects") };
}

// ---- transcripts ----------------------------------------------------------------------------------
let uid = 0;
const cl = { user: (text, at) => J({ type: "user", uuid: "u" + ++uid, timestamp: at, cwd: ROOT, permissionMode: "acceptEdits", message: { role: "user", content: text } }),
  say: (text, model = "claude-opus-5", effort = "high") => J({ type: "assistant", uuid: "a" + ++uid, effort, message: { id: "m" + uid, model, role: "assistant", content: [{ type: "text", text }] } }),
  tool: (name, input, model = "claude-opus-5") => J({ type: "assistant", uuid: "a" + ++uid, effort: "high", message: { id: "m" + uid, model, role: "assistant", content: [{ type: "tool_use", id: "t" + uid, name, input }] } }),
  done: () => J({ type: "system", subtype: "turn_duration", durationMs: 4000, uuid: "s" + ++uid }) };
function claudeSession(h1, id, lines) { const p = path.join(h1.projects, "-shop-web", id + ".jsonl"); fs.writeFileSync(p, lines.join("\n") + "\n"); return p; }
function codexSession(h1, id, lines) {
  const d = path.join(h1.codexHome, "sessions", "2026", "09", "16");
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, `rollout-2026-09-16T09-00-00-${id}.jsonl`);
  fs.writeFileSync(p, lines.map(J).join("\n") + "\n");
  return p;
}
const ev = (payload, id) => ({ timestamp: "2026-09-16T09:00:00.000Z", type: "event_msg", payload: payload.item ? { type: "item_completed", thread_id: id, turn_id: "t1", ...payload } : payload });
const ctx = (model, effort) => ({ timestamp: "2026-09-16T09:00:00.100Z", type: "turn_context", payload: { turn_id: "t1", cwd: ROOT, approval_policy: "on-request",
  sandbox_policy: { type: "workspace-write", writable_roots: [ROOT] }, model, effort, collaboration_mode: { mode: "default", settings: { model, reasoning_effort: effort } } } });
const fast = (model, effort) => ({ timestamp: "2026-09-16T09:05:00.000Z", type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { model, service_tier: "priority",
  reasoning_effort: effort, approval_policy: "on-request", collaboration_mode: { mode: "default", settings: { model, reasoning_effort: effort } } } } });

// ---- three Macs --------------------------------------------------------------------------------------
const ID = { perm: "0c0ffee0-0000-4000-8000-000000000001", work: "0c0ffee0-0000-4000-8000-000000000002", notes: "0c0ffee0-0000-4000-8000-000000000003",
  ended: "0c0ffee0-0000-4000-8000-000000000004", old: "0c0ffee0-0000-4000-8000-000000000005",
  billing: "01a0b000-0000-7000-8000-000000000001", images: "01a0b000-0000-7000-8000-000000000002", imagesOld: "01a0b000-0000-7000-8000-000000000003" };
const SCREENS = {
  perm: ["● Update(tests/fixtures/cart.fixture.ts)", "  ⎿  Updated with 14 additions and 6 removals", "",
    "╭───────────────────────────────────────────────────────────────╮", "│ Bash command                                                  │", "│   npm test -- checkout                                        │",
    "│ Do you want to proceed?                                       │", "│ ❯ 1. Yes                                                      │", "│   2. Yes, and don't ask again for npm test commands            │",
    "│   3. No, and tell Claude what to do differently (esc)          │", "╰───────────────────────────────────────────────────────────────╯"].join("\n"),
  working: ["● Read(src/auth/session.ts)", "● Edit(src/auth/session.ts)", "  Replaced the cookie parser with the shared helper.", "", "✻ Working… (3m 12s · esc to interrupt)", "",
    "╭──────────────────────────────────────────╮", "│ ❯                                          │", "╰──────────────────────────────────────────╯", "  ⏵⏵ accept edits on (shift+tab to cycle)"].join("\n"),
  typed: ["● Read src/auth/session.ts (212 lines)", "● Edit src/auth/session.ts", "  Replaced the cookie parser with the shared", "  helper and removed the duplicated expiry check.",
    "● Bash(npm run typecheck)", "  src/auth/middleware.ts:41:7 - error TS2345:", "  Argument of type 'string | undefined' is not", "  assignable to parameter of type 'string'.", "  Found 1 error.",
    "✻ Thought for 4s", "  The middleware still passes the raw header. I'll narrow it before the call.", "● Edit src/auth/middleware.ts", "",
    "╭──────────────────────────────────────────╮", "│ ❯ run the auth tests only                  │", "╰──────────────────────────────────────────╯", "  ? for shortcuts                ⏵⏵ accept edits on"].join("\n"),
  codex: ["› Migrate the billing webhooks to v2.", "", "• Which Stripe API version should I target?", "", "› Ask Codex to do anything", "", "  gpt-6-astra xhigh · ~/shop-web"].join("\n"),
};
const screens = { "t-perm": SCREENS.perm, "t-work": SCREENS.working, "t-cx": SCREENS.codex };

function mac(name, sessions, queue, { superset = true, delay = 0, unseen = 0, tag = "" } = {}) {
  const h1 = homes(name.replace(/\W/g, "") + tag);
  const store = createStore(path.join(T, name.replace(/\W/g, "") + tag + "-store"));
  const sent = [];
  const app = createServer({ store, log: () => {}, hostLabel: name, homeDir: HOME, claudeDir: h1.claudeDir, codexHome: h1.codexHome, claudeProjects: h1.projects,
    knownSessions: () => sessions, getQueue: () => queue, dequeue: () => 0, hasSuperset: () => superset, typeGap: () => 0, unseenAgents: () => unseen,
    fileBase: async () => "http://127.0.0.1:47999",
    // This process stands in for every agent, in the foreground of a stand-in terminal.
    inspectAgent: (pid) => { const i = processInfo(pid); return i && { ...i, tty: "ttys990", pgid: 9, tpgid: 9 }; },
    superset: async (args) => {
      if (args[0] === "projects") return J([{ id: "11111111-aaaa-4aaa-8aaa-111111111111", name: "shop-web" }, { id: "11111111-aaaa-4aaa-8aaa-222222222222", name: "billing" }]);
      if (args[0] === "workspaces") return J([{ id: "22222222-bbbb-4bbb-8bbb-222222222222", projectId: "11111111-aaaa-4aaa-8aaa-111111111111", name: "main", branch: "main", type: "main" }]);
      if (args[0] === "agents") return J([{ presetId: "claude", label: "Claude" }, { presetId: "codex", label: "Codex" }, { presetId: "gemini", label: "Gemini" }]);
      if (args[1] === "read") return J({ text: screens[args[args.indexOf("--terminal") + 1]] || "" });
      if (args[1] === "send") sent.push(args[args.indexOf("--text") + 1]);
      return "{}";                                              // typing and keys go nowhere
    } });
  if (delay) {
    const inner = app.server.listeners("request")[0];
    app.server.removeAllListeners("request");
    app.server.on("request", (req, res) => { if (req.url.startsWith("/api/sessions")) setTimeout(() => inner(req, res), delay); else inner(req, res); });
  }
  return { name, h: h1, store, app, sessions, queue, sent };
}

const S = mac("Studio", [], []);
const A = mac("MacBook Air", [], []);
const M = mac("Mini", [], [], { superset: false });
const E = mac("Studio", [], [], { superset: false });          // one Mac, nothing running, some earlier
const SLOW = mac("Studio", [], [], { delay: 60000 });
// Agents that haven't checked in: none on the list, then a list with rows; the first also has Codex hooks not trusted yet.
const U = mac("Studio", [], [], { superset: false, unseen: 3, tag: "-unseen" });
const UO = mac("Studio", S.sessions, S.queue, { unseen: 1, tag: "-unseen1" });
{
  const cfg = require("../../src/agentconfig");
  fs.mkdirSync(U.h.codexHome, { recursive: true });
  fs.writeFileSync(path.join(U.h.codexHome, "hooks.json"), J(cfg.addHooks({}, "codex", cfg.hookCommand({ node: "/n", hook: "/h", agent: "codex" })).config));
}

S.sessions.push(
  { session_id: ID.perm, bridge_id: "session_perm", agent: "claude", title: "Fix checkout tests", branch: "fix/checkout", cwd: ROOT, pid: process.pid, started: ME, last_seen: now - 120, terminal: "t-perm", workspace: "w1",
    transcript: claudeSession(S.h, ID.perm, [
      cl.user("Fix the failing checkout tests. Don't touch the pricing module.", "2026-09-16T11:28:00Z"),
      cl.say("Two tests fail because the cart fixture predates the tax change. I'll update the fixture and re-run the suite."),
      cl.tool("Bash", { command: "npm test -- checkout", description: "Run the checkout tests" }), cl.tool("Edit", { file_path: F.fixture, old_string: "a", new_string: "b" }),
      cl.tool("Edit", { file_path: F.spec, old_string: "a", new_string: "b" }),
      cl.say("The fixture is updated, see `tests/fixtures/cart.fixture.ts` and `docs/TAX-RULES.md`. The notice is in `docs/legal/vat-notice-2026.pdf`. Before I run the suite I need to run a shell command."),
    ]) },
  { session_id: ID.billing, bridge_id: "codex:" + ID.billing, agent: "codex", title: "Migrate billing webhooks", branch: "feat/webhooks-v2", cwd: ROOT, pid: process.pid, started: ME, last_seen: now - 540, terminal: "t-cx", workspace: "w2",
    transcript: codexSession(S.h, ID.billing, [{ timestamp: "2026-09-16T09:00:00.000Z", type: "session_meta", payload: { id: ID.billing, cwd: ROOT } }, ev({ type: "task_started", turn_id: "t1" }), ctx("gpt-6-astra", "xhigh"),
      ev({ item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "Migrate the billing webhooks to v2." }] } }, ID.billing),
      ev({ item: { type: "AgentMessage", id: "a1", phase: "final_answer", content: [{ type: "Text", text: "Which Stripe API version should I target?" }] } }, ID.billing),
      ev({ type: "task_complete", turn_id: "t1" }), fast("gpt-6-astra", "xhigh")]) },
  { session_id: ID.work, bridge_id: "session_work", agent: "claude", title: "Refactor auth", branch: "refactor/auth", cwd: ROOT, pid: process.pid, started: ME, last_seen: now - 5, terminal: "t-work", workspace: "w3",
    working_since: Date.now() - 192000,
    transcript: claudeSession(S.h, ID.work, [
      cl.user("Fix the failing checkout tests. Don't touch the pricing module.", "2026-09-16T11:28:00Z"),
      cl.say("Two tests fail because the cart fixture predates the tax change. I'll update the fixture and re-run the suite."),
      cl.tool("Bash", { command: "npm test -- checkout", description: "npm test -- checkout" }), cl.tool("Bash", { command: "npm run lint", description: "npm run lint" }),
      cl.tool("Edit", { file_path: F.fixture, old_string: "a", new_string: "b" }), cl.tool("Edit", { file_path: F.spec, old_string: "a", new_string: "b" }),
      cl.say("Updated `tests/fixtures/cart.fixture.ts` and `tests/checkout.spec.ts`."),
      cl.say("Re-running the suite now."),
    ]) },
  { session_id: ID.old, bridge_id: "session_old", agent: "claude", title: "Fix flaky login test", branch: "fix/login", cwd: ROOT, pid: process.pid, started: ME - 60, last_seen: now - 86000 },
);
S.queue.push({ id: "session_perm", sid: ID.perm, kind: "input", reason: "needs permission", message: "Claude needs your permission to use Bash" },
  { id: "codex:" + ID.billing, sid: ID.billing, kind: "input", reason: "waiting for you", message: "Which Stripe API version should I target?" });

A.sessions.push(
  { session_id: ID.notes, bridge_id: "session_notes", agent: "claude", title: "Write release notes", branch: "main", cwd: ROOT, pid: process.pid, started: ME, last_seen: now - 2460,
    transcript: claudeSession(A.h, ID.notes, [cl.user("Draft the 2.4.0 release notes from the merged PRs.", "2026-09-16T11:02:00Z"), cl.say("Drafted CHANGELOG.md for 2.4.0.", "claude-sonnet-5", "medium"), cl.done()]) },
  { session_id: ID.ended, bridge_id: "session_ended", agent: "claude", title: "Write release notes", branch: "main", cwd: ROOT, pid: process.pid, started: ME - 60, last_seen: now - 3000,
    transcript: claudeSession(A.h, ID.ended, [
      J({ type: "user", uuid: "c1", timestamp: "2026-09-16T10:50:00Z", message: { role: "user", content: "<command-name>/compact</command-name><command-args></command-args>" } }),
      cl.user("Draft the 2.4.0 release notes from the merged PRs.", "2026-09-16T10:58:00Z"),
      cl.say("## 2.4.0 highlights\n\n- Webhooks are retried with backoff ([#412](https://github.com/example/shop/pull/412))\n- Checkout totals include regional tax\n- New `--dry-run` flag for migrations\n\n| Area | PRs |\n| --- | --- |\n| Billing | 4 |\n| Checkout | 3 |\n\nSaved to `CHANGELOG.md`.", "claude-sonnet-5", "medium"),
      J({ type: "user", uuid: "i1", message: { role: "user", content: "[Request interrupted by user]" } }),
    ]) },
);
A.queue.push({ id: "session_notes", sid: ID.notes, kind: "done", reason: "finished", message: "Drafted CHANGELOG.md for 2.4.0." });

M.sessions.push(
  { session_id: ID.images, bridge_id: "codex:" + ID.images, agent: "codex", title: "Profile image pipeline", branch: "perf/images", cwd: ROOT, pid: process.pid, started: ME, last_seen: now - 3600,
    transcript: codexSession(M.h, ID.images, [{ timestamp: "2026-09-16T09:00:00.000Z", type: "session_meta", payload: { id: ID.images, cwd: ROOT } }, ev({ type: "task_started", turn_id: "t1" }), ctx("gpt-6-astra", "xhigh"),
      ev({ item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "Profile the image pipeline." }] } }, ID.images), ev({ type: "task_complete", turn_id: "t1" }), fast("gpt-6-astra", "xhigh")]) });

E.sessions.push(
  { session_id: ID.old, bridge_id: "session_old", agent: "claude", title: "Fix checkout tests", branch: "fix/checkout", cwd: ROOT, pid: process.pid, started: ME - 60, last_seen: now - 86400 },
  { session_id: ID.imagesOld, bridge_id: "codex:" + ID.imagesOld, agent: "codex", title: "Profile image pipeline", branch: "perf/images", cwd: ROOT, pid: process.pid, started: ME - 60, last_seen: now - 3 * 86400 });

// ---- run ------------------------------------------------------------------------------------------------
const listen = (srv) => new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv.address().port)));
const post = (port, p, body) => new Promise((ok, bad) => {
  const data = Buffer.from(J(body));
  const r = http.request({ host: "127.0.0.1", port, path: p, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": data.length } },
    (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => ok(JSON.parse(b))); });
  r.on("error", bad); r.end(data);
});

// In the page: the checks each shot must pass.
const CHECKS = `(() => {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;left:0;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)";
  document.body.append(probe);
  const cs = getComputedStyle(probe), top = parseFloat(cs.paddingTop) || 0, bottom = parseFloat(cs.paddingBottom) || 0;
  probe.remove();
  const out = { hscroll: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1, small: [], unsafe: [], glass: [], insets: [top, bottom] };
  const label = (el) => (el.getAttribute("aria-label") || el.textContent || el.placeholder || el.tagName).trim().replace(/\\s+/g, " ").slice(0, 40);
  for (const el of document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=tab]")) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
    const cx = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1), cy = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
    const at = document.elementFromPoint(cx, cy);
    if (!at || !(el === at || el.contains(at) || (el.tagName === "INPUT" && at.closest && at.closest(".digits") && el.closest(".digits")))) continue;   // covered: not reachable now
    if (el.disabled) continue;
    const inline = el.tagName === "A" && el.closest(".msg");                 // a link inside reading text keeps the text's own line height
    if (!inline && (r.width < 44 || r.height < 44)) {
      const pts = [[cx, cy - 21], [cx, cy + 21], [cx - 21, cy], [cx + 21, cy]];
      const miss = pts.filter(([x, y]) => { const hit = document.elementFromPoint(x, y); return !hit || !(el === hit || el.contains(hit)); });
      if (miss.length) out.small.push(label(el) + " " + Math.round(r.width) + "x" + Math.round(r.height));
    }
    if (cy < top || cy > innerHeight - bottom) out.unsafe.push(label(el) + " at " + Math.round(cy));
  }
  const g = document.getElementById("glass"), bar = document.getElementById("bar"), deck = document.getElementById("deck");
  if (g && g.classList.contains("on")) {
    const gr = g.getBoundingClientRect(), br = bar.getBoundingClientRect(), dr = deck.getBoundingClientRect();
    const barBottom = bar.offsetHeight ? br.bottom : top;
    if (Math.abs(gr.top - barBottom) > 1) out.glass.push("glass top " + Math.round(gr.top) + " vs strip " + Math.round(barBottom));
    const deckTop = deck.offsetHeight ? dr.top : innerHeight;
    if (Math.abs(gr.bottom - deckTop) > 1) out.glass.push("glass bottom " + Math.round(gr.bottom) + " vs deck " + Math.round(deckTop));
  }
  return out;
})()`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const macs = [S, A, M, E, SLOW, U, UO];
  for (const m of macs) {
    m.port = await listen(m.app.server);
    m.base = "http://127.0.0.1:" + m.port;
    m.token = (await post(m.port, "/api/pair", { code: m.store.newCode().code, name: "Kim's iPhone" })).token;
  }
  const closed = http.createServer();
  const deadPort = await listen(closed);
  await new Promise((ok) => closed.close(ok));
  const dead = "http://127.0.0.1:" + deadPort;
  const host = (m, base, id, name) => ({ id, name: name || m.name, base, token: m.token, deviceId: "d" + id });

  // The app is always opened from a Mac whose origin the phone storage belongs to; the others are reached by address.
  const FAKE_Y4M = process.env.CAMERA_Y4M || "";
  const chrome = await launch({ width: 390, height: 844, scale: 2, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
    ...(FAKE_Y4M ? ["--use-file-for-fake-video-capture=" + FAKE_Y4M] : [])] });
  const { cmd, js } = chrome;
  let standaloneScript = null;
  const standalone = async (on) => {
    if (standaloneScript) { await cmd("Page.removeScriptToEvaluateOnNewDocument", { identifier: standaloneScript }); standaloneScript = null; }
    if (on) standaloneScript = (await cmd("Page.addScriptToEvaluateOnNewDocument", { source: "Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true })" })).identifier;
  };
  const report = [];
  const click = (selector, text) => js(`(() => { const els = [...document.querySelectorAll(${J(selector)})]; const el = ${text ? `els.find((e) => e.textContent.trim().replace(/\\s+/g, " ").includes(${J(text)}))` : "els[0]"}; if (!el) return false; el.click(); return true; })()`);
  const typeInto = (selector, value) => js(`(() => { const el = document.querySelector(${J(selector)}); el.focus(); el.value = ${J(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);

  // origin: which Mac serves the page; hosts: what the phone has paired; prefs; then the steps.
  const SCENES = [
    { name: "1a-first-run", installed: false, origin: S, hosts: [], hash: "#/" },
    { name: "2b-pair-code", origin: S, hosts: [], hash: "#/", steps: async () => { await typeInto(".digits input", "4812"); } },
    { name: "2b-pair-wrong-code", origin: S, hosts: [], hash: "#/", steps: async () => {
      S.store.newCode(); await typeInto(".digits input", "481207"); await click(".btn.wide", "Pair"); await sleep(900);
      await typeInto(".page input.input", "Kim's iPhone"); } },
    { name: "2a-pair-scan", origin: S, hosts: [], hash: "#/", steps: async () => { await click(".btn.outline", "Scan"); await sleep(1800); } },
    { name: "2c-paired", origin: S, hosts: [], hash: "#/", steps: async () => {
      const { code } = S.store.newCode(); await typeInto(".page input.input", "Kim's iPhone"); await typeInto(".digits input", code); await click(".btn.wide", "Pair"); await sleep(1400); } },
    { name: "3a-sessions", origin: S, hosts: () => [host(S, "", "h1"), host(A, A.base, "h2"), host(M, M.base, "h3")], hash: "#/", wait: 2200 },
    { name: "3b-sessions-empty-offline", origin: E, hosts: () => [host(E, "", "h1"), host(A, dead, "h2", "MacBook Air")], prefs: { showEarlier: true }, hash: "#/", wait: 2600 },
    { name: "3c-sessions-one-mac", origin: S, hosts: () => [host(S, "", "h1")], hash: "#/", wait: 2200 },
    { name: "3d-sessions-unseen-empty", origin: U, hosts: () => [host(U, "", "h1")], hash: "#/", wait: 2200 },
    { name: "3e-sessions-unseen", origin: UO, hosts: () => [host(UO, "", "h1")], hash: "#/", wait: 2200 },
    { name: "4a-session-working", origin: S, hosts: () => [host(S, "", "h1"), host(A, A.base, "h2")], hash: `#/s/h1/${ID.work}`, wait: 3200, before: () => { screens["t-work"] = SCREENS.working; } },
    { name: "4b-session-question", origin: S, hosts: () => [host(S, "", "h1"), host(A, A.base, "h2")], hash: `#/s/h1/${ID.perm}`, wait: 3200 },
    { name: "4c-session-terminal-typed", origin: S, hosts: () => [host(S, "", "h1"), host(A, A.base, "h2")], prefs: { view: "terminal", wrap: true }, hash: `#/s/h1/${ID.work}`, wait: 3200,
      before: () => { screens["t-work"] = SCREENS.typed; }, after: () => { screens["t-work"] = SCREENS.working; } },
    { name: "4e-send-shell-confirm", origin: S, hosts: () => [host(S, "", "h1")], hash: `#/s/h1/${ID.work}`, wait: 3000, steps: async () => {
      // Keep sends nothing; Run it sends the text as typed; then the dialog again, for the shot.
      const check = (ok, what) => { if (!ok) { console.log("  CHECK " + what); failures++; } };
      S.sent.length = 0;
      await typeInto("textarea.input", "!git push --force"); await click("button.send"); await sleep(400);
      await click(".dialog button", "Keep"); await sleep(300);
      check(S.sent.length === 0 && (await js(`document.querySelector("textarea.input").value`)) === "!git push --force", "Keep sent nothing and kept the text");
      await click("button.send"); await sleep(400); await click(".dialog button", "Run it"); await sleep(800);
      check(S.sent.length === 1 && S.sent[0] === "!git push --force", "Run it sent the command once: " + J(S.sent));
      await typeInto("textarea.input", "git push --force"); await click("button.send"); await sleep(600);
      check(S.sent.length === 2 && !(await js(`!!document.querySelector(".dialog")`)), "a message without \"!\" is sent with no dialog");
      await typeInto("textarea.input", "!git push --force"); await click("button.send"); await sleep(400); } },
    { name: "4d-session-read-only", origin: A, hosts: () => [host(A, "", "h2", "MacBook Air"), host(S, S.base, "h1")], hash: `#/s/h2/${ID.ended}`, wait: 3200 },
    { name: "5a-controls-claude", origin: S, hosts: () => [host(S, "", "h1")], hash: `#/s/h1/${ID.work}`, wait: 3000, steps: async () => {
      await click(".sk", "Controls"); await sleep(500); await click(".opt", "Sonnet 5"); await sleep(400); } },
    { name: "5b-controls-codex-toast", origin: S, hosts: () => [host(S, "", "h1")], hash: `#/s/h1/${ID.billing}`, wait: 3000, steps: async () => {
      await click(".sk", "Controls"); await sleep(400); await click(".opt", "Fast mode"); await sleep(300); await click(".sk", "Controls"); await sleep(500); } },
    { name: "5c-keys-confirm", origin: S, hosts: () => [host(S, "", "h1")], hash: `#/s/h1/${ID.work}`, wait: 3000, steps: async () => {
      await click(".sk", "Keys"); await sleep(600); await click(".cell", "Clear"); await sleep(400); } },
    { name: "5d-controls-ended", origin: S, hosts: () => [host(S, "", "h1")], hash: `#/s/h1/${ID.perm}`, wait: 3000, steps: async () => {
      await click(".sk", "Controls"); await sleep(400);
      S.sessions.find((s) => s.session_id === ID.perm).started = ME - 60;
      await sleep(3200); },
      after: () => { S.sessions.find((s) => s.session_id === ID.perm).started = ME; } },
    { name: "6a-new-session", origin: S, hosts: () => [host(S, "", "h1"), host(A, A.base, "h2")], hash: "#/", wait: 1800, steps: async () => {
      await js(`location.hash = "#/new"`); await sleep(1500); await click(".pair2 .cell", "New branch"); await sleep(200);
      await typeInto(".form textarea", "Add regional tax to checkout totals. Keep the pricing module untouched and add tests."); await typeInto(".form input.mono", "");
      await click(".btn.wide", "Start"); await sleep(300); } },
    { name: "7a-files", origin: S, hosts: () => [host(S, "", "h1")], hash: `#/s/h1/${ID.perm}`, wait: 2600, steps: async () => {
      await click('[aria-label="Files"]'); await sleep(1200); } },
    { name: "7b-file-viewer", origin: S, hosts: () => [host(S, "", "h1")], hash: `#/s/h1/${ID.perm}`, wait: 2600, steps: async () => {
      await click('[aria-label="Files"]'); await sleep(1000); await click(".frow", "cart.fixture.ts"); await sleep(1200); } },
    { name: "7b-pdf-card", origin: S, hosts: () => [host(S, "", "h1")], hash: `#/s/h1/${ID.perm}`, wait: 2600, steps: async () => {
      await click('[aria-label="Files"]'); await sleep(1000); await click(".frow", "vat-notice-2026.pdf"); await sleep(1200); } },
    { name: "8a-macs", origin: S, hosts: () => [host(S, "", "h1"), host(A, dead, "h2", "MacBook Air"), { ...host(M, M.base, "h3"), token: "x".repeat(43) }], hash: "#/hosts", wait: 1800 },
    { name: "8a-macs-remove-confirm", origin: S, hosts: () => [host(S, "", "h1"), host(A, dead, "h2", "MacBook Air"), { ...host(M, M.base, "h3"), token: "x".repeat(43) }], hash: "#/hosts", wait: 1800,
      steps: async () => { await js(`[...document.querySelectorAll(".mac")].pop().querySelector(".hazard-edge").click()`); await sleep(400); } },
    { name: "9a-no-mac-answered", origin: S, hosts: () => [host(S, dead, "h1", "Studio"), host(A, dead, "h2", "MacBook Air"), host(M, dead, "h3", "Mini")], hash: "#/", wait: 2800 },
    { name: "9b-loading", origin: SLOW, hosts: () => [host(SLOW, "", "h1"), host(SLOW, SLOW.base, "h2", "MacBook Air"), host(SLOW, SLOW.base, "h3", "Mini")], hash: "#/", wait: 3000 },
    { name: "L1-launch", origin: SLOW, hosts: () => [host(SLOW, "", "h1")], hash: "#/", wait: 500, noChecks: true },
    { name: "rt-sessions-reduced-transparency", origin: S, hosts: () => [host(S, "", "h1"), host(A, A.base, "h2"), host(M, M.base, "h3")], hash: "#/", wait: 2200, media: [{ name: "prefers-reduced-transparency", value: "reduce" }] },
    { name: "rt-session-reduced-transparency", origin: S, hosts: () => [host(S, "", "h1")], hash: `#/s/h1/${ID.work}`, wait: 3000, media: [{ name: "prefers-reduced-transparency", value: "reduce" }] },
  ];

  let failures = 0;
  for (const size of SIZES) {
    fs.mkdirSync(path.join(OUT, size.name), { recursive: true });
    for (const sc of SCENES) {
      if (ONLY && !sc.name.startsWith(ONLY)) continue;
      await chrome.size(size.w, size.h, 2);
      try { await cmd("Emulation.setSafeAreaInsetsOverride", { insets: { top: size.top, topMax: size.top, bottom: size.bottom, bottomMax: size.bottom, left: 0, leftMax: 0, right: 0, rightMax: 0 } }); } catch {}
      await cmd("Emulation.setEmulatedMedia", { features: sc.media || [] });
      await standalone(sc.installed !== false);
      if (sc.before) sc.before();
      await chrome.go(sc.origin.base + "/manifest.webmanifest", 300);
      await js(`localStorage.clear(); localStorage.setItem("airpocket.hosts.v1", ${J(J(typeof sc.hosts === "function" ? sc.hosts() : sc.hosts))}); localStorage.setItem("airpocket.prefs.v1", ${J(J({ wrap: true, ...(sc.prefs || {}) }))}); true`);
      await chrome.go(sc.origin.base + "/" + sc.hash, sc.wait || 1500);
      if (sc.steps) await sc.steps();
      await js("document.fonts.ready.then(() => true)");
      await sleep(250);
      const file = path.join(OUT, size.name, sc.name + ".png");
      await chrome.shot(file);
      if (process.env.DEBUG_JS) console.log("  debug:", await js(process.env.DEBUG_JS));
      const c = sc.noChecks ? null : await js(CHECKS);
      if (sc.after) sc.after();
      const problems = c ? [c.hscroll ? "horizontal scroll" : "", ...c.small.map((x) => "small target: " + x), ...c.unsafe.map((x) => "outside the safe area: " + x), ...c.glass].filter(Boolean) : [];
      failures += problems.length;
      report.push({ size: size.name, screen: sc.name, insets: c && c.insets, problems });
      console.log(`${size.name} ${sc.name.padEnd(34)} ${problems.length ? "CHECK " + problems.join("; ") : c ? "ok" : "(not checked)"}`);
      if (chrome.logs.length) { console.log("  console:", chrome.logs.splice(0).join(" | ").slice(0, 400)); }
    }
  }
  fs.writeFileSync(path.join(OUT, "report.json"), J(report));
  console.log(failures ? `${failures} findings` : "all checks passed");
  chrome.close();
  for (const m of macs) m.app.server.close();
  setTimeout(() => { fs.rmSync(T, { recursive: true, force: true }); process.exit(0); }, 1200);
})().catch((e) => { console.error(e); process.exit(1); });

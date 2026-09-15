"use strict";
// Airpocket on the phone. Plain DOM, no framework, no HTML strings: every
// value from a Mac goes in through textContent. Paired Macs and their device
// tokens live in this phone's storage only.
(() => {
  const HOSTS_KEY = "airpocket.hosts.v1";
  const PREFS_KEY = "airpocket.prefs.v1";
  const bar = document.getElementById("bar");
  const view = document.getElementById("view");
  const composer = document.getElementById("composer");
  const toastEl = document.getElementById("toast");

  // ---- DOM ---------------------------------------------------------------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  // ---- icons: small line icons, built with DOM calls like everything else ---------
  const SVGNS = "http://www.w3.org/2000/svg";
  const ICONS = {
    back: ["M15 18l-6-6 6-6"],
    close: ["M18 6L6 18", "M6 6l12 12"],
    plus: ["M12 5v14", "M5 12h14"],
    down: ["M6 9l6 6 6-6"],
    refresh: ["M23 4v6h-6", "M1 20v-6h6", "M3.51 9a9 9 0 0 1 14.85-3.36L23 10", "M1 14l4.64 4.36A9 9 0 0 0 20.49 15"],
    mac: ["M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M8 21h8", "M12 17v4"],
    sliders: ["M4 21v-7", "M4 10V3", "M12 21v-9", "M12 8V3", "M20 21v-5", "M20 12V3", "M1 14h6", "M9 8h6", "M17 16h6"],
    send: ["M12 19V5", "M5 12l7-7 7 7"],
    stop: ["M6 6h12v12H6z"],
    wrap: ["M9 10l-5 5 5 5", "M20 4v7a4 4 0 0 1-4 4H4"],
    folder: ["M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"],
    file: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6"],
    image: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z", "M21 15l-5-5L5 21"],
    external: ["M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6", "M15 3h6v6", "M10 14L21 3"],
  };
  function icon(name, size = 22) {
    const svg = document.createElementNS(SVGNS, "svg");
    for (const [k, v] of [["viewBox", "0 0 24 24"], ["width", size], ["height", size], ["fill", "none"], ["stroke", "currentColor"],
                          ["stroke-width", "2"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"]]) svg.setAttribute(k, String(v));
    for (const d of ICONS[name] || []) { const p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", d); svg.append(p); }
    return svg;
  }

  // ---- storage (this phone only) -------------------------------------------
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
  const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  let hosts = load(HOSTS_KEY, []);           // [{id, name, base, token, deviceId}]
  if (!Array.isArray(hosts)) hosts = [];
  const prefs = load(PREFS_KEY, { wrap: true });
  const saveHosts = () => keep(HOSTS_KEY, hosts);
  // Macs that can start a session (Superset is there), as their last list said.
  const startable = new Set();

  // ---- api -------------------------------------------------------------------
  async function api(host, path, { method = "GET", body, timeout = 9000, signal } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener("abort", () => ctrl.abort(), { once: true }); }
    try {
      const headers = {};
      if (host.token) headers.Authorization = "Bearer " + host.token;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetch((host.base || "") + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal, cache: "no-store", credentials: "omit",
      });
      let data = {};
      try { data = await res.json(); } catch {}
      if (!res.ok) {
        const err = new Error(data.message || (res.status === 401 ? "Not paired with this Mac" : "The Mac said no (" + res.status + ")"));
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (err) {
      if (err.name === "AbortError") { const e = new Error("The Mac didn't answer in time"); e.status = 0; e.quiet = !!(signal && signal.aborted); throw e; }
      if (err instanceof TypeError) { const e = new Error("Can't reach this Mac. Is it awake, and is Tailscale on?"); e.status = 0; throw e; }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- small things -----------------------------------------------------------
  let toastTimer;
  function toast(msg, bad) {
    toastEl.textContent = msg;
    toastEl.className = bad ? "bad" : "";
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, bad ? 3800 : 1600);
  }
  function ago(sec) {
    if (!sec) return "";
    const s = Math.max(0, Date.now() / 1000 - sec);
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }
  const spin = (on) => { const s = document.getElementById("spin"); if (s) s.classList.toggle("on", !!on); };

  // One poller at a time, paused while the app is in the background.
  let poll = null;
  function stopPoll() { if (poll) { poll.stopped = true; clearTimeout(poll.t); poll = null; } }
  function startPoll(fn, every) {
    stopPoll();
    const p = { stopped: false, t: 0, busy: false, since: 0, ctrl: null, soon: false };
    p.tick = async () => {
      clearTimeout(p.t);
      if (p.stopped) return;
      if (document.visibilityState === "visible" && !p.busy) {
        p.busy = true; p.since = Date.now(); p.ctrl = new AbortController();
        try { await fn(p.ctrl.signal); } catch {}
        p.busy = false;
      }
      if (!p.stopped) { p.t = setTimeout(p.tick, p.soon ? 50 : every); p.soon = false; }
    };
    poll = p;
    p.tick();
  }
  const refreshSoon = (ms) => setTimeout(() => poll && poll.tick(), ms);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !poll) return;
    // A request that was in flight when the phone went to sleep can hang for
    // seconds after it wakes. Drop it and ask again straight away.
    if (poll.busy && poll.ctrl && Date.now() - poll.since > 2500) { poll.soon = true; poll.ctrl.abort(); }
    else poll.tick();
  });

  function setBar({ back, title, sub, mark, actions = [] }) {
    const kids = [];
    if (back) kids.push(h("button", { class: "ib back", "aria-label": "Back", onclick: () => { location.hash = back; } }, icon("back", 26)));
    kids.push(mark ? h("div", { class: "mark", text: mark })
                   : h("div", { class: "title" }, h("b", { text: title || "" }), sub ? h("span", { text: sub }) : null));
    kids.push(h("div", { id: "spin" }));
    bar.replaceChildren(...kids, ...actions);
  }

  // ---- routes -------------------------------------------------------------------
  let leave = [];                               // undo steps for the screen being left
  function route() {
    stopPoll();
    leave.splice(0).forEach((f) => f());
    composer.hidden = true;
    composer.replaceChildren();
    document.body.classList.remove("in-session", "on-list");
    const hash = location.hash || "#/";
    if (!hosts.length && hash !== "#/hosts") return renderPair(false);
    const m = /^#\/s\/([^/]+)\/(.+)$/.exec(hash);
    if (m) {
      const host = hosts.find((x) => x.id === decodeURIComponent(m[1]));
      if (host) return renderSession(host, decodeURIComponent(m[2]));
    }
    if (hash === "#/new") return renderNew();
    if (hash === "#/hosts") return renderHosts();
    if (hash === "#/add") return renderPair(true);
    return renderList();
  }
  const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
  window.addEventListener("hashchange", route);

  // ---- list ---------------------------------------------------------------------
  function renderList() {
    document.body.classList.add("on-list");
    const sub = hosts.length > 1 ? hosts.length + " Macs" : (hosts[0] && hosts[0].name) || "";
    setBar({ title: "Sessions", sub, actions: [
      h("button", { class: "ib", "aria-label": "Paired Macs", onclick: () => go("#/hosts") }, icon("mac")),
      h("button", { class: "ib", "aria-label": "Refresh", onclick: () => poll && poll.tick() }, icon("refresh", 20)),
    ] });
    view.replaceChildren(h("div", { class: "empty", text: "Loading…" }));
    startPoll(async () => {
      spin(true);
      const results = await Promise.all(hosts.map(async (host) => {
        try { const d = await api(host, "/api/sessions"); return { host, sessions: d.sessions || [], label: d.host, can: d.can || null }; }
        catch (err) { return { host, err }; }
      }));
      spin(false);
      drawList(results);
    }, 5000);
  }

  // Three groups: what needs you, what is running, and a folded "Earlier" for
  // sessions whose process has ended, so the list stays about now.
  function drawList(results) {
    const multi = hosts.length > 1;
    const all = [], errs = [];
    for (const r of results) {
      if (r.err) { errs.push(r); continue; }
      if (r.label && !r.host.name) { r.host.name = r.label; saveHosts(); }
      for (const s of r.sessions) all.push({ ...s, host: r.host });
      if (!r.can || r.can.start) startable.add(r.host.id); else startable.delete(r.host.id);
    }
    const waiting = all.filter((s) => s.waiting);
    const open = all.filter((s) => !s.waiting && s.live);
    const earlier = all.filter((s) => !s.waiting && !s.live);
    const showEarlier = !!prefs.showEarlier;
    const hdr = (title, n) => h("div", { class: "hdr" }, title, h("span", { class: "n", text: String(n) }));
    const none = errs.length && errs.length === results.length;
    // replaceChildren does not flatten arrays, and each section is an array of rows.
    view.replaceChildren(...[
      errs.map((r) => h("div", { class: "hosterr" }, h("b", { text: r.host.name || "Mac" }),
        r.err.status === 401 ? "needs pairing again" : r.err.message)),
      hdr("Needs you", waiting.length),
      waiting.length ? waiting.map((s) => row(s, multi)) : h("div", { class: "empty", text: none ? "No Mac answered." : "Nothing is waiting on you." }),
      hdr("Open", open.length),
      open.length ? open.map((s) => row(s, multi)) : h("div", { class: "empty", text: "No sessions are running." }),
      earlier.length ? h("button", { class: "hdr foldhdr", "aria-expanded": String(showEarlier),
          onclick: () => { prefs.showEarlier = !showEarlier; keep(PREFS_KEY, prefs); drawList(results); } },
        "Earlier", h("span", { class: "n", text: String(earlier.length) }), h("span", { class: "chev" + (showEarlier ? " open" : "") }, icon("down", 16))) : null,
      showEarlier ? earlier.map((s) => row(s, multi)) : null,
      // New sessions start through Superset: no button when no Mac here has it.
      hosts.some((x) => startable.has(x.id)) ? h("button", { class: "fab", onclick: () => go("#/new") }, icon("plus", 20), "New") : null,
    ].flat().filter(Boolean));
  }

  // The hooks' stock notifications say nothing the status pill doesn't, and go stale.
  function rowNote(note) {
    const t = String(note || "").trim();
    const perm = /needs your permission to use (.+)$/i.exec(t);
    if (perm) return "to use " + perm[1];
    return /^(Claude is waiting for your input|Claude needs your (permission|attention)|Codex (is waiting|needs).*)$/i.test(t) ? "" : t;
  }
  const STATUS = { "needs permission": ["Needs permission", "need"], "waiting for you": ["Your turn", "turn"], finished: ["Finished", "done"] };
  function row(s, multi) {
    const [label, tone] = s.waiting ? (STATUS[s.reason] || (s.kind === "input" ? ["Needs you", "need"] : ["Finished", "done"])) : ["", ""];
    const meta = [multi ? s.host.name : null, s.account, s.branch].filter(Boolean).join(" · ");
    const note = rowNote(s.note);
    return h("button", {
      class: "row" + (tone ? " " + tone : ""),
      onclick: () => go(`#/s/${encodeURIComponent(s.host.id)}/${encodeURIComponent(s.id)}`),
    },
      h("span", { class: "av" + (s.live ? " live" : ""), title: s.live ? "Running" : "Ended" },
        h("img", { src: s.agent === "codex" ? "/agent-codex.png" : "/agent-claude.png", alt: s.agent === "codex" ? "Codex" : "Claude" })),
      h("span", { class: "txt" },
        h("span", { class: "top" }, h("span", { class: "t", text: s.title }), h("span", { class: "ago", text: ago(s.lastSeen) })),
        label || note ? h("span", { class: "sub" }, label ? h("span", { class: "pill " + tone, text: label }) : null,
          note ? h("span", { class: "sn", text: note }) : null) : null,
        meta ? h("span", { class: "meta", text: meta }) : null));
  }

  // ---- one session --------------------------------------------------------------
  const clock = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };

  function renderSession(host, id) {
    document.body.classList.add("in-session");
    const st = { view: prefs.view === "terminal" ? "terminal" : "chat", sig: "", items: [], meta: null, kind: null,
                 open: new Set(), chat: null, blocks: new Map(), openFile: (f) => openFile(host, id, f) };
    const feed = h("div");
    const screen = h("div", { class: "screen" + (prefs.wrap ? "" : " nowrap") });
    const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
    const toBottom = (smooth) => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    // New output while you are reading further up: say so instead of yanking the page.
    const newer = h("button", { class: "newer", hidden: true, onclick: () => { newer.hidden = true; toBottom(true); } }, "New below ↓");
    const onScroll = () => { if (!newer.hidden && atBottom()) newer.hidden = true; };
    window.addEventListener("scroll", onScroll, { passive: true });
    leave.push(() => window.removeEventListener("scroll", onScroll));
    view.replaceChildren(feed, newer);
    const ui = buildComposer(host, id);

    const drawBar = () => {
      const s = st.meta;
      const sub = s ? [hosts.length > 1 ? host.name : null, s.account, s.branch].filter(Boolean).join(" · ") : host.name;
      const showsTerminal = st.view === "terminal" || st.kind === "terminal";
      const actions = [h("button", { class: "ib", "aria-label": "Files", onclick: () => filesSheet(host, id) }, icon("folder", 20))];
      if (st.kind === "chat") {
        actions.push(h("button", { class: "seg", onclick: () => {
          st.view = st.view === "chat" ? "terminal" : "chat";
          prefs.view = st.view; keep(PREFS_KEY, prefs);
          st.sig = ""; feed.dataset.sig = "";
          drawBar();
          if (poll) poll.tick();
        } }, st.view === "chat" ? "Terminal" : "Chat"));
      }
      if (showsTerminal) {
        actions.push(h("button", { class: "ib", "aria-label": "Wrap long lines", onclick: () => {
          prefs.wrap = !prefs.wrap; keep(PREFS_KEY, prefs); screen.classList.toggle("nowrap", !prefs.wrap);
        } }, icon("wrap", 18)));
      }
      setBar({ back: "#/", title: s ? s.title : " ", sub, actions });
    };
    drawBar();

    api(host, "/api/sessions").then((d) => {
      st.meta = (d.sessions || []).find((x) => x.id === id) || null;
      // You opened it, so a finished turn is read. The Mac leaves real questions on the list.
      if (st.meta && st.meta.waiting) api(host, "/api/seen", { method: "POST", body: { id } }).catch(() => {});
      if (st.meta && st.meta.can) ui.setCan(st.meta.can);
      drawBar();
    }).catch(() => {});

    const redraw = () => drawChat(feed, host, id, st, redraw);
    let first = true;
    startPoll(async (signal) => {
      spin(true);
      try {
        const d = await api(host, `/api/screen?id=${encodeURIComponent(id)}&view=${st.view}&sig=${encodeURIComponent(st.sig)}`, { signal });
        if (st.kind !== d.kind) { st.kind = d.kind; drawBar(); }
        const stick = first || atBottom();
        const height = document.documentElement.scrollHeight;
        if (st.view === "terminal" || d.kind === "terminal") {
          if (screen.textContent !== (d.text || "")) screen.textContent = d.text || "";
          if (feed.firstChild !== screen || feed.childNodes.length > 1) feed.replaceChildren(screen);
          st.chat = null;
        } else if (d.items) {
          st.items = d.items; st.sig = d.sig;
          redraw();
        }
        ui.setLive(d.live);
        ui.setInfo(d.info, d.agent);
        if (d.can) ui.setCan(d.can);
        if (stick) toBottom(false);
        else if (document.documentElement.scrollHeight > height + 2) newer.hidden = false;
        first = false;
      } catch (err) {
        if (err.quiet) return;
        // One missed poll on mobile data must not wipe what you are reading. Keep
        // the conversation, say so in the status line, and let the next poll resume.
        const showing = st.chat ? feed.firstChild === st.chat : feed.firstChild === screen;
        if (showing && err.status !== 401 && err.status !== 404) { ui.trouble(err.message); return; }
        feed.replaceChildren(h("div", { class: "hosterr" }, h("b", { text: "Can't read it" }), err.message));
        st.sig = ""; st.chat = null;
      } finally {
        spin(false);
      }
    }, 2500);
  }

  // The conversation as keyed blocks. A poll that brings one new step adds one
  // node; everything already on screen stays put, so reading and scrolling are
  // never interrupted.
  function drawChat(feed, host, id, st, redraw) {
    const blocks = [];                                  // [key, content signature, make]
    const items = st.items || [];
    for (let i = 0; i < items.length;) {
      const it = items[i];
      if (it.type === "tool") {
        const group = [];
        while (i < items.length && items[i].type === "tool") group.push(items[i++]);
        const key = "g:" + (group[0].id || i);
        const open = group.length <= 3 || st.open.has(key);
        blocks.push([key, JSON.stringify([open, group.length, open ? group : group.slice(-2)]), () => steps(group, key, open, st, redraw)]);
        continue;
      }
      i++;
      const key = it.type + ":" + (it.id || i);
      if (it.type === "user") {
        blocks.push([key, JSON.stringify([it.text, it.at, it.queued, st.open.has(key)]), () => userMsg(it, key, st, redraw)]);
      } else if (it.type === "agent") {
        blocks.push([key, (it.aside ? "~" : "") + it.text + JSON.stringify(it.files || []), () => {
          const m = h("div", { class: "msg agent" + (it.aside ? " aside" : "") });
          window.renderMarkdown(it.text, m);
          if (!it.files || !it.files.length) return m;
          return h("div", { class: "withfiles" }, m, h("div", { class: "att" }, it.files.map((f) =>
            h("button", { class: "attchip", onclick: () => openFile(host, id, f) }, icon(f.kind === "image" ? "image" : "file", 16), h("span", { text: f.name })))));
        }]);
      } else if (it.type === "command") {
        blocks.push([key, it.text, () => h("div", { class: "cmdmsg", text: it.text })]);
      } else if (it.type === "note") {
        blocks.push([key, it.text, () => h("div", { class: "mnote", text: it.text })]);
      }
    }
    if (!blocks.length) blocks.push(["empty", "", () => h("div", { class: "empty", text: "No messages yet." })]);

    if (!st.chat || feed.firstChild !== st.chat) {
      st.chat = h("div", { class: "chat" });
      st.blocks = new Map();
      feed.replaceChildren(st.chat);
    }
    const next = new Map(), nodes = [];
    for (const [k0, sig, make] of blocks) {
      let key = k0;
      while (next.has(key)) key += "'";
      let b = st.blocks.get(key);
      if (!b || b.sig !== sig) b = { sig, node: make() };
      next.set(key, b);
      nodes.push(b.node);
    }
    st.blocks = next;
    const box = st.chat;
    nodes.forEach((node, i) => { const at = box.childNodes[i]; if (at !== node) box.insertBefore(node, at || null); });
    while (box.childNodes.length > nodes.length) box.lastChild.remove();
  }

  // Long prompts (a pasted brief) fold to their start.
  function userMsg(it, key, st, redraw) {
    const folded = it.text.length > 700 && !st.open.has(key);
    return h("div", { class: "msg user" },
      folded ? it.text.slice(0, 560).trimEnd() + "…" : it.text,
      folded ? h("button", { class: "more", onclick: () => { st.open.add(key); redraw(); } }, "Show all") : null,
      it.at ? h("span", { class: "at", text: clock(it.at) + (it.queued ? " · sent while it worked" : "") }) : null);
  }

  // A run of tool steps: short runs in full, long runs folded to the last two.
  function steps(group, key, open, st, redraw) {
    const box = h("div", { class: "steps" });
    if (!open) {
      const names = [...new Set(group.map((g) => g.name))].slice(0, 4).join(", ");
      box.append(h("button", { class: "fold", onclick: () => { st.open.add(key); redraw(); } },
        `${group.length - 2} more steps · ${names}`));
    }
    for (const g of open ? group : group.slice(-2)) {
      const kids = [h("span", { class: "tn", text: g.name }), g.label ? h("span", { class: "tl", text: g.label }) : null];
      box.append(g.file
        ? h("button", { class: "step link" + (g.error ? " err" : ""), onclick: () => st.openFile(g.file) }, ...kids)
        : h("div", { class: "step" + (g.error ? " err" : "") }, ...kids));
    }
    return box;
  }

  function buildComposer(host, id) {
    // What this session allows (the Mac's list and each poll say); what it doesn't is hidden.
    let can = { read: true, send: true, keys: true, controls: true, why: "" };
    const press = async (k, label, ask) => {
      if (ask && !window.confirm(ask)) return;
      try {
        await api(host, "/api/key", { method: "POST", body: { id, key: k } });
        toast(label);
        refreshSoon(700);
      } catch (err) { toast(err.message, true); }
    };

    // One status line: what it is doing, what it runs with, Stop while it works, Controls.
    const liveText = h("span", { class: "lt", text: "Connecting…" });
    const liveEl = h("div", { class: "live" }, h("span", { class: "ld" }), liveText);
    const infoEl = h("button", { class: "infochip", hidden: true, onclick: () => openSheet() });
    const stopBtn = h("button", { class: "stopbtn", hidden: true, onclick: () => press("esc", "Stopped", "Stop the current turn?") }, icon("stop", 12), "Stop");
    const ctlBtn = h("button", { class: "ib ctlbtn", "aria-label": "Controls", onclick: () => openSheet() }, icon("sliders", 20));
    const menuEl = h("div", { class: "menu", hidden: true });

    // ---- Controls: model, effort, mode, session commands and keys ---------------
    // The phone names a command; the Mac types the slash command the agent knows.
    let cur = { info: null, agent: "claude" };
    let sheetEl = null;
    // What each agent offers on this Mac, from the agents' own lists; asked once per session view.
    let offered = null;
    api(host, "/api/models").then((d) => { offered = d; }).catch(() => {});
    const closeSheet = () => { if (sheetEl) { sheetEl.remove(); sheetEl = null; } };
    leave.push(closeSheet);
    const run = async (cmd, arg, label, ask) => {
      if (ask && !window.confirm(ask)) return;
      closeSheet();
      try {
        await api(host, "/api/command", { method: "POST", body: arg === undefined ? { id, cmd } : { id, cmd, arg } });
        toast(label || "Sent");
        refreshSoon(900);
      } catch (err) { toast(err.message, true); }
    };
    const alias = (m) => {
      const t = String(m || "").toLowerCase();
      const fam = ["opus", "sonnet", "haiku", "fable"].find((f) => t.includes(f));
      return fam ? fam + (/1m/.test(t) && fam !== "haiku" ? "[1m]" : "") : "";
    };
    const shortModel = (m) => (m ? String(m).replace(/\s*\(1M context\)/i, " 1M") : "");
    function openSheet() {
      closeSheet();
      if (!can.controls && !can.keys) return;
      const info = cur.info || {};
      const chip = (label, on, fn) => h("button", { class: "chipbtn" + (on ? " on" : ""), onclick: fn }, label);
      const sec = (title, note, kids) => h("div", { class: "sec" },
        h("div", { class: "st" }, h("b", { text: title }), note ? h("span", { text: note }) : null), h("div", { class: "chips" }, kids));
      const secs = [];
      if (!can.controls) {
        // Keys only: the slash-command sections below need Controls.
      } else if (cur.agent === "codex") {
        secs.push(sec("Model and effort", [info.model, info.effort].filter(Boolean).join(" · "), [
          chip("Choose…", false, () => run("model", undefined, "The model picker is open below")),
          chip("Fast mode", !!info.fast, () => run("fast", undefined, info.fast ? "Fast mode off" : "Fast mode on"))]));
        secs.push(sec("Permissions", info.access || "", [chip("Choose…", false, () => run("permissions", undefined, "The permissions picker is open below"))]));
        secs.push(sec("Mode", info.mode === "plan" ? "plan" : "", [chip("Plan mode", info.mode === "plan", () => run("plan", undefined, "Plan mode"))]));
        secs.push(sec("Session", "", [
          chip("Compact", false, () => run("compact", undefined, "Compacting")), chip("Status", false, () => run("status", undefined, "Status is in the terminal view")),
          chip("Usage", false, () => run("usage", undefined, "Usage is in the terminal view")), chip("Diff", false, () => run("diff", undefined, "The diff is in the terminal view")),
          chip("Review", false, () => run("review", undefined, "Review started")), chip("Resume…", false, () => run("resume", undefined, "Pick a chat below")),
          chip("New chat", false, () => run("new", undefined, "New chat", "Start a new chat in this terminal? The current one stays saved."))]));
      } else {
        // The models Claude Code itself offers on that Mac (or its aliases, when its list can't be read).
        const list = (offered && offered.claude && offered.claude.models) || [];
        const on = (m) => info.model === m.id || (!!info.name && info.name === m.name) || alias(info.model) === m.id;
        secs.push(sec("Model", info.name || info.model || "", [
          ...list.map((m) => chip(m.name || m.id, on(m), () => run("model", m.id, "Model: " + (m.name || m.id) + ". Claude also makes it the default for new sessions."))),
          chip("More…", false, () => run("model", undefined, "The model picker is open below"))]));
        const efforts = (offered && offered.claude && offered.claude.efforts) || ["low", "medium", "high", "xhigh", "max"];
        secs.push(sec("Effort", info.effort || "", efforts.map((x) => chip(x, info.effort === x, () => run("effort", x, "Effort: " + x + ". Claude also makes it the default for new sessions of this model.")))));
        secs.push(sec("Permission mode", info.mode || "", [
          chip("Next mode", false, () => { closeSheet(); press("stab", "Switched mode"); }),
          chip("Plan", /plan/.test(info.mode || ""), () => run("plan", undefined, "Plan mode")),
          chip("Fast mode", false, () => run("fast", undefined, "Toggled fast mode"))]));
        secs.push(sec("Session", "", [
          chip("Compact", false, () => run("compact", undefined, "Compacting")), chip("Context", false, () => run("context", undefined, "Context is in the terminal view")),
          chip("Usage", false, () => run("usage", undefined, "Usage is in the terminal view")), chip("Resume…", false, () => run("resume", undefined, "Pick a conversation below")),
          chip("Rewind…", false, () => run("rewind", undefined, "Pick a point below")),
          chip("Clear", false, () => run("clear", undefined, "Cleared", "Start fresh in this terminal? The conversation stays saved and can be resumed."))]));
      }
      if (can.keys) secs.push(sec("Keys", "for whatever is on screen",
        [["1", "1"], ["2", "2"], ["3", "3"], ["Enter", "enter"], ["Esc", "esc"], ["↑", "up"], ["↓", "down"], ["←", "left"], ["→", "right"], ["Tab", "tab"], ["⇧Tab", "stab"]]
          .map(([l, k]) => chip(l, false, () => press(k, "Pressed " + l)))));
      if (can.send) secs.push(sec("Message box", "", [chip("Type it without sending", false, () => { closeSheet(); submit(false); })]));
      const summary = [info.name || shortModel(info.model), info.effort, info.fast ? "fast" : "", info.mode && info.mode !== "default" ? info.mode : "", info.access || ""]
        .filter(Boolean).join(" · ");
      sheetEl = h("div", { class: "sheet-back", onclick: (ev) => { if (ev.target === sheetEl) closeSheet(); } },
        h("div", { class: "sheet", role: "dialog", "aria-label": "Controls" },
          h("div", { class: "sh" },
            h("div", { class: "sht" }, h("b", { text: cur.agent === "codex" ? "Codex" : "Claude" }), summary ? h("span", { text: summary }) : null),
            h("button", { class: "ib", "aria-label": "Close", onclick: closeSheet }, icon("close"))),
          secs));
      document.body.append(sheetEl);
    }

    // The message box and one send button, which lights up once there is text.
    const box = h("textarea", { rows: "1", placeholder: "Message", autocapitalize: "sentences", "aria-label": "Message" });
    const sendBtn = h("button", { class: "send", "aria-label": "Send" }, icon("send", 20));
    const fit = () => {
      box.style.height = "auto";
      box.style.height = Math.min(box.scrollHeight, 136) + "px";
      sendBtn.classList.toggle("ready", !!box.value.trim());
    };
    box.addEventListener("input", fit);
    const submit = async (enter) => {
      const text = box.value.trim();
      if (!text) { box.focus(); if (!enter) toast("Write something first."); return; }
      sendBtn.disabled = true;
      try {
        await api(host, "/api/send", { method: "POST", body: { id, text, submit: enter } });
        box.value = "";
        fit();
        toast(enter ? "Sent" : "Typed into its box, not sent");
        refreshSoon(800);
      } catch (err) {
        toast(err.message, true);
      } finally {
        sendBtn.disabled = false;
      }
    };
    sendBtn.addEventListener("click", () => submit(true));
    const statusEl = h("div", { class: "status" }, liveEl, infoEl, stopBtn, ctlBtn);
    const cmEl = h("div", { class: "cm" }, box, sendBtn);
    const roEl = h("div", { class: "ro", hidden: true });
    composer.replaceChildren(statusEl, menuEl, cmEl, roEl);
    composer.hidden = false;
    if (window.ResizeObserver) {
      new ResizeObserver(() => document.body.style.setProperty("--composer-h", composer.offsetHeight + "px")).observe(composer);
    }

    return {
      // Only what this session allows shows: no terminal hides the status line, no
      // running agent hides the message box, keys and Controls. The Mac checks again on every write.
      setCan(c) {
        const next = { read: !!c.read, send: !!c.send, keys: !!c.keys, controls: !!c.controls, why: String(c.why || "") };
        if (JSON.stringify(next) === JSON.stringify(can)) return;
        can = next;
        statusEl.hidden = !can.read;
        cmEl.hidden = !can.send;
        ctlBtn.hidden = !(can.controls || can.keys);
        if (!can.keys) stopBtn.hidden = true;
        roEl.hidden = can.send;
        roEl.textContent = can.send ? "" : ["Read-only here.", can.why].filter(Boolean).join(" ");
        if (!can.controls && !can.keys) closeSheet();
        menuEl.dataset.sig = "";                        // redraw the on-screen question with or without its buttons
      },
      // What the session runs with; a tap opens Controls.
      setInfo(info, agent) {
        cur = { info: info || null, agent: agent || cur.agent };
        const i = info || {};
        const t = [i.name || shortModel(i.model), i.effort, i.fast ? "fast" : ""].filter(Boolean).join(" · ");
        infoEl.hidden = !t;
        if (infoEl.dataset.t !== t) { infoEl.dataset.t = t; infoEl.textContent = t; }
        if (sheetEl && !sheetEl.isConnected) sheetEl = null;
      },
      // A poll failed but the conversation is still on screen.
      trouble(msg) {
        liveEl.className = "live trouble";
        liveText.textContent = "Retrying · " + msg;
      },
      setLive(live) {
        if (!live) { liveEl.className = "live"; liveText.textContent = "Ready"; stopBtn.hidden = true; menuEl.hidden = true; return; }
        const working = live.state === "working";
        liveEl.className = "live" + (working ? " working" : live.menu ? " ask" : "");
        liveText.textContent = working ? `${live.verb || "Working…"} ${live.elapsed || ""}`.trim()
          : live.menu ? "Asking you to choose"
          : live.staged ? "Typed, not sent: " + live.staged
          : "Waiting for you";
        stopBtn.hidden = !working || !can.keys;
        const sig = live.menu ? JSON.stringify([live.menu, can.keys]) : "";
        if (menuEl.dataset.sig !== sig) {
          menuEl.dataset.sig = sig;
          if (!live.menu) {
            menuEl.hidden = true;
            menuEl.replaceChildren();
          } else {
            const parts = [live.menu.question ? h("div", { class: "q", text: live.menu.question }) : null,
              ...live.menu.options.map((o) => h("button", { class: o.cur ? "cur" : "", disabled: !can.keys, onclick: () => press(String(o.n), "Chose " + o.n) },
                h("b", { text: o.n + "." }), h("span", { class: "ml", text: o.label }), o.hint ? h("span", { class: "md", text: o.hint }) : null))];
            menuEl.replaceChildren(...parts.filter(Boolean));
            menuEl.hidden = false;
          }
        }
      },
    };
  }

  // ---- files: made or mentioned by the session ------------------------------------------
  // The phone asks by an opaque ref; the Mac decides what that is and whether it may be shown.
  const fmtSize = (n) => (n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB");
  const FILE_LINK = /^(https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net(:\d{1,5})?|http:\/\/127\.0\.0\.1:\d{1,5})\/f\/[A-Za-z0-9_-]{43}\/[^/?#]+$/i;
  async function fetchBlob(host, path, timeout = 30000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch((host.base || "") + path, { headers: host.token ? { Authorization: "Bearer " + host.token } : {},
        signal: ctrl.signal, cache: "no-store", credentials: "omit" });
      if (!res.ok) { let m = ""; try { m = (await res.json()).message; } catch {} throw new Error(m || "The Mac said no (" + res.status + ")"); }
      return await res.blob();
    } catch (err) {
      if (err.name === "AbortError") throw new Error("The Mac didn't answer in time");
      if (err instanceof TypeError) throw new Error("Can't reach this Mac. Is it awake, and is Tailscale on?");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  // A full-screen layer over the session; nothing it shows is kept after it closes.
  function viewer(title, sub) {
    const closers = [];
    const body = h("div", { class: "vbody" }, h("div", { class: "empty", text: "Opening…" }));
    const close = () => { el.remove(); closers.splice(0).forEach((f) => f()); };
    const el = h("div", { class: "viewer", role: "dialog", "aria-label": title },
      h("div", { class: "vh" }, h("div", { class: "vt" }, h("b", { text: title }), sub ? h("span", { text: sub }) : null),
        h("button", { class: "ib", "aria-label": "Close", onclick: close }, icon("close"))),
      body);
    document.body.append(el);
    leave.push(close);
    return {
      show(...nodes) { body.replaceChildren(...nodes.filter(Boolean)); },
      onClose(f) { closers.push(f); },
    };
  }
  async function openFile(host, id, f) {
    const q = `id=${encodeURIComponent(id)}&ref=${encodeURIComponent(f.ref)}`;
    const v = viewer(f.name, f.dir || "");
    try {
      if (f.kind === "text" || f.kind === "markdown") {
        const d = await api(host, "/api/file/text?" + q, { timeout: 20000 });
        let node;
        if (f.kind === "markdown") { node = h("div", { class: "msg agent filemd" }); window.renderMarkdown(d.text, node); }
        else node = h("pre", { class: "filetext", text: d.text });
        v.show(d.truncated ? h("div", { class: "note", text: `Showing the start of a ${fmtSize(d.size)} file.` }) : null, node);
      } else if (f.kind === "image") {
        const url = URL.createObjectURL(await fetchBlob(host, "/api/file/image?" + q));
        v.onClose(() => URL.revokeObjectURL(url));
        v.show(h("div", { class: "imgwrap" }, h("img", { class: "fileimg", src: url, alt: f.name })));
      } else {
        const d = await api(host, "/api/file/open", { method: "POST", body: { id, ref: f.ref } });
        if (!FILE_LINK.test(String(d.url || ""))) throw new Error("The Mac sent a link this app won't open.");
        v.show(h("div", { class: "opencard" },
          h("div", { class: "oc-icon" }, icon("file", 34)),
          h("p", { text: f.kind === "page" ? "Opens as a still page in a separate, locked-down view. Its scripts don't run." : "Opens in the iPhone's PDF viewer." }),
          h("a", { class: "btn wide openlink", href: d.url, target: "_blank", rel: "noopener noreferrer" }, icon("external", 18), f.kind === "pdf" ? "Open PDF" : "Open page"),
          h("p", { class: "note", text: "The link works for two minutes, for this file only." })));
      }
    } catch (err) {
      v.show(h("div", { class: "perr", text: err.message }));
    }
  }
  async function filesSheet(host, id) {
    const v = viewer("Files", "Made or mentioned in this session");
    try {
      const d = await api(host, `/api/files?id=${encodeURIComponent(id)}`);
      if (!d.files.length) {
        v.show(h("div", { class: "empty", text: d.root ? "Nothing to show yet. Files this session writes, edits or links show up here."
                                                      : "This session's folder isn't one the phone can show files from." }));
        return;
      }
      v.show(h("div", { class: "flist" }, d.files.map((f) => h("button", { class: "frow", onclick: () => openFile(host, id, f) },
        h("span", { class: "fi" }, icon(f.kind === "image" ? "image" : "file", 20)),
        h("span", { class: "ft" }, h("b", { text: f.name }), h("span", { text: [f.dir, fmtSize(f.size), ago(f.mtime / 1000)].filter(Boolean).join(" · ") }))))));
    } catch (err) {
      v.show(h("div", { class: "perr", text: err.message }));
    }
  }

  // ---- new session (Superset) --------------------------------------------------------
  function renderNew() {
    setBar({ back: "#/", title: "New session", sub: "Starts in Superset on the Mac" });
    // Only Macs with Superset can start one. Before any list has said, offer them all.
    const able = hosts.filter((x) => startable.has(x.id));
    const choices = able.length ? able : hosts;
    let host = choices.find((x) => x.id === prefs.newHost) || choices[0];
    const form = h("div", { class: "form" });
    view.replaceChildren(form);
    const sel = (opts, value) => {
      const el = h("select", {}, opts.map(([v, t]) => h("option", { value: v }, t)));
      if (value != null && opts.some(([v]) => v === value)) el.value = value;
      return el;
    };
    const wrapSel = (el) => h("div", { class: "selwrap" }, el, icon("down", 18));
    const field = (label, ...kids) => h("div", { class: "field" }, h("div", { class: "fl", text: label }), ...kids);
    // A row of tappable choices, one selected.
    const pick = (opts, value, onChange, extra) => {
      const el = h("div", { class: "chips" });
      let val = value;
      const paint = () => el.replaceChildren(...opts.map(([v, label, img]) => h("button", {
        class: "chipbtn" + (v === val ? " on" : ""), type: "button", "aria-pressed": String(v === val),
        onclick: () => { val = v; paint(); if (onChange) onChange(v); },
      }, img ? h("img", { class: "ci", src: img, alt: "" }) : null, label)), ...(extra ? [extra] : []));
      paint();
      return { el, get value() { return val; } };
    };
    async function load() {
      form.replaceChildren(h("p", { text: "Asking Superset for its projects…" }));
      try { draw(await api(host, "/api/new/options", { timeout: 25000 })); }
      catch (err) { form.replaceChildren(h("div", { class: "perr", text: err.message })); }
    }
    function draw(o) {
      const projects = (o.projects || []).slice().sort((a, b) => a.name.localeCompare(b.name));
      const hostSel = choices.length > 1 ? sel(choices.map((x) => [x.id, x.name]), host.id) : null;
      if (hostSel) hostSel.addEventListener("change", () => { host = choices.find((x) => x.id === hostSel.value) || host; prefs.newHost = host.id; keep(PREFS_KEY, prefs); load(); });
      if (!projects.length) { form.replaceChildren(...[hostSel ? field("Mac", wrapSel(hostSel)) : null, h("p", { text: "No Superset projects on this Mac." })].filter(Boolean)); return; }
      const projSel = sel(projects.map((p) => [p.id, p.name]), prefs.newProject);
      const whereSel = h("select");
      const branch = h("input", { placeholder: "new-branch-name", autocapitalize: "none", autocorrect: "off", spellcheck: "false", maxlength: "80" });
      const branchField = field("New branch", branch);
      const fillWhere = () => {
        const ws = (o.workspaces || []).filter((w) => w.projectId === projSel.value)
          .sort((a, b) => (a.type === "main" ? -1 : b.type === "main" ? 1 : a.branch.localeCompare(b.branch)));
        whereSel.replaceChildren(...ws.map((w) => h("option", { value: "ws:" + w.id }, w.name && w.name !== w.branch ? `${w.name} (${w.branch})` : (w.branch || w.name))),
          h("option", { value: "new" }, "New branch…"));
        branchField.hidden = whereSel.value !== "new";
      };
      projSel.addEventListener("change", fillWhere);
      whereSel.addEventListener("change", () => { branchField.hidden = whereSel.value !== "new"; if (!branchField.hidden) branch.focus(); });
      fillWhere();
      const rank = (a) => (a.id === "claude" ? 0 : a.id === "codex" ? 1 : 2);
      const agents = (o.agents || []).slice().sort((a, b) => rank(a) - rank(b));
      const logo = (id) => (id === "claude" ? "/agent-claude.png" : id === "codex" ? "/agent-codex.png" : null);
      const tune = h("div", { class: "tune" });
      let modelPick = { value: "" }, effortPick = { value: "" };
      // Models come as { id, name, efforts } from the agents' own lists (plain ids from an older Mac).
      const fillTune = (agentId) => {
        const m = ((o.models || {})[agentId] || []).map((x) => (typeof x === "string" ? { id: x, name: x } : x));
        const all = (o.efforts || {})[agentId] || [];
        const effortBox = h("div");
        // The effort levels the chosen model takes; with no model chosen, any the agent offers.
        const fillEffort = (modelId) => {
          const chosen = m.find((x) => x.id === modelId);
          const e = chosen && Array.isArray(chosen.efforts) ? chosen.efforts : all;
          effortPick = pick([["", "Default"], ...e.map((x) => [x, x])], "");
          effortBox.replaceChildren(...(e.length ? [field("Effort", effortPick.el)] : []));
        };
        modelPick = pick([["", "Default"], ...m.map((x) => [x.id, x.name || x.id])], "", fillEffort);
        fillEffort("");
        tune.replaceChildren(...[m.length ? field("Model", modelPick.el) : null, effortBox].filter(Boolean));
      };
      const first = agents.some((a) => a.id === prefs.newAgent) ? prefs.newAgent : (agents[0] || {}).id;
      const main = agents.filter((a) => rank(a) < 2), rest = agents.filter((a) => rank(a) >= 2);
      let showAll = !main.length || rest.some((a) => a.id === first);
      const agentBox = h("div");
      let agentPick;
      const paintAgents = (value) => {
        const more = !showAll && rest.length
          ? h("button", { class: "chipbtn quiet", type: "button", onclick: () => { showAll = true; paintAgents(agentPick.value); } }, `Other agents (${rest.length})…`) : null;
        agentPick = pick((showAll ? agents : main).map((a) => [a.id, a.label, logo(a.id)]), value, fillTune, more);
        agentBox.replaceChildren(agentPick.el);
      };
      paintAgents(first);
      fillTune(first);
      const prompt = h("textarea", { rows: "5", placeholder: "What should it do?", "aria-label": "Prompt" });
      const msg = h("div", { class: "perr", role: "alert" });
      const start = h("button", { class: "btn wide", text: "Start" });
      start.addEventListener("click", async () => {
        msg.textContent = "";
        const body = { agent: agentPick.value, prompt: prompt.value, model: modelPick.value || undefined, effort: effortPick.value || undefined };
        if (whereSel.value === "new") { body.project = projSel.value; body.branch = branch.value.trim(); }
        else body.workspace = whereSel.value.slice(3);
        if (!body.prompt.trim()) { msg.textContent = "Write what it should do."; return; }
        if (whereSel.value === "new" && !body.branch) { msg.textContent = "Name the new branch."; return; }
        start.disabled = true; start.textContent = "Starting…";
        try {
          await api(host, "/api/new", { method: "POST", body, timeout: 100000 });
          prefs.newProject = projSel.value; prefs.newAgent = agentPick.value; keep(PREFS_KEY, prefs);
          toast("Started. It shows up in the list in a few seconds.");
          go("#/");
        } catch (err) {
          msg.textContent = err.message;
          start.disabled = false; start.textContent = "Start";
        }
      });
      form.replaceChildren(...[
        hostSel ? field("Mac", wrapSel(hostSel)) : null,
        field("Project", wrapSel(projSel)), field("Where", wrapSel(whereSel)), branchField,
        field("Agent", agentBox), tune,
        field("Prompt", prompt), msg, start,
      ].filter(Boolean));
    }
    load();
  }

  // ---- pairing -------------------------------------------------------------------
  function renderPair(adding) {
    setBar(adding ? { back: "#/hosts", title: "Add a Mac" } : { mark: "Airpocket" });
    const base = h("input", { type: "url", inputmode: "url", placeholder: "https://mac-name.your-tailnet.ts.net",
      autocapitalize: "none", autocorrect: "off", spellcheck: "false", "aria-label": "Mac address" });
    const code = h("input", { class: "code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "7",
      placeholder: "000 000", "aria-label": "Pairing code" });
    const name = h("input", { value: "iPhone", maxlength: "40", "aria-label": "Name for this phone" });
    const msg = h("div", { class: "perr", role: "alert" });
    const btn = h("button", { class: "btn wide", text: "Pair" });
    btn.addEventListener("click", async () => {
      msg.textContent = "";
      let b = "";
      if (adding) {
        b = base.value.trim().replace(/\/+$/, "");
        if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(b) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/i.test(b)) {
          msg.textContent = "Use the Mac's Tailscale address, like https://mac-name.your-tailnet.ts.net";
          return;
        }
      }
      btn.disabled = true;
      try {
        const d = await api({ base: b }, "/api/pair", { method: "POST", body: { code: code.value, name: name.value } });
        hosts = hosts.filter((x) => (x.base || "") !== b);          // pairing again replaces the old entry
        hosts.push({ id: Math.random().toString(36).slice(2, 10), name: d.host || "Mac", base: b, token: d.token, deviceId: d.deviceId });
        saveHosts();
        toast("Paired with " + (d.host || "the Mac"));
        go("#/");
      } catch (err) {
        msg.textContent = err.message;
        btn.disabled = false;
      }
    });
    view.replaceChildren(h("div", { class: "card" },
      h("h1", { text: adding ? "Add another Mac" : "Pair this phone" }),
      h("p", {}, "On the Mac, in Terminal, run ", h("code", { text: "airpocket pair" }), ", then enter the six-digit code it shows."),
      adding ? h("label", {}, "Mac address", base) : null,
      h("label", {}, "Code", code),
      h("label", {}, "Name for this phone", name),
      msg, btn));
  }

  // ---- paired Macs ----------------------------------------------------------------
  function renderHosts() {
    setBar({ back: hosts.length ? "#/" : null, title: "Macs", sub: "Paired with this phone" });
    const list = h("div");
    const draw = () => list.replaceChildren(...hosts.map((host) => {
      const status = h("span", { class: "sub", text: "checking…" });
      api(host, "/api/hello")
        .then((d) => { status.textContent = "online as " + (d.device || "this phone"); status.className = "sub ok"; })
        .catch((err) => { status.textContent = err.status === 401 ? "not paired any more" : err.message; status.className = "sub bad"; });
      const remove = h("button", { class: "btn ghost", text: "Remove" });
      remove.addEventListener("click", () => {
        if (!window.confirm(`Remove ${host.name} from this phone? You can pair it again later.`)) return;
        hosts = hosts.filter((x) => x !== host);
        saveHosts();
        if (hosts.length) draw(); else go("#/");
      });
      return h("div", { class: "host" },
        h("span", { class: "txt" }, h("span", { class: "name" }, h("span", { class: "t", text: host.name })),
          h("span", { class: "meta", text: host.base || "this address" }), status),
        remove);
    }));
    draw();
    view.replaceChildren(list, h("div", { class: "card" },
      h("p", { text: "Each Mac has its own Tailscale address and its own pairing code. To cut a phone off, run airpocket devices on that Mac and revoke it." }),
      h("button", { class: "btn wide", text: "Add another Mac", onclick: () => go("#/add") })));
  }

  // ---- start ------------------------------------------------------------------------
  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
  route();
})();

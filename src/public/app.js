"use strict";
// Airpocket on the phone. Plain DOM, no framework, no HTML strings: every
// value from a Mac goes in through textContent. Paired Macs and their device
// tokens live in this phone's storage only.
//
// The look is the design pack in docs/design: a dark chart under frosted glass,
// a top strip, one content sheet, a deck of soft keys along the bottom, and
// status lights that each keep their own word and shape.
(() => {
  const HOSTS_KEY = "airpocket.hosts.v1";
  const PREFS_KEY = "airpocket.prefs.v1";
  // Scan first, or type first. Scanning works in a browser, but a Home Screen web
  // app's camera hasn't been tried on an iPhone yet, so the six digits come first
  // and the scan is one tap away. Flip this once it has been tried there.
  const SCAN_FIRST = false;
  // A message the agent runs as a shell command: "!" first, after any spaces or control characters.
  const SHELL_MODE = /^[\s\x00-\x1f\x7f]*!/;
  const root = document.documentElement;
  const bar = document.getElementById("bar");
  const view = document.getElementById("view");
  const deck = document.getElementById("deck");
  const glass = document.getElementById("glass");
  const toastEl = document.getElementById("toast");
  const launchEl = document.getElementById("launch");

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

  /** Replace an element's children; nulls and falses are skipped and arrays flattened, unlike replaceChildren. */
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

  // ---- icons: the pack's line icons (24px grid, 1.5px strokes), and the status-light glyphs (10px) --------
  const SVGNS = "http://www.w3.org/2000/svg";
  const ICONS = {
    back: ["M15 6l-6 6 6 6"], next: ["M9 6l6 6-6 6"], down: ["M6 9l6 6 6-6"],
    refresh: ["M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"],
    mac: ["M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M9 20h6"],
    file: ["M6 3h8l4 4v14H6z", "M14 3v4h4"],
    doc: ["M6 3h8l4 4v14H6z", "M14 3v4h4", "M9 13h6M9 17h6"],
    pdf: ["M6 3h8l4 4v14H6z", "M14 3v4h4", "M9 14h6M9 17h4"],
    image: ["M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z", "M3 15l5-5 4 4 3-3 6 6", "M17.5 9a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"],
    send: ["M12 19V5M6 11l6-6 6 6"], type: ["M9 6l6 6-6 6", "M4 12h11"],
    close: ["M6 6l12 12M18 6L6 18"], check: ["M5 12l5 5 9-10"], cross: ["M2 2l6 6M8 2L2 8"],
    caution: ["M12 3l9 17H3z", "M12 10v5M12 17.5v.5"],
    dart: ["M4 20l16-8L4 4v5l9 3-9 3z"],
    scan: ["M4 7h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z", "M16 13.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0z", "M8 7l1.5-3h5L16 7"],
    up: ["M12 19V5M6 11l6-6 6 6"], dn: ["M12 5v14M6 13l6 6 6-6"], left: ["M19 12H5M11 6l-6 6 6 6"], right: ["M5 12h14M13 6l6 6-6 6"],
    erase: ["M9 6h11v12H9l-5-6z", "M12 10l4 4M16 10l-4 4"],
    open: ["M14 4h6v6", "M20 4l-9 9", "M18 14v6H4V6h6"],
    stop: ["M5 5h14v14H5z"],
  };
  function svg(paths, size, { vb = 24, sw = 1.5, fill = false, dash } = {}) {
    const el = document.createElementNS(SVGNS, "svg");
    for (const [k, v] of [["viewBox", `0 0 ${vb} ${vb}`], ["width", size], ["height", size], ["fill", fill ? "currentColor" : "none"],
                          ["stroke", fill ? "none" : "currentColor"], ["stroke-width", sw], ["aria-hidden", "true"]]) el.setAttribute(k, String(v));
    for (const d of paths) {
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", d);
      if (dash) p.setAttribute("stroke-dasharray", dash);
      el.append(p);
    }
    return el;
  }
  const icon = (name, size = 24, opts) => svg(ICONS[name] || [], size, opts);
  const GLYPHS = {
    tri: [["M5 1L9.5 9H.5z"], { sw: 1.4 }], play: [["M2 1l6 4-6 4z"], { fill: true }], check: [["M1.5 5.5l2.5 2.5 4.5-6"], { sw: 1.5 }],
    ring: [["M9 5a4 4 0 1 1-8 0 4 4 0 0 1 8 0z"], { sw: 1.2, dash: "2 1.5" }], square: [["M2 2h6v6H2z"], { fill: true }], cross: [["M2 2l6 6M8 2L2 8"], { sw: 1.5 }],
  };
  // Each light: its colour (the class), its shape (the glyph), and whether a bar scans along its base.
  const LIGHTS = { need: ["tri"], turn: ["play"], done: ["check"], work: ["ring", true], ended: ["square"], off: ["cross"], check: ["ring", true], online: ["check"] };
  function light(kind, word) {
    const [glyph, scanning] = LIGHTS[kind];
    const [d, o] = GLYPHS[glyph];
    return h("span", { class: "light " + kind }, svg(d, 10, { vb: 10, ...o }), word, scanning ? h("span", { class: "bar", "aria-hidden": "true" }) : null);
  }
  const sweep = (...cls) => h("span", { class: ["sweep", ...cls].join(" "), "aria-hidden": "true" });

  // ---- storage (this phone only) -------------------------------------------
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
  const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  let hosts = load(HOSTS_KEY, []);           // [{id, name, base, token, deviceId}]
  if (!Array.isArray(hosts)) hosts = [];
  const prefs = load(PREFS_KEY, { wrap: true });
  const saveHosts = () => keep(HOSTS_KEY, hosts);
  // Macs that can start a session (Superset is there), as their last list said.
  const startable = new Set();
  const BASE_OK = (b) => /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net(:\d{1,5})?$/i.test(b) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/i.test(b);

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
        err.code = data.error;
        err.left = data.left;
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
  let toastTimer, toastFade;
  function toast(msg, bad) {
    fill(toastEl, ...(bad ? [] : [svg(GLYPHS.check[0], 12, { vb: 10, sw: 1.5 })]), msg);
    toastEl.className = bad ? "bad" : "";
    toastEl.hidden = false;
    clearTimeout(toastTimer); clearTimeout(toastFade);
    toastFade = setTimeout(() => toastEl.classList.add("out"), bad ? 3600 : 2500);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, bad ? 3800 : 2700);
  }
  function ago(sec) {
    if (!sec) return "";
    const s = Math.max(0, Date.now() / 1000 - sec);
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }
  // "3m 12s" on a row reads "3m": the largest unit the Mac sent.
  const shortElapsed = (t) => String(t || "").split(" ")[0];
  const fmtSize = (n) => (n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB");
  const shortModel = (m) => (m ? String(m).replace(/\s*\(1M context\)/i, " 1M") : "");
  const infoLine = (i) => (i ? [i.name || shortModel(i.model), i.effort, i.fast ? "fast" : ""].filter(Boolean).join(" · ") : "");

  // The top strip and the deck move the content sheet's edges; keep their heights in two properties.
  function measure() {
    root.style.setProperty("--bar-h", bar.offsetHeight + "px");
    root.style.setProperty("--deck-h", deck.offsetHeight + "px");
  }
  if (window.ResizeObserver) { const ro = new ResizeObserver(measure); ro.observe(bar); ro.observe(deck); }
  /** Which part of the chart shows, and which glass: "on" for reading, "thin" for lists of Macs, null for none. */
  function screenIs(name, sheet) {
    document.body.dataset.screen = name;
    glass.className = sheet === "thin" ? "on thin" : sheet ? "on" : "";
  }
  // A pane drops its blur while it scrolls, and takes it back when it stops.
  function dropBlur(scroller, pane = scroller, target = scroller) {
    let t;
    target.addEventListener("scroll", () => {
      pane.classList.add("scrolling");
      clearTimeout(t);
      t = setTimeout(() => pane.classList.remove("scrolling"), 160);
    }, { passive: true });
  }
  dropBlur(window, glass, window);

  let launched = false;
  function launchDone() {
    if (launched || !launchEl) return;
    launched = true;
    launchEl.classList.add("out");
    setTimeout(() => launchEl.remove(), 260);
  }
  setTimeout(launchDone, 2500);

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

  // ---- the frame: top strip, deck, soft keys, dialogs ------------------------------------
  /** The top strip: back (a hash or a function) or close (a hash), a title, and what sits on its right. */
  function setBar({ back, close, title, sub, readout, actions = [], below } = {}) {
    if (title === undefined) { fill(bar); measure(); return; }
    const to = back || close;
    const lead = to ? h("button", { class: "ib", "aria-label": close ? "Close" : "Back", onclick: typeof to === "function" ? to : () => go(to) }, icon(close ? "close" : "back")) : null;
    fill(bar, h("div", { class: "row1" }, lead,
      h("div", { class: "title" + (sub ? " two" : "") + (lead ? "" : " pad") }, h("b", { text: title }), sub ? h("span", { text: sub }) : null),
      readout || null, ...actions), ...(below ? [below] : []));
    measure();
  }
  function setDeck(...nodes) { fill(deck, ...nodes.flat().filter(Boolean)); measure(); }
  /** A row of soft keys; one that can't work is left out, never greyed. */
  function softkeys(keys) {
    const shown = keys.filter((k) => k && !k.hidden);
    if (!shown.length) return null;
    return h("div", { class: "softkeys" }, shown.map((k) => h("button", { class: "sk" + (k.on ? " on" : "") + (k.fill ? " fill" : ""), onclick: k.onclick, "aria-pressed": k.on ? "true" : null },
      k.fill ? null : h("span", { class: "tick", "aria-hidden": "true" }), h("span", { text: k.label }))));
  }
  /** A confirmation for anything that stops, clears or removes: the hazard bar, Keep, and the action in red. */
  function confirmDialog({ title, body, action }) {
    return new Promise((resolve) => {
      let back;
      const done = (v) => { if (back.isConnected) back.remove(); resolve(v); };
      const keepBtn = h("button", { class: "btn plain", text: "Keep", onclick: () => done(false) });
      back = h("div", { class: "dialog-back", onclick: (e) => { if (e.target === back) done(false); } },
        h("div", { class: "dialog", role: "alertdialog", "aria-label": title }, h("div", { class: "hz", "aria-hidden": "true" }),
          h("div", { class: "db" }, h("h3", { text: title }), body ? h("p", { text: body }) : null,
            h("div", { class: "two" }, keepBtn, h("button", { class: "btn danger", text: action, onclick: () => done(true) })))));
      document.body.append(back);
      leave.push(() => done(false));
      keepBtn.focus();
    });
  }
  /** A sheet from the bottom over a scrim: a header, a body, soft keys at its foot. */
  function openSheet({ title, right, body, keys, tall, onClose }) {
    const scrim = h("div", { class: "scrim" });
    const foot = h("div", { class: "sfoot" });
    const el = h("div", { class: "sheet" + (tall ? " tall" : ""), role: "dialog", "aria-label": title },
      h("div", { class: "grab", "aria-hidden": "true" }, h("i")), h("div", { class: "sh" }, h("b", { text: title }), right || null), body, foot);
    let open = true;
    const close = () => {
      if (!open) return;
      open = false; scrim.remove(); el.remove();
      if (!document.querySelector(".sheet")) document.body.classList.remove("sheet-open");
      if (onClose) onClose();
    };
    scrim.addEventListener("click", close);
    const setKeys = (list) => fill(foot, ...list.filter((k) => k && !k.hidden).map((k) => h("button", { class: "sk" + (k.fill ? " fill" : ""), onclick: k.onclick },
      k.fill ? null : h("span", { class: "tick", "aria-hidden": "true" }), h("span", { text: k.label }))));
    setKeys(keys || [{ label: "Close", onclick: () => close() }]);
    document.body.append(scrim, el);
    document.body.classList.add("sheet-open");
    leave.push(close);
    return { el, close, setKeys, get open() { return open; } };
  }

  // ---- routes -------------------------------------------------------------------
  let leave = [];                               // undo steps for the screen being left
  function route() {
    stopPoll();
    leave.splice(0).forEach((f) => f());
    setDeck();
    fill(view);
    window.scrollTo(0, 0);
    const hash = location.hash || "#/";
    if (!hosts.length && hash !== "#/hosts") return pairOrInstall(false);
    const m = /^#\/s\/([^/]+)\/(.+)$/.exec(hash);
    if (m) {
      const host = hosts.find((x) => x.id === decodeURIComponent(m[1]));
      if (host) return renderSession(host, decodeURIComponent(m[2]));
    }
    if (hash === "#/new") return renderNew();
    if (hash === "#/hosts") return renderHosts();
    if (hash === "#/add" || hash.startsWith("#/add?")) return pairOrInstall(true);
    return renderList();
  }
  const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
  window.addEventListener("hashchange", route);
  // Pairing happens only inside the installed app (where.js says why); a browser tab shows how to install it.
  const pairOrInstall = (adding) => (window.AirpocketWhere.pairingScreen(window) === "pair" ? renderPair(adding) : renderInstall());

  // ---- list ---------------------------------------------------------------------
  const seenAlerts = new Set();                 // needs-you lights that have pulsed long enough in view
  function renderList() {
    screenIs("list", "on");
    let results = null, asking = true;
    const n = hosts.length;
    const askingLight = () => h("span", { class: "readout" }, h("span", { class: "light check" }, sweep("s11", "grey"), `Asking ${n} ${n === 1 ? "Mac" : "Macs"}`, h("span", { class: "bar" })));
    setBar({ title: "Sessions", readout: askingLight() });
    const refresh = () => { asking = true; setBar({ title: "Sessions", readout: askingLight() }); if (poll) poll.tick(); };
    const skel = (a, b) => {
      const i1 = h("i"), i2 = h("i");
      i1.style.width = a + "px"; i2.style.width = b + "px";
      return h("div", { class: "skel", "aria-hidden": "true" }, h("div", {}, h("i", { class: "box" }), i1), i2);
    };
    fill(view, h("div", { class: "hdr" }, h("span", { text: "Needs you" }), h("span", { text: "—" })), skel(180, 120), skel(140, 200),
      h("div", { class: "hdr" }, h("span", { text: "Open" }), h("span", { text: "—" })), skel(160, 90));
    setDeck(softkeys([{ label: "Macs", onclick: () => go("#/hosts") }, { label: "Refresh", onclick: refresh }]));

    // A needs-you light pulses until it has been in view for two slow pulses.
    const inView = new Map();
    const io = window.IntersectionObserver ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        const key = e.target.dataset.alert;
        if (!e.isIntersecting) { inView.delete(key); continue; }
        if (!inView.has(key)) inView.set(key, Date.now());
        if (Date.now() - inView.get(key) >= 4800) { seenAlerts.add(key); e.target.classList.remove("pulse"); }
      }
    }, { threshold: 0.5 }) : null;
    const tick = setInterval(() => {
      for (const [key, since] of inView) if (Date.now() - since >= 4800) seenAlerts.add(key);
      for (const el of view.querySelectorAll(".light.pulse")) if (seenAlerts.has(el.dataset.alert)) el.classList.remove("pulse");
    }, 1200);
    leave.push(() => { clearInterval(tick); if (io) io.disconnect(); });

    startPoll(async () => {
      results = await Promise.all(hosts.map(async (host) => {
        try { const d = await api(host, "/api/sessions"); return { host, sessions: d.sessions || [], label: d.host, can: d.can || null, unseen: d.unseen || null }; }
        catch (err) { return { host, err }; }
      }));
      asking = false;
      drawList(results, { io, refresh });
      launchDone();
    }, 5000);
  }

  // The hooks' stock notifications say nothing the status light doesn't, and go stale.
  function rowNote(note) {
    const t = String(note || "").trim();
    const perm = /needs your permission to use (.+)$/i.exec(t);
    if (perm) return "to use " + perm[1];
    return /^(Claude is waiting for your input|Claude needs your (permission|attention)|Codex (is waiting|needs).*)$/i.test(t) ? "" : t;
  }

  // Why a Mac's list may be shorter than what runs there, as that Mac counts it: agents
  // whose hooks haven't fired yet (Claude's at its next prompt, Codex's only after a
  // restart), and Codex hooks Codex hasn't been told to trust. Setup says the same.
  const UNSEEN = {
    claude: ["1 Claude agent hasn't checked in. It appears the next time you prompt it.", "Claude agents haven't checked in. They appear the next time you prompt them."],
    codex: ["1 Codex agent hasn't checked in. Codex takes its hooks at launch, so it needs restarting.", "Codex agents haven't checked in. Codex takes its hooks at launch, so they need restarting."],
    hooks: "Codex hooks aren't trusted yet: start Codex, run /hooks, trust Airpocket's.",
  };
  function unseenLines(u) {
    const line = (kind) => {
      const n = Math.floor(Number(u && u[kind]) || 0);
      return n <= 0 ? "" : n === 1 ? UNSEEN[kind][0] : n + " " + UNSEEN[kind][1];
    };
    return { agents: [line("claude"), line("codex")].filter(Boolean), hooks: u && u.codexHooks === "untrusted" ? UNSEEN.hooks : "" };
  }

  // Three groups: what needs you, what is running, and a folded "Earlier" for
  // sessions whose process has ended, so the list stays about now.
  function drawList(results, { io, refresh }) {
    const multi = hosts.length > 1;
    const all = [], errs = [];
    for (const r of results) {
      if (r.err) { errs.push(r); continue; }
      if (r.label && !r.host.name) { r.host.name = r.label; saveHosts(); }
      for (const s of r.sessions) all.push({ ...s, host: r.host });
      if (!r.can || r.can.start) startable.add(r.host.id); else startable.delete(r.host.id);
    }
    const name = (h1) => h1.name || "Mac";
    const count = results.length;
    const readout = !errs.length ? h("span", { class: "readout ok", text: count === 1 ? name(results[0].host) + " · online" : count + " Macs · online" })
      : errs.length === count ? h("span", { class: "readout bad", text: `${count} ${count === 1 ? "Mac" : "Macs"} · 0 answered` })
      : h("span", { class: "readout" }, `${count} Macs · `, h("span", { class: "bad", text: errs.length + " offline" }));
    setBar({ title: "Sessions", readout });

    // Nobody answered: say so, and keep trying.
    if (errs.length && errs.length === count) {
      screenIs("nomac", null);
      const unpaired = errs.every((r) => r.err.status === 401);
      fill(view, 
        navigator.onLine === false ? h("div", { class: "banner", role: "status" }, svg(GLYPHS.cross[0], 10, { vb: 10, sw: 1.5 }), "PHONE OFFLINE") : null,
        h("div", { class: "nomac" },
          h("div", { class: "radar", "aria-hidden": "true" }, h("i"), h("i"), h("b"), h("b")),
          h("div", {},
            h("h2", { text: unpaired ? "Not paired any more" : count === 1 ? name(errs[0].host) + " didn't answer" : "No Mac answered" }),
            h("p", { text: unpaired ? "This phone isn't paired with " + (count === 1 ? "that Mac" : "those Macs") + " now. Pair it again from Macs."
              : count === 1 ? errs[0].err.message : "Can't reach your Macs. Is Tailscale on, and is a Mac awake?" }),
            unpaired ? null : h("p", { text: "Sessions reappear on their own once one answers." })),
          h("div", { class: "maclist" }, errs.map((r) => h("div", {}, h("span", { text: name(r.host) }), h("span", { text: r.err.status === 401 ? "not paired" : "didn't answer" })))),
          unpaired ? null : light("check", "RETRYING")));
      setDeck(softkeys([{ label: "Macs", onclick: () => go("#/hosts") }, { label: "Retry now", onclick: refresh }]));
      return;
    }
    screenIs("list", "on");
    const waiting = all.filter((s) => s.waiting);
    const open = all.filter((s) => !s.waiting && s.live);
    const earlier = all.filter((s) => !s.waiting && !s.live);
    const showEarlier = !!prefs.showEarlier;
    const hdr = (title, n, tone) => h("div", { class: "hdr" + (n && tone ? " " + tone : "") }, h("span", { text: title }), h("span", { text: String(n) }));
    const rows = (list) => list.map((s) => row(s, multi, io));
    // Plain lines under Open, nothing to tap; with several Macs, each says which.
    const notes = { agents: [], hooks: [] };
    const onMac = (r, t) => (multi ? name(r.host) + ": " + t : t);
    for (const r of results) {
      if (r.err) continue;
      const l = unseenLines(r.unseen);
      for (const t of l.agents) notes.agents.push(onMac(r, t));
      if (l.hooks) notes.hooks.push(onMac(r, l.hooks));
    }
    fill(view, ...[
      errs.map((r) => h("div", { class: "offline" }, h("div", { class: "hz", "aria-hidden": "true" }),
        h("div", { class: "o1" }, light("off", r.err.status === 401 ? "NOT PAIRED" : "OFFLINE"),
          h("b", { text: name(r.host) + (r.err.status === 401 ? " needs pairing again" : " didn't answer") })),
        h("p", { text: r.err.status === 401 ? "This phone isn't paired with it any more." : r.err.message + " Its sessions are hidden until it answers." }),
        softkeys([{ label: "Retry", onclick: refresh }, { label: "Pair again", onclick: () => go("#/add?mac=" + encodeURIComponent(r.host.base || location.origin)) }]))),
      hdr("Needs you", waiting.length, "need"),
      waiting.length ? rows(waiting) : h("div", { class: "empty", text: "Nothing is waiting on you." }),
      hdr("Open", open.length, "open"),
      open.length ? rows(open) : notes.agents.length ? h("div", { class: "empty" }, notes.agents.map((t) => h("p", { class: "unseen", text: t })))
        : h("div", { class: "empty", text: "No sessions are running." }),
      [...(open.length ? notes.agents : []), ...notes.hooks].map((t) => h("p", { class: "mac-note", text: t })),
      earlier.length ? h("button", { class: "hdr fold", "aria-expanded": String(showEarlier),
          onclick: () => { prefs.showEarlier = !showEarlier; keep(PREFS_KEY, prefs); drawList(results, { io, refresh }); } },
        h("span", {}, icon(showEarlier ? "down" : "next", 12, { sw: 2 }), "Earlier"), h("span", { text: String(earlier.length) })) : null,
      showEarlier ? rows(earlier) : null,
    ].flat().filter(Boolean));
    // New sessions start through Superset: no New key when no Mac here has it.
    setDeck(softkeys([{ label: "Macs", onclick: () => go("#/hosts") }, { label: "Refresh", onclick: refresh },
      { label: "New", hidden: !hosts.some((x) => startable.has(x.id)), onclick: () => go("#/new") }]));
  }

  const STATUS = { "needs permission": ["need", "NEEDS PERMISSION"], "waiting for you": ["turn", "YOUR TURN"], finished: ["done", "FINISHED"] };
  function row(s, multi, io) {
    const [tone, word] = s.waiting ? (STATUS[s.reason] || (s.kind === "input" ? ["need", "NEEDS YOU"] : ["done", "FINISHED"])) : ["", ""];
    const working = s.live && s.status && s.status.state === "working";
    const meta = [multi ? s.host.name : null, s.account, s.branch].filter(Boolean);
    const note = rowNote(s.note);
    const info = infoLine(s.info);
    // The mark by the title: the sweep while it works, a lit dot while it waits on you, an open one when it rests.
    const mark = !s.live ? null : working ? sweep() : s.waiting && s.kind === "input" ? h("span", { class: "dot", "aria-hidden": "true" })
      : h("span", { class: "dot hollow", "aria-hidden": "true" });
    let r2;
    if (s.waiting) {
      const l = light(tone, word);
      if (tone === "need") {
        const key = `${s.host.id}/${s.id}/${s.reason}`;
        l.dataset.alert = key;
        if (!seenAlerts.has(key)) {
          l.classList.add("pulse");
          l.style.animationDelay = -(Date.now() % 2400) + "ms";        // redraws keep the pulse in step
          if (io) io.observe(l);
        }
      }
      r2 = [l, note ? h("span", { class: "note", text: note }) : null];
    } else if (!s.live) {
      r2 = [light("ended", "ENDED"), note ? h("span", { class: "note", text: note }) : null];
    } else if (working) {
      r2 = [light("work", "WORKING"), s.status.elapsed ? h("span", { class: "elapsed", text: shortElapsed(s.status.elapsed) }) : null, info ? h("span", { class: "info", text: info }) : null];
    } else if (s.status) {
      r2 = [h("span", { class: "info", text: "Idle" }), info || note ? h("span", { class: "info quiet", text: info || note }) : null];
    } else r2 = note ? [h("span", { class: "note", text: note })] : null;
    return h("button", {
      class: "row" + (s.live ? "" : " ended"),
      onclick: () => go(`#/s/${encodeURIComponent(s.host.id)}/${encodeURIComponent(s.id)}`),
    },
      h("span", { class: "r1" }, h("span", { class: "ag", title: s.agent === "codex" ? "Codex" : "Claude", text: s.agent === "codex" ? "CX" : "CL" }), mark,
        h("span", { class: "t", text: s.title }), h("span", { class: "ago", text: ago(s.lastSeen) })),
      r2 ? h("span", { class: "r2" }, r2) : null,
      meta.length ? h("span", { class: "r3" }, meta.map((m) => h("span", { text: m }))) : null);
  }

  // ---- one session --------------------------------------------------------------
  const clock = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };

  function renderSession(host, id) {
    screenIs("session", "on");
    const st = { view: prefs.view === "terminal" ? "terminal" : "chat", sig: "", items: [], meta: null, kind: null, trouble: false,
                 open: new Set(), chat: null, blocks: new Map(), openFile: (f) => openFile(host, id, f) };
    const feed = h("div");
    const screen = h("pre", { class: "screen" + (prefs.wrap ? "" : " nowrap") });
    const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
    const toBottom = (smooth) => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    // New output while you are reading further up: say so instead of yanking the page.
    const newer = h("button", { class: "newer", hidden: true, onclick: () => { newer.hidden = true; toBottom(true); } }, icon("down", 12, { sw: 2 }), "NEW BELOW");
    const onScroll = () => { if (!newer.hidden && atBottom()) newer.hidden = true; };
    window.addEventListener("scroll", onScroll, { passive: true });
    leave.push(() => window.removeEventListener("scroll", onScroll));
    fill(view, feed, newer);
    const ui = buildDeck(host, id);

    const ttyText = h("span", { text: "TERMINAL · LIVE" });
    const drawBar = () => {
      const s = st.meta;
      const sub = [host.name ? host.name.toUpperCase() : null, s && s.account, s && s.branch].filter(Boolean).join(" · ");
      const showsTerminal = st.view === "terminal" || st.kind === "terminal";
      const actions = [h("button", { class: "ib", "aria-label": "Files", onclick: () => filesSheet(host, id) }, icon("file"))];
      if (st.kind === "chat") {
        actions.push(h("div", { class: "seg", role: "group", "aria-label": "Show" }, [["chat", "CHAT", "Conversation"], ["terminal", "TERM", "Terminal"]].map(([v, label, aria]) =>
          h("button", { class: st.view === v ? "on" : "", "aria-pressed": String(st.view === v), "aria-label": aria, onclick: () => {
            if (st.view === v) return;
            st.view = v;
            prefs.view = st.view; keep(PREFS_KEY, prefs);
            st.sig = ""; feed.dataset.sig = "";
            drawBar();
            if (poll) poll.tick();
          } }, label))));
      }
      const below = showsTerminal ? h("div", { class: "tty" }, ttyText, h("div", { class: "seg", role: "group", "aria-label": "Long lines" },
        [["wrap", "WRAP"], ["scroll", "SCROLL"]].map(([k, label]) => h("button", { class: (k === "wrap") === !!prefs.wrap ? "on" : "", "aria-pressed": String((k === "wrap") === !!prefs.wrap), onclick: () => {
          prefs.wrap = k === "wrap"; keep(PREFS_KEY, prefs); screen.classList.toggle("nowrap", !prefs.wrap); drawBar();
        } }, label)))) : null;
      setBar({ back: "#/", title: s ? s.title : " ", sub, actions, below });
    };
    drawBar();

    api(host, "/api/sessions").then((d) => {
      st.meta = (d.sessions || []).find((x) => x.id === id) || null;
      // You opened it, so a finished turn is read. The Mac leaves real questions on the list.
      if (st.meta && st.meta.waiting) {
        seenAlerts.add(`${host.id}/${id}/${st.meta.reason}`);
        api(host, "/api/seen", { method: "POST", body: { id } }).catch(() => {});
      }
      if (st.meta && st.meta.can) ui.setCan(st.meta.can);
      drawBar();
    }).catch(() => {});

    const redraw = () => drawChat(feed, host, id, st, redraw);
    let first = true;
    startPoll(async (signal) => {
      try {
        const d = await api(host, `/api/screen?id=${encodeURIComponent(id)}&view=${st.view}&sig=${encodeURIComponent(st.sig)}`, { signal });
        if (st.kind !== d.kind) { st.kind = d.kind; drawBar(); }
        const stick = first || atBottom();
        const height = document.documentElement.scrollHeight;
        if (st.view === "terminal" || d.kind === "terminal") {
          if (screen.textContent !== (d.text || "")) screen.textContent = d.text || "";
          if (feed.firstChild !== screen || feed.childNodes.length > 1) fill(feed, screen);
          st.chat = null;
        } else if (d.items) {
          st.items = d.items; st.sig = d.sig;
          redraw();
        }
        if (st.trouble) { st.trouble = false; ttyText.textContent = "TERMINAL · LIVE"; }
        ui.setLive(d.live);
        ui.setInfo(d.info, d.agent, d.efforts);
        if (d.can) ui.setCan(d.can);
        if (stick) toBottom(false);
        else if (document.documentElement.scrollHeight > height + 2) newer.hidden = false;
        first = false;
      } catch (err) {
        if (err.quiet) return;
        // One missed poll on mobile data must not wipe what you are reading. Keep
        // the conversation, say so in the status line, and let the next poll resume.
        const showing = st.chat ? feed.firstChild === st.chat : feed.firstChild === screen;
        if (showing && err.status !== 401 && err.status !== 404) { st.trouble = true; ttyText.textContent = "TERMINAL · RETRYING"; ui.trouble(err.message); return; }
        fill(feed, h("div", { class: "hosterr" }, h("b", { text: "Can't read it" }), err.message));
        st.sig = ""; st.chat = null;
      } finally {
        launchDone();
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
            h("button", { class: "attchip", onclick: () => openFile(host, id, f) }, icon(f.kind === "image" ? "image" : "file", 14), h("span", { text: f.name })))));
        }]);
      } else if (it.type === "command") {
        blocks.push([key, it.text, () => h("div", { class: "cmdmsg", text: it.text })]);
      } else if (it.type === "note") {
        blocks.push([key, it.text, () => h("div", { class: "mnote", text: it.text })]);
      }
    }
    if (!blocks.length) blocks.push(["empty", "", () => h("div", { class: "empty bare", text: "No messages yet." })]);

    if (!st.chat || feed.firstChild !== st.chat) {
      st.chat = h("div", { class: "chat" });
      st.blocks = new Map();
      fill(feed, st.chat);
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

  // Long prompts (a pasted brief) fold to their start. The time sits above, centred.
  function userMsg(it, key, st, redraw) {
    const folded = it.text.length > 700 && !st.open.has(key);
    const when = it.at ? clock(it.at) + (it.queued ? " · sent while it worked" : "") : "";
    const bubble = h("div", { class: "msg user" },
      folded ? it.text.slice(0, 560).trimEnd() + "…" : it.text,
      folded ? h("button", { class: "more hit", onclick: () => { st.open.add(key); redraw(); } }, "Show all") : null);
    return when ? h("div", { class: "umsg" }, h("div", { class: "when", text: when }), bubble) : bubble;
  }

  // A run of tool steps: short runs in full, long runs folded to the last two.
  function steps(group, key, open, st, redraw) {
    const box = h("div", { class: "steps" });
    if (!open) {
      const names = [...new Set(group.map((g) => g.name))].slice(0, 4).join(", ");
      box.append(h("button", { class: "fold", onclick: () => { st.open.add(key); redraw(); } }, icon("next", 12, { sw: 2 }),
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

  // The deck in a session: its status line, an on-screen question, the message box, and the soft keys.
  function buildDeck(host, id) {
    // What this session allows (the Mac's list and each poll say); what it doesn't is hidden.
    let can = { read: true, send: true, keys: true, controls: true, why: "" };
    let typeOnly = false;                       // "Type it without sending", from the Keys section
    const press = async (k, label, ask) => {
      if (ask && !(await confirmDialog(ask))) return;
      try {
        await api(host, "/api/key", { method: "POST", body: { id, key: k } });
        toast(label);
        refreshSoon(700);
      } catch (err) { toast(err.message, true); }
    };

    // One status line: what it is doing, what it runs with, and Stop while it works.
    const ind = h("span", { class: "ind", "aria-hidden": "true" }, sweep("s16", "sand"));
    const liveText = h("span", { class: "lt", text: "Connecting…" });
    const infoEl = h("button", { class: "infochip", hidden: true, onclick: () => openControls("model") });
    const stopBtn = h("button", { class: "stopbtn", hidden: true, onclick: () => press("esc", "Stopped",
      { title: "Stop the current turn?", body: "This presses Esc in its terminal on " + (host.name || "the Mac") + ".", action: "Stop" }) },
      icon("stop", 12, { fill: true }), "Stop");
    const menuEl = h("div", { class: "menu", hidden: true });
    const setInd = (node) => fill(ind, node);

    // ---- Controls: model, effort, mode, session commands and keys ---------------
    // The phone names a command; the Mac types the slash command the agent knows.
    let cur = { info: null, agent: "claude", efforts: null };
    let sheet = null, sheetTab = "model", nextModel = null;
    // What each agent offers on this Mac, from the agents' own lists; asked once per session view.
    let offered = null;
    api(host, "/api/models").then((d) => { offered = d; }).catch(() => {});
    const closeSheet = () => { if (sheet) { const s = sheet; sheet = null; s.close(); } };
    leave.push(closeSheet);
    const run = async (cmd, arg, label, ask) => {
      if (ask && !(await confirmDialog(ask))) return;
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
    const sec = (id1, label, ...kids) => h("div", { class: "sec", "data-sec": id1 }, label ? h("div", { class: "label", text: label }) : null, ...kids);
    const cell = (label, on, fn, cls) => h("button", { class: "cell" + (on ? " on" : "") + (cls ? " " + cls : ""), "aria-pressed": on ? "true" : null, onclick: fn }, label);
    const cells = (n, kids) => h("div", { class: "cells" + (n === 4 ? " c4" : n === 5 ? " c5" : "") }, kids);
    const opt = (label, right, cls, fn) => h(fn ? "button" : "div", { class: "opt" + (cls ? " " + cls : ""), onclick: fn || null }, h("span", { text: label }), right || null);
    const sw = (on) => h("span", { class: "sw" + (on ? " on" : ""), "aria-hidden": "true" }, h("i"));

    function openControls(tab) {
      if (!can.controls && !can.keys) return;
      sheetTab = tab;
      nextModel = null;
      drawControls(true);
    }
    function drawControls(fresh) {
      const info = cur.info || {};
      const secs = [];                                  // [id, rail label, node]
      if (!can.controls && !can.keys) {
        // Its agent went away while Controls was open: what it last ran with, and nothing to press.
        const body = h("div", { class: "pane" }, h("div", { class: "sec" },
          h("div", { class: "readback" },
            h("div", {}, h("div", { class: "label", text: "Last model" }), h("div", { text: info.name || shortModel(info.model) || "—" })),
            h("div", {}, h("div", { class: "label", text: "Last effort" }), h("div", { text: info.effort || "—" }))),
          h("p", { class: "boxnote", text: "Nothing to control. " + (can.why || "Its agent isn't running on " + (host.name || "the Mac") + ".") })));
        showSheet(light("ended", "ENDED"), body, [{ label: "Close", onclick: closeSheet }], fresh);
        return;
      }
      if (can.controls && cur.agent === "codex") {
        secs.push(["model", "Model", sec("model", "Model",
          h("div", { class: "opts" },
            info.model || info.name ? opt([info.name || shortModel(info.model), info.effort].filter(Boolean).join(" · "), h("small", { text: "ACTIVE" }), "active") : null,
            opt("Choose…", icon("next", 16), "", () => run("model", undefined, "The model picker is open below")),
            opt("Fast mode", sw(!!info.fast), "", () => run("fast", undefined, info.fast ? "Fast mode off" : "Fast mode on"))))]);
        secs.push(["access", "Access", sec("access", "Permissions",
          h("div", { class: "opts" },
            info.access ? opt(info.access, h("small", { text: "ACTIVE" }), "active") : null,
            opt("Choose…", icon("next", 16), "", () => run("permissions", undefined, "The permissions picker is open below")),
            opt("Plan mode", sw(info.mode === "plan"), "", () => run("plan", undefined, "Plan mode"))))]);
        secs.push(["session", "Session", sec("session", "Session", cells(4, [
          cell("Compact", false, () => run("compact", undefined, "Compacting")), cell("Status", false, () => run("status", undefined, "Status is in the terminal view")),
          cell("Usage", false, () => run("usage", undefined, "Usage is in the terminal view")), cell("Diff", false, () => run("diff", undefined, "The diff is in the terminal view")),
          cell("Review", false, () => run("review", undefined, "Review started")), cell("Resume…", false, () => run("resume", undefined, "Pick a chat below")),
          cell("New chat", false, () => run("new", undefined, "New chat", { title: "Start a new chat?", body: "In this terminal. The current one stays saved.", action: "New chat" }), "span2 hazard")]))]);
      } else if (can.controls) {
        // The models Claude Code itself offers on that Mac (or its aliases, when its list can't be read).
        const list = (offered && offered.claude && offered.claude.models) || [];
        const on = (m) => info.model === m.id || (!!info.name && info.name === m.name) || alias(info.model) === m.id;
        // The levels its current model takes, as the Mac checks them; none for a model without effort levels.
        const efforts = cur.efforts || (offered && offered.claude && offered.claude.efforts) || ["low", "medium", "high", "xhigh", "max"];
        const model = sec("model", "Model",
          h("div", { class: "opts" },
            list.map((m) => on(m) ? opt(m.name || m.id, h("small", { text: "ACTIVE" }), "active")
              : opt(m.name || m.id, nextModel === m.id ? h("small", { text: "NEXT" }) : null, nextModel === m.id ? "next" : "", () => {
                nextModel = nextModel === m.id ? null : m.id;
                drawControls(false);
              })),
            opt("More…", icon("next", 16), "", () => run("model", undefined, "The model picker is open below"))));
        if (efforts.length) {
          model.append(h("div", { class: "label", text: "Effort" }),
            h("div", { class: "cells", role: "group", "aria-label": "Effort" }, efforts.map((x) => cell(efforts.length > 4 && x === "medium" ? "med" : x, info.effort === x,
              () => run("effort", x, "Effort: " + x + ". Claude also makes it the default for new sessions of this model."), "mono"))),
            h("div", { class: "scale", "aria-hidden": "true" }));
          const grid = model.querySelector(".cells");
          grid.style.gridTemplateColumns = `repeat(${Math.min(efforts.length, 5)},1fr)`;
        }
        secs.push(["model", "Model", model]);
        secs.push(["mode", "Mode", sec("mode", "Permission mode", cells(3, [
          cell("Next mode", false, () => { closeSheet(); press("stab", "Switched mode"); }),
          cell("Plan", /plan/.test(info.mode || ""), () => run("plan", undefined, "Plan mode")),
          cell("Fast mode", false, () => run("fast", undefined, "Toggled fast mode"))]))]);
        secs.push(["session", "Session", sec("session", "Session", cells(3, [
          cell("Compact", false, () => run("compact", undefined, "Compacting")), cell("Context", false, () => run("context", undefined, "Context is in the terminal view")),
          cell("Usage", false, () => run("usage", undefined, "Usage is in the terminal view")), cell("Resume…", false, () => run("resume", undefined, "Pick a conversation below")),
          cell("Rewind…", false, () => run("rewind", undefined, "Pick a point below")),
          cell("Clear", false, () => run("clear", undefined, "Cleared", { title: "Clear this session?", body: "It starts fresh in this terminal. The conversation stays saved and can be resumed.", action: "Clear" }), "hazard")]))]);
      }
      if (can.keys) {
        const key = (label, k, name, cls) => h("button", { class: "key" + (cls ? " " + cls : ""), "aria-label": name, onclick: () => {
          if (navigator.vibrate) navigator.vibrate(8);
          press(k, "Pressed " + name);
        } }, label);
        const keysSec = h("div", { class: "sec keys", "data-sec": "keys" }, h("div", { class: "label", text: "Keys · sent to the terminal" }),
          h("div", { class: "keypad" },
            key("1", "1", "1", "big"), key("2", "2", "2", "big"), key("3", "3", "3", "big"), key("ESC", "esc", "Esc"),
            key("TAB", "tab", "Tab"), key(icon("up"), "up", "↑"), key(["SHIFT", h("br"), "TAB"], "stab", "⇧Tab"), key("ENTER", "enter", "Enter", "tall"),
            key(icon("left"), "left", "←"), key(icon("dn"), "down", "↓"), key(icon("right"), "right", "→")),
          can.send ? h("button", { class: "toggle" + (typeOnly ? " on" : ""), "aria-pressed": String(typeOnly), onclick: () => {
            typeOnly = !typeOnly;
            paintSend();
            drawControls(false);
          } }, h("span", { text: "Type it without sending" }), h("i", { "aria-hidden": "true" })) : null,
          h("p", { class: "hint", text: "Each key goes straight to the live terminal on " + (host.name || "the Mac") + "." }));
        secs.push(["keys", "Keys", keysSec]);
      }
      const summary = [info.name || shortModel(info.model), info.effort, info.fast ? "fast" : "", info.mode && info.mode !== "default" ? info.mode : "", info.access || ""]
        .filter(Boolean).join(" · ");
      const pane = h("div", { class: "pane" }, secs.map((s) => s[2]));
      const tabs = secs.map(([sid, label]) => h("button", { role: "tab", "aria-selected": String(sid === sheetTab), class: sid === sheetTab ? "on" : "",
        onclick: () => jump(sid) }, label.toUpperCase()));
      const rail = h("div", { class: "rail", role: "tablist" }, tabs, h("i"));
      const jump = (sid) => {
        const target = pane.querySelector(`[data-sec="${sid}"]`);
        if (target) pane.scrollTop = target.offsetTop - pane.firstChild.offsetTop;
        mark(sid);
      };
      const mark = (sid) => { sheetTab = sid; tabs.forEach((t, i) => { const on = secs[i][0] === sid; t.className = on ? "on" : ""; t.setAttribute("aria-selected", String(on)); }); };
      // The rail follows where the pane is.
      pane.addEventListener("scroll", () => {
        let at = secs[0][0];
        for (const [sid] of secs) { const el = pane.querySelector(`[data-sec="${sid}"]`); if (el && el.offsetTop - pane.firstChild.offsetTop <= pane.scrollTop + 12) at = sid; }
        if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2) at = secs[secs.length - 1][0];
        if (at !== sheetTab) mark(at);
      }, { passive: true });
      const next = (offered && offered.claude && offered.claude.models || []).find((m) => m.id === nextModel);
      const keys = [{ label: "Close", onclick: closeSheet },
        next ? { label: "Apply · " + (next.name || next.id), fill: true, onclick: () => run("model", next.id, "Model: " + (next.name || next.id) + ". Claude also makes it the default for new sessions.") } : null];
      const body = h("div", { class: "sbody" }, rail, pane);
      const keepAt = sheet && !fresh ? sheet.el.querySelector(".pane") : null;
      const top = keepAt ? keepAt.scrollTop : null;
      showSheet(summary ? h("span", { text: summary }) : null, body, keys, fresh);
      if (top !== null) pane.scrollTop = top;
      else requestAnimationFrame(() => jump(sheetTab));
      dropBlur(pane, sheet.el);
    }
    function showSheet(right, body, keys, fresh) {
      if (sheet && !fresh) {
        const head = sheet.el.querySelector(".sh");
        fill(head, h("b", { text: "Controls" }), right || h("span"));
        sheet.el.replaceChild(body, sheet.el.children[2]);
        sheet.setKeys(keys);
        return;
      }
      closeSheet();
      sheet = openSheet({ title: "Controls", right, body, keys, tall: true, onClose: () => { sheet = null; } });
    }

    // The message box and one send button, which lights up once there is text.
    const box = h("textarea", { class: "input", rows: "1", placeholder: "Message the agent", autocapitalize: "sentences", "aria-label": "Message" });
    const sendBtn = h("button", { class: "send", "aria-label": "Send" }, icon("send"));
    const paintSend = () => {
      fill(sendBtn, icon(typeOnly ? "type" : "send", 24, { sw: typeOnly ? 2 : 1.5 }));
      sendBtn.setAttribute("aria-label", typeOnly ? "Type without sending" : "Send");
      sendBtn.classList.toggle("ready", !!box.value.trim());
    };
    const fit = () => {
      box.style.height = "auto";
      box.style.height = Math.min(Math.max(box.scrollHeight + 2, 48), 136) + "px";
      sendBtn.classList.toggle("ready", !!box.value.trim());
    };
    box.addEventListener("input", fit);
    const submit = async (enter) => {
      const text = box.value.trim();
      if (!text) { box.focus(); if (!enter) toast("Write something first."); return; }
      // A message that starts with "!" is a shell command to Claude Code (and Codex), run on the Mac as it is.
      // The Mac drops control characters, so they don't hide the "!" from this check.
      if (SHELL_MODE.test(text) && !(await confirmDialog({ title: "Run a shell command?",
        body: `It starts with "!", so the agent runs it as a command in a shell on ${host.name || "the Mac"}, not as a message.` +
          (enter ? "" : " Typed into its box, it runs when Enter is pressed."), action: enter ? "Run it" : "Type it" }))) return;
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
    sendBtn.addEventListener("click", () => submit(!typeOnly));
    const statusEl = h("div", { class: "status" }, ind, liveText, h("span", { class: "spacer" }), infoEl, stopBtn);
    const cmEl = h("div", { class: "cm" }, h("div", { class: "fw" }, box), sendBtn);
    const roEl = h("div", { class: "ro", hidden: true });
    const keysEl = h("div");
    const paintKeys = () => {
      const k = softkeys([{ label: "Controls", hidden: !can.controls, onclick: () => openControls("model") },
        { label: "Keys", hidden: !can.keys, onclick: () => openControls("keys") }]);
      fill(keysEl, ...(k ? [k] : []));
      measure();
    };
    paintKeys();
    setDeck(statusEl, menuEl, cmEl, roEl, keysEl);

    // The status line shows whenever there is something to say: a read-only session
    // still has what it runs with and whether it is working, from its files and the hooks.
    let said = false;
    const showStatus = () => { statusEl.hidden = !(can.read || said); measure(); };

    return {
      // Only what this session allows shows: no running agent hides the message box,
      // keys and Controls. The Mac checks again on every write.
      setCan(c) {
        const next = { read: !!c.read, send: !!c.send, keys: !!c.keys, controls: !!c.controls, why: String(c.why || "") };
        if (JSON.stringify(next) === JSON.stringify(can)) return;
        can = next;
        showStatus();
        cmEl.hidden = !can.send;
        if (!can.send && typeOnly) { typeOnly = false; paintSend(); }
        if (!can.keys) stopBtn.hidden = true;
        roEl.hidden = can.send;
        roEl.textContent = can.send ? "" : ["Read-only here.", can.why].filter(Boolean).join(" ");
        paintKeys();
        if (sheet) drawControls(false);
        menuEl.dataset.sig = "";                        // redraw the on-screen question with or without its buttons
      },
      // What the session runs with; a tap opens Controls.
      setInfo(info, agent, efforts) {
        cur = { info: info || null, agent: agent || cur.agent, efforts: Array.isArray(efforts) ? efforts : null };
        const t = infoLine(info);
        infoEl.hidden = !t;
        infoEl.disabled = !(can.controls || can.keys);
        if (infoEl.dataset.t !== t) { infoEl.dataset.t = t; infoEl.textContent = t; }
        if (t && !said) { said = true; showStatus(); }
      },
      // A poll failed but the conversation is still on screen.
      trouble(msg) {
        setInd(sweep("s16", "amber"));
        liveText.className = "lt trouble";
        liveText.textContent = "Retrying · " + msg;
      },
      setLive(live) {
        // No state at all: its agent has exited (a running one is always working or idle).
        if (!live) {
          setInd(can.send ? h("span", { class: "ring" }) : light("ended", "ENDED"));
          liveText.className = "lt";
          liveText.textContent = can.send ? "Ready" : "Not running";
          stopBtn.hidden = true; menuEl.hidden = true; measure();
          return;
        }
        if (!said) { said = true; showStatus(); }
        const working = live.state === "working";
        setInd(working ? sweep("s16") : live.menu ? h("span", { class: "caution" }, icon("caution", 16))
          : live.staged ? h("span", { class: "box" }, h("i")) : h("span", { class: "ring" }));
        liveText.className = "lt" + (working ? " working" : live.menu ? " ask" : live.staged ? " staged" : " wait");
        liveText.textContent = working ? `${live.verb || "Working…"} ${live.elapsed || ""}`.trim()
          : live.menu ? "Asking you to choose"
          : live.staged ? "Typed, not sent: " + live.staged
          : "Waiting for you";
        stopBtn.hidden = !working || !can.keys;
        box.placeholder = live.menu ? "Or type a reply" : "Message the agent";
        const sig = live.menu ? JSON.stringify([live.menu, can.keys]) : "";
        if (menuEl.dataset.sig !== sig) {
          menuEl.dataset.sig = sig;
          if (!live.menu) {
            menuEl.hidden = true;
            fill(menuEl);
          } else {
            const parts = [live.menu.question ? h("div", { class: "q", text: live.menu.question }) : null,
              ...live.menu.options.map((o) => h("button", { class: o.cur ? "cur" : "", disabled: !can.keys, onclick: () => press(String(o.n), "Chose " + o.n) },
                h("span", { class: "num", text: String(o.n) }), h("span", { class: "ml" }, h("span", { text: o.label }), o.hint ? h("span", { class: "md", text: o.hint }) : null)))];
            fill(menuEl, ...parts.filter(Boolean));
            menuEl.hidden = false;
          }
        }
        measure();
      },
    };
  }

  // ---- files: made or mentioned by the session ------------------------------------------
  // The phone asks by an opaque ref; the Mac decides what that is and whether it may be shown.
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
  const fileIcon = (f) => (f.kind === "image" ? "image" : f.kind === "pdf" || f.kind === "page" ? "pdf" : f.kind === "markdown" ? "doc" : "file");
  // A full-screen layer over the session; nothing it shows is kept after it closes.
  function viewer(title, sub) {
    const closers = [];
    const body = h("div", { class: "vbody" }, h("div", { class: "empty bare", text: "Opening…" }));
    const subEl = h("span", { text: sub || "" });
    const keysEl = h("div");
    let el;
    const close = () => { if (!el.isConnected) return; el.remove(); closers.splice(0).forEach((f) => f()); };
    el = h("div", { class: "viewer", role: "dialog", "aria-label": title },
      h("div", { class: "vh" }, h("button", { class: "ib", "aria-label": "Back", onclick: close }, icon("back")), h("div", { class: "vt" }, h("b", { text: title }), subEl)),
      body, keysEl);
    document.body.append(el);
    dropBlur(body);
    leave.push(close);
    return {
      show(...nodes) { fill(body, ...nodes.filter(Boolean)); body.scrollTop = 0; },
      onClose(f) { closers.push(f); },
      sub(t) { subEl.textContent = t; },
      keys(list) { const k = softkeys(list); fill(keysEl, ...(k ? [k] : [])); },
    };
  }
  async function openFile(host, id, f) {
    const q = `id=${encodeURIComponent(id)}&ref=${encodeURIComponent(f.ref)}`;
    const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(f.name) || [])[1];
    const v = viewer(f.name, [f.dir, f.size != null ? fmtSize(f.size) : ""].filter(Boolean).join(" · "));
    try {
      if (f.kind === "text" || f.kind === "markdown") {
        const d = await api(host, "/api/file/text?" + q, { timeout: 20000 });
        const note = d.truncated ? h("div", { class: "vnote", text: `Showing the start of a ${fmtSize(d.size)} file.` }) : null;
        if (f.kind === "markdown") {
          const node = h("div", { class: "msg agent filemd" });
          window.renderMarkdown(d.text, node);
          v.show(note, node);
          return;
        }
        const lines = d.text.split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        v.sub([f.dir, lines.length + (lines.length === 1 ? " LINE" : " LINES"), ext ? ext.toUpperCase() : ""].filter(Boolean).join(" · "));
        // Numbered lines for code; a very long file stays one plain block.
        let node;
        if (lines.length <= 5000) {
          node = h("div", { class: "code" + (prefs.wrap ? " wrap" : "") }, lines.map((l, i) => h("div", {}, h("span", { class: "ln", text: String(i + 1) }), h("span", { class: "lt", text: l }))));
        } else node = h("pre", { class: "filetext", text: d.text });
        v.show(note, node);
        const paint = () => v.keys([{ label: "Wrap", on: !!prefs.wrap, onclick: () => { prefs.wrap = !prefs.wrap; keep(PREFS_KEY, prefs); node.classList.toggle("wrap", !!prefs.wrap); paint(); } }]);
        if (node.classList.contains("code")) paint();
      } else if (f.kind === "image") {
        const url = URL.createObjectURL(await fetchBlob(host, "/api/file/image?" + q));
        v.onClose(() => URL.revokeObjectURL(url));
        v.show(h("div", { class: "imgwrap" }, h("img", { class: "fileimg", src: url, alt: f.name })));
      } else {
        const d = await api(host, "/api/file/open", { method: "POST", body: { id, ref: f.ref } });
        if (!FILE_LINK.test(String(d.url || ""))) throw new Error("The Mac sent a link this app won't open.");
        v.show(h("div", { class: "opencard" },
          h("div", { class: "oc1" }, icon("pdf", 28), h("div", {}, h("b", { text: f.name }), h("span", { text: [f.size != null ? fmtSize(f.size) : "", f.kind === "pdf" ? "PDF" : "Web page"].filter(Boolean).join(" · ") }))),
          h("p", { text: f.kind === "page" ? "Opens as a still page in a separate, locked-down view. Its scripts don't run." : "Opens in the iPhone's PDF viewer." }),
          h("a", { class: "openlink", href: d.url, target: "_blank", rel: "noopener noreferrer" }, icon("open", 18), f.kind === "pdf" ? "Open PDF" : "Open page")),
          h("p", { class: "vnote", text: "The link works for two minutes, for this file only." }));
      }
    } catch (err) {
      v.show(h("div", { class: "perr", text: err.message }));
    }
  }
  async function filesSheet(host, id) {
    const pane = h("div", { class: "pane" }, h("div", { class: "empty bare", text: "Opening…" }));
    const count = h("span", { class: "label" });
    const s = openSheet({ title: "Files", right: count, body: pane });
    dropBlur(pane, s.el);
    try {
      const d = await api(host, `/api/files?id=${encodeURIComponent(id)}`);
      if (!s.open) return;
      count.textContent = d.files.length + " in this session";
      if (!d.files.length) {
        fill(pane, h("div", { class: "empty bare", text: d.root ? "Nothing to show yet. Files this session writes, edits or links show up here."
                                                                   : "This session's folder isn't one the phone can show files from." }));
        return;
      }
      fill(pane, ...d.files.map((f) => h("button", { class: "frow", onclick: () => openFile(host, id, f) },
        icon(fileIcon(f), 24),
        h("span", { class: "ft" }, h("b", { text: f.name }), h("span", { text: [f.dir, fmtSize(f.size), ago(f.mtime / 1000)].filter(Boolean).join(" · ") })),
        f.kind === "pdf" || f.kind === "page" ? h("span", { class: "tag", text: "OPENS APART" }) : null)));
    } catch (err) {
      fill(pane, h("div", { class: "perr", text: err.message }));
    }
  }

  // ---- new session (Superset) --------------------------------------------------------
  function renderNew() {
    screenIs("new", "on");
    launchDone();
    setBar({ close: "#/", title: "New session" });
    // Only Macs with Superset can start one. Before any list has said, offer them all.
    const able = hosts.filter((x) => startable.has(x.id));
    const choices = able.length ? able : hosts;
    let host = choices.find((x) => x.id === prefs.newHost) || choices[0];
    const form = h("div", { class: "form" });
    fill(view, form);
    const sel = (opts, value, label) => {
      const el = h("select", { class: "input", "aria-label": label }, opts.map(([v, t]) => h("option", { value: v }, t)));
      if (value != null && opts.some(([v]) => v === value)) el.value = value;
      return el;
    };
    const wrapSel = (el) => h("div", { class: "sel" }, el, icon("down", 16));
    const field = (label, ...kids) => h("div", { class: "field" }, h("div", { class: "label", text: label }), ...kids);
    const errLine = () => h("div", { class: "err", role: "alert" });
    const sayErr = (el, text) => fill(el, ...(text ? [svg(GLYPHS.cross[0], 12, { vb: 10, sw: 1.5 }), text] : []));
    async function load() {
      setDeck();
      fill(form, h("p", { text: "Asking Superset for its projects…" }));
      try { draw(await api(host, "/api/new/options", { timeout: 25000 })); }
      catch (err) { fill(form, h("div", { class: "perr", text: err.message })); }
    }
    function draw(o) {
      const projects = (o.projects || []).slice().sort((a, b) => a.name.localeCompare(b.name));
      const hostSel = choices.length > 1 ? sel(choices.map((x) => [x.id, x.name]), host.id, "Mac") : null;
      if (hostSel) hostSel.addEventListener("change", () => { host = choices.find((x) => x.id === hostSel.value) || host; prefs.newHost = host.id; keep(PREFS_KEY, prefs); load(); });
      if (!projects.length) { fill(form, ...[hostSel ? field("Mac", wrapSel(hostSel)) : null, h("p", { text: "No Superset projects on this Mac." })].filter(Boolean)); return; }
      const projSel = sel(projects.map((p) => [p.id, p.name]), prefs.newProject, "Project");
      // Where: one of the project's workspaces, or a new branch.
      let where = "ws";
      const wsSel = h("select", { class: "input", "aria-label": "Workspace" });
      const branch = h("input", { class: "input mono", placeholder: "new-branch-name", autocapitalize: "none", autocorrect: "off", spellcheck: "false", maxlength: "80", "aria-label": "New branch" });
      const branchErr = errLine();
      const whereBox = h("div", { class: "field" });
      const whereBtns = h("div", { class: "pair2" });
      const paintWhere = () => {
        const ws = (o.workspaces || []).filter((w) => w.projectId === projSel.value)
          .sort((a, b) => (a.type === "main" ? -1 : b.type === "main" ? 1 : a.branch.localeCompare(b.branch)));
        if (!ws.length) where = "new";
        fill(wsSel, ...ws.map((w) => h("option", { value: w.id }, w.name && w.name !== w.branch ? `${w.name} (${w.branch})` : (w.branch || w.name))));
        fill(whereBtns, 
          ws.length ? h("button", { class: "cell" + (where === "ws" ? " sel" : ""), "aria-pressed": String(where === "ws"), onclick: () => { where = "ws"; paintWhere(); } }, "Existing workspace") : null,
          h("button", { class: "cell" + (where === "new" ? " sel" : "") + (ws.length ? "" : " span2"), "aria-pressed": String(where === "new"), onclick: () => { where = "new"; paintWhere(); branch.focus(); } }, "New branch"));
        fill(whereBox, h("div", { class: "label", text: "Start in" }), whereBtns,
          where === "new" ? h("div", { class: "fw" }, branch) : wrapSel(wsSel), where === "new" ? branchErr : null);
      };
      projSel.addEventListener("change", paintWhere);
      paintWhere();
      const rank = (a) => (a.id === "claude" ? 0 : a.id === "codex" ? 1 : 2);
      const agents = (o.agents || []).slice().sort((a, b) => rank(a) - rank(b));
      const tune = h("div", { class: "two" });
      let modelSel = { value: "" }, effortSel = { value: "" };
      // Models come as { id, name, efforts } from the agents' own lists (plain ids from an older Mac).
      const fillTune = (agentId) => {
        const m = ((o.models || {})[agentId] || []).map((x) => (typeof x === "string" ? { id: x, name: x } : x));
        const all = (o.efforts || {})[agentId] || [];
        const effortBox = h("div", { class: "field" });
        // The effort levels the chosen model takes; with no model chosen, any the agent offers.
        const fillEffort = (modelId) => {
          const chosen = m.find((x) => x.id === modelId);
          const e = chosen && Array.isArray(chosen.efforts) ? chosen.efforts : all;
          effortSel = sel([["", "Default"], ...e.map((x) => [x, x])], "", "Effort");
          fill(effortBox, ...(e.length ? [h("div", { class: "label", text: "Effort" }), wrapSel(effortSel)] : []));
        };
        modelSel = sel([["", "Default"], ...m.map((x) => [x.id, x.name || x.id])], "", "Model");
        modelSel.addEventListener("change", () => fillEffort(modelSel.value));
        fillEffort("");
        fill(tune, ...[m.length ? field("Model", wrapSel(modelSel)) : null, effortBox].filter(Boolean));
      };
      let agentId = agents.some((a) => a.id === prefs.newAgent) ? prefs.newAgent : (agents[0] || {}).id;
      const main = agents.filter((a) => rank(a) < 2), rest = agents.filter((a) => rank(a) >= 2);
      let showAll = !main.length || rest.some((a) => a.id === agentId);
      const agentBox = h("div", { class: "agents", role: "group", "aria-label": "Agent" });
      const paintAgents = () => {
        fill(agentBox, ...(showAll ? agents : main).map((a) => h("button", { class: "pick" + (a.id === agentId ? " on" : ""), "aria-pressed": String(a.id === agentId),
          onclick: () => { agentId = a.id; paintAgents(); fillTune(a.id); } },
          rank(a) < 2 ? h("span", { class: "ag", text: a.id === "claude" ? "CL" : "CX" }) : null, a.label)),
        !showAll && rest.length ? h("button", { class: "pick more", onclick: () => { showAll = true; paintAgents(); } }, `Other agents (${rest.length})…`) : null);
      };
      paintAgents();
      fillTune(agentId);
      const prompt = h("textarea", { class: "input", rows: "5", placeholder: "What should it do?", "aria-label": "Prompt" });
      const promptErr = errLine();
      const msg = h("div", { class: "perr", role: "alert" });
      const start = h("button", { class: "btn wide", text: "Start on " + (host.name || "the Mac") });
      start.addEventListener("click", async () => {
        msg.textContent = ""; sayErr(promptErr, ""); sayErr(branchErr, "");
        const body = { agent: agentId, prompt: prompt.value, model: modelSel.value || undefined, effort: effortSel.value || undefined };
        if (where === "new") { body.project = projSel.value; body.branch = branch.value.trim(); }
        else body.workspace = wsSel.value;
        if (!body.prompt.trim()) { sayErr(promptErr, "Write what it should do."); prompt.focus(); return; }
        if (where === "new" && !body.branch) { sayErr(branchErr, "Name the new branch."); branch.focus(); return; }
        start.disabled = true; start.textContent = "Starting…";
        try {
          await api(host, "/api/new", { method: "POST", body, timeout: 100000 });
          prefs.newProject = projSel.value; prefs.newAgent = agentId; keep(PREFS_KEY, prefs);
          toast("Started. It shows up in the list in a few seconds.");
          go("#/");
        } catch (err) {
          msg.textContent = err.message;
          start.disabled = false; start.textContent = "Start on " + (host.name || "the Mac");
        }
      });
      fill(form, ...[
        hostSel ? h("div", { class: "two" }, field("Mac", wrapSel(hostSel)), field("Project", wrapSel(projSel))) : field("Project", wrapSel(projSel)),
        whereBox,
        field("Agent", agentBox), tune,
        field("Prompt", h("div", { class: "fw" }, prompt), promptErr), msg,
      ].filter(Boolean));
      setDeck(h("div", { class: "deck-pad" }, start));
    }
    load();
  }

  // ---- first run in a browser tab ---------------------------------------------------------
  function renderInstall() {
    screenIs("install", null);
    setBar();
    launchDone();
    const steps = [["Tap ", h("em", { text: "Share" }), " in the Safari bar below"], ["Choose ", h("em", { text: "Add to Home Screen" })],
      ["Open Airpocket from there to pair this phone"]];
    fill(view, h("div", { class: "center install" },
      h("div", { class: "intro" }, h("div", { class: "brand" }, icon("dart", 28), h("b", { text: "AIRPOCKET" })),
        h("p", { class: "lede", text: "Follow and steer the coding agents on your Macs from your phone. Over your Tailscale network, no accounts, no cloud." })),
      h("div", { class: "card" }, h("div", { class: "label", text: "Add to the Home Screen" }),
        steps.map((s, i) => h("div", { class: "stepn" }, h("span", { text: String(i + 1) }), h("span", {}, s))),
        h("div", { class: "illus", "aria-hidden": "true" },
          h("div", { class: "phone" }, h("div", { class: "apps" }, [0, 1, 2, 3, 4, 5].map((i) => h("i", { class: i === 5 ? "on" : null })))),
          icon("right"), h("div", { class: "app" }, icon("dart", 22)))),
      h("p", { class: "hint", text: "Pairing happens inside the installed app: iOS keeps its storage apart from Safari's, so a phone paired in this tab wouldn't be paired there." })));
  }

  // ---- pairing: the six digits, or the QR code the Mac shows -------------------------------------
  const canScan = () => !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AirpocketQR);
  // What pairing hands over, said before the code is entered or scanned.
  const pairWarning = () => h("p", { class: "hint" }, "A paired phone can type anything into your agents, shell commands too. It stays paired until you revoke it on the Mac (",
    h("code", { class: "k", text: "airpocket devices" }), ").");
  function renderPair(adding) {
    // On glass: on the bare map at its brightest, an error in red and a field's border fall under 4.5:1 and 3:1.
    screenIs("pair", "thin");
    launchDone();
    const q = new URLSearchParams(location.hash.split("?")[1] || "");
    const st = { mode: SCAN_FIRST && canScan() ? "scan" : "code", code: "", name: "iPhone", base: adding ? (q.get("mac") || "") : "", err: "", left: null, busy: false, paired: null };
    let stopCamera = () => {};
    leave.push(() => stopCamera());
    const draw = () => {
      stopCamera(); stopCamera = () => {};
      window.scrollTo(0, 0);
      if (st.mode === "scan") drawScan(); else if (st.mode === "paired") drawPaired(); else drawCode();
    };

    // Pair with `b` ("" is the Mac this app came from): the same code, tries and expiry however the code arrived.
    async function pairNow(b, code) {
      st.busy = true;
      try {
        const d = await api({ base: b }, "/api/pair", { method: "POST", body: { code, name: st.name } });
        hosts = hosts.filter((x) => (x.base || "") !== b);          // pairing again replaces the old entry
        const host = { id: Math.random().toString(36).slice(2, 10), name: d.host || "Mac", base: b, token: d.token, deviceId: d.deviceId };
        hosts.push(host);
        saveHosts();
        st.paired = host;
        st.mode = "paired";
      } catch (err) {
        st.err = err.message;
        st.left = err.code === "wrong_code" ? err.left : null;
        st.mode = "code";
      }
      st.busy = false;
      draw();
    }

    function drawCode() {
      setBar({ back: adding ? "#/hosts" : null, title: adding ? "Add a Mac" : "Pair this phone" });
      setDeck();
      const addr = adding ? h("input", { class: "input mono", type: "url", inputmode: "url", placeholder: "https://mac-name.your-tailnet.ts.net",
        autocapitalize: "none", autocorrect: "off", spellcheck: "false", "aria-label": "Mac address", value: st.base }) : null;
      const addrErr = h("div", { class: "err", role: "alert" });
      if (addr) addr.addEventListener("input", () => { st.base = addr.value; fill(addrErr); addr.classList.remove("bad"); });
      const input = h("input", { inputmode: "numeric", pattern: "[0-9]*", autocomplete: "one-time-code", maxlength: "7", "aria-label": "Pairing code", value: st.code });
      const boxes = [0, 1, 2, 3, 4, 5].map(() => h("div", { class: "d", "aria-hidden": "true" }));
      const bad = !!st.err && st.left !== null;
      const digits = h("div", { class: "digits" + (bad ? " bad" : "") }, boxes.slice(0, 3), h("div", { class: "dot3", "aria-hidden": "true", text: "·" }), boxes.slice(3), input);
      const msg = h("div", { class: "err", role: "alert" });
      const btn = h("button", { class: "btn wide", text: st.busy ? "Pairing…" : "Pair" });
      const say = () => {
        const text = !st.err ? "" : st.left != null ? (st.left ? `Wrong code · ${st.left} ${st.left === 1 ? "try" : "tries"} left` : "Wrong code · make a new one on the Mac") : st.err;
        fill(msg, ...(text ? [svg(GLYPHS.cross[0], 12, { vb: 10, sw: 1.5 }), text] : []));
      };
      const paint = () => {
        boxes.forEach((b, i) => { b.textContent = st.code[i] || ""; b.classList.toggle("cur", document.activeElement === input && i === Math.min(st.code.length, 5)); });
        btn.disabled = st.busy || st.code.length !== 6;
      };
      const clearErr = () => { if (!st.err) return; st.err = ""; st.left = null; digits.classList.remove("bad"); say(); };
      input.addEventListener("input", () => { st.code = input.value.replace(/\D/g, "").slice(0, 6); input.value = st.code; clearErr(); paint(); });
      input.addEventListener("focus", paint);
      input.addEventListener("blur", paint);
      const tap = (k) => { st.code = k === "erase" ? st.code.slice(0, -1) : (st.code + k).slice(0, 6); input.value = st.code; clearErr(); paint(); };
      const pad = h("div", { class: "numpad" }, ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "erase"].map((k) => (k === ""
        ? h("span") : h("button", { type: "button", "aria-label": k === "erase" ? "Delete a digit" : k, onclick: () => tap(k) }, k === "erase" ? icon("erase") : k))));
      const name = h("input", { class: "input", value: st.name, maxlength: "40", "aria-label": "Name for this phone" });
      name.addEventListener("input", () => { st.name = name.value; });
      btn.addEventListener("click", () => {
        let b = "";
        if (adding) {
          b = String(addr.value).trim().replace(/\/+$/, "");
          if (!BASE_OK(b)) {
            addr.classList.add("bad");
            fill(addrErr, svg(GLYPHS.cross[0], 12, { vb: 10, sw: 1.5 }), "Use the Mac's Tailscale address, like https://mac-name.your-tailnet.ts.net");
            return;
          }
          if (b === location.origin) b = "";
        }
        btn.textContent = "Pairing…";
        pairNow(b, st.code);
      });
      say();
      fill(view, h("div", { class: "page" },
        h("p", { class: "lede" }, "On your Mac, in Terminal, run ", h("code", { class: "k", text: "airpocket pair" }), ", then enter the six digits it shows."),
        canScan() ? h("button", { class: "btn outline wide", onclick: () => { st.err = ""; st.mode = "scan"; draw(); } }, icon("scan", 20), "Scan the code on your Mac") : null,
        addr ? h("div", { class: "field" }, h("div", { class: "label", text: "Mac address" }), h("div", { class: "fw" }, addr), addrErr) : null,
        h("div", { class: "field" }, h("div", { class: "label", text: "Code" }), digits, msg),
        h("div", { class: "field" }, h("div", { class: "label", text: "Name for this phone" }), h("div", { class: "fw" }, name),
          h("p", { class: "hint", text: "Shown on the Mac so you know which phone is connected." })),
        h("div", { class: "pushdown" }, pad, btn, pairWarning())));
      paint();
    }

    function drawScan() {
      setBar({ back: () => { st.mode = "code"; draw(); }, title: "Scan the code" });
      setDeck();
      const video = h("video", { playsinline: true, muted: true, autoplay: true, "aria-label": "Camera" });
      video.muted = true;
      const state = h("span", { class: "vl tl", text: "STARTING" });
      const note = h("div", { class: "vmsg", role: "status" });
      const vf = h("div", { class: "viewfinder" }, video,
        h("div", { class: "aim", "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i"), h("b"), h("b"), h("div", { class: "ring" }), h("div", { class: "line" })),
        state, h("span", { class: "vl tr", text: "CAMERA · REAR" }), h("span", { class: "vl bl", text: "QR · AIRPOCKET" }), note);
      fill(view, h("div", { class: "page" },
        h("p", { class: "lede" }, "On your Mac, run ", h("code", { class: "k", text: "airpocket pair" }), " and point the camera at the code it shows."),
        vf,
        pairWarning(),
        h("button", { class: "btn outline wide", onclick: () => { st.mode = "code"; draw(); } }, "Enter the six-digit code instead")));

      let stream = null, timer = 0, running = false;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const halt = () => {
        running = false;
        clearTimeout(timer);
        if (stream) stream.getTracks().forEach((t) => t.stop());
        stream = null;
        video.srcObject = null;
      };
      const tick = () => {
        if (!running) return;
        if (video.readyState >= 2 && video.videoWidth) {
          const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
          const w = Math.round(video.videoWidth * scale), hh = Math.round(video.videoHeight * scale);
          if (canvas.width !== w) canvas.width = w;
          if (canvas.height !== hh) canvas.height = hh;
          ctx.drawImage(video, 0, 0, w, hh);
          const text = window.AirpocketQR.scan(ctx.getImageData(0, 0, w, hh));
          if (text !== null) {
            const found = window.AirpocketQR.readPair(text);
            if (found) {
              halt();
              state.textContent = "PAIRING";
              st.code = found.code;
              if (adding) st.base = found.address;
              pairNow(found.address === location.origin ? "" : found.address, found.code);
              return;
            }
            note.textContent = "That QR code isn't an Airpocket pairing code.";
          }
        }
        timer = setTimeout(tick, 150);
      };
      const start = async () => {
        if (running) return;
        running = true;
        try {
          const s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } });
          if (!running) { s.getTracks().forEach((t) => t.stop()); return; }
          stream = s;
          video.srcObject = s;
          await video.play().catch(() => {});
          state.textContent = "SCANNING";
          vf.classList.add("live");
          note.textContent = "";
          tick();
        } catch (err) {
          running = false;
          state.textContent = "NO CAMERA";
          note.textContent = err && err.name === "NotAllowedError"
            ? "Airpocket isn't allowed to use the camera. Enter the six digits instead."
            : "The camera didn't start. Enter the six digits instead.";
        }
      };
      // The camera stops when the app goes to the background, and starts again when it comes back.
      const onVisible = () => { if (document.visibilityState === "hidden") halt(); else if (st.mode === "scan") start(); };
      document.addEventListener("visibilitychange", onVisible);
      stopCamera = () => { halt(); document.removeEventListener("visibilitychange", onVisible); };
      start();
    }

    function drawPaired() {
      setBar();
      const host = st.paired;
      const found = h("span", { class: "n", text: "—" });
      api(host, "/api/sessions").then((d) => { found.textContent = String((d.sessions || []).length); }).catch(() => {});
      fill(view, h("div", { class: "page" },
        h("div", { class: "paired" },
          h("div", { class: "okring" }, icon("check", 44)),
          h("div", {}, h("h2", { text: "Paired with " + host.name }), h("div", { class: "addr", text: (host.base || location.origin).replace(/^https?:\/\//, "") })),
          h("div", { class: "card facts" },
            h("div", {}, h("span", { text: "THIS PHONE" }), h("span", { text: st.name || "Phone" })),
            h("div", {}, h("span", { text: "SESSIONS FOUND" }), found))),
        h("div", { class: "pushdown" },
          h("button", { class: "btn wide", text: "Open sessions", onclick: () => go("#/") }),
          h("button", { class: "btn ghost wide", text: "Add another Mac", onclick: () => go("#/add") }))));
    }
    draw();
  }

  // ---- paired Macs ----------------------------------------------------------------
  function renderHosts() {
    screenIs("list", "thin");
    launchDone();
    const phone = h("span", { class: "readout" });
    setBar({ back: hosts.length ? "#/" : null, title: "Macs", readout: phone });
    const list = h("div");
    const draw = () => fill(list, ...hosts.map((host) => {
      const lightBox = h("span", {}, light("check", "CHECKING"));
      const ring = sweep("grey");
      const detail = h("span");
      const actions = h("div", { class: "m3", hidden: true });
      const remove = h("button", { class: "btn plain hazard-edge", text: "Remove", onclick: async () => {
        const ok = await confirmDialog({ title: `Remove ${host.name}?`, body: `This phone forgets ${host.name}. You can pair it again later; nothing changes on the Mac.`, action: "Remove" });
        if (!ok) return;
        hosts = hosts.filter((x) => x !== host);
        saveHosts();
        if (hosts.length) draw(); else go("#/");
      } });
      fill(actions, h("span"), remove);
      actions.hidden = false;
      api(host, "/api/hello")
        .then((d) => {
          ring.remove();
          fill(lightBox, light("online", "ONLINE"));
          detail.textContent = "as " + (d.device || "this phone");
          if (d.device && !phone.textContent) phone.textContent = "This phone · " + d.device;
        })
        .catch((err) => {
          ring.remove();
          const unpaired = err.status === 401;
          fill(lightBox, light("off", unpaired ? "NOT PAIRED" : "OFFLINE"));
          detail.textContent = unpaired ? "this phone isn't paired with it now" : err.message;
          if (unpaired) fill(actions, h("button", { class: "btn outline", text: "Pair again", onclick: () => go("#/add?mac=" + encodeURIComponent(host.base || location.origin)) }), remove);
        });
      return h("div", { class: "mac" },
        h("div", { class: "m1" }, icon("mac"), ring, h("b", { text: host.name }), lightBox),
        h("div", { class: "m2" }, h("span", { text: (host.base || location.origin).replace(/^https?:\/\//, "") }), detail),
        actions);
    }));
    draw();
    fill(view, list,
      h("p", { class: "mac-note", text: "Each Mac has its own Tailscale address and its own pairing code. To cut a phone off, run airpocket devices on that Mac and revoke it." }));
    setDeck(h("div", { class: "deck-pad" }, h("button", { class: "btn outline wide", text: "Add another Mac", onclick: () => go("#/add") })));
  }

  // ---- start ------------------------------------------------------------------------
  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
  route();
})();

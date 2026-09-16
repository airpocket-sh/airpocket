"use strict";
// Terminal bridges: how Airpocket reaches the terminal a session runs in.
//
// The phone never names a terminal. It names a session, and the Mac looks up
// where that session runs in its own records (what the hook saw in the agent's
// environment), then picks a bridge:
//
//   tmux       the pane (TMUX_PANE, "%12") on the server behind the socket in $TMUX,
//              and only while that is still the same server (its pid, also in $TMUX)
//   superset   the Superset terminal (SUPERSET_WORKSPACE_ID, SUPERSET_TERMINAL_ID)
//
// A pane wins over a Superset terminal. When tmux runs inside Superset, the
// Superset terminal shows the tmux client, and what is typed there goes to
// whichever pane is active, not necessarily the agent's. A session with
// neither is read-only.
//
// Every bridge does the same three things and nothing else:
//
//   read()               the screen, as plain text
//   type(text, submit)   type text, then Enter if submit; empty text with submit is Enter alone
//   press(key)           one key from KEYS
//
// What reaches a bridge from the phone is text that has lost its control
// characters, or a key from the fixed table below. Both run their program by
// absolute path with an argument list, never through a shell.
//
// Typing is refused unless the session's agent is still the process the hook
// recorded (pid plus start time, read fresh at that moment). When the agent
// exits, its terminal falls back to a shell, and nothing typed on the phone
// may land there.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { stillRunning, pidOf } = require("./proc");

const ESC = String.fromCharCode(27);
const SUPERSET = path.join(os.homedir(), ".superset", "bin", "superset");
// Homebrew on Apple silicon, Homebrew on Intel, MacPorts.
const TMUX_BINS = Object.freeze(["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/opt/local/bin/tmux"]);
// tmux takes one command of 16 KB at most (MAX_IMSGSIZE), so text goes in pieces well under that.
const TMUX_PIECE = 4096;
const TMUX_PANE = /^%\d{1,9}$/;
const TERMINAL_ID = /^[A-Za-z0-9_-]{1,100}$/;
// tmux gets no environment of ours: no $TMUX to confuse it, and a UTF-8 locale
// (with -u) so capture-pane doesn't turn ❯ and friends into underscores.
const TMUX_ENV = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" });

// The only keys the phone can press. Digits pick an option in a prompt without
// pressing Enter; Enter submits whatever is typed; Esc interrupts a turn.
// Superset takes the bytes; tmux takes its own key names (digits go in as text).
const KEYS = Object.freeze({
  // Arrows and Tab move through a picker on screen; Shift+Tab cycles Claude's permission mode.
  up: { text: ESC + "[A", submit: false, tmux: "Up" }, down: { text: ESC + "[B", submit: false, tmux: "Down" },
  right: { text: ESC + "[C", submit: false, tmux: "Right" }, left: { text: ESC + "[D", submit: false, tmux: "Left" },
  tab: { text: String.fromCharCode(9), submit: false, tmux: "Tab" }, stab: { text: ESC + "[Z", submit: false, tmux: "BTab" },
  ...Object.fromEntries(["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => [d, { text: d, submit: false, tmux: null }])),
  enter: { text: "", submit: true, tmux: "Enter" },
  esc: { text: ESC, submit: false, tmux: "Escape" },
});

function runFile(file, args, timeout = 15000, env) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, ...(env ? { env } : {}) }, (err, out, errOut) =>
      err ? reject(new Error(String(errOut || err.message).trim().slice(0, 300))) : resolve(out));
  });
}
function runSuperset(args, o = {}) { return runFile(SUPERSET, args, o.timeout || 15000); }

const executable = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };
const supersetInstalled = () => executable(SUPERSET);

// The tmux program: the first of the two usual places that holds one. Looked
// for again at most once a minute, so installing tmux needs no restart.
let tmuxFound = { at: -Infinity, bin: "" };
function findTmux() {
  if (Date.now() - tmuxFound.at > 60000) tmuxFound = { at: Date.now(), bin: TMUX_BINS.find(executable) || "" };
  return tmuxFound.bin;
}
function runTmux(args, o = {}) {
  const bin = findTmux();
  return bin ? runFile(bin, args, o.timeout || 5000, TMUX_ENV) : Promise.reject(new Error("tmux isn't installed"));
}

/** tmux's socket, if it may be used: an absolute path to a socket itself (not a link to one) that this user owns. Else "". */
function tmuxSocket(p, uid = process.getuid()) {
  if (typeof p !== "string" || !path.isAbsolute(p) || p.length > 1024) return "";
  let st;
  try { st = fs.lstatSync(p); } catch { return ""; }
  return st.isSocket() && st.uid === uid ? p : "";
}

/**
 * Text as one send-keys argument that tmux reads back as exactly this text.
 * tmux takes an argument ending in ";" for the end of a command (and drops the
 * ";"); one ending in "\;" for a literal ";".
 */
const tmuxLiteral = (t) => (t.endsWith(";") ? t.slice(0, -1) + "\\;" : t);

/** Text in pieces of at most `max` bytes of UTF-8, cut between characters, never inside one. */
function tmuxPieces(text, max = TMUX_PIECE) {
  const out = [];
  let cur = "", size = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (size + n > max && cur) { out.push(cur); cur = ""; size = 0; }
    cur += ch;
    size += n;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The bridges, over their programs. The seams are for the tests: superset and
 * tmux run the program with an argument list; hasTmux says whether tmux is
 * installed; uid owns the sockets; alive(pid, started) is the fresh liveness
 * check; gap(text) is how long tmux waits between text and its Enter.
 */
function createBridges(o = {}) {
  const superset = o.superset || runSuperset;
  const tmux = o.tmux || runTmux;
  const hasTmux = o.hasTmux || (() => !!findTmux());
  const uid = o.uid ?? process.getuid();
  const alive = o.alive || stillRunning;
  // A burst of text and an Enter right behind it reads as a paste with a line
  // break in it. Let the text land first (the agents need longer for more).
  const gap = o.gap || ((text) => Math.min(1000, 150 + text.length));
  const wait = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  function supersetBridge(ws, term) {
    const send = (text, submit) => superset(["terminals", "send", "--workspace", ws, "--terminal", term, "--text", text,
      ...(submit ? [] : ["--no-submit"])]);
    return {
      name: "superset",
      key: `superset:${ws}/${term}`,
      read: async () => String(JSON.parse(await superset(["terminals", "read", "--workspace", ws, "--terminal", term, "--json"])).text || ""),
      type: send,
      press: (k) => send(k.text, k.submit),
      ready: async () => "",
    };
  }

  function tmuxBridge(sock, pane, server) {
    const t = (...args) => tmux(["-u", "-S", sock, ...args]);
    const literal = async (text) => { for (const piece of tmuxPieces(text)) await t("send-keys", "-t", pane, "-l", "--", tmuxLiteral(piece)); };
    // Pane ids start again at %0 when a tmux server restarts on the same socket.
    // Another server means the recorded terminal is gone, like a closed Superset terminal.
    const sameServer = (pid) => { if (Number(pid) !== server) throw new Error("that tmux server is gone"); };
    return {
      name: "tmux",
      key: `tmux:${sock}:${server}:${pane}`,
      // One tmux call: which server this is, then the screen (";" alone separates tmux commands).
      async read() {
        const out = String(await t("display-message", "-p", "-t", pane, "#{pid}", ";", "capture-pane", "-p", "-t", pane));
        const nl = out.indexOf("\n");
        sameServer(out.slice(0, nl < 0 ? out.length : nl).trim());
        return nl < 0 ? "" : out.slice(nl + 1);
      },
      async type(text, submit) {
        if (text) await literal(text);
        if (!submit) return;
        if (text) await wait(gap(text));
        await t("send-keys", "-t", pane, "Enter");
      },
      press: (k) => (k.tmux ? t("send-keys", "-t", pane, k.tmux) : literal(k.text)),
      // The same server, and not scrolled back in copy mode, where keys are copy-mode commands, not input for the agent.
      async ready() {
        const [pid, mode] = String(await t("display-message", "-p", "-t", pane, "#{pid} #{pane_in_mode}")).trim().split(" ");
        sameServer(pid);
        return mode === "0" ? "" : "Its tmux pane is scrolled back in copy mode. Leave that on the Mac (Esc or q) first.";
      },
    };
  }

  /** The bridge to a session's terminal, from its record; null when it has none (read-only). */
  function of(e) {
    if (!e) return null;
    if (typeof e.pane === "string" && TMUX_PANE.test(e.pane) && pidOf(e.tmux_pid) && hasTmux()) {
      const sock = tmuxSocket(e.tmux, uid);
      if (sock) return tmuxBridge(sock, e.pane, e.tmux_pid);
    }
    if (TERMINAL_ID.test(String(e.workspace || "")) && TERMINAL_ID.test(String(e.terminal || ""))) return supersetBridge(e.workspace, e.terminal);
    return null;
  }

  /**
   * What the phone may do with a session, for its list and screen. `live` is the
   * service's cached answer, so a poll stays cheap; every write checks again,
   * fresh (writable). `why` says, in a few words, why it's read-only.
   */
  function caps(e, live) {
    const b = of(e);
    const known = !!(e && e.pid && e.started);
    const can = !!b && known && !!live;
    const why = !b ? "Start it with airpocket run and the phone can answer." : !known ? "Airpocket doesn't know which process runs it."
      : !live ? "Its agent has exited." : "";
    return { bridge: b ? b.name : null, read: !!b, send: can, keys: can, controls: can, why };
  }

  /** The bridge to type into, or { error, message } when typing into it isn't safe. Checked at the moment of use. */
  async function writable(e) {
    const b = of(e);
    if (!b) return { error: "no_route", message: "This session isn't in a terminal Airpocket can type into, so it's read-only here. Start it with airpocket run and the phone can answer." };
    if (!alive(e.pid, e.started)) return { error: "ended", message: "Its agent has exited, so Airpocket won't type into that terminal." };
    let why;
    try { why = await b.ready(); } catch { return { error: "unreachable", message: "Couldn't reach its terminal. It may have been closed." }; }
    return why ? { error: "not_ready", message: why } : { bridge: b };
  }

  return { of, caps, writable };
}

module.exports = { createBridges, KEYS, tmuxSocket, tmuxLiteral, tmuxPieces, runFile, runSuperset, runTmux, findTmux, supersetInstalled, TMUX_BINS };

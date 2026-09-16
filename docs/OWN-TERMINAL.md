# Own-terminal mode: options

Airpocket reaches a session through a bridge: a Superset terminal or a tmux
pane. People with neither get a read-only session on the phone. Own-terminal
mode fills that gap: `airpocket run claude` (or `codex`) starts the agent
somewhere Airpocket can reach, and it shows up in the user's own terminal
window as well.

Walkie (the earlier prototype) did this with node-pty: it ran the agent in a
pseudo-terminal it owned, copied the output to the terminal that launched it,
and sent the same stream to the phone, where xterm.js drew it. The lessons
that carry over are in Airpocket already: paste the text, wait, then press
Enter from the Mac; queue input from the phone so nothing interleaves.

This note was the comparison before the build. Option A is built (step 10b):
`src/ownterm.js`, `src/tmux.conf`, `airpocket run` and `airpocket attach`,
the aliases in setup, and the trial `docs/reference/try-own-terminal.js`. What
the trial found is at the end.

## What decides it

- **Decision 1, packaging.** Either a Homebrew formula that depends on Node,
  or one self-contained program (Node's single-executable build, or Bun's
  `--compile`). Both work for plain JavaScript. A native addon (a `.node`
  file) works in the first and is awkward in the second: it can't be embedded
  and loaded from inside the program, so it has to be unpacked to disk first
  and signed for Gatekeeper, for each CPU.
- **Few dependencies.** Today there are none: plain Node. (`ws` was Walkie's.)
  B would add the first two, C the first one.
- **The agent must outlive Airpocket.** The service restarts: upgrades,
  crashes, logging out and in. If the service owns the terminal, a restart
  kills every session in it.
- **The user's own terminal must still feel normal**: resizing, scrolling,
  copy and paste, Esc without a delay, Shift+Enter.
- **Airpocket must be able to type into it safely**: a fixed address, owned by
  this user, and the same liveness check as the other bridges.

## The options

### A. A private tmux session the user attaches to

`airpocket run claude` runs, in the user's terminal:

```
tmux -S "<data folder>/tmux/sock" -f "<Airpocket's tmux.conf>" \
     new-session -A -s <name> -c "$PWD" -- claude …
```

The agent's hook records `TMUX_PANE` and the socket as it does for any tmux
session, and the tmux bridge from step 7 does the rest. The socket sits in
Airpocket's own folder (0700), apart from the user's own tmux server and its
default socket.

- Native code: none of ours. tmux itself, from Homebrew.
- New code: the `run` and `attach` commands and a short tmux.conf. The bridge,
  its tests and its safety checks exist already.
- Survives a service restart: yes. The tmux server owns the terminal, not
  Airpocket. Closing the window detaches; `airpocket attach` brings it back.
- Resize, scrollback, true colour: tmux handles these. It needs a config to
  feel invisible: `status off`, `mouse on`, `escape-time 0` (otherwise Esc
  lags half a second), `extended-keys on` (Shift+Enter), clipboard through
  OSC 52, a large history.
- Screen for the phone: `capture-pane`. It is exact, because tmux keeps the
  screen itself.
- Packaging: the same under both choices. Homebrew: `depends_on "tmux"`.
  Single program: setup checks for tmux and offers `brew install tmux`.
- Risks: tmux shows through at the edges (copy mode on scroll, a prefix key).
  People who already use tmux get a second server they didn't ask for; the
  private socket keeps the two apart.
- Already in tmux or Superset: `$TMUX` is set inside tmux, and tmux refuses
  to nest ("sessions should be nested with care"). Inside Superset it works,
  but adds a layer for nothing. In both cases the existing bridges already
  reach the agent, so `run` should start the agent directly there.
- Socket path length: macOS caps a Unix socket path at 104 bytes; longer
  fails with `File name too long`. The default
  (`~/Library/Application Support/Airpocket/tmux/sock`) is about 55 bytes
  plus the user name, but a custom data folder (`$AIRPOCKET_DIR`) could pass
  the limit. `doctor` should check it.

### B. node-pty in the service, plus a JavaScript terminal emulator

The service spawns the agent in a pty it owns (node-pty). A small client
(`airpocket run`) connects to the service over a local socket and passes the
user's keys and the agent's output back and forth. `@xterm/headless` keeps
the screen for the phone.

- Native code: node-pty. Walkie used 1.0.0, which compiles at install (needs
  the Xcode command line tools, rebuilds on every Node major version). Newer
  releases ship prebuilt binaries, which helps with Homebrew and still leaves
  the single program having to unpack and sign a `.node` file.
- New dependencies: two (node-pty, @xterm/headless).
- New code: the most. An attach client, raw mode, resize, detach and
  reattach, what happens to output while nobody is attached.
- Survives a service restart: no. The pty dies with the service, and every
  session with it, unless the pty moves into a separate long-lived process.
  That process is a small tmux we would have to write and maintain.
- The user's terminal: the client passes bytes through, so it feels native.

A variant is Walkie's own shape: the pty lives in the foreground `airpocket
run` process, not the service. That survives a service restart but dies when
the window closes.

### C. macOS `script` plus a JavaScript terminal emulator

`/usr/bin/script` makes the pty, so there is no native addon. A Node wrapper
puts the user's terminal in raw mode, starts `script -q /dev/null claude` with
pipes, and passes through both the user's keys and the phone's input.
`@xterm/headless` reads the output to draw the screen for the phone.

- Native code: none. One JavaScript dependency (@xterm/headless).
- Resize: broken. With a pipe on its input, `script` can't pass window size
  changes to the pty. The agent keeps its first size, and its TUI tears when
  the window changes. There is no clean fix without a pty of our own.
- Survives a service restart: yes, if the wrapper is the foreground process.
  It dies when the window closes, like Walkie.
- The screen on the phone is our emulator's guess, not the terminal's own
  screen. That is good enough for Claude and Codex, but it is one more thing
  that can drift.

### D. No own-terminal mode

Say "use Superset or tmux" and leave everyone else read-only. Nothing to
build, and a worse first run for exactly the people this mode is for.

## Side by side

|                                | A: private tmux | B: node-pty in service | C: script + emulator |
| ------------------------------ | --------------- | ---------------------- | -------------------- |
| Native addon                   | no              | yes                    | no                   |
| Fine as one self-contained program | yes         | awkward                | yes                  |
| New npm dependencies           | 0               | 2                      | 1                    |
| Agent survives service restart | yes             | no                     | yes                  |
| Survives closing the window    | yes (detach)    | yes                    | no                   |
| Window resize                  | yes             | yes                    | no                   |
| Phone screen                   | tmux's own      | our emulator           | our emulator         |
| New code                       | small           | large                  | medium               |
| Needs installed                | tmux            | nothing                | nothing              |

## Recommendation: A, a private tmux session

It is the only option that holds under both packaging choices without a
native addon, keeps agents alive through Airpocket's own restarts and
upgrades, and gets resize and scrollback right. It reuses the tmux bridge
that step 7 built and tested, with the same checks: an absolute socket that
is a real socket this user owns, and typing only while the recorded agent
process runs. The cost is tmux as a dependency (one line in a Homebrew
formula, one check in `airpocket doctor`) and a tmux.conf tuned so it stays
out of the way.

If people find that tmux shows through too much, B is the fallback, but only
with a prebuilt node-pty, only if packaging lands on Homebrew with Node, and
with the pty in a process that outlives the service.

### What building A would take (later)

1. `airpocket run claude|codex [args]` and `airpocket attach [name]`, using
   the private socket in the data folder and a shipped tmux.conf.
2. The tmux.conf: `status off`, `mouse on`, `escape-time 0`,
   `extended-keys on`, `set-clipboard on`, `history-limit 50000`,
   `default-terminal tmux-256color` with RGB.
3. `airpocket doctor` checks tmux is installed and new enough (3.2 or later
   for extended keys), and that the socket path is under 104 bytes; setup
   offers `brew install tmux`.
4. Inside tmux or Superset already, `run` starts the agent in place instead
   of a nested session.
5. A real-tmux test like step 7's, through `run`, on a temporary socket.

## What the trial found (step 10b)

`docs/reference/try-own-terminal.js` plays the terminal window (a pty with
pyte, answering tmux's queries like iTerm2, or like a terminal that doesn't
answer XTVERSION). It ran 54 checks that passed and 1 that failed, with tmux
3.6a and Claude Code 2.1.273.

Works as through a plain terminal, compared side by side with Claude run
directly: Shift+Enter (CSI u and xterm encodings) and Option+Enter put a
newline in the box; a three-line paste stays in the box; Ctrl+V pastes an
image; Esc interrupts a turn (70 to 130 ms from key to "Interrupted" either
way); Ctrl+C, Ctrl+U, Ctrl+R, Ctrl+O, Ctrl+D work. Resize redraws at the new
width. The wheel scrolls back; scrolling to the end, or typing, leaves
scrollback, and the typed key lands in the box. Dragging copies to the Mac's
clipboard (pbcopy) and to the terminal's (OSC 52). Closing the window leaves
Claude running and reachable from the phone; `airpocket attach` brings it back
with its scrollback; the service restarting doesn't touch it; `/exit` ends it
all.

**The failure: Esc can lag 500 ms for the first seconds after attaching.**
tmux holds a lone Esc for at least 500 ms, whatever `escape-time` says, while
the outer terminal hasn't answered its startup queries (DA1, DA2, XTVERSION),
for at most 5 seconds (tmux 3.6a, `tty-keys.c`). It also does this while a
colour query is pending, which it repeats after a resize (at most every 30 s)
or a theme change, until the terminal answers. A terminal that answers all of
them (iTerm2, Ghostty, kitty, WezTerm) sees no delay at all. One that doesn't
answer XTVERSION, which may include Terminal.app (not tried in a real window),
gets 500 ms Esc for about 5 s after each `run` or `attach`, then none. No tmux
option changes this. It is short and bounded, so option A stands, but it is a
place where tmux shows through.

Also found:
- Codex asks for the kitty keyboard protocol, which tmux 3.6a doesn't accept
  as a request, so with `extended-keys on` Codex would get Shift+Enter as a
  plain Enter and send the prompt. The conf uses `extended-keys always` with
  the CSI u format; a stand-in agent that asks the way Codex does gets
  Shift+Enter as `ESC[13;2u` and Ctrl+C as its plain byte. Codex's own prompt
  box through `run` isn't tried (it needs a login; step 13).
- When the agent exits, tmux leaves its alternate screen: the window shows
  what was there before `claude` was typed, plus `[exited]`, rather than the
  end of the conversation as Claude run directly would leave it.
- The window's `airpocket` (node) process stays as the tmux client's parent
  while attached: about 30 MB resident per open window (measured with Node 20).

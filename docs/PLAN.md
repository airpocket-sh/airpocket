# Plan

Airpocket is the phone side of a private tool (claude-overlay's `overlay/mobile`),
cut loose from the desktop panel it lived in and made installable by anyone on
macOS. It also carries on an earlier private prototype, Walkie, whose own
terminal mode becomes the option for people without Superset or tmux.

## Decisions

- Phone web app only. The floating desktop panel stays private.
- No account switching or usage screen (that was a personal tool).
- No relay and no hosted service: loopback servers, published with
  `tailscale serve` (never `funnel`).
- Free and open source (MIT), shared as-is, macOS first.
- Private repo until launch; public on launch day.

## What moves over, as it is

Pairing and per-device tokens, the session list and waiting list, the chat view
(Claude transcripts, Codex session files read live), live state from the
screen, the Controls sheet (fixed command tables), new sessions through
Superset, file viewing with the file-only origin, the UI, and the test suite.

## What changes

1. **A small background service replaces the desktop panel.** It owns the
   session registry, the waiting list (enqueue, dequeue, seen, expiry) and the
   Codex app-server connection for approvals, and receives the hooks. Biggest
   piece.
2. **Terminal bridges.** Superset (today), tmux, and Walkie-style sessions the
   service runs itself. Without a bridge, sessions are read-only.
3. **Model line without a custom status line.** Read what Claude Code and
   Codex show on their own screens and in their session files.
4. **Model lists from the agents**, not hard-coded names that go stale.
5. **One-command install and uninstall.** Hooks for Claude and Codex, a login
   item, `tailscale serve` for both ports, a pairing code. No Remote Control
   switched on for anyone.
6. **Remove everything personal**: names in identifiers, paths, account names.
7. **Security write-up and review** before launch.
8. **Fresh-Mac test** on a new macOS user account.
9. **Launch**: README, a short demo video, the post.

## Design

Öncel designs the look: a fighter-jet, flight-screen theme (cockpit, HUD). The
phone UI step waits for those designs; the current warm palette is a
placeholder carried over from the private tool.

## Build steps

Decide first
1. Runtime: require Node (Homebrew) or ship one self-contained program.
2. v1 scope: Superset and tmux bridges, then own-terminal mode in v1 as step
   10b (decided 2026-09-16: watching already works anywhere, so only typing
   needs a bridge, and one mechanism covers every terminal); drop the Codex
   desktop-daemon link.
3. Its own ports, so it runs beside the private tool during the build.

Build
4. [done, PR #1] Carry over the phone code (server, pairing, web app, tests), renamed. Done
   when the current tests pass here.
5. [done, PR #2] The background service replacing the desktop panel: session registry and
   waiting list (expiry, seen). Done when sessions appear, wait and clear with
   no panel.
6. [done, PR #3] One hook for Claude and Codex: start, prompt, finished, question, end,
   where the transcript lives, which terminal. Done when sessions from several
   accounts land in one list.
7. Terminal bridges: Superset, tmux, then own-terminal mode; read-only without
   one, with the phone hiding what it can't do.
8. Model and status from what the agents show themselves; model lists that do
   not go stale.
9. The phone app for the public: the new design, Airpocket name and icon, no
   Accounts screen, first-run guidance, QR pairing.
10. setup / doctor / uninstall: hooks, login item, Tailscale for both
    addresses, QR; uninstall removes exactly what setup added.
10b. Own-terminal mode, so the phone works whatever terminal people use:
    `airpocket run claude|codex` starts the agent in a private tmux session
    (docs/OWN-TERMINAL.md, option A) with the user's own terminal attached, and
    `airpocket attach` brings a detached one back. Setup offers the alias
    (`alias claude='airpocket run claude'`) so muscle memory doesn't change.
    Inside tmux or Superset it starts the agent directly instead of nesting. A
    session started the old way stays read-only and says in one line how to
    reach it. Prove in a real session: Esc with no delay, Shift+Enter,
    clipboard, pasting an image, resize and scrollback.
11. Security pass: threat model, review, secret scan of code and history,
    dependency audit, SECURITY.md.
12. Tests on GitHub Actions (macOS) for every change.

Prove it, then launch
13. Öncel switches his own Macs over for a few days; the private tool's phone
    part retires (the panel stays private). Phones pair with Airpocket fresh:
    it is a separate app with its own tokens, and nothing carries over.
    Also, once and on purpose: Controls → Effort in one of his own Claude
    sessions, to see that the command runs on its first Enter (in step 8's
    trial it seemed to wait for something on screen), then set it back.
    Claude saves /effort as the default for new sessions of that model, so
    no trial or test may run it.
    Also once, on the phone: add Airpocket to the Home Screen, tap "Scan the
    code on your Mac", and see whether iOS grants the camera in a Home Screen
    web app, whether it asks again on every launch, and whether the stream
    survives the app going to the background. Step 9 could not test this (no
    simulator, and a tailnet trial needed Öncel's OK), so pairing opens on the
    six digits and the scan is one tap away. If it works, flip SCAN_FIRST in
    app.js.
    And Codex end to end: use Codex once so its login refreshes, then run
    `node docs/reference/try-codex.js`. Step 10 stopped short of this because a
    throwaway copy would have refreshed the login and signed the real one out.
    With Codex logged in, also try its prompt box through `airpocket run`:
    step 10b could not, and Codex asks for the kitty keyboard protocol, which
    is why the tmux conf uses `extended-keys always`.
14. Fresh-Mac test from the README alone: Superset and tmux, Claude and Codex,
    a second Mac, a real iPhone including a PDF. Include Terminal.app, the
    terminal a new Mac actually has: if it doesn't answer XTVERSION, `airpocket
    run` gives a 500 ms Esc for the first five seconds (tmux waiting on a
    terminal query, see docs/OWN-TERMINAL.md), which is the first thing a new
    user would feel.
15. Launch material: README with screenshots, a short demo video, FAQ, first
    release.
16. Go public: final secret scan, remove `private: true` from package.json,
    repo public, buy airpocket.sh last and point it at the repo or a small page
    with the install command, post on X. Öncel decides three things first, all
    found in step 11's review and all easier before anyone has cloned it:
    - his personal Gmail address is the author of the commits, and goes public
      with the history unless it is rewritten now;
    - `claude-overlay`, `claude-accounts`, port 47820 and his name appear in
      AGENTS.md, PLAN.md and `docs/reference/shoot.js`;
    - Node 20 reached end of life in April and is still in `engines` and CI.

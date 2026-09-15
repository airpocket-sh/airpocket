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
2. v1 scope: Superset and tmux bridges; the Walkie-style own-terminal mode in
   v1 or just after; drop the Codex desktop-daemon link.
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
11. Security pass: threat model, review, secret scan of code and history,
    dependency audit, SECURITY.md.
12. Tests on GitHub Actions (macOS) for every change.

Prove it, then launch
13. Öncel switches his own Macs over for a few days; the private tool's phone
    part retires (the panel stays private). Phones pair with Airpocket fresh:
    it is a separate app with its own tokens, and nothing carries over.
14. Fresh-Mac test from the README alone: Superset and tmux, Claude and Codex,
    a second Mac, a real iPhone including a PDF.
15. Launch material: README with screenshots, a short demo video, FAQ, first
    release.
16. Go public: final secret scan, repo public, buy airpocket.sh last and point
    it at the repo or a small page with the install command, post on X.

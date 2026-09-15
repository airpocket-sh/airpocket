# Plan

Windsock is the phone side of a private tool (claude-overlay's `overlay/mobile`),
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

## Sessions

1. Service skeleton: registry, waiting list, hook endpoints, phone server
   started from it; tests carried over.
2. Terminal bridges (Superset, tmux, own PTY) and read-only fallback.
3. Installer and uninstaller; generic model and status detection.
4. Clean-up, security review, docs.
5. Fresh-Mac test, fixes, demo and launch.

## What changed, and why

<!-- The problem first, then what this does about it. Link the issue if there
is one. If you decided something a reviewer might have decided differently,
say what and why. -->

## How it was tested

<!-- Paste the end of each run. Say which macOS and Node you ran them on. -->

- [ ] `npm test` passes on macOS
- [ ] `npm run smoke` passes on macOS
- [ ] Tests I added fail when the change is taken out
- [ ] Anything checked by hand is described here, with its output

## Rules this change keeps

- [ ] Nothing reaches the network: no telemetry, no update check, no request
      that leaves the phone, the Mac and the user's own tailnet. Servers stay
      on 127.0.0.1, published with `tailscale serve`, never `funnel`.
- [ ] No test or trial types text, keys or commands into a real session, runs
      `/model` or `/effort` in a real Claude Code, or writes the real
      `~/.claude/settings.json`, `$CODEX_HOME` or the login item. Tests point
      `HOME` (and `CODEX_HOME`) at a temporary folder.
- [ ] No new dependencies.

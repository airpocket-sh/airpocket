# Airpocket

Your coding agents, on your phone. Every Claude Code and Codex session on every
one of your Macs, in one list, with the ones waiting on you first. Read the
conversation, reply, answer questions, switch models, start new sessions and
open the files they made, from anywhere.

Nothing sits in between: your phone talks to your Macs over your own
[Tailscale](https://tailscale.com) network. There is no Airpocket server, no
account and no relay.

> **Status: private, work in progress.** Not ready to install yet. See
> [docs/PLAN.md](docs/PLAN.md).

## What it will do

- **One list** of every session on every paired Mac: needs you, open, earlier.
- **The conversation**, not the raw terminal: messages, answers, one line per
  step, updated live, including Codex mid-turn.
- **Reply and control**: send messages, press keys, pick options on screen,
  change model, effort and permission mode, compact, resume and more.
- **Start sessions** in a project, on a new branch or an existing workspace
  (with Superset).
- **Open files** a session wrote or linked: text, Markdown, code, images,
  PDFs, pages, under strict rules.
- **A web app**, added to your home screen. No App Store.

## Install (macOS)

You need Node 20 or newer, [Tailscale](https://tailscale.com/download/mac)
signed in with HTTPS certificates turned on for your tailnet, and Claude Code
or Codex. tmux is optional (for sessions you run in tmux).

```sh
npm install -g airpocket
airpocket setup --dry-run   # every change it would make; changes nothing
airpocket setup
```

Setup checks first and stops with a plain explanation if something is
missing. Then it:

- adds Airpocket's hooks to `~/.claude/settings.json` and `~/.codex/hooks.json`
  (or under `$CLAUDE_CONFIG_DIR` and `$CODEX_HOME`). It merges: every other
  setting and hook stays as it was, a timestamped backup is written next to the
  file first, and a file that isn't valid JSON is left alone. Running it again
  adds nothing twice.
- adds a login item (`~/Library/LaunchAgents/sh.airpocket.service.plist`) that
  starts Airpocket at login and brings it back after a crash. It runs a copy of
  Airpocket kept in its data folder, so it works the same after `npx airpocket
  setup`.
- publishes the app and its file-only origin inside your tailnet with
  `tailscale serve` (never `funnel`), on ports nothing else uses: 443 and
  8443 when they are free.
- prints a pairing code and its QR.

Codex asks you to review new hooks the next time it starts: choose to trust
Airpocket's, or open `/hooks`. A Codex session shows up on the phone once
you've sent it a first message.

```sh
airpocket doctor      # checks everything, says what to do; exits 1 if something is broken
airpocket pair        # a new pairing code
airpocket devices     # paired phones; airpocket revoke <id> cuts one off
airpocket uninstall   # removes exactly what setup added; asks before deleting paired phones
```

**Tested so far:** setup, doctor and uninstall against a temporary home folder
(with the real launchd in a trial), Claude Code end to end with real
sessions, and Codex against recorded session files and a real Codex's hooks
(installed, trusted, firing). Codex with real model replies driven from the
phone has not been run end to end yet.

## Security in one paragraph

Airpocket listens on 127.0.0.1 and is published only inside your tailnet. Each
phone gets its own token for a one-time pairing code; the Mac keeps only
hashes. The phone never sends a file path or command text: it names a session
and an action, and the Mac looks up the rest in its own records. Files are
limited to what a session made or mentioned, inside its own folder, checked by
content, and PDFs and pages open from a separate file-only origin through
two-minute links.

## License

MIT. The fonts in `src/public/fonts` (B612, B612 Mono, IBM Plex Sans) are under the
SIL Open Font License; their licences sit next to them.

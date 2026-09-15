# Airpocket: brief for the agent building it

Read this and docs/PLAN.md before touching anything. Öncel (the owner) talks to
you directly; a separate Claude session supervises and reviews each step.

## What this is

Airpocket is a phone web app (added to the home screen) that shows every
Claude Code and Codex session on every paired Mac, lets you read the
conversation, reply, answer questions, change model and mode, start sessions
and open the files they made. It talks to each Mac over the user's own
Tailscale network. No server of ours, no account, no relay. Free, MIT, macOS
first, private repo until launch.

It already exists as the phone part of Öncel's private tool. Your job is to
carry it over, cut it loose from that tool's desktop panel, and make it
installable by anyone. docs/PLAN.md has the build steps in order.

## Where the code comes from (read only)

`~/Developer/claude-overlay` is Öncel's live private tool. **Never modify it,
never restart it, never change its data or ports.** Copy from it.

- `overlay/mobile/server.js`: the phone API server and the file-only server.
  Claude transcript parser, Codex session-file reader, live state from the
  terminal screen, model/effort/mode detection, the Controls command table,
  new sessions through Superset, file viewing with all its rules, "seen".
  The Accounts routes are Öncel's personal tool: drop them.
- `overlay/mobile/store.js`: pairing codes and device tokens.
- `overlay/mobile/cli.js`: pair, devices, revoke, serve, unserve, status.
- `overlay/mobile/public/`: the web app (plain DOM, no framework), safe
  Markdown renderer, styles, service worker, manifest, icons.
- `overlay/mobile/test.js`: the node:test suite (fake Superset, fake panel,
  temp dirs). It must keep passing here.
- `overlay/main.js`: the desktop panel. Not carried over, but its waiting-list
  logic is what step 5 reimplements: `enqueue`, `dequeue`, `sweep`,
  `kindOf`, `knownSessions`, and the `/enqueue`, `/dequeue`, `/touch` routes.
- `hooks/claude-attention.sh`: the hook that records sessions (session id,
  cwd, title, account, pid, Superset terminal and workspace ids) and calls
  the panel. Step 6 replaces it with an Airpocket hook.
- `README.md`, section "Phone": the user-facing description and security list.

Airpocket must not depend on: the desktop panel (port 47820), claude.ai,
`~/.claude-accounts` (never read `accounts.json`), or Öncel's custom Claude
status line.

## Security rules (non-negotiable)

- Servers listen on 127.0.0.1 only. Published with `tailscale serve`, never
  `tailscale funnel`.
- Each phone pairs with a six-digit code (ten minutes, five tries) and gets
  its own random token; the Mac stores only SHA-256 hashes and compares in
  constant time. Auth is a bearer header. No cookies. Revoke works at once.
- CORS only for `*.ts.net` and loopback origins. Strict CSP on the app.
- The phone never sends a file path or command text. It names a session and
  an action; the Mac looks up the terminal, the path or the slash command in
  its own records and fixed tables. Keys come from an allow-list. Typed text
  loses control characters; a newline would press Enter.
- Controls commands are refused while a turn runs, a menu is open, or unsent
  text sits in the box.
- Files: only what that session wrote, edited, cited or linked (never what it
  only read), by opaque ref (HMAC with a per-process secret), re-checked at
  use; only inside the session's folder by real path; never the home folder,
  hidden files or folders (Superset workspaces excepted, never `~/.superset`
  itself), node_modules, files with extra hard links, key or secret names, or
  text matching key/token patterns; kinds verified by their first bytes. Text
  and images through the authenticated API; PDFs and HTML only through
  two-minute single-file links on a separate file-only origin; HTML there runs
  no scripts. Nothing cached.
- What leaves the Mac for a conversation: the user's messages, the agent's
  replies, one short label per step. Never tool output, full command lines,
  file contents (unless the user opens that file), or the model's context.
- Logs never contain tokens, query strings, bodies or file contents.

## Hard-won facts

- **Superset CLI** (`~/.superset/bin/superset`): `terminals read|send
  --workspace W --terminal T [--json]`; `send --no-submit` types without
  Enter; empty text plus submit is Enter; a raw ESC byte arrives intact; each
  call takes about 0.6 s. `agents create --workspace W --agent claude|codex
  [--model] [--effort] --prompt P`; `workspaces create --local --project P
  --branch B --agent A --prompt P`; `agents list --local --json`; `projects
  list --json`. Never read `~/.superset/config.json`.
- **Hooks**: Codex reads `~/.codex/hooks.json` once at launch. Superset puts
  `SUPERSET_TERMINAL_ID` and `SUPERSET_WORKSPACE_ID` in the agent's
  environment; tmux puts `TMUX_PANE`. Claude's hook input carries
  `transcript_path`, which also covers `CLAUDE_CONFIG_DIR` setups.
- **Claude transcripts**: `~/.claude/projects/<slug>/<session>.jsonl`, can be
  100 MB: read the tail. `/model <alias>` also saves the default for new
  sessions. `/effort <low|medium|high|xhigh|max>` (the bare picker is a
  slider). Shift+Tab cycles modes; the mode line reads `⏵⏵ <mode> on`; the
  effort marker `◐ medium · /effort`; an empty box may show `Try "…"`.
- **Codex**: for terminal-hosted threads the app-server daemon reports a
  running turn as "interrupted" with only the prompt. Read the session file
  instead: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`
  (thread ids are UUIDv7, so the id gives the local date), one
  `event_msg`/`item_completed` per step, `turn_context` for model, effort and
  plan mode. Browser and MCP results make lines up to ~1 MB: widen the tail
  until it holds enough steps. The TUI draws braille dots (U+2800 to U+28FF)
  over its lower rows: strip them. Menus use `›` as the cursor, descriptions
  after two or more spaces. `/model` and `/permissions` open numbered pickers;
  `/fast` and `/plan` exist.
- **Tailscale**: run the CLI by its real path
  (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`); through the
  `/usr/local/bin` symlink it aborts. From a launchd process `status --json`
  returns no DNSName: take the tailnet host from the request's Host header
  (tailscale serve forwards it). The first HTTPS request after enabling serve
  can take over 15 s while the certificate is issued.
- **macOS paths**: `/var` is `/private/var`. Compare real paths; resolve a
  session's relative paths from the folder it recorded.
- **iOS**: a home-screen web app has storage separate from Safari (pair inside
  it). A popup opened after an await may be blocked: use a tap on a real
  `<a target=_blank rel="noopener noreferrer">`. There is no iOS simulator on
  this Mac (Command Line Tools only).
- **Tool environment**: Claude Code's Bash tool rejects commands containing
  raw control characters, and typed `\u` escapes can arrive as raw bytes.
  Build them in source (`String.fromCharCode(27)`). zsh does not word-split an
  unquoted `$VAR`. `replaceChildren` does not flatten arrays.
- **Shell traps (zsh)**: never name a variable `path` (it is the PATH array;
  every command after it goes missing). `$var:t...` applies a modifier, so
  write `${var}:file`. The Mac has an `rtk` hook that rewrites `git diff`
  and `grep` output into short summaries: use `rtk proxy git diff` when you
  need the real lines.
- **Probing a TUI**: run it in a hidden pty (Python `pty` + `pyte`). An
  untrusted folder shows a trust prompt: Codex's default answer is Yes and
  writes a trust entry to `~/.codex/config.toml` (remove it), Claude's is
  "No, exit". Start Claude with `--settings '{"remoteControlAtStartup":false}'`
  so it does not register a Remote Control session.

## Testing

- `node --test`. Everything in temp directories. Never write the real
  `~/.claude/settings.json`, anything in `~/.codex`, or the private tool's
  data (`overlay/sessions`, `queue.json`,
  `~/Library/Application Support/claude-overlay`).
- Checking against real sessions: start a throwaway server instance on another
  loopback port with a temporary pairing store, give it an empty waiting list
  and a panel stub that blocks `/dequeue`, so nothing real changes.
- Screenshots: headless Chrome over the DevTools protocol at 390x844, scale 2
  (`docs/reference/shoot.js` is the harness used for the private tool).
- Never send text, keys or commands into Öncel's real sessions while testing.
- The private tool owns HTTPS ports 443 and 8443 on this Mac. Do not change
  Tailscale serve settings without Öncel's OK.

## Working agreement

- One branch per build step: `step-<n>-<slug>`. Commit as you go, push the
  branch, never merge to main. At the end of a step, stop and report: what
  changed, how you tested it (with output), what is left. The supervisor
  reviews; Öncel merges.
- Plain Node (CommonJS), no frameworks, DOM-only UI (no innerHTML, no HTML
  strings), as few dependencies as possible (`ws` today).
- The UI design is Öncel's (a fighter-jet, flight-screen theme). Until his
  designs arrive, keep the current look as a placeholder; do not restyle.
- Write to Öncel plainly and briefly; he reads on his phone.

## Where the code stands

- Step 4 is merged (PR #1): `src/server.js` (phone API + file-only server),
  `src/store.js`, `src/cli.js` (`airpocket pair|devices|revoke|serve|unserve|status`),
  `src/ports.js` (47871/47872, public 443/8443 until step 13, `AIRPOCKET_*`
  variables), `src/service.js` (stand-ins), `src/public/`, `test/server.test.js`.
- The server reaches the service through three seams passed to
  `createServer()`: `knownSessions()`, `getQueue()`, `service(method, path, body)`.
  Step 5 replaces the stand-ins; keep a test that builds `createServer()` with
  no stubs.

## Decisions waiting for Öncel (proposed defaults)

1. Runtime: Node 20+ during the build; packaging (Homebrew with Node, or one
   self-contained program) decided at step 10.
2. v1 bridges: Superset and tmux; the own-terminal mode right after; drop the
   Codex desktop-daemon link.
3. Ports: 47871 (app) and 47872 (files) on loopback; public HTTPS ports
   decided at step 13.

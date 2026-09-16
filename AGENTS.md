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
- **Hooks**: Codex reads `~/.codex/hooks.json` once at launch. Codex (0.154)
  runs a hook only after you trust it: new ones are listed as "N hooks need
  review before they can run", reviewed in `/hooks`, and remembered in
  `config.toml` as `[hooks.state."<hooks.json>:<snake_event>:<group>:<hook>"]`
  with a `trusted_hash`. The key is a position, so add groups at the end and
  never insert. Codex's events: PreToolUse, PermissionRequest, PostToolUse,
  PreCompact, PostCompact, SessionStart, SessionEnd, UserPromptSubmit,
  SubagentStart, SubagentStop, Stop, Interrupt; handlers take `timeout`.
  Superset's `codex` wrapper may set `CODEX_HOME` to its own account folder
  inside a Superset terminal. Superset puts
  `SUPERSET_TERMINAL_ID` and `SUPERSET_WORKSPACE_ID` in the agent's
  environment; tmux puts `TMUX_PANE`. Claude's hook input carries
  `transcript_path`, which also covers `CLAUDE_CONFIG_DIR` setups.
- **Claude transcripts**: `~/.claude/projects/<slug>/<session>.jsonl`, can be
  100 MB: read the tail. `/model <alias>` also saves the default for new
  sessions. `/effort <low|medium|high|xhigh|max>` (the bare picker is a
  slider). Shift+Tab cycles modes; the mode line reads `⏵⏵ <mode> on`; the
  effort marker `◐ medium · /effort`; an empty box may show `Try "…"`.
- **`/effort` and `/model` write the user's real settings.** `/effort low`
  saves `modelSettings.<model>.effortLevel` in `~/.claude/settings.json`
  ("saved as your default for new sessions"), even with `--setting-sources
  project`. Never run either in a trial or a test against a real Claude.
- **What a Claude transcript records**: each reply's `message.model`
  (`<synthetic>` for an API error) and top-level `effort`; the permission
  mode on each prompt (`permissionMode`) and in a `permission-mode` entry
  rewritten with the session's metadata (`mode` is something else: "normal").
  `/model` and `/effort` output lands at once ("Set model to `Fable 5.1` …
  with `xhigh` effort", "Set effort level to low (…)"). Shift+Tab does not:
  the new mode reaches the transcript with the next prompt. Turn ends:
  `system/turn_duration`, `system/stop_hook_summary`, `[Request interrupted`.
- **Model lists**: Claude Code's own catalog is
  `~/.claude/cache/model-catalog/<id>-cc.json` (`catalog.config.models[]`:
  `id`, `name`, `thinking.effort_options`). Codex's is
  `$CODEX_HOME/models_cache.json`; its picker shows `visibility: "list"`
  only, ordered by `priority`, with `supported_reasoning_levels`.
- **Codex**: for terminal-hosted threads the app-server daemon reports a
  running turn as "interrupted" with only the prompt. Read the session file
  instead: `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`
  (thread ids are UUIDv7, so the id gives the local date), one
  `event_msg`/`item_completed` per step, `turn_context` for model, effort and
  plan mode. Browser and MCP results make lines up to ~1 MB: widen the tail
  until it holds enough steps. The TUI draws braille dots (U+2800 to U+28FF)
  over its lower rows: strip them. Menus use `›` as the cursor, descriptions
  after two or more spaces. `/model` and `/permissions` open numbered pickers;
  `/fast` and `/plan` exist. Settings changed between turns go into the file
  (`thread_settings_applied`: model, reasoning_effort, service_tier
  "priority" = fast, approval_policy, permission_profile, collaboration_mode)
  only as the next turn starts, a few ms before its `task_started`; until
  then only the status line shows them.
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
  so it does not register a Remote Control session. Add
  `--setting-sources project` so Öncel's own hooks (and the private tool)
  never hear of it. Answer the terminal's queries (subclass `pyte.Screen`,
  write `write_process_input` back to the pty) and type key by key:
  unanswered, Claude takes the first keys for the answer and prompts are lost.

## Testing

- `node --test`. Everything in temp directories. Never write the real
  `~/.claude/settings.json`, anything in `~/.codex`, or the private tool's
  data (`overlay/sessions`, `queue.json`,
  `~/Library/Application Support/claude-overlay`).
- **Only `airpocket setup`, run by Öncel himself, may write the agents'
  config files** (`~/.claude/settings.json`, `$CODEX_HOME/hooks.json`) or the
  login item in `~/Library/LaunchAgents`. No test, no trial and no agent may.
  Tests and trials run setup, doctor and uninstall with `HOME` (and
  `CODEX_HOME`) pointed at a temp folder, a stand-in launchctl and a
  stand-in Tailscale (`test/setup.test.js`), and check the real files'
  modification times at the end.
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
  strings), as few dependencies as possible (none today).
- The UI design is Öncel's (a fighter-jet, flight-screen theme). His design
  pack is in `docs/design` and the app follows it since step 9; change the
  look only from that pack or with his OK.
- Write to Öncel plainly and briefly; he reads on his phone.

## Where the code stands

- Steps 4 to 9, 11 (first half) and 12 are merged (PR #1 to #7, #9), and
  the lock-race fix (#8). `npm start` runs one process: the service with its
  hook endpoint, the phone server and the file-only server, all on
  127.0.0.1. 123 tests before #8.
- CI (`.github/workflows/test.yml`, step 12): macOS, Node 20 and 22, a syntax
  check, `node --test` with a real tmux, and `.github/smoke.js` (the real app
  on loopback with a temporary data folder and HOME).
- Security docs (step 11, first half): `docs/THREAT-MODEL.md`, `SECURITY.md`,
  `docs/SECURITY-REVIEW-CHECKLIST.md`.
- `src/service.js`: session records (`sessions/<id>.json`) and the waiting list
  (`queue.json`) in the data folder (`~/Library/Application Support/Airpocket`
  or `$AIRPOCKET_DIR`); folders 0700, files 0600, every write whole
  (temp file, fsync, rename). One service per data folder: `airpocket.lock`
  holds `"<pid> <start time>"`, written to a temp file and linked into place;
  a stale lock is renamed aside, and a live one moved by mistake is put
  back. A second service throws `ELOCKED` and writes nothing.
- Hook endpoint on 127.0.0.1:47873 (`AIRPOCKET_HOOK_PORT`), never published.
  `hook.json` = `{ port, secret }`, 0600, written only once it listens, new
  secret every start. `POST /hook/session | enqueue | dequeue | touch` with
  `Authorization: Bearer <secret>` and a JSON body naming the session:
  `session_id, agent (claude|codex), cwd, transcript, title, branch, note,
  account, pid, started, terminal, workspace, pane, tmux, tmux_pid` (empty
  fields keep the old value; a new pid never keeps the old start time).
  Except where the session runs: a hook from another process (a resumed
  session, a reused pid) replaces all five terminal fields (`terminal,
  workspace, pane, tmux, tmux_pid`), and empty stays empty, so nothing is
  kept from a terminal that may now hold only a shell. `enqueue` needs
  `reason`: finished | waiting for you | needs permission | needs input |
  needs a response. `dequeue` needs `why`: prompt | interrupt | end. Refused: Origin
  header, non-loopback Host, wrong secret, non-JSON, bodies over 16 KB.
  `transcript` is kept only if absolute and named after that session
  (`<id>.jsonl` for Claude, `rollout-…-<id>.jsonl` for Codex); `pane` must be
  `%<n>`, `tmux` (the socket) absolute. Note and message snippets that match
  the key/token patterns (`src/secrets.js`, shared with the file viewer) are
  dropped.
- `src/hook.js` (`node src/hook.js claude|codex`): the one hook. Reads
  `hook.json` every run; silent, 1.5 s limit, always exit 0, nothing when the
  service is down. Claude: SessionStart → session, UserPromptSubmit →
  dequeue prompt, Stop → finished, Notification permission / idle /
  elicitation → needs permission / waiting for you / needs a response (other
  notifications touch), SessionEnd → dequeue end; subagent events (with
  `agent_id`) ignored. Codex: the same plus PermissionRequest → needs
  permission ("Wants to use <tool>", never the input) and Interrupt →
  dequeue interrupt. Sends the agent's pid (first non-shell parent) and start
  time, the branch read from `.git`, the Claude account email from
  `$CLAUDE_CONFIG_DIR`, else the transcript's config folder, else
  `~/.claude.json` (only `.claude.json`, only `oauthAccount.emailAddress`).
  Not installed anywhere yet: that is step 10.
- `src/proc.js`: a process is its pid plus its start time (`ps -o lstart`,
  batched). A pid that exists is that process unless a start time was read
  and differs; one that can't be read proves nothing, so the session stays.
  The service caches one `ps` call per second; the phone's list asks it
  through `service.isLive(record)`.
- A record keeps `working_since` (ms, or 0): a prompt starts a turn; Stop,
  the idle prompt after it, a Codex interrupt and a new process end it.
  Esc in Claude fires no hook, so an interruption in the transcript ends it
  too.
- Waiting-list rules: finished = done, 20 minutes; the rest = input, 60
  minutes; one entry per session; a gone process leaves the list and the
  records; records not heard from in a day are forgotten.
- `createServer()` needs `opts.service` or all three seams (`knownSessions`,
  `getQueue`, `dequeue`); only `start()` creates a service. "Seen" dequeues
  in-process and clears only finished and waiting-for-you entries. Chats are
  read from the recorded transcript path (re-checked at use by real path),
  then from `~/.claude/projects` or `$CODEX_HOME/sessions`.
- `src/bridges.js`: every terminal action goes through one interface,
  `read()`, `type(text, submit)`, `press(key)`, picked from the session's
  record: a tmux pane if it has one (it wins over a Superset terminal, which
  would only show the tmux client), else a Superset terminal, else none and
  the session is read-only. The Codex desktop-daemon link is gone.
- The tmux bridge runs tmux by absolute path (`/opt/homebrew/bin`,
  `/usr/local/bin`, `/opt/local/bin`), argv only, `-u` and a clean env. Its
  checks: the socket must be absolute, really a socket (lstat, no links) and
  owned by this user; the pane `%<n>`; the server must still be the one the
  hook saw (`#{pid}` against the pid in `$TMUX`, checked on every read and
  before typing, since pane ids restart at `%0`); a pane in copy mode is
  refused. Text goes with `send-keys -l --` in pieces of at most 4 KB (tmux
  takes 16 KB per command), a trailing `;` escaped, then Enter as its own
  call after a gap (150 ms + 1 ms a character, at most 1 s). Keys map to tmux
  names; digits go in as text.
- Both bridges type only while the recorded agent is still that process
  (`proc.stillRunning`: pid plus start time, read fresh; no answer means no).
  The phone gets `can: { bridge, read, send, keys, controls, why }` per
  session in `/api/sessions` and `/api/screen`, and `can.start` for the Mac
  (new sessions are Superset-only; 409 `no_superset` without it). The app
  hides what can't work and says why in one line.
- `src/models.js`: each agent's model list from its own file, read fresh with
  a size cap: Codex `$CODEX_HOME/models_cache.json` (`visibility: "list"`,
  by `priority`, with its reasoning levels), Claude
  `~/.claude/cache/model-catalog/<id>-cc.json` (only that folder, by real
  path). Missing, malformed or too big: built-in lists stand in (Claude's
  aliases). Names by rule (`claude-fable-5-1` → "Fable 5.1"). `GET
  /api/models` serves both; Controls and New accept only names on the list
  and only that model's effort levels.
- Model, effort and mode for every session, read-only ones too: Claude from
  the transcript (`message.model`, `effort`, `permissionMode`, what `/model`
  and `/effort` printed), Codex from `turn_context` then
  `thread_settings_applied`. File first, screen second, except where the file
  is late: Claude's mode after Shift+Tab, and Codex's model, effort and fast
  mode between turns. Without a screen, `statusOf` gives working or idle
  from Codex's file or `working_since`. The custom status line is no longer
  read.
- `docs/reference/try-hook.py` (+ `try-hook-driver.js`): the end-to-end trial
  with a real, throwaway Claude session against a throwaway Airpocket. Needs
  `pyte`. Passed 9/9 at step 6.
- `docs/reference/try-tmux.js`: a real throwaway Claude (haiku, only the
  trial's hook) in a tmux server on a private socket in a temp folder,
  driven only through the phone API. Passed 8/8 at step 7. The user's own
  tmux server is never touched.
- `docs/reference/try-info.js`: the same setup plus a second phone server
  that sees the session without its pane: model and effort from the
  transcript, Shift+Tab, working and idle read-only, and a check that
  `~/.claude/settings.json` is untouched. Never runs `/effort` or `/model`.
  Passed 8/8 at step 8.
- The phone app (step 9) follows `docs/design`: tokens copied from the pack,
  self-hosted B612, B612 Mono and IBM Plex Sans (`src/public/fonts`, OFL), the
  map (`map.svg`) behind glass panes, Reduce Transparency and Reduce Motion
  honoured. Icons, manifest and twelve iOS launch images rendered by
  `docs/reference/render-icons.js`. Agents are marked CL and CX.
- First run: `src/public/where.js` tells a Safari tab from a Home Screen app;
  in a tab the app shows the add-to-Home-Screen steps wherever it would pair.
- QR pairing: `src/public/qr.js` encodes and scans QR codes with no library.
  `airpocket pair` prints the six digits and a QR of
  `AIRPOCKET:PAIR:<code>:<ADDRESS>`; the phone accepts only an
  `https://…ts.net` or loopback address, and a scan posts to the same
  `/api/pair` (same code, tries and expiry). The camera scan is the second
  option (`SCAN_FIRST = false` in `app.js`) until it is tried on a real
  iPhone (step 13).
- `/api/sessions` rows carry `status: { state, elapsed }` and `info` (model,
  effort, fast, mode) for running sessions, from the same readers as the
  session view; still one `ps` call per refresh.
- The app's CSP has `font-src 'self'`; the app sends
  `Permissions-Policy: camera=(self)`, the file-only origin `camera=()`.
- Screenshots: `docs/reference/shoot-app.js` (27 screens at 390x844, 375x667
  and 430x932, with automatic checks: no side scroll, 44px targets, safe
  areas, glass edges). Contrast: `docs/reference/contrast.js`. Scan trial in
  Chrome with a fake camera: `docs/reference/try-scan.js`, 10/10 at step 9.
- `docs/OWN-TERMINAL.md`: options for sessions outside Superset and tmux;
  recommends a private tmux session. Planned as step 10b, not built.
- Open: Codex has not been tried end to end with a real session, in Superset
  or tmux (do it at step 10, when hooks are installed). Denying a Claude
  permission with Esc leaves "needs permission" until the next prompt (no
  hook fires). `/effort` through Controls: in step 8's trial its first Enter
  didn't take; not verified (step 13, once, on purpose). On a real iPhone
  (step 13): the camera in a Home Screen app, `prefers-reduced-transparency`,
  the launch images. A desktop browser tab can't pair (first-run rule).

## Decisions waiting for Öncel (proposed defaults)

1. Runtime: Node 20+ during the build; packaging (Homebrew with Node, or one
   self-contained program) decided at step 10.
2. v1 bridges: Superset and tmux; the own-terminal mode right after; drop the
   Codex desktop-daemon link.
3. Ports: 47871 (app) and 47872 (files) on loopback; public HTTPS ports
   decided at step 13.

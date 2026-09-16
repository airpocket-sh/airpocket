# Threat model

What Airpocket exposes, who it defends against and how, what it does not try
to defend against, and the risks that remain. Written from the code on `main`
after step 8 (commit `e444886`), and updated by the review pass (the second
half of step 11) for the fixes it made: the agent proved to be in its tmux
pane, `hook.json` removed on stop, a Host check on the app and file servers,
a confirmation before a `!` message, and a plain warning before pairing. Step
10 (setup and uninstall) lands separately; its lines in
[SECURITY-REVIEW-CHECKLIST.md](SECURITY-REVIEW-CHECKLIST.md) are still open.

Names in `code` are functions and constants in `src/`. Line numbers are left
out on purpose: other steps are changing those files.

## What an attacker would want

- **The terminals.** Typing into an agent's terminal is close to running
  commands as the Mac's user: the agent can run commands, and Claude Code runs
  a message that starts with `!` as a shell command. This is the main asset.
- **The conversations.** Prompts, replies and session details (folder name,
  branch, account name).
- **Files** on the Mac.
- **The credentials** that grant the above: device tokens, pairing codes, the
  hook secret, file links.

## What Airpocket exposes

One process (`start()` in `server.js`) runs three HTTP servers. All three bind
127.0.0.1 only.

| Server | Port (default) | Reached from | Answers without a token |
| --- | --- | --- | --- |
| App and API | 47871 | The tailnet, over HTTPS, through `tailscale serve` (tailnet port 443 for now). Also any process or account on this Mac, over loopback. | The static app (a fixed list of files in `STATIC`), CORS preflights, and `POST /api/pair`. Every other `/api/` route returns 401. A Host that isn't a `*.ts.net` name or loopback gets 403 before anything else. |
| File-only origin | 47872 | The tailnet, through `tailscale serve` (tailnet port 8443 for now). Also loopback. | `GET` and `HEAD /f/<ticket>/<name>`, where the ticket is the credential. Anything else returns 404 or 405. The same Host check first. |
| Hook endpoint | 47873 | This Mac only. Never published. | Nothing. Unknown paths 404, other methods 405, a request with an Origin header or a non-loopback Host 403, no secret 401. |

Tailscale ends TLS; the hop from `tailscaled` to Airpocket is plain HTTP on
loopback. Airpocket cannot tell a request from the tailnet apart from one made
by a local process: both arrive from 127.0.0.1.

`airpocket serve` runs `tailscale serve --https=<port> --bg
http://127.0.0.1:<port>` for the first two servers, and refuses a tailnet port
where something else is already published. Nothing in Airpocket runs
`tailscale funnel`.

### With a device token

`GET /api/hello`, `/api/sessions`, `/api/screen`, `/api/models`,
`/api/new/options`, `/api/files`, `/api/file/text`, `/api/file/image`;
`POST /api/send`, `/api/key`, `/api/command`, `/api/seen`, `/api/new`,
`/api/file/open`. The checklist lists what each one takes and checks.

**A paired phone is as strong as the keyboard** at every agent terminal on that
Mac that has a bridge (Superset or tmux) and a running agent. It can also start
new agent sessions in any Superset project. Every other defence limits *how*
the phone reaches those terminals and files; none of them limits what the
owner of a valid token may type.

### What leaves the Mac

- **Chat view:** the user's messages, the agent's replies, one short label per
  tool step (a Bash step's description or first word, a file's base name, a
  search pattern, a host name), notes such as "compacted". Tool output, full
  tool input and the agent's command lines are not sent. A `!` command the user
  typed in Claude Code is sent clipped to 200 characters.
- **Terminal view** (and sessions with no chat file): the terminal screen as it
  is, after trimming rules and blank lines.
- **Session list:** title (folder name), branch, the account's name before the
  `@`, the last prompt or reply snippet (at most 120 or 220 characters), state.
- **Files** the user opens, under the file rules below.
- **New-session options:** Superset project and workspace names and ids, agent
  presets, model names. No paths or repository addresses.

### What is kept, and where

On the Mac, in `~/Library/Application Support/Airpocket` (or
`$AIRPOCKET_DIR`), a folder the service sets to 0700:

| File | Holds | Written by |
| --- | --- | --- |
| `devices.json` | Per phone: id, name, SHA-256 of its token, created, last seen | `store.js` (server and CLI) |
| `pairing.json` | The pending code's SHA-256, expiry, tries | `store.js` |
| `hook.json` | Hook port and hook secret, in plain text. Only while the service runs: removed when it stops, and one left by a crash is removed when the next service starts | `service.js` |
| `sessions/<id>.json` | Folder, transcript path, title, branch, snippet, account email, pid and start time, terminal ids | `service.js` |
| `queue.json` | The waiting list, with reply snippets | `service.js` |
| `airpocket.lock` | The running service's pid and start time | `service.js` |

Files are created 0600. Only in memory: the file-ref key (`FILE_SECRET`), file
tickets, parsed transcripts.

On the phone, in the web app's local storage: for each paired Mac its address,
name, device id and token, in plain text. The service worker caches the app
shell only, never `/api/`.

## Trust boundaries

1. **Tailnet to loopback.** Whoever can reach the Mac's tailnet address, and
   every account on the Mac, reaches the app and file servers.
2. **Agent output to the Mac.** Transcripts, Codex session files and terminal
   screens hold text shaped by whatever the agent read: web pages, repositories,
   issues. Airpocket treats all of it as untrusted.
3. **Local processes to the hook endpoint.** Anything on the Mac can connect to
   the port.
4. **The Mac to terminals.** The service decides which terminal a session's
   text goes to, from records the hooks wrote.

## Who it defends against, and how

### 1. Another person on the same tailnet

This includes another account on the same Mac (loopback is shared) and anyone
a Mac is shared with through Tailscale. They can reach the app server and the
file-only server. Tailscale's access rules are the first barrier and are the
user's to set; Airpocket assumes they may allow everyone on the tailnet.

- **Pairing code** (`store.newCode`, `store.useCode`). Six digits from
  `crypto.randomInt`. Only its SHA-256 is written. Good for ten minutes and
  five tries; the try count is kept on disk, so a restart doesn't reset it.
  After the fifth wrong try the code is deleted. One code at a time: a new code
  replaces the old one. A code works once. Compared in constant time. Only
  someone who can write the data folder, which means someone at the Mac, can
  make one (`airpocket pair`).
- **Per-device tokens** (`store.addDevice`, `store.deviceFor`). 32 random bytes,
  returned once in the pairing response. The Mac keeps only the SHA-256 and
  compares it in constant time with every device. The API takes the token only
  as `Authorization: Bearer`, 32 to 128 URL-safe characters. The token is
  checked before any route that reads sessions, files or terminals.
- **No ambient credentials.** No cookies and no trust in the client's address,
  so a page on another site has nothing to ride on (no CSRF). The app sends
  `credentials: "omit"`.
- **CORS** (`corsHeaders`). Allow headers go only to `https://*.ts.net`
  origins and `http://127.0.0.1` or `localhost` origins. Request bodies must be
  `application/json`, which forces a preflight from any other site.
- **Response headers** (`BASE_HEADERS`). A strict CSP (`default-src 'none'`,
  scripts and styles from the app itself, no framing, no forms, no base URL),
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`, `Cross-Origin-Opener-Policy: same-origin`.
- **Host check** (`HOST_OK`, `hostOk`). The app and file servers answer only
  to a Host that is a `*.ts.net` name (what `tailscale serve` passes on) or
  `127.0.0.1` / `localhost`, with any port; anything else gets 403 before
  routing, so a refused request uses no pairing try and no file-link use. Only
  Host counts: `X-Forwarded-Host` is a header a page can set itself. A web page
  that rebinds its own name to 127.0.0.1 still sends its own name, so DNS
  rebinding reaches nothing, not even the static app.
- **Limits.** JSON bodies up to 32 KB; request timeout 30 s, header timeout
  15 s.
- **Tailnet only.** `tailscale serve`, never `funnel`, and `airpocket serve`
  won't replace another program's handler on the same tailnet port, so the app
  never shares an origin with something else.

### 2. A device token that leaks

Impact: see "A paired phone is as strong as the keyboard" above, for anyone who
also has network reach to the Mac.

- The token never appears in a URL, a cookie, a log line or a Referer. Request
  logs record method, path, status and time only (`createServer`, the request
  handler), never the query string, headers or body.
- The Mac stores only the hash, so `devices.json` can't be replayed.
- Using a token needs tailnet reach as well.
- **Revoke works at once.** `airpocket revoke <id>` rewrites `devices.json`,
  and `store.deviceFor` reads that file on every request.
- **Said before pairing.** The pairing screens (code and scan) and the README
  say that a paired phone can type anything into the agents, shell commands
  included, until it is revoked on the Mac.
- `airpocket devices` shows each phone's last use (updated at most every five
  minutes).

### 3. A lost or stolen phone

- The phone's own lock is the first barrier. The token lives in the home-screen
  app's own storage, separate from Safari's.
- Revoke the phone on each Mac with `airpocket revoke`. Removing the phone from
  the tailnet in Tailscale cuts it off from every Mac at once.
- Nothing about sessions is cached on the phone: API responses are `no-store`,
  the service worker skips `/api/`, an opened image's blob URL is revoked when
  the viewer closes, and file links stop working after two minutes.

### 4. A malicious file or a poisoned transcript

Agent output can be steered by what the agent read. Assume any text in a
transcript, a Codex session file or on screen may be hostile: it may try to
open a file outside the session, run script on the phone, or put a secret on
the phone.

**Rendering on the phone**
- The app builds DOM nodes and never uses `innerHTML` or HTML strings. The
  Markdown renderer (`md.js`) puts all text in text nodes and makes links only
  for `http:` and `https:` addresses, opened with `rel="noopener noreferrer"`.
- The CSP allows no inline script and no script from anywhere but the app.

**Reading transcripts** (`claudeItems`, `codexStep`)
- Tool results are skipped. A tool step becomes a name and a short label (its
  description, a file's base name, a search pattern), never its output or its
  full input. Messages are clipped (8,000 characters for the user's,
  60,000 for the agent's), and at most 160 items are sent.
- A transcript is read from the path the hook recorded only if its real path is
  a regular file named after that session (`recordedTranscript`,
  `transcriptPath`). Otherwise it is looked up under `~/.claude/projects` or
  `$CODEX_HOME/sessions` by the session's UUID.

**Choosing which files a session may show** (`filesFor`, `sessionFiles`)
- The phone never sends a path. It sends a ref: an HMAC-SHA256 of the session id
  and the file's real path, keyed with 32 random bytes made at process start,
  cut to 22 characters (`refOf`). Refs can't be computed off the Mac and change
  on restart.
- A ref is looked up only in that session's own list, rebuilt from its
  transcript on each request (`lookupFile`). The list holds files the session
  wrote or edited (Claude's Write, Edit, MultiEdit, NotebookEdit and Artifact;
  Codex file changes) and files named in the agent's own messages (Codex
  citations, Markdown links, names in backticks). Claude's Read steps are never
  on it.

**Checking each file** (`sessionRoot`, `fileMeta`)
- The root is the session's recorded folder by real path: inside the home
  folder, never the home folder itself, never a hidden folder (Superset
  workspaces under `~/.superset` excepted, never `~/.superset` itself).
- A candidate is refused unless every rule passes. It must be a plain path or
  a `file:` URL (other schemes are refused) of at most 400 characters. It is
  resolved from the session's folder. It must have an extension on the allowed
  list (`FILE_KINDS`) and be under that kind's size cap. Its name must not look
  like a key, certificate, keychain, env file, or contain "secret",
  "credential", "passw", "private key" or "api key" (`DENY_NAME`). Its real path
  must be inside the root with no hidden folder or `node_modules` on the way. It
  must be a regular file with one hard link. The real file must keep the same
  extension and pass the name rules too. Its first bytes must match its kind
  (`looksLike`: PDF, PNG, JPEG, GIF, WebP, HEIC, SVG; text kinds must be valid
  UTF-8 with no NUL). Text kinds and SVG must not match the key patterns in
  their first 4 KB.
- **Checked again at use:** `lookupFile` runs `fileMeta` again and requires the
  same inode and device.

**Serving a file**
- **Text and Markdown** go through the authenticated API as JSON: the first
  512 KB, with control characters removed. The whole text sent is scanned for
  key patterns, and a match is refused (`fileText`).
- **Images** go through the authenticated API with their own
  `Content-Security-Policy: default-src 'none'; sandbox` (`fileImage`).
- **PDFs and HTML pages** open only on the file-only origin, a separate port and
  so a separate browser origin, with no API, no app and no cookies
  (`openFile`, `fileRoute`). The link carries a ticket of 32 random bytes held
  in memory. It lasts two minutes and at most 40 requests, and names one file.
  On every request the file is checked again: same name, inode, device and
  extension, and every rule in `fileMeta`. An HTML page is scanned whole for key
  patterns each time and served with a sandbox CSP: no scripts, forms, frames,
  or loads except `data:` images and fonts (`PAGE_CSP`). Responses carry
  `no-store`, `nosniff`, `Cross-Origin-Resource-Policy: same-origin` and
  `X-Robots-Tag: noindex`.

**Key patterns** (`secrets.js`, `SECRET_CONTENT`): PEM private key headers,
service-account JSON (`"private_key"`), AWS access key ids, `sk-` and `sk-ant-`
style API keys, GitHub tokens, Slack tokens. The same patterns drop a prompt or
reply snippet whole, in the hook and again in the service.

### 5. A local process talking to the hook endpoint

A process on the Mac, another account's or a web page's, may try to write
session records: to point a session at another terminal, another transcript,
or another folder.

- **Loopback only**, never published.
- **Secret** (`service.js`, `secretOk`). 32 random bytes, new each start, in
  `hook.json` (0600, in the 0700 data folder). The file is written whole
  (private temp file, fsync, rename) and only once the endpoint is listening.
  The secret is compared as a SHA-256 digest with `timingSafeEqual`.
- **`hook.json` only while the service runs** (`dropHookFile`, `release`).
  It is removed when the service stops (`close`, and `release` from the
  process's exit handler, which SIGINT and SIGTERM reach), and when a service
  stops because it lost the data folder, in each case only if it still holds
  this service's secret. A service that starts removes any `hook.json` a crash
  left, right after taking the lock and before it listens. A hook that finds no
  `hook.json` sends nothing.
- **No browsers.** A request with any Origin header is refused, since browsers
  send one with cross-site requests and with POSTs. The Host must be
  `127.0.0.1` or `localhost`, which stops DNS rebinding.
- **Form.** `application/json` only, 16 KB at most (checked from
  `Content-Length` and again while reading, closing the connection), 5 s
  timeouts. Checks run in this order: path, method, Origin and Host, secret,
  type, size.
- **Every field is checked** (`upsert`, `handle`). Session ids must match
  `[A-Za-z0-9_-]{6,100}`. `agent` must be `claude` or `codex`. Paths must be
  absolute, at most 1,024 characters, with no control characters. A transcript
  must be named after that session. A tmux pane must be `%<n>`. Superset ids
  must match `[A-Za-z0-9_-]{1,100}`. `reason` and `why` come from fixed sets.
  Text is clipped with control characters removed, and snippets that match the
  key patterns are dropped.
- **A different process resets the terminal.** A hook from another pid, or the
  same pid with another start time, replaces all five terminal fields, and an
  empty field stays empty.
- Refusals are logged by method, path (first 40 characters) and status only.
- **The hook itself** (`hook.js`) sends only to 127.0.0.1. It never writes to
  stdout or stderr, gives up after 1.5 s and always exits 0. It reads at most
  1 MB of input. For a permission request it sends the tool's name, never its
  input.

### 6. Typing into a terminal that is no longer the agent's

When an agent exits, its terminal usually falls back to a shell. Text from the
phone must not land there.

- **The phone names a session, never a terminal.** The terminal comes from the
  session's record (`bridges.of`).
- **The agent must still be that process** (`proc.processInfo`, called by
  `bridges.writable` before every send, key and Controls command). Its pid and
  start time are read fresh from `/bin/ps`. No pid, no recorded start time, or
  no answer from `ps` means refused.
- **The agent must hold its terminal.** The same `ps` call reads the agent's
  terminal, its process group and the terminal's foreground process group
  (`ps -o pid=,tty=,pgid=,tpgid=,lstart=`). No terminal at all is refused
  (`not_in_terminal`); a process group that isn't the terminal's foreground
  (the agent in the background, stopped with job control, or behind another
  program) is refused (`not_foreground`).
- **tmux: the agent must be in that pane.** The agent's terminal must be the
  pane's (`#{pane_tty}`, read in the same tmux call as the server pid and copy
  mode). An agent that was only started from the pane, and so inherited
  `TMUX_PANE`, runs on another terminal or none, and is refused
  (`not_in_pane`). Checked against a real tmux server: a process outside the
  pane, one in another pane, and a job sent to the background, brought back
  with `fg` and stopped with Ctrl+Z.
- **Superset: the terminal can't be proved.** A Superset terminal id can't be
  mapped to a terminal device from outside Superset, so for Superset only the
  checks above hold: the agent is alive and in the foreground of *some*
  terminal, not that the terminal is the recorded one (residual risk 2).
- **tmux** (`tmuxBridge`, `tmuxSocket`). tmux runs by absolute path with
  argument lists, `-u` and a clean environment. The socket must be an absolute
  path to a real socket (checked with `lstat`, so no links) owned by this user.
  The pane must be `%<n>`. The tmux server must still be the one the hook saw:
  its pid is compared with the one from `$TMUX` on every read and before typing,
  since pane ids start again at `%0` after a restart. A pane in copy mode is
  refused. Text goes as `send-keys -l --` in pieces of at most 4 KB, a trailing
  `;` escaped, then Enter as a separate call.
- **Superset.** Its CLI runs by a fixed path with argument lists. Workspace and
  terminal ids must match `[A-Za-z0-9_-]{1,100}`.
- **Text** (`cleanText`). Line breaks become spaces (a newline would press
  Enter), control characters 0 to 31 and 127 are dropped, 8,000 characters at
  most. The phone asks once before sending text that starts with `!` (after
  spaces or control characters), which Claude Code and Codex run as a shell
  command: a hazard dialog says it will run as a command, and Keep sends
  nothing. This is in the app only; the API takes such text as it is. **Keys** come from the fixed table `KEYS` (arrows, Tab, Shift+Tab, 1
  to 9, Enter, Esc).
- **Controls** (`command`). The command text comes from a fixed table per
  agent (`COMMANDS`). A model or effort argument must be on the agent's own list
  (`models.js`). The screen is read fresh first, and the command is refused
  while a menu is open, text sits unsent in the box, or a turn runs.
- **New sessions** (`newSession`). The project or workspace must be one Superset
  just listed, by UUID, and the agent a preset from its list. The branch must
  match a strict pattern with no leading dash, dot or slash. Model and effort
  must be on the agent's lists. The prompt loses control characters (line
  breaks stay: it is one argument), and a leading dash is padded so it can't
  read as an option.

## Out of scope

- **A Mac account already compromised.** That includes every process running
  as that user: it can read `hook.json`, add a hash to `devices.json`, and read
  transcripts and files directly. The hook secret keeps out other accounts and
  web pages, not the user's own processes.
- **An agent already running that the user asked for, and anything the user's
  own agent chooses to do.** That includes an agent that reads `hook.json`, or
  that names a file in its reply so the phone may show it. The file rules still
  apply.
- **Physical access to an unlocked phone,** or a phone running malware.
- **Bugs in Tailscale, Claude Code, Codex, Superset, tmux, macOS or iOS.** That
  includes a file built to attack the phone's own image or PDF viewer.
  Airpocket passes images and PDFs through unchanged.
- **Setups Airpocket doesn't make:** `tailscale funnel`, binding to other
  addresses, another proxy in front.
- **Availability** against someone already on the tailnet or on the Mac.

## Residual risks

What remains, without fixes; the review decides what to do with each. Rough
weight: **H** worth deciding before launch, **M** worth a fix or a clear note,
**L** accept or note.

1. **H: A token is all-powerful and permanent.** Tokens don't expire. They
   aren't bound to a phone or a tailnet device, and aren't limited to some
   sessions. Free text reaches the agent as typed, so a Claude Code or Codex
   message that starts with `!` runs in a shell. The Controls table limits what
   *Controls* types, not the message box. A leaked token plus tailnet reach
   gives full use of the agents until revoked on each Mac.
   *Step 11: still true, by design.* What changed is that people are told: the
   pairing screens and the README say so before a phone is paired, and the app
   asks once before sending a `!` message. The dialog guards against a slip on
   the phone, not against a leaked token, which calls the API directly.

2. **H for Superset, closed for tmux: a recorded terminal proves where the
   agent started, not where it runs now.** The terminal fields come from
   environment variables (`TMUX`, `TMUX_PANE`, `SUPERSET_TERMINAL_ID`,
   `SUPERSET_WORKSPACE_ID`) that every program started inside that terminal
   inherits.
   *Step 11:* every bridge now refuses an agent that holds no terminal, or
   whose process group isn't its terminal's foreground: stopped with job
   control, in the background, or behind another program. The tmux bridge also
   proves the agent is in the recorded pane (its terminal is the pane's
   `#{pane_tty}`). What remains:
   - **Superset can't be proved.** A Superset terminal id can't be matched to a
     terminal device, so an agent started from a Superset terminal that now
     runs, in the foreground, in *another* terminal (an editor's terminal that
     was launched from the Superset one, for example) passes the checks, and
     text from the phone goes to the Superset terminal, where the shell or
     whatever runs there now receives it.
   - **Checked, then typed.** The checks run just before typing; a long message
     goes to tmux in several calls after them, and Superset's CLI takes about
     0.6 s. A process that takes the terminal's foreground in that window
     receives the text.

3. **M: Loopback ports aren't private to one account.** On a Mac with several
   accounts, another account can take 47871, 47872 or 47873 while Airpocket
   isn't running. Airpocket then logs "port taken" and runs without that
   server. `tailscale serve` would forward phone requests, bearer tokens
   included, to whatever holds the app port.
   *Step 11: the hook half is closed.* `hook.json` is removed when the service
   stops and, after a crash, when the next service starts, so a hook fired
   while Airpocket is down finds no file and sends nothing. What remains for
   hooks: after a crash that skips the exit handler (SIGKILL, a power cut),
   the old `hook.json` stays until Airpocket starts again, and hooks keep
   sending to its port until then. The app-port half is unchanged.

4. **Closed at step 11: the app and file servers didn't check the Host
   header.** A web page opened on the Mac that rebinds its own name to
   127.0.0.1 could reach what needs no token: the static app, `/api/pair` (the
   pending code's five tries) and ticket URLs. Both servers now refuse any Host
   but a `*.ts.net` name or loopback (`HOST_OK`); tested with rebound names,
   look-alikes (`ts.net.attacker.example`) and `X-Forwarded-Host`.

5. **M: Key patterns are a short list, and cover only files and snippets.** A
   credential of another shape passes: a password in a config file, a database
   URL with a password, other providers' keys. The patterns aren't applied to
   chat messages or the screen. A key pasted into a prompt, repeated in a reply
   or printed in the terminal reaches the phone.

6. **M: SVG.** Only an SVG's first 4 KB are scanned for key patterns before the
   whole file (up to 5 MB) is sent. The app shows it from a `blob:` URL it
   creates in its own origin. Inside `<img>` an SVG runs no script, but whether
   every way of opening that blob URL on iOS keeps the app's CSP hasn't been
   checked.

7. **M: The terminal view sends the screen as it is:** tool output, file
   contents and command lines, whatever is visible. "Never tool output" holds
   for the chat view only.

8. **M: Pairing is first come, first served.** Anyone who can reach the Mac and
   sees a pending code (over a shoulder, on a screen share) can pair before the
   phone. Anyone who can reach it can use up the five tries. The Mac says a
   phone paired only in the service log and in `airpocket devices`. There is no
   limit on the number of paired devices.

9. **L: Revoke can lose a race.** `devices.json` is rewritten whole by two
   processes, the CLI and the server (for "last seen", at most every five
   minutes a device), with no lock between them. A revoke written between the
   server's read and write of that file is undone. The window is very small;
   `airpocket devices` shows the result.

10. **L: CORS allows every `*.ts.net` origin and every loopback port,** not
    just this tailnet's Macs. That includes other tailnets and pages published
    with Funnel. With no ambient credentials this exposes only `/api/pair`
    today. It would matter if cookies or address-based trust were ever added.

11. **L: File links are bearer URLs.** For two minutes and 40 requests a ticket
    works for anyone with the link and tailnet reach, not just the phone that
    asked. It can stay in the phone's browser history.

12. **L: Codex image views count as files.** A Codex `ImageView` step (the agent
    looked at an image) makes that image openable, although the rule is "never
    what it only read". Every other file rule still applies.

13. **L: The Superset exception is wider than workspaces.** `sessionRoot`
    accepts any non-hidden folder two or more levels under `~/.superset`, not
    only `~/.superset/worktrees/<project>/<workspace>`. A session whose folder
    is `~/.superset/worktrees/<project>` gets every workspace of that project as
    its root.

14. **L: A session's folder can be broad.** Any folder under home except home
    itself counts. A session started in `~/Documents` or `~/Downloads` can show
    any file of an allowed kind there once the agent names it.

15. **L: Checked, then opened by path.** The viewer checks a file (real path,
    inode, device), then opens it by path. A process that can write in the
    session's folder could swap the file in between. Same-user processes are out
    of scope; the gap is noted.

16. **L: Typed text not fully characterised.** C1 control characters (U+0080
    to U+009F) and invisible formatting characters are not removed; how each
    agent's input reader treats them hasn't been verified.
    *Step 11: the leading dash is settled.* The installed Superset CLI's parser
    refuses an option value that starts with `-`, so such text was never read
    as an option, but the message failed. Text starting with `-` now goes as
    `--text=<value>`, which that parser takes whole, and terminal and workspace
    ids can't start with `-`. This rests on the Superset build on this Mac; a
    later CLI could parse differently.

17. **L: Tokens at rest on the phone** are in plain text in the web app's
    storage. With several Macs, all their tokens sit in the storage of the
    origin that served the app, readable by that Mac's app code. Whether iOS
    backups include this storage hasn't been checked.

18. **L: Error text crosses boundaries.** When a new session fails, up to 160
    characters of Superset's error output go to the phone. Up to 300 characters
    of Superset's or tmux's error output can reach the service log inside an
    error stack.
    *Step 11: partly fixed.* A failed program used to carry Node's own message,
    `Command failed: <program> <every argument>`, whenever it wrote nothing to
    stderr (a timeout, for one), so typed text and new-session prompts reached
    the log and the phone. `runFile` now reports only the program's stderr or
    how it ended (`superset timed out`). What the programs themselves write to
    stderr is still passed on and hasn't been checked to exclude typed text or
    paths.

19. **L: A process is named to the second.** `ps -o lstart` has one-second
    resolution; a pid reused within the same second would pass. macOS hands out
    pids in increasing order, so this is unlikely.

20. **L: Tailscale HTTPS names are public.** Certificates for `tailscale serve`
    appear in public Certificate Transparency logs, and with them the Mac's
    tailnet name. Names only, never content.

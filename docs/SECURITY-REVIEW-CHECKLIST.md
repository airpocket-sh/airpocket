# Security review checklist

The list for the review half of step 11, once steps 9 and 10 have landed. It
was written from `main` after step 8 (commit `e444886`); anything added since
needs a line of its own. Read it with [THREAT-MODEL.md](THREAT-MODEL.md).

How to work through it:

- Tick a box only with evidence: the function that does it, the test that
  would fail without it, or command output. Put the evidence in the review PR.
- A line that no longer matches the code is a finding in itself.
- Look for what is missing, not just for what is listed: a new route, file,
  command or log line that isn't here.
- Findings go in the review PR, and into the threat model's residual risks
  when they are accepted rather than fixed.
- Never test against the maintainer's real sessions, settings or Tailscale
  serve config (AGENTS.md, "Testing").

## 1. Routes

### Every server

- [ ] Each server binds `127.0.0.1` only (`start()`, `service.listen`). No
      `0.0.0.0`, `::` or tailnet address anywhere, tests included.
- [ ] Only `airpocket serve` publishes, only with `tailscale serve`, only the
      app and file ports. Search the repo (docs too) for `funnel`: it may appear
      only as "never".
- [ ] Every table lookup keyed by request input uses `Object.hasOwn` (`STATIC`,
      `KEYS`, `COMMANDS`, `FILE_KINDS`, model lists), so `__proto__` or
      `constructor` resolve to nothing.
- [ ] Error bodies never echo request input back.
- [ ] Timeouts and body caps are set on each server (app: 30 s request, 15 s
      headers, 32 KB JSON; file: 60 s request, header timeout left at Node's
      default; hook: 5 s and 5 s, 16 KB).
- [ ] Decide on a Host allow-list (tailnet name or loopback) for the app and
      file servers (residual risk 4).

### App and API (47871)

Without a token:

| Route | Takes | Confirm |
| --- | --- | --- |
| `OPTIONS /api/*` | Origin | Allow headers only for `https://*.ts.net` and loopback origins (`ORIGIN_OK`); 204, else 404. |
| `GET`/`HEAD` static | path | Only names in `STATIC`, read from `src/public`; anything else 404; other methods 405. |
| `POST /api/pair` | JSON `code`, `name` | Code rules (below). `name` has control characters removed and is clipped to 40. The token is in this response only. The log line holds name and device id only. |

Code rules (`store.useCode`): six digits, SHA-256 at rest, ten minutes, five
tries counted on disk, deleted when used, expired or locked, constant-time
compare, one pending code.

With a token (`Authorization: Bearer`, checked by `store.deviceFor` before the
handler runs):

| Route | Takes | Confirm |
| --- | --- | --- |
| `GET /api/hello` | nothing | Host label, device name, `can.start`. |
| `GET /api/sessions` | nothing | Fields per session. No paths, no full email, snippets clipped. |
| `GET /api/screen` | `id`, `view`, `sig` | `id` must match `SESSION_ID`. What `items`, `text` and `info` carry. Terminal text is sent as is (residual 7). |
| `POST /api/send` | `id`, `text`, `submit` | `cleanText` (line breaks to spaces, codes 0-31 and 127 dropped), 8,000 characters at most, `bridges.writable` before typing. C1 controls (residual 16). |
| `POST /api/key` | `id`, `key` | Key from `KEYS` only, `writable` first. |
| `POST /api/command` | `id`, `cmd`, `arg` | `COMMANDS` table only. Model or effort from the agent's own lists. Fresh screen read; refused on a menu, unsent text or a running turn. `writable` first. |
| `POST /api/seen` | `id` | Clears only "finished" and "waiting for you". |
| `GET /api/models` | nothing | Ids, names and efforts only. |
| `GET /api/new/options` | nothing | Superset present; names and ids only, no paths or remotes. |
| `POST /api/new` | `agent`, `workspace` or `project` + `branch`, `model`, `effort`, `prompt` | Each id must be in Superset's fresh list; `BRANCH` pattern; model and effort on the lists; `cleanPrompt`; leading dash padded; 8,000 characters. Error text returned (residual 18). |
| `GET /api/files` | `id` | Refs, names, folder relative to the root, kind, size, time. No absolute paths. |
| `GET /api/file/text` | `id`, `ref` | Ref shape; `lookupFile`; text kinds only; 512 KB; key patterns over everything sent. |
| `GET /api/file/image` | `id`, `ref` | `lookupFile`; image kinds only; own sandbox CSP. SVG scan covers 4 KB only (residual 6). |
| `POST /api/file/open` | `id`, `ref` | `lookupFile`; PDF and page only; ticket rules (below); the returned origin comes from the Host header only if it is a `*.ts.net` name. |
| anything else | | 401 without a token, 404 with one, 405 for other methods. |

- [ ] A revoked token fails on the very next request.
- [ ] Nothing touches the service, a bridge or the filesystem before the token
      check (apart from static files and pairing).
- [ ] The phone can't name a terminal, a path or a transcript in any route, nor
      the text of a Controls command.

### File-only origin (47872)

- [ ] Only `GET`/`HEAD /f/<43-character ticket>/<name>`; anything else 404 or
      405, with no API and no app.
- [ ] Ticket: 32 random bytes, in memory, two minutes, 40 requests, at most
      100 alive. The name in the URL must equal the ticket's.
- [ ] Every request runs `fileMeta` again and matches inode, device and
      extension. Pages are scanned whole for key patterns each time.
- [ ] Headers: `PAGE_CSP` for pages (sandbox, no scripts, `data:` images and
      fonts only); `frame-ancestors 'none'` for PDFs; `no-store`, `nosniff`,
      `Cross-Origin-Resource-Policy: same-origin`, `noindex`.
- [ ] Range requests: malformed or out of range gives 416, never a read past
      the end.
- [ ] Logs carry method and status only, never the path (it holds the ticket).

### Hook endpoint (47873)

- [ ] Never published; not in `TARGETS` in `cli.js`.
- [ ] Check order: path and event (404), method (405), Origin present or Host
      not loopback (403), secret (401), JSON type (415), size from
      `Content-Length` and while reading (413, connection closed), JSON object
      (400).
- [ ] `POST /hook/session`, `/hook/touch`: `upsert`. `/hook/enqueue`: `reason`
      from `REASONS`. `/hook/dequeue`: `why` is `prompt`, `interrupt` or `end`.
- [ ] Field checks in `upsert`: `session_id` pattern; `agent` enum; `cwd`,
      `tmux` absolute, 1,024 characters, no control characters; `transcript`
      named after the session; `pane` `%<n>`; `terminal`, `workspace` id
      pattern; `pid` via `pidOf`; `started` a positive safe integer; text
      clipped; snippets matching key patterns dropped.
- [ ] A hook from another process replaces all five terminal fields.
- [ ] `hook.js`: sends only to 127.0.0.1; silent; exits 0; 1.5 s; 1 MB input;
      never tool input; subagent events ignored.

### Added by steps 9 and 10 (fill in)

- [ ] QR pairing: what the QR holds. It must never hold a token, and should hold
      no more than the address and, at most, the short-lived code.
- [ ] First-run guidance: nothing that tells users to use `funnel`, open ports
      or turn off checks.
- [ ] setup, doctor, uninstall: every file, setting and login item they write,
      and that uninstall removes exactly those.
- [ ] Any new route, in the tables above.

## 2. Filesystem

Every read and write, and what guards it.

| Where | Path | Read or write | Confirm |
| --- | --- | --- | --- |
| `store.js` | data folder `devices.json`, `pairing.json` | both | Folder made 0700; files 0600 via temp and rename; no lock between CLI and server (residual 9). |
| `service.js` | data folder, `sessions/<id>.json`, `queue.json`, `hook.json`, `airpocket.lock` | both | `privateDir` sets 0700 on every start; `writeAtomic` (`wx` temp, 0600, fsync, rename); record file names only from `SESSION_ID`; leftover `.tmp` removed; lock taken before any write. `hook.json` left behind after stop (residual 3). |
| `server.js` static | `src/public/<fixed name>` | read | Names from `STATIC` only. |
| `server.js` transcripts | recorded path; `~/.claude/projects/*/<uuid>.jsonl`; `$CODEX_HOME/sessions/Y/M/D/rollout-*-<uuid>.jsonl` | read | Recorded path by real path, a file, named after the session. Fallback ids must be UUIDs. Tail reads: 4 MB; Codex window up to 32 MB. |
| `server.js` files | session folder and below | read | `sessionRoot` (residuals 13, 14), `fileMeta` every rule, `lookupFile` at use, `fileRoute` per request. Check-then-open by path (residual 15). |
| `models.js` | `~/.claude/cache/model-catalog/*-cc.json`, `$CODEX_HOME/models_cache.json` | read | Folder by real path; names by pattern; `lstat` refuses links; size caps 1 MB and 4 MB checked on the open file. |
| `hook.js` | data folder `hook.json`; `.git` up to 40 folders up, a worktree's `gitdir:` target `HEAD`; `.claude.json` in the config folder | read | `HEAD` and a `.git` file are read whole with no size cap, then only the first 1 KB and 4 KB are used, and only a `ref: refs/heads/…` line is taken; `.claude.json` at most 32 MB, only `oauthAccount.emailAddress`. The `gitdir:` target is chosen by the repository. |
| `bridges.js` | `~/.superset/bin/superset`; tmux in three fixed folders; the tmux socket | stat | Executable regular file; socket by `lstat`, owned by this user. |
| `server.js`, `cli.js` | Tailscale app bundle and two fixed paths; `which tailscale` in the CLI | stat | Real path, executable. The CLI also trusts `PATH` (section 4). |
| setup, uninstall (step 10) | `~/.claude/settings.json`, `~/.codex/hooks.json`, login item, logs | write | Fill in: backups, merge not overwrite, modes, exact removal. |

- [ ] No path from the phone reaches `fs` without going through the rules
      above.
- [ ] No write outside the data folder, apart from what setup documents.
- [ ] Every read of a file whose size someone else controls has a cap.
- [ ] Tests use temp folders only; none touches the real home, `~/.claude`,
      `~/.codex` or the private tool's data.

## 3. Where a secret could be logged

Secrets here: device tokens, pairing codes, the hook secret, file tickets and
refs, query strings, request bodies, typed text, file contents, snippets.

| Where | Line | Confirm |
| --- | --- | --- |
| `server.js` request handler | `METHOD /path status ms`, for POSTs and failures | Path only, never the query string. A ticket path sent to the wrong port would be logged: acceptable? |
| `server.js` | `error:` with the stack | Stacks can carry Superset or tmux error output, 300 characters (residual 18). Check it never holds typed text. |
| `server.js` `pair` | `paired <name> (<id>)` | No token or code. |
| `server.js` `openFile` | `opened a <kind> (<ext>)` | No name or path. |
| `server.js` `newSession` | `started <agent> in a workspace` or `on a new branch` | No prompt, branch or project. |
| `server.js` file server | `file server error:` with the message; `file <method> <status>` | fs error messages hold paths; no ticket. |
| `server.js` `start` | listening and port-taken lines | Nothing secret. |
| `service.js` | `service: couldn't save <what>: <code>`; `hook <method> <path> <status>`; `hook error:` with the message | No body or secret; path clipped to 40. |
| `hook.js` | none | Nothing on stdout or stderr, ever (Claude adds hook output to the conversation). |
| `cli.js` | the pairing code (by design, on the Mac's own terminal); device list; Tailscale's own output | Nothing else prints a code, token or secret. |
| step 10 | where the service's output goes | Log file mode 0600 in a private folder, size limit or rotation, removed by uninstall. |

- [ ] Search `src/` for every `log(`, `console.`, `process.stdout`,
      `process.stderr`; each one is in this table.
- [ ] Uncaught exceptions: what Node prints, and where it goes under the login
      item.

## 4. External commands

All must use `execFile` or `execFileSync` with an argument list: no shell, no
`exec`, no `shell: true`, no string commands.

| Program | Found by | Arguments | Env | Timeout | From the phone |
| --- | --- | --- | --- | --- | --- |
| `/bin/ps` (`proc.js`) | fixed path | `-o pid=,lstart= -p <pids>`; `-o pid=,ppid=,lstart=,comm= -p <pid>` | `PATH=/usr/bin:/bin`, `LC_ALL=C` | 2 s | nothing (pids come from records) |
| tmux (`bridges.js`) | first of `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin` | `-u -S <socket>` then `display-message -p -t <pane> #{pid} ; capture-pane -p -t <pane>` (the `;` is its own argument); `display-message -p -t <pane> "#{pid} #{pane_in_mode}"` (one argument); `send-keys -t <pane> -l -- <text>`; `send-keys -t <pane> <key name>` | `PATH=/usr/bin:/bin`, `LANG=en_US.UTF-8` | 5 s | text (cleaned, 4 KB pieces, trailing `;` escaped), key names from `KEYS` |
| Superset (`bridges.js`, `server.js`) | `~/.superset/bin/superset` (a shim into the app bundle) | `terminals read --workspace W --terminal T --json`; `terminals send --workspace W --terminal T --text <text> [--no-submit]`; `projects list --json`; `workspaces list --json`; `agents list --local --json`; `agents create --workspace <uuid> --agent <preset> [--model M] [--effort E] --prompt <p> --json`; `workspaces create --local --project <uuid> --branch B --name B --agent <preset> [--model M] [--effort E] --prompt <p> --json` | inherited | 15 s, 90 s to create | text, prompt, branch, ids chosen from lists |
| Tailscale (`server.js`) | real path of the app bundle binary or two fixed paths | `status --json` | inherited | 6 s | nothing |
| Tailscale (`cli.js`) | `/usr/bin/which tailscale` plus fixed paths | `status --json`; `serve status --json`; `serve --https=<port> --bg http://127.0.0.1:<port>`; `serve --https=<port> off` | inherited | 8 s for status | nothing |
| step 10 | fill in | | | | |

- [ ] Every value that reaches an argument from the phone is validated first
      (tables above).
- [ ] Free text never lands where it can be read as an option: tmux has `--`.
      Superset `--text` with a leading dash is unverified (residual 16); check
      the CLI's parsing without typing into a real terminal.
- [ ] `--prompt` with a leading dash is padded; `--branch` and `--name` can't
      start with a dash.
- [ ] Decide whether inherited environments are fine for Superset and
      Tailscale, and whether the CLI should stop trusting `PATH` for
      `tailscale`.
- [ ] No command runs with text from a transcript or a screen.

## 5. Secrets at rest

| Secret | Where | Form | Confirm |
| --- | --- | --- | --- |
| Device token | phone: web app local storage, key `airpocket.hosts.v1` | plain | Residual 17. Never in the service worker cache. |
| Device token | Mac: `devices.json` | SHA-256 (256-bit random input, so no salt needed) | 0600 in a 0700 folder. |
| Pairing code | Mac: `pairing.json` | SHA-256 of six digits, easily reversed | Only for ten minutes; same-user readable only. Acceptable? |
| Hook secret | Mac: `hook.json` | plain (the hooks must read it) | 0600; new each start; left on disk after stop (residual 3). |
| File-ref key | memory | 32 random bytes | Never written or logged. |
| File tickets | memory | 32 random bytes | Never written or logged. |
| Account email, snippets | Mac: `sessions/*.json`, `queue.json` | plain | 0600; snippets matching key patterns dropped. |

- [ ] Modes on a fresh install from step 10's setup, and after an upgrade
      over an existing folder with looser modes.
- [ ] No real token, code, secret, email or tailnet name in any file in the
      repo (section 7).

## 6. Phone web app

- [ ] CSP on every app response (`CSP`); nothing inline; no external scripts,
      styles, fonts or images.
- [ ] No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`,
      `eval` or `new Function` in `src/public`.
- [ ] `h()` sets attributes only from keys in code, never from data.
- [ ] `md.js`: links only `http:` and `https:`, `target=_blank` with
      `rel="noopener noreferrer"`.
- [ ] File links opened only when they match `FILE_LINK`; blob URLs revoked on
      close.
- [ ] The "Add a Mac" address must be a `*.ts.net` HTTPS address or loopback.
- [ ] Service worker: same-origin `GET` only, never `/api/`, app shell only.
- [ ] SVG shown from a `blob:` URL: check what iOS does if it is opened
      directly (residual 6).
- [ ] Step 9's new app: repeat all of the above.

## 7. Dependency and history scans

- [ ] Dependencies: `package.json` lists none today and there is no lock file.
      Confirm that's still true. If anything was added, commit a lock file, run
      `npm audit --omit=dev`, and read each package and its install scripts.
- [ ] Node: the supported range in `engines` is still maintained upstream.
- [ ] Secret scan of the working tree and **all history on all branches**, for
      example `gitleaks detect --log-opts="--all"` and `trufflehog git
      file://. --no-update`. Include `docs/reference`, `docs/design` and
      `test/fixtures`.
- [ ] Search history for personal data: real tailnet names (anything
      `*.ts.net` that isn't a placeholder), email addresses, home-folder paths
      with a real user name, account names, the private tool's names and
      ports, Superset workspace or terminal ids (`git log -p --all` piped
      through a search).
- [ ] GitHub, before going public: PR descriptions, review comments, issues and
      Actions logs become public too; read them. Check step 12's workflows
      (`permissions`, no `pull_request_target` with checkout of PR code, no
      secrets printed). Turn on private vulnerability reporting, since
      SECURITY.md points to it.
- [ ] If a secret is found in history: rotate it first, then decide on
      rewriting history before the repo goes public.

## 8. Tests that hold the defences

For each defence, a test that fails if it is removed. Confirm one exists, or
list it as a gap:

- [ ] Pairing: wrong code, five tries, expiry, reuse, one code at a time.
- [ ] Tokens: missing, malformed, wrong, revoked.
- [ ] CORS: allowed and refused origins; preflight.
- [ ] File rules: hidden folders, `node_modules`, links out of the folder, hard
      links, deny names, wrong magic bytes, key patterns, the home folder as a
      root, a file changed between listing and use.
- [ ] Tickets: expiry, use count, wrong name, a file replaced after the link was
      made, page CSP.
- [ ] Hook endpoint: Origin, Host, secret, type, size, bad fields, terminal reset
      on a new process.
- [ ] Bridges: no pid or start time, a gone agent, another tmux server, copy
      mode, socket not owned or a link.
- [ ] Controls: refused on a menu, unsent text, a running turn; unknown commands
      and arguments.
- [ ] Nothing logs a token, a code, a query string or a body (a test that
      captures the log during a full session).

## 9. Residual risks

- [ ] Go through each residual risk in THREAT-MODEL.md: still true? Fixed,
      accepted, or moved to after launch? Record the decision next to it.

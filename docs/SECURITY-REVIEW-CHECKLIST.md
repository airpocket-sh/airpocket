# Security review checklist

The list for the review half of step 11, once steps 9 and 10 have landed. It
was written from `main` after step 8 (commit `e444886`); anything added since
needs a line of its own. Read it with [THREAT-MODEL.md](THREAT-MODEL.md).

**Status (step 11, second half).** Worked through on branch `step-11-fixes`.
`[x]` is confirmed with evidence (in the PR); `[ ]` with a note is a finding or
still open. Step 10 (setup, doctor, uninstall, `tailscale.js`, the login
item) landed after this pass, so its lines are not checked here. Notes and rows changed by this
pass say *step 11*.

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

- [x] Each server binds `127.0.0.1` only (`start()`, `service.listen`). No
      `0.0.0.0`, `::` or tailnet address anywhere, tests included.
- [ ] Only `airpocket setup` publishes, only with `tailscale serve`, only the
      app and file ports, never on a tailnet port another program uses;
      `airpocket uninstall` turns off only ports that publish nothing but
      Airpocket's own targets. Search the repo (docs too) for `funnel`: it may appear
      only as "never".
      *Step 11 checked this for `airpocket serve`, before step 10 replaced it with setup; setup and uninstall are not checked here. Note: `ports.js` would let `AIRPOCKET_FILE_PORT` equal the hook port, which publishing would then expose.*
- [x] Every table lookup keyed by request input uses `Object.hasOwn` (`STATIC`,
      `KEYS`, `COMMANDS`, `FILE_KINDS`, model lists), so `__proto__` or
      `constructor` resolve to nothing.
      *Also plain, safe today: the POST handler map (paths start with `/api/`) and `hook.js`'s notification table (the service refuses the result).*
- [x] Error bodies never echo request input back.
      *Step 11: `runFile` failures carried `Command failed: <program> <all arguments>` into `/api/new`'s error and the log; fixed (residual 18).*
- [x] Timeouts and body caps are set on each server (app: 30 s request, 15 s
      headers, 32 KB JSON; file: 60 s request, header timeout left at Node's
      default; hook: 5 s and 5 s, 16 KB).
- [x] Decide on a Host allow-list (tailnet name or loopback) for the app and
      file servers (residual risk 4).
      *Step 11: done. `HOST_OK` (`*.ts.net` or loopback, any port) runs first on both servers; test "DNS rebinding: …". It accepts any `*.ts.net` name, not only this Mac's.*

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
| `GET /api/sessions` | nothing | Fields per session. No paths, no full email, snippets clipped. `unseen` is two counts and a word, nothing about the processes. |
| `GET /api/screen` | `id`, `view`, `sig` | `id` must match `SESSION_ID`. What `items`, `text` and `info` carry. Terminal text is sent as is (residual 7). |
| `POST /api/send` | `id`, `text`, `submit` | `cleanText` (line breaks to spaces, codes 0-31 and 127 dropped), 8,000 characters at most, `bridges.writable` before typing. C1 controls (residual 16). |
| `POST /api/key` | `id`, `key` | Key from `KEYS` only, `writable` first. |
| `POST /api/command` | `id`, `cmd`, `arg` | `COMMANDS` table only. Model or effort from the agent's own lists. Fresh screen read; refused on a menu, unsent text or a running turn. `writable` first. |
| `POST /api/seen` | `id` | Clears only "finished" and "waiting for you". |
| `GET /api/models` | nothing | Ids, names and efforts, plus where each list came from (`from`) and a model's default effort. |
| `GET /api/new/options` | nothing | Superset present; names and ids, plus a workspace's branch, type and project id; no paths or remotes. Lists cached up to 60 s. |
| `POST /api/new` | `agent`, `workspace` or `project` + `branch`, `model`, `effort`, `prompt` | Each id must be in Superset's fresh list; `BRANCH` pattern; model and effort on the lists; `cleanPrompt`; leading dash padded; 8,000 characters. Error text returned (residual 18). |
| `GET /api/files` | `id` | Refs, names, folder relative to the root, kind, size, time. No absolute paths. |
| `GET /api/file/text` | `id`, `ref` | Ref shape; `lookupFile`; text kinds only; 512 KB; key patterns over everything sent. |
| `GET /api/file/image` | `id`, `ref` | `lookupFile`; image kinds only; own sandbox CSP. SVG scan covers 4 KB only (residual 6). |
| `POST /api/file/open` | `id`, `ref` | `lookupFile`; PDF and page only; ticket rules (below); the returned origin comes from the Host header only if it is a `*.ts.net` name (*step 11*: it read `X-Forwarded-Host` first; now Host only). |
| `POST /api/upload` | `id` (query), the photo's bytes | The only non-JSON body. Session must exist first; `Content-Type` must be one of four image types and must match what the bytes say they are; 8 MB; written 0600 under `uploads/` in the data folder with a name the Mac chooses; answers a ref, never a path. Old photos swept (a week, forty files). |
| anything else | | 401 without a token, 404 with one, 405 for other methods. |

- [x] A revoked token fails on the very next request.
- [x] Nothing touches the service, a bridge or the filesystem before the token
      check (apart from static files and pairing).
      *Step 11: the Host check runs before everything.*
- [x] The phone can't name a terminal, a path or a transcript in any route, nor
      the text of a Controls command.
- [x] A photo is the only thing the phone can write to the Mac, and it cannot
      say where it goes: `/api/send` turns refs into paths itself, and a ref
      this process never issued (or has forgotten) is refused with 410.

### File-only origin (47872)

- [x] Only `GET`/`HEAD /f/<43-character ticket>/<name>`; anything else 404 or
      405, with no API and no app.
- [x] Ticket: 32 random bytes, in memory, two minutes, 40 requests, at most
      100 alive. The name in the URL must equal the ticket's.
      *No test drives 40 good requests or 100 tickets (section 8).*
- [x] Every request runs `fileMeta` again and matches inode, device and
      extension. Pages are scanned whole for key patterns each time.
- [x] Headers: `PAGE_CSP` for pages (sandbox, no scripts, `data:` images and
      fonts only); `frame-ancestors 'none'` for PDFs; `no-store`, `nosniff`,
      `Cross-Origin-Resource-Policy: same-origin`, `noindex`.
      *Tests check CSP, `nosniff` and `no-store` only; CORP, `noindex` and the PDF `frame-ancestors` are untested.*
- [x] Range requests: malformed or out of range gives 416, never a read past
      the end.
      *No test for 416. Step 11: an empty page or PDF hung its response for 60 s (a range ending at -1); fixed and tested.*
- [x] Logs carry method and status only, never the path (it holds the ticket).
      *Step 11 adds `file <method> 403 (host)`, without the Host value.*

### Hook endpoint (47873)

- [ ] Never published; not in `TARGETS` in `cli.js`.
      *Held for `cli.js` before step 10; step 10 publishes through `setup.js` and `tailscale.js`, not checked in this pass.*
- [x] Check order: path and event (404), method (405), Origin present or Host
      not loopback (403), secret (401), JSON type (415), size from
      `Content-Length` and while reading (413, connection closed), JSON object
      (400).
- [x] `POST /hook/session`, `/hook/touch`: `upsert`. `/hook/enqueue`: `reason`
      from `REASONS`. `/hook/dequeue`: `why` is `prompt`, `interrupt` or `end`.
- [x] Field checks in `upsert`: `session_id` pattern; `agent` enum; `cwd`,
      `tmux` absolute, 1,024 characters, no control characters; `transcript`
      named after the session; `pane` `%<n>`; `terminal`, `workspace` id
      pattern; `pid` via `pidOf`; `started` a positive safe integer; text
      clipped; snippets matching key patterns dropped.
- [x] A hook from another process replaces all five terminal fields.
- [x] `hook.js`: sends only to 127.0.0.1; silent; exits 0; 1.5 s; 1 MB input;
      never tool input; subagent events ignored.
      *Subagent events are skipped for Claude only (`agent_id`); whether Codex needs the same isn't verified.*

### Added by steps 9 and 10 (fill in)

- [x] QR pairing: what the QR holds. It must never hold a token, and should hold
      no more than the address and, at most, the short-lived code.
      *`AIRPOCKET:PAIR:<code>:<address>`, no token (`qr.js`; test "the pairing payload …").*
- [x] First-run guidance: nothing that tells users to use `funnel`, open ports
      or turn off checks.
- [ ] setup, doctor, uninstall: every file, setting and login item they write,
      and that uninstall removes exactly those.
      *Step 10 landed after this pass; not checked here.*
- [x] Any new route, in the tables above.
      *None added; `STATIC` grew by fixed names only.*

## 2. Filesystem

Every read and write, and what guards it.

| Where | Path | Read or write | Confirm |
| --- | --- | --- | --- |
| `store.js` | data folder `devices.json`, `pairing.json` | both | Folder made 0700; files 0600 via temp and rename; no lock between CLI and server (residual 9). *Step 11 finding:* 0700 only when the folder is created (only the service's `privateDir` fixes a looser one); the temp name `<file>.<pid>.tmp` is predictable, opened without `wx`, not fsynced. |
| `service.js` | data folder, `sessions/<id>.json`, `queue.json`, `hook.json`, `airpocket.lock` | both | `privateDir` sets 0700 on every start; `writeAtomic` (`wx` temp, 0600, fsync, rename); record file names only from `SESSION_ID`; leftover `.tmp` removed (in `sessions/` only); lock taken before any write; also `airpocket.lock.takeover`, `*.stale.*` and their temp files. *Step 11:* `hook.json` is removed on stop, and a crash's leftover at the next start. |
| `server.js` static | `src/public/<fixed name>` | read | Names from `STATIC` only. |
| `server.js` transcripts | recorded path; `~/.claude/projects/*/<uuid>.jsonl`; `$CODEX_HOME/sessions/Y/M/D/rollout-*-<uuid>.jsonl` | read | Recorded path by real path, a file, named after the session. Fallback ids must be UUIDs. Tail reads: 4 MB; Codex window up to 32 MB. *Step 11 findings:* the Claude fallback is only `existsSync` (follows links, not checked to be a file); later Codex polls read everything appended with no cap (`readOn`). |
| `server.js` files | session folder and below | read | `sessionRoot` (residuals 13, 14), `fileMeta` every rule, `lookupFile` at use, `fileRoute` per request. Check-then-open by path (residual 15). |
| `models.js` | `~/.claude/cache/model-catalog/*-cc.json`, `$CODEX_HOME/models_cache.json` | read | Folder by real path; names by pattern; `lstat` refuses links; size caps 1 MB and 4 MB checked on the open file. *Step 11:* true for Claude's folder; Codex's file is opened by path (follows links) and `CODEX_HOME` isn't real-path checked. |
| `hook.js` | data folder `hook.json`; `.git` up to 40 folders up, a worktree's `gitdir:` target `HEAD`; `.claude.json` in the config folder | read | `HEAD` and a `.git` file are read whole with no size cap, then only the first 1 KB and 4 KB are used, and only a `ref: refs/heads/…` line is taken; `.claude.json` at most 32 MB, only `oauthAccount.emailAddress`. The `gitdir:` target is chosen by the repository. |
| `bridges.js` | `~/.superset/bin/superset`; tmux in three fixed folders; the tmux socket | stat | Executable regular file; socket by `lstat`, owned by this user. |
| `server.js`, `cli.js` | Tailscale app bundle and two fixed paths; `which tailscale` in the CLI | stat | Real path, executable. The CLI also trusts `PATH` (section 4). |
| setup, uninstall (step 10) | `~/.claude/settings.json`, `~/.codex/hooks.json`, login item, logs | write | Fill in: backups, merge not overwrite, modes, exact removal. |

- [x] No path from the phone reaches `fs` without going through the rules
      above.
- [x] No write outside the data folder, apart from what setup documents.
      *Checked for the code before step 10: apart from publishing through Tailscale, nothing outside the data folder. What setup writes is step 10's, not checked here.*
- [ ] Every read of a file whose size someone else controls has a cap.
      *Finding: Codex `readOn` growth; `.git`/`HEAD` read whole; images and pages re-read whole after the size check.*
- [ ] Tests use temp folders only; none touches the real home, `~/.claude`,
      `~/.codex` or the private tool's data.
      *Finding (reads only): "liveness costs one ps call per second" builds a server without `claudeProjects`, so it lists the real `~/.claude/projects`; one server test leaves `claudeDir` at the real home. Nothing is written.*

## 3. Where a secret could be logged

Secrets here: device tokens, pairing codes, the hook secret, file tickets and
refs, query strings, request bodies, typed text, file contents, snippets.

| Where | Line | Confirm |
| --- | --- | --- |
| `server.js` request handler | `METHOD /path status ms`, for POSTs and failures | Path only, never the query string. A ticket path sent to the wrong port would be logged: acceptable? |
| `server.js` | `error:` with the stack | Stacks can carry Superset or tmux error output, 300 characters (residual 18). *Step 11:* they carried every argument (typed text) when a program failed without stderr; `runFile` fixed. |
| `server.js` `pair` | `paired <name> (<id>)` | No token or code. |
| `server.js` `openFile` | `opened a <kind> (<ext>)` | No name or path. |
| `server.js` `newSession` | `started <agent> in a workspace` or `on a new branch` | No prompt, branch or project. |
| `server.js` file server | `file server error:` with the message; `file <method> <status>` | fs error messages hold paths; no ticket. |
| `server.js` `start` | listening and port-taken lines; `console.error` of the ELOCKED message or a start-up stack | Nothing secret. |
| `server.js` request handlers (*step 11*) | `<METHOD> 403 (host)`, `file <METHOD> 403 (host)` | Not the Host value. |
| `service.js` | `service: couldn't save <what>: <code>`; `hook <method> <path> <status>`; `hook error:` with the message; `airpocket.lock now names process N … stops`; `onLost failed:` with the message | No body or secret; path clipped to 40. |
| `hook.js` | none | Nothing on stdout or stderr, ever (Claude adds hook output to the conversation). |
| `cli.js` | the pairing code (by design, on the Mac's own terminal); device list; Tailscale's own output | Nothing else prints a code, token or secret. |
| step 10 | where the service's output goes | Log file mode 0600 in a private folder, size limit or rotation, removed by uninstall. |

- [x] Search `src/` for every `log(`, `console.`, `process.stdout`,
      `process.stderr`; each one is in this table.
      *Rows added above for what the search found missing. `cli.js` usage lines: step 10.*
- [ ] Uncaught exceptions: what Node prints, and where it goes under the login
      item.
      *No `uncaughtException` handler: Node prints the stack and exits 1; the exit handler still removes `hook.json` and the lock. Where stderr goes under the login item (step 10): not checked here.*

## 4. External commands

All must use `execFile` or `execFileSync` with an argument list: no shell, no
`exec`, no `shell: true`, no string commands.

| Program | Found by | Arguments | Env | Timeout | From the phone |
| --- | --- | --- | --- | --- | --- |
| `/bin/ps` (`proc.js`) | fixed path | `-o pid=,lstart= -p <pids>`; `-o pid=,ppid=,lstart=,comm= -p <pid>`; *step 11:* `-o pid=,tty=,pgid=,tpgid=,lstart= -p <pid>` before every write (`processInfo`) | `PATH=/usr/bin:/bin`, `LC_ALL=C` | 2 s | nothing (pids come from records) |
| tmux (`bridges.js`) | first of `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin` | `-u -S <socket>` then `display-message -p -t <pane> #{pid} ; capture-pane -p -t <pane>` (the `;` is its own argument); `display-message -p -t <pane> "#{pid} #{pane_in_mode} #{pane_tty}"` (one argument; *step 11* added `#{pane_tty}`); `send-keys -t <pane> -l -- <text>`; `send-keys -t <pane> <key name>` | `PATH=/usr/bin:/bin`, `LANG=en_US.UTF-8` | 5 s | text (cleaned, 4 KB pieces, trailing `;` escaped), key names from `KEYS` |
| Superset (`bridges.js`, `server.js`) | `~/.superset/bin/superset` (a shim into the app bundle) | `terminals read --workspace W --terminal T --json`; `terminals send --workspace W --terminal T --text <text> [--no-submit]` (*step 11:* `--text=<text>` when the text starts with `-`); `projects list --json`; `workspaces list --json`; `agents list --local --json`; `agents create --workspace <uuid> --agent <preset> [--model M] [--effort E] --prompt <p> --json`; `workspaces create --local --project <uuid> --branch B --name B --agent <preset> [--model M] [--effort E] --prompt <p> --json` | inherited | 15 s, 90 s to create | text, prompt, branch, ids chosen from lists |
| Tailscale (`server.js`) | real path of the app bundle binary or two fixed paths | `status --json` | inherited | 6 s | nothing |
| Tailscale (`cli.js`) | `/usr/bin/which tailscale` plus fixed paths | `status --json`; `serve status --json`; `serve --https=<port> --bg http://127.0.0.1:<port>`; `serve --https=<port> off` | inherited | 8 s for status | nothing |
| step 10 | fill in | | | | |
| tmux (`ownterm.js`, `airpocket run` and `attach`, on this user's terminal) | the same three fixed folders | `-V`; `-u -S <data>/tmux/sock -f <app>/src/tmux.conf new-session -s <agent>-<folder> -c <cwd> -- /bin/sh <start script>`; `-u -S <socket> attach-session -t =<name>`; `-u -S <socket> list-sessions -F <format>` | the user's shell (new-session, attach); `PATH=/usr/bin:/bin`, `LANG=en_US.UTF-8` (the rest) | none on the terminal; 10 s | nothing: the phone never starts or attaches these |

- [x] Every value that reaches an argument from the phone is validated first
      (tables above).
- [x] Free text never lands where it can be read as an option: tmux has `--`.
      Superset `--text` with a leading dash is unverified (residual 16); check
      the CLI's parsing without typing into a real terminal.
      *Step 11: the installed Superset CLI's parser refuses a value starting with `-` ("requires a value"), so such messages failed. Now sent as `--text=<value>`; ids can't start with `-`. The CLI also reads some options from the environment (`SUPERSET_API_KEY`).*
- [x] `--prompt` with a leading dash is padded; `--branch` and `--name` can't
      start with a dash.
- [ ] Decide whether inherited environments are fine for Superset and
      Tailscale, and whether the CLI should stop trusting `PATH` for
      `tailscale`.
      *Open for Öncel. Superset and Tailscale get the service's whole environment; `tailscale.js` (step 10) runs `/usr/bin/which tailscale` on the inherited `PATH`, with no timeout.*
- [x] No command runs with text from a transcript or a screen.

## 5. Secrets at rest

| Secret | Where | Form | Confirm |
| --- | --- | --- | --- |
| Device token | phone: web app local storage, key `airpocket.hosts.v1` | plain | Residual 17. Never in the service worker cache. |
| Device token | Mac: `devices.json` | SHA-256 (256-bit random input, so no salt needed) | 0600 in a 0700 folder. |
| Pairing code | Mac: `pairing.json` | SHA-256 of six digits, easily reversed | Only for ten minutes; same-user readable only. Acceptable? |
| Hook secret | Mac: `hook.json` | plain (the hooks must read it) | 0600; new each start; *step 11:* removed on stop, and a crash's leftover at the next start. |
| File-ref key | memory | 32 random bytes | Never written or logged. |
| File tickets | memory | 32 random bytes | Never written or logged. |
| Account email, snippets | Mac: `sessions/*.json`, `queue.json` | plain | 0600; snippets matching key patterns dropped. |

- [ ] Modes on a fresh install from step 10's setup, and after an upgrade
      over an existing folder with looser modes.
      *Not checked here (step 10 landed after this pass); see the `store.js` folder-mode finding in section 2.*
- [ ] No real token, code, secret, email or tailnet name in any file in the
      repo (section 7).
      *A manual pass found only placeholders and fixtures; no scanner run (section 7).*

## 6. Phone web app

- [x] CSP on every app response (`CSP`); nothing inline; no external scripts,
      styles, fonts or images.
- [x] No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`,
      `eval` or `new Function` in `src/public`.
- [x] `h()` sets attributes only from keys in code, never from data.
- [x] `md.js`: links only `http:` and `https:`, `target=_blank` with
      `rel="noopener noreferrer"`.
- [x] File links opened only when they match `FILE_LINK`; blob URLs revoked on
      close.
- [x] The "Add a Mac" address must be a `*.ts.net` HTTPS address or loopback.
- [x] Service worker: same-origin `GET` only, never `/api/`, app shell only.
- [ ] SVG shown from a `blob:` URL: check what iOS does if it is opened
      directly (residual 6).
      *Needs a real iPhone (step 13).*
- [x] Step 9's new app: repeat all of the above.
      *Done on the app as merged at step 9, plus step 11's `!` dialog and pairing warning (DOM only).*

## 7. Dependency and history scans

- [x] Dependencies: `package.json` lists none today and there is no lock file.
      Confirm that's still true. If anything was added, commit a lock file, run
      `npm audit --omit=dev`, and read each package and its install scripts.
      *None, no lock file. AGENTS.md still says "`ws` today"; `docs/reference/shoot.js` loads `ws` from the private tool's folder.*
- [ ] Node: the supported range in `engines` is still maintained upstream.
      *Finding: `>=20`, but Node 20 reached end of life on 2026-04-30; CI tests 20 and 22, not 24.*
- [ ] Secret scan of the working tree and **all history on all branches**, for
      example `gitleaks detect --log-opts="--all"` and `trufflehog git
      file://. --no-update`. Include `docs/reference`, `docs/design` and
      `test/fixtures`.
      *gitleaks and trufflehog aren't installed. A manual `git log -p --all` search (key headers, `sk-ant-`, `ghp_`, `xox`, `AKIA`) found only test fixtures. Run a real scanner before going public.*
- [ ] Search history for personal data: real tailnet names (anything
      `*.ts.net` that isn't a placeholder), email addresses, home-folder paths
      with a real user name, account names, the private tool's names and
      ports, Superset workspace or terminal ids (`git log -p --all` piped
      through a search).
      *Findings: a personal Gmail address is the author of 52 commits; `claude-overlay`, `claude-accounts` and port 47820 appear in AGENTS.md, PLAN.md and `docs/reference/shoot.js`; three UUIDs in `test/server.test.js` may be real session ids. Tailnet names and home paths are placeholders.*
- [ ] GitHub, before going public: PR descriptions, review comments, issues and
      Actions logs become public too; read them. Check step 12's workflows
      (`permissions`, no `pull_request_target` with checkout of PR code, no
      secrets printed). Turn on private vulnerability reporting, since
      SECURITY.md points to it.
      *Workflow is fine (`contents: read`, `pull_request`, pinned actions, no secrets). PR bodies #1 to #9 hold fixtures only. Actions logs not read; private vulnerability reporting waits for a public repo.*
- [ ] If a secret is found in history: rotate it first, then decide on
      rewriting history before the repo goes public.

## 8. Tests that hold the defences

For each defence, a test that fails if it is removed. Confirm one exists, or
list it as a gap:

- [ ] Pairing: wrong code, five tries, expiry, reuse, one code at a time.
      *Gaps: code expiry, and a new code replacing the old one.*
- [ ] Tokens: missing, malformed, wrong, revoked.
      *Gap: malformed headers for the app's bearer check.*
- [x] CORS: allowed and refused origins; preflight.
- [x] File rules: hidden folders, `node_modules`, links out of the folder, hard
      links, deny names, wrong magic bytes, key patterns, the home folder as a
      root, a file changed between listing and use.
- [ ] Tickets: expiry, use count, wrong name, a file replaced after the link was
      made, page CSP.
      *Gaps: the 40-use limit, and the inode/device match (the replacement test keeps the inode, so only the first-bytes check catches it).*
- [x] Hook endpoint: Origin, Host, secret, type, size, bad fields, terminal reset
      on a new process.
- [x] Bridges: no pid or start time, a gone agent, another tmux server, copy
      mode, socket not owned or a link.
      *Step 11 adds the agent's terminal and foreground, against a real tmux ("tmux (real): an agent that was only started from the pane…", "… doesn't hold its pane …").*
- [x] Controls: refused on a menu, unsent text, a running turn; unknown commands
      and arguments.
- [x] Nothing logs a token, a code, a query string or a body (a test that
      captures the log during a full session).
      *Step 11: "the log holds no pairing code, token, ticket, query string or typed text" (the server, over the whole test run); the hook secret in `service.test.js`. The service's own log over a session isn't captured.*

## 9. Residual risks

- [ ] Go through each residual risk in THREAT-MODEL.md: still true? Fixed,
      accepted, or moved to after launch? Record the decision next to it.
      *Step 11 recorded decisions for 1 (kept; said before pairing, confirmed on the phone), 2 (closed for tmux, open for Superset), 3 (hook half closed), 4 (closed), 16 (leading dash settled), 18 (argument leak fixed). The rest are unchanged and still read true.*

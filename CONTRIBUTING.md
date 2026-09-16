# Contributing

Thanks for trying Airpocket. This is how the repo works today.

## Where to look first

- [AGENTS.md](AGENTS.md): the brief. What Airpocket is, the security rules,
  hard-won facts about Claude Code, Codex, tmux and Tailscale, and where the
  code stands. Read it before changing anything.
- [docs/PLAN.md](docs/PLAN.md): the build steps, in order, and what is left.
- [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md): the security boundary: what a
  paired phone can do, what leaves the Mac, what is kept where.
- [docs/design](docs/design): the design pack the phone app follows.

## Running the tests

```sh
node --test
```

That is the whole suite. There are no dependencies to install. Everything runs
in temporary folders, with stand-ins for launchctl, Tailscale and Superset. The
tmux bridge tests skip themselves when tmux isn't installed
(`brew install tmux` to run them).

CI runs on macOS for Node 20 and 22: a syntax check, `node --test` with a real
tmux, and `.github/smoke.js`. A push doesn't always start a run. If a pull
request shows no checks, start one:

```sh
gh workflow run test.yml --ref <branch>
```

## Sending a change

- One branch per change, off the latest `main`.
- Open a pull request that says what changed and how you proved it: the tests
  you added, and the output of anything you ran by hand.
- Nobody merges their own pull request. Someone else reviews it and merges it.

## Rules that aren't obvious

- **Nothing invented on screen.** The phone shows only what the Mac really
  knows: from the agents' own files, the terminal, or Airpocket's records.
  When something can't be known, the app says so; it never guesses a model,
  a state or a name.
- **No new dependencies.** Plain Node (CommonJS), a DOM-only app with no
  framework, no `innerHTML`. Today there are none, and that is on purpose.
- **Tests that fail when the fix is removed.** Take your change out, run the
  test, and see it fail before you call it proved.
- **Never touch your real agent config.** Only `airpocket setup`, run by you,
  writes `~/.claude/settings.json`, `$CODEX_HOME/hooks.json`, your shell
  profile or the login item. Tests and trials point `HOME` (and `CODEX_HOME`)
  at a temporary folder. Never send text or keys into your real sessions
  while testing, and never run `/model` or `/effort` in a real Claude Code
  during a trial: they save your defaults.
- **The security rules in AGENTS.md hold for every change**: loopback only,
  `tailscale serve` and never `funnel`, the phone names a session and an
  action and never sends a path or command text.

## Reporting a security problem

See [SECURITY.md](SECURITY.md). Please don't open a public issue for it.

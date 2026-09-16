# Changelog

Every change people using Airpocket would notice, newest first. The form is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

The first version. Airpocket runs on each Mac where you use Claude Code or
Codex and makes those sessions reachable from a web app on your phone, over
your own Tailscale network. There is no Airpocket server, account or relay.
macOS only, Node 20 or newer.

### Added

- **One list** of every Claude Code and Codex session on every paired Mac,
  with the ones waiting on you first: finished, waiting for input, needing
  permission. Each row shows the model, effort, permission mode and whether a
  turn is running. Agents running on the Mac that Airpocket hasn't heard from
  yet are counted, with a line on how to bring them in.
- **The conversation**, read from the agents' own session files rather than the
  terminal: your messages, the replies, and one short label per step, updated
  live. Codex turns are shown while they run.
- **Reply and control** from the phone: send messages and photos, press keys,
  pick options in on-screen menus, and change model, effort, permission mode
  and fast mode from each agent's own model list. Commands such as compact,
  resume and clear come from a fixed table on the Mac, and are refused while a
  turn runs, a menu is open or unsent text sits in the box.
- **New sessions** in a project, on a new branch or in an existing workspace,
  for Claude Code or Codex, when Superset is installed.
- **Files a session wrote, edited or linked**: text, Markdown, code, images,
  PDFs and HTML pages, limited to the session's own folder and checked by
  content. PDFs and pages open from a separate file-only origin through
  two-minute links, and pages there run no scripts.
- **`airpocket run claude|codex`**: starts the agent in a tmux session of
  Airpocket's own, so the phone can answer a session started in any terminal.
  `airpocket attach` brings back one whose window was closed. Sessions in
  Superset or an existing tmux pane can be answered without it; anything else
  is shown read-only.
- **`airpocket setup`**: checks the Mac first and stops before changing
  anything if something is missing, then installs the hooks for Claude Code
  and Codex (merged into their settings, with a backup), a login item, the app
  published inside the tailnet with `tailscale serve`, optional `claude` and
  `codex` shell aliases, and a pairing code with its QR. `--dry-run` prints
  the plan.
- **`airpocket doctor`**: checks the install and says what to do about each
  problem. **`airpocket uninstall`** removes what setup added, taking only its
  own entries out of the agents' config files.
- **Pairing** with a six-digit code or its QR, one token per phone and per
  Mac, stored on the Mac only as a hash. `airpocket devices` lists paired
  phones and `airpocket revoke` cuts one off at once.
- **A home-screen web app** with no App Store. It still opens when the Mac
  that served it is asleep, follows Reduce Motion and Reduce Transparency, and
  ships its own fonts.
- **Security documentation**: [SECURITY.md](SECURITY.md) for reporting a
  problem, and a threat model and review checklist in the repository's `docs`.

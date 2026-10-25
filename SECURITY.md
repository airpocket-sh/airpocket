# Security policy

Airpocket lets a phone read and type into coding agents on your Macs, so its
security matters more than its size suggests. Thank you for looking.

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request for a security
problem.**

Report it privately through GitHub: on this repository, open the **Security**
tab and choose **Report a vulnerability**. Only the maintainers can see the
report and the conversation that follows.

If that route isn't open to you — GitHub only offers it on a public
repository, and not everyone wants a GitHub account to report a bug — email
**info@airpocket.sh** instead. It reaches the same people.

A good report says:

- what the problem is, and what someone could do with it;
- where it is (file, function, route or command);
- the version or commit you tested;
- how to see it happen on your own Mac, phone and tailnet.

Leave out real device tokens, pairing codes, hook secrets, tailnet names,
email addresses and anyone's conversations or files. Replace them with
placeholders.

## What to expect

- **Within 7 days:** we confirm we received the report.
- **Within 14 days:** a first assessment: in scope or not, how serious, and
  what happens next.
- **Until it's fixed:** an update at least every 14 days.
- **A fix** as soon as its severity calls for it, released with a GitHub
  security advisory that describes the problem and the fix.
- **Disclosure:** please keep the details private until the advisory is out,
  or 90 days after your report, whichever comes first. If a fix needs longer,
  we'll ask you and agree on a date together.
- **Credit** in the advisory, under the name you choose, if you want it.

Airpocket is a free project. There is no bug bounty.

## Supported versions

Only the latest release gets security fixes. Fixes are not backported. Until
the first release, that means the `main` branch.

## Scope

In scope:

- The Airpocket service: the phone app server and its API, the file-only
  server and the hook endpoint.
- The hook (`src/hook.js`), the `airpocket` command, and the setup and
  uninstall steps once they ship.
- The phone web app (`src/public`).
- Anything that breaks a promise in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)
  or in the posture below. For example: reaching the API without a valid
  token; opening a file outside the file rules; typing into a terminal that
  isn't the agent's; a token, secret or file's contents in a log; data leaving
  the user's own machines.

Out of scope:

- A Mac account that is already compromised, including any process running as
  that user.
- Physical access to an unlocked phone.
- What a user's own agent chooses to do.
- Bugs in Tailscale, Claude Code, Codex, Superset, tmux, macOS or iOS. Please
  report those to their makers. If Airpocket *uses* one of them unsafely, that
  is in scope.
- Setups Airpocket doesn't make: `tailscale funnel`, listening on addresses
  other than 127.0.0.1, another proxy in front of it.
- Denial of service by someone already on your tailnet or your Mac.
- The residual risks already listed in the threat model, unless you show one
  is worse than written there.

When testing, use only Macs, phones and tailnets that are yours. Don't read,
change or keep other people's data; if you come across any, stop and tell us.
We won't pursue anyone who follows this policy in good faith.

## Standing posture

These hold for every release. A change that breaks one of them won't be
accepted.

- **Tailnet only.** Every server listens on 127.0.0.1. `airpocket setup`
  publishes the app and the file-only origin with `tailscale serve`, which
  reaches only devices on your tailnet. Airpocket never uses `tailscale
  funnel` and never publishes anything to the public internet. The hook
  endpoint is never published at all.
- **No cloud.** There is no Airpocket server, relay or hosted service. Your
  phone talks straight to your Macs over your own Tailscale network.
- **No account.** Nothing to sign up for. Each phone pairs with each Mac using
  a short-lived code shown on that Mac, and gets its own token; the Mac keeps
  only a hash of it.
- **Nothing leaves your machines.** Airpocket has no telemetry, analytics,
  crash reporting or update checks, and makes no network requests except
  between your phone and your Macs. Your conversations, files and tokens stay
  on your devices. Your agents still talk to their own providers, as they do
  without Airpocket, and Tailscale's coordination service knows which devices
  you have, not what they send.
- **The phone asks, the Mac decides.** The phone names a session and an
  action. It never sends a file path, a terminal, or the text of a Controls
  command; the Mac looks those up in its own records and fixed tables.
- **One way in, one place to land.** The only thing a phone can put on the Mac
  is a photo for a session, and it lands in Airpocket's own data folder, 0600,
  never in a project. The bytes have to be an image the agents can read, the
  phone gets a ref rather than a path, and old photos are swept.

How Airpocket defends each of these, and what it knowingly doesn't, is in
[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

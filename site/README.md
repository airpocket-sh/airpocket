# The launch page

`airpocket.sh`. One static page: `index.html`, the chart behind it (`map.svg`),
five screenshots of the real app (`shots/`), and the three fonts (`fonts/`,
copied from `src/public/fonts`, both licences beside them).

Nothing here reaches the network: no fonts from a CDN, no analytics, no
third-party script. Keep it that way; the page argues that nothing of yours
leaves your machines, and it should be true of the page itself.

The screenshots come from the real app, rendered by
`node docs/reference/shoot-app.js <dir>` against invented Macs and sessions.
Regenerate them when the app's look changes rather than editing them.

`<meta name="robots" content="noindex">` is in `index.html` on purpose: the page
links to a repository that is still private, so those links would 404 for a
visitor. Remove that line at step 16, when the repo goes public.

Designed in Claude Design; the source of that design and the app's own design
pack are in `docs/design`.

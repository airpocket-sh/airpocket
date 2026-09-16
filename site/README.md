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
visitor. Remove that line at step 16, when the repo goes public. The share card
below does not depend on it: chat apps and social sites read the tags of a page
whether or not search engines may index it.

## The share card and the icon

A link to `airpocket.sh` pasted into X, Slack or WhatsApp shows a card, because
the `<head>` of `index.html` carries Open Graph and Twitter tags. Their title
and description are the page's own `<title>` and the first and last sentences
of its opening paragraph; if those change, change the tags with them.

- `og.png`: the card, 1200x630. Its source is `og.html`, the opening
  sequence's settled frame held still (the map, the dart on station beside the
  wordmark, the page's first line, the chips), with the page's own fonts and
  map. `og:image` has to be an absolute URL, so it names
  `https://airpocket.sh/og.png`; the card only works on that host.
- `icon.svg`: the favicon, the dart from the header on the dark ground, the
  same path.
- `icon-180.png`: the same dart as a square PNG, for the browsers that ignore
  an SVG icon and for iOS, which rounds the corners itself.

Both PNGs are committed and rendered by hand when their sources change:

    node site/render-card.js

It uses headless Chrome through `docs/reference/cdp.js`, like the app's
screenshots and icons, and exits with an error if a source logs anything to the
console or the card comes out over 300 KB, the point past which some chat apps stop fetching the image. After a
change to the card, platforms may show the old one for days, since they cache
it by URL.

`og.html` and `render-card.js` are deployed with the rest of the folder. Nothing
links to them, `og.html` carries its own `noindex`, and neither reaches the
network.

Designed in Claude Design; the source of that design and the app's own design
pack are in `docs/design`.

## The opening sequence

The first block in `index.html` is the intro: the dart comes in low from the
left, swoops up, brakes onto station beside the wordmark, and the plate lifts to
let the page through. 4.3 seconds, ported by hand from the `Airpocket Intro`
composition in Claude Design — canvas for the flight, the trail and the range
rings, plain DOM for everything else, no library.

It is opt-out by construction: the page underneath is fully rendered the whole
time, the script only ever hides it, and every path that ends the intro puts it
back. It does not play for `prefers-reduced-motion`, for a deep link with a
`#hash`, for a second visit in the same tab (`sessionStorage`), or if anything
in it throws; a tap, a key or a scroll skips to the lift; a 9-second timer ends
it even if the tab was in the background. Add `?intro=1` to watch it again.

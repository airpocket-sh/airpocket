# The site

`airpocket.sh`. A small static site: the launch page (`index.html`), four guides
that each answer one question people search for, the chart behind every page
(`map.svg`), five screenshots of the real app (`shots/`), and the three fonts
(`fonts/`, copied from `src/public/fonts`, both licences beside them).

Nothing here reaches the network: no fonts from a CDN, no analytics, no
third-party script, no tag manager. Keep it that way, however much a habit from
other sites suggests one; the launch page argues that nothing of yours leaves
your machines, and it should be true of the site itself.

The screenshots come from the real app, rendered by
`node docs/reference/shoot-app.js <dir>` against invented Macs and sessions.
Regenerate them when the app's look changes rather than editing them.

## The pages

| Address | File | Answers |
| --- | --- | --- |
| `/` | `index.html` | What Airpocket is, how it works, how to install it. |
| `/install-tailscale` | `install-tailscale.html` | MagicDNS and HTTPS certificates, and why a work email puts you in a tailnet where you can't turn them on. |
| `/claude-code-on-iphone` | `claude-code-on-iphone.html` | Claude Code from the phone: the hooks, why a session appears at its next prompt, what the phone can and can't do. |
| `/codex-on-iphone` | `codex-on-iphone.html` | The same for Codex: hooks read at launch, and hooks to trust. |
| `/any-terminal` | `any-terminal.html` | Which terminals the phone can answer, and what `airpocket run` and `airpocket attach` do. |

The guides say only what is already true in the repository's README,
`docs/THREAT-MODEL.md` or the launch page, and state their limits plainly. When
the product changes, change the guide that describes it.

`vercel.json` turns on `cleanUrls`, so Vercel serves each page without `.html`
and redirects the `.html` address to it (`/index.html` goes to `/`), and
`trailingSlash: false`, so `/any-terminal/` redirects to `/any-terminal`. The
launch page's own links are all `#` anchors or GitHub addresses, so this doesn't
touch them; the guides link to each other and home by their clean addresses
(`/`, `/#faq`, `/any-terminal`). Their stylesheet, icons and fonts stay
relative, which works because every page sits at the top of the site.

### One stylesheet

`style.css` holds the design every page shares: the fonts, the tokens, the base
elements, the HUD frame, the status strip, the section heads, the footer, and
the parts of a guide (the prose column, command blocks, notes, the contents
list, the related guides). Anything only one page uses stays in that page: the
launch page keeps its opening sequence and its inline layout.

When the stylesheet moved out of `index.html`, the page was rendered before and
after, at 390 and 1280 wide, scrolled from top to bottom, with Reduce
Transparency, and through the opening sequence, and the still frames were
compared pixel by pixel. They were identical. Do the same after any change to
`style.css` that isn't meant to move the launch page.

### Adding a page

Copy a guide, then give it its own `<title>`, description, canonical link,
`og:url`, Open Graph and Twitter titles and descriptions, and one `<h1>`. Add it
to `sitemap.xml`, to the header and footer lists of every page (`aria-current`
on its own), to the related guides of the others, and to the table above. It
carries the noindex line until launch like the rest.

## Search engines

`robots.txt` allows everything and no page carries a `noindex` line; both were
closed until the repository went public on 2026-10-26, because every page links
to it. `og.html` keeps its own noindex: it is the source of the share card, not
a page. `grep -l 'content="noindex"' site/*.html` should list only it.


## The share card and the icon

A link to `airpocket.sh` pasted into X, Slack or WhatsApp shows a card, because
the `<head>` of `index.html` carries Open Graph and Twitter tags. Their title
and description are the page's own `<title>` and the first and last sentences
of its opening paragraph; if those change, change the tags with them. Each guide
carries the same tags with its own `<h1>` and description, and the same image.

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
console or the card comes out over 300 KB, the point past which some chat apps
stop fetching the image. After a change to the card, platforms may show the old
one for days, since they cache it by URL.

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

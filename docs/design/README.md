# The design pack

Öncel's design for the public phone app (step 9), exported from Claude Design.
Port from these files; they are the source of truth for how the app looks.

| File | What is in it |
| --- | --- |
| `design-system.html` | Tokens, type, status lights, buttons and soft keys, fields, the keypad, session rows, toasts, icons, the map and glass layers, motion. |
| `screens-a.html` | First run in Safari, pairing (scan, code, wrong code, paired), Sessions in three states including 375×667. |
| `screens-b.html` | A session (working, question, terminal, read-only, 375×667) and Controls (Claude, Codex, keys and confirm, ended). |
| `screens-c.html` | New session, Files, Macs, system states, the launch screen, the app icon. |
| `map.svg` | The chart behind everything. 780×1688, flat paths and gradients, 14 KB, no text. |

Open the HTML files in a browser to see them. They are plain HTML and CSS,
written to be ported by hand.

## How to port

- **Tokens.** Every colour, size, stroke and font is a CSS custom property
  declared once in `:root` at the top of each file. Copy that block into
  `app.css` and use nothing else.
- **Fonts.** B612, B612 Mono and IBM Plex Sans, all OFL. The pack pulls them
  from Google's CDN because it runs on a design canvas; **the app must not**.
  Self-host the woff2 files, subset to Latin plus the few symbols the app
  draws, and use `font-display: swap`.
- **The map.** One file, referenced through the `--map` token, never inlined as
  a data URL. It is drawn at twice the screen so each screen shows a different
  part of it with `background-position`; the pack uses `-40 -844` for the
  session list, `-390 -260` for a session and `-330 -820` for pairing.
- **The glass.** `--glass` for the top strip, the soft keys and the bottom
  panel; `--glass-2` for sheets carrying long reading text. Blur with
  `backdrop-filter: var(--blur)` and the `-webkit-` prefix. Only those few
  large panes are blurred, never a list row or a chip, and a sheet drops its
  blur while it scrolls.
- **Accessibility.** Under `prefers-reduced-transparency: reduce` every pane
  becomes solid `--ground` with a 1px `--stroke` edge and the map drops to 40%.
  `prefers-reduced-motion: reduce` stops the scan and the caution pulse. Labels
  carrying real data stay at 11px or larger, and a status light never depends
  on colour alone: each keeps its own word and shape.
- **Agents** are marked with the `CL` and `CX` monograms, not the brand logos
  the app ships today.

## Two rules the design is built on

1. **Nothing on screen is invented.** Every readout is real data from the app:
   the model, the effort, how long a turn has run, the Mac, the branch. The map
   carries no text at all, so it cannot be mistaken for information.
2. **The cockpit is in the frame, not in the prose.** Labels and status lights
   are mono, uppercase and fixed; the conversation is a plain reading font that
   follows the phone's own text size.

## Measured, at the map's brightest point

Body text 14.5:1, secondary 8.4:1, the 11px meta 6.1:1, sand 10.4:1, green
9.6:1, amber 8.2:1, red 5.2:1, control borders 3.3:1. Keep these above 4.5:1
(3:1 for a control border) if you change a colour.

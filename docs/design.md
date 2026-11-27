# RiverMind Poker design

The site has two looks (Phase 5C, D-18), chosen by the player and kept in their browser: the **clean look**, [described below](#the-clean-look), which every browser gets until its player chooses otherwise (P5C.7), and the **pixel look**, described first, which a browser that chose it keeps. Both share every page, component and line of markup; a look is a stylesheet, a set of art and a deck, chosen by `data-look` on `<html>`. Every Playwright test runs in both, in CI as well, and `pnpm visual` captures both.

The pixel look is drawn in hand-made pixel art: a night-blue card room, a green felt table with a wooden rail, a detailed pixel-art deck with four suit colors, and one pixel font for everything. The aim is the easiest poker table to read and play on a phone or a desktop, with the warmth of a pixel-art card game. The [design reference page](../web/src/routes/style/+page.svelte) (`/style` on any build) shows every piece of the kit as the site draws it.

The interface art and the font are original and licensed with the rest of the project under [GPL-3.0-or-later](../LICENSE). The card deck is a set of pixel-art sprites the owner chose and added to the repository (see [The cards](#the-cards)).

## How the art is made

The interface art is drawn by hand as text, after the approach of an earlier pixel-art project of the owner’s: every pixel is a character in a grid, every color is named from one palette, and a generator renders the grids into PNG files. Text sources diff cleanly, can be recolored and composed by code, and can never leave the palette.

| Source in `web/art/` | What it holds |
| --- | --- |
| [`palette.hex`](../web/art/palette.hex) | The 44 colors, by name, in ramps from dark to light. Nothing else is ever drawn. |
| [`cards/`](../web/art/cards/) | The deck as PNG sprites: `fronts/<rank>-<suit>.png` (ranks `2` to `10`, `jack`, `queen`, `king`, `ace`) and `backs/<name>.png`. They are the only card art on the site. |
| [`ui.pxl`](../web/art/ui.pxl) | The chip, the dealer button, the person and bot avatars and the RiverMind emblem. |
| [`rivermind-pixel.font`](../web/art/rivermind-pixel.font) | RiverMind Pixel, the site’s font: 111 glyphs, capital height 7, x-height 5, digits all 5 wide. |

A `.pxl` file is a legend (one character per palette color, or a role such as `@suit` that the generator fills in) followed by `sprite <name>` grids. The generator in [`web/scripts/pixel-art/`](../web/scripts/pixel-art/) lays the sprites out and draws what is better described by rule: the empty board slot, the nine-slice frames and buttons, and the table rail. It reads the card sprites, shrinks each back to one pixel per art pixel and crops the clear ring every card shares. It writes everything into [`web/src/lib/art/`](../web/src/lib/art/), where Vite gives each file a content-hashed URL, plus the favicon and home-screen icon in `web/static/`. From `web/`:

```sh
pnpm art                      # write the art
pnpm art --preview /tmp/art   # also write contact sheets for review (cards at 1x, 2x and 4x)
```

Look at the contact sheets before accepting a change, at 1x and zoomed in. `pnpm test` fails if a committed file no longer matches its source (PNGs are compared by their pixels and the font by its tables, so a different zlib does not matter), if any drawn pixel is off the palette, if a card is not 71 × 95 with hard edges, or if `src/lib/art/cards/` holds a file the generator did not make. `pnpm art` itself fails if a card sprite is missing, unexpected, not an exact whole-number enlargement of 73 × 97, partly transparent or drawn outside the shared ring. Commit the sources and the regenerated files together, and never edit a generated file by hand.

## The rules

- **Square pixels.** Art is drawn at whole multiples: interface sprites and frames at 2x (`--px`, the theme's `--spacing`, is 2px). Cards ask for a size with `--k` on any parent (1 is 71 CSS pixels wide) and snap to the nearest whole number of *device* pixels per art pixel, using `--dpr` (set in `app.css` from `resolution` media queries) and CSS `round()`, so a card is crisp on 1x, 2x, 2.625x and 3x screens alike. `image-rendering: pixelated` is set on the body, so nothing is smoothed.
- **One light.** Light comes from the top-left: frames have a light bevel on the top and left and a shade on the bottom and right. Sprites have a 1-pixel ink outline. Shadows are hard offsets (`drop-shadow` with no blur), never blurred.
- **One font.** RiverMind Pixel is pixel-exact at multiples of 10px: 20px for text and buttons, 30px for headings and amounts, 40px for titles. 15px is used only for secondary text (the log, tags, bets); it is crisp on 2x screens and soft on 1x ones. Text on art gets a 1-pixel ink shadow (`text-shadow-ink`).
- **Readable first.** A card’s rank is 8 art pixels tall, so it is drawn at 2 or more device pixels per art pixel wherever it must be read (`--card-min: 2` keeps the cards a phone pod shows legible). Every suit has its own color: hearts red, diamonds amber, clubs blue, spades slate. Amounts are shown in full, with the gold chip for stacks.
- **No inline style or script.** The site’s Content-Security-Policy forbids both, so positions are classes (`seat-places.css`, generated by `layout.ts`), swatches are SVG fills, and animations are CSS keyframes, never Svelte transitions. Fonts are always their own files, since the CSP allows `data:` only for images.

## Styling: Tailwind on the kit's own theme

The pages are styled with Tailwind CSS 4 utilities (P4B.2). `pnpm art` writes the theme, [`web/src/lib/art/theme.css`](../web/src/lib/art/theme.css), from the palette and the constants in [`render.js`](../web/scripts/pixel-art/render.js), and it replaces Tailwind's own theme entirely (`--*: initial`), so the utilities offer only what the kit has:

| Token | Utilities | Values |
| --- | --- | --- |
| `--color-<name>` | `bg-felt`, `text-gold`, `border-deep-slate`, `fill-ink`, `accent-gold` | The 44 palette colors, by name with hyphens. No other color has a class. |
| `--spacing` | `p-3`, `gap-4`, `mt-1`, `w-88`, `min-h-24`, `size-7` | One art pixel, 2px: the number counts art pixels, so `p-3` is 6px. Whole numbers only. A length that is not a whole art pixel is written out (`gap-[3px]`), which marks it as off the grid. |
| `--text-<size>` | `text-xs`, `text-s`, `text-m`, `text-l`, `text-xl` | 10, 15, 20, 30 and 40px. |
| `--font-pixel` | `font-pixel` (the default family) | RiverMind Pixel. |
| `--text-shadow-ink` | `text-shadow-ink` | The hard 1-pixel ink shadow under light text. |

[`app.css`](../web/src/app.css) imports Tailwind and the theme, puts the kit (`pixel.css`) in the `components` layer so a utility always overrides a kit class, and keeps the page's own element styles in `base`, over Tailwind's preflight. It also defines:

- **Breakpoints** as variants with the layouts' exact queries: `lt-800:`, `lt-640:`, `lt-600:`, `ge-600:`, `lt-460:`, `lt-360:` for the pages, and for the table `lap:` (1279px and narrower: the narrower side column), `tall:` (899px and narrower, or 1279px and narrower held upright: one column), `phone:` (639px and narrower, or 1099px and narrower held upright: pods and the tall table), `tab:` (640 to 1099px held upright, adjusting `phone:`) and `pocket:` (639px and narrower: a phone alone, which has no site header at a table). Later ones win, in that order.
- **`clean:` and `pixel:`**, a utility for one look alone (`clean:rounded-full`), for an element whose look-bound property is set by a utility, which a kit rule under `:where([data-look=…])` cannot override (Phase 5C).
- **`hover:`** on every device, as the kit's buttons do; Tailwind's default skips touch screens.
- **`text-shadow-title`** and the stepped animations (`animate-blink`, `animate-wait`, `animate-drop`, `animate-slide`, `animate-pop`, `animate-fade`, `animate-rise`, `animate-nudge`).
- **Sources.** Only the routes, `lib/nl` and the three shared components are scanned, and a few ordinary words (`table`, `filter`, `transform` and others) are ruled out as classes, because Tailwind reads every word of a source as a candidate.

What is not a utility, and why:

- **The kit** (`pixel.css`): nine-slice frames, buttons, fields and sprites are `border-image` and `background-image` rules over generated PNGs.
- **Card geometry** (`PlayingCard.svelte`, and the hand in `NlSeat.svelte`): the `--k`, `--dpr` and `round()` snapping, the fan's overlap in snapped art pixels, and the `deal` keyframes that use them.
- **Seat positions** (`seat-places.css`): generated from `layout.ts`, one class per seat count and place.
- **Fixed values with meaning** stay as written: translucent ink is `bg-[rgb(12_13_21/0.72)]` rather than `bg-ink/72`, because Tailwind's opacity modifier rounds the alpha differently, and box shadows are `[box-shadow:…]`, which keeps Tailwind's ring and shadow machinery out of the page's CSS.

A class that only names an element (`seat`, `meta`, `result`) is kept where the tests or the seat's card rules select by it. Do not name one after a utility: `grow` on a label once made it grow.

Check any change to styles or markup with `pnpm visual` against captures of the commit before it ([CONTRIBUTING.md](../CONTRIBUTING.md#comparing-screenshots-p4b2)).

## The kit

[`web/src/styles/pixel.css`](../web/src/styles/pixel.css) holds the shared classes:

| Class | Use |
| --- | --- |
| `.px-panel`, `.px-raised`, `.px-inset`, `.px-paper` | Nine-slice frames: a panel, a lighter panel, a sunken well (logs, inputs), paper. |
| `.px-gold`, `.px-glow`, `.px-danger` | The viewer’s seat, the seat to act, an error. |
| `.px-btn` with `.red`, `.blue`, `.amber`, `.green`, `.gold` | Buttons with a 2-pixel lip that drops when pressed. Fold is red, check and call blue, bet and raise amber, a chosen option gold. Slate is the default. `.small` for secondary actions. |
| `.px-btn.choice` | A choice that turns gold when chosen: a pressed toggle (`aria-pressed`), or the face of a checked radio button or checkbox before it. |
| `.px-table` | The table: its rail and felt as one nine-slice image, at `--table-px` screen pixels per art pixel (3, or 2 on smaller screens). |
| `.px-field`, `.px-range` | Inputs and selects; the bet slider with a gold chip for a thumb. |
| `.sprite` with `.chip-*`, `.avatar-*`, `.pot-pile`, `.dealer-button`, `.mini-cards`, `.emblem` | Sprites as background images, sized in art pixels. |
| `.card-peek` | A compact hand: two cards fanned tight in a 58 × 50 art-pixel window (the first card’s index and the second card’s corner), at 2 device pixels per art pixel or more. Lists of hands and small seats. |

`PlayingCard` draws a face, a back (`card={null}`, optionally `back="nebula"`) or an empty board slot (`card={undefined}`), sized by the nearest `--k` and snapped as above. Faces have alt text such as “Jack of hearts”.

## The cards

The deck is pixel art at 73 × 97, delivered as PNGs enlarged 12 times (fronts) and 13 times (backs); on the site a card is 71 × 95 after the clear outer ring is cropped. It is a four-colour deck: the number cards use the standard pip layouts, the aces a large suit, and the courts are framed figures whose robes and trim take the suit’s color. There are 18 backs: five classic ornate backs (red, the site’s default, plus blue, green, amber and slate), a dusk gradient ornate back, parchment, argyle, confetti, maze, tracks, moons, nebula, rose marble, two contour maps (blue and rainbow), a violet swirl and shapes. Their names are the files’ names. [`card-assets.ts`](../web/src/lib/card-assets.ts) maps cards to files, lists the backs for the settings in P6.5 and preloads only the faces and the back in use. The sprites’ original file names were `8BitDeck_opt2.png` to `8BitDeck_opt53.png` (hearts, clubs, diamonds, spades; 2 to ace) and `Deck Backs1.png` to `Deck Backs18.png`; their source and license terms are still to be recorded in [`licenses/`](../licenses/).

To replace a card, drop a new PNG with the same name into `web/art/cards/` (any whole-number enlargement of 73 × 97 with hard-edged transparency), run `pnpm art --preview <dir>` and look at the sheets. To add a back, add its file and its name to `BACKS` in [`cards.js`](../web/scripts/pixel-art/cards.js) and `CARD_BACKS` in `card-assets.ts`.

## The clean look

A dark card room drawn without pixel art (P5C.2): charcoal and slate surfaces, a deep muted felt inside a dark rail, one gold accent for the viewer's seat and the turn, the system's own fonts, soft shadows and smooth motion. It is dark only for 1.0 (Q-12). Everything is in [`web/src/styles/clean.css`](../web/src/styles/clean.css), under `:where([data-look='clean'])`, which adds no specificity, so a utility overrides a kit class exactly as in the pixel look.

**Tokens.** The clean look gives the theme's variables its own values rather than adding a second set of names, so the markup is the same in both looks and every utility (`bg-felt`, `text-gold`) follows the look. Each palette name keeps its role: gold is the accent, felt is the table, `green-light` a win, `red-light` a loss, ink the darkest ground and paper the main text. Where one name plays two roles in the markup, a role token replaces it there and is mapped back to the same value in the pixel look, so the pixel look is unchanged: `warn` (the turn clock under 30% and the voice meter's middle) is `var(--color-gold)` in the pixel look and amber in the clean one. The deck's colours (P5C.3) are role tokens of the clean look alone: `card` (`#fffdf7`) with its `card-edge`, and one colour per suit, FeltPrep's: clubs green `#19703a`, diamonds blue `#1a58ad`, hearts red `#b4231b`, spades near black `#1a1d22`.

| Token | Clean value |
| --- | --- |
| Surfaces | ink `#0a0c11` (header, wells, fields), night `#11141b` (the page), deep-slate `#181c25` (panels), slate `#232935` (raised panels, buttons), dusk `#687186` (the edge of a control) |
| Text | paper `#eceff4`, paper-shade `#cdd3de`, mist `#b3bbca` (secondary), haze `#a1a9ba` (tertiary and disabled) |
| The table | felt `#174237` from felt-light `#1f5646` to felt-dark `#12352d`, inside a rail of wood-dark `#1a1c22` |
| Accent | gold `#f0bd4f`, gold-light `#ffdc8a` |
| Win, loss, warning | green-light `#7fd9a2`, red-light `#ff8f86`, warn `#e8923a` |
| Fonts | `system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial, sans-serif` through `--font-pixel`, the theme's one family, and the system's monospace for code. No font file and no third-party origin. |
| Text sizes | `text-xs` 11px, `text-s` 13px, `text-m` 16px (the page), `text-l` 22px, `text-xl` 28px |
| Radii | `--radius-s` 6px (buttons, fields), `--radius-m` 10px (frames), `--radius-l` 16px |
| Shadows | `--elevation-1` `0 1px 2px` (buttons), `--elevation-2` `0 4px 14px` (frames), `--elevation-3` `0 14px 36px` (the table), all black at 35 to 45%; `text-shadow-ink` is a soft `0 1px 2px` |
| Motion | The same keyframes as the pixel look, eased instead of stepped: `--ease-out` `cubic-bezier(0.2, 0.7, 0.2, 1)` at 180 to 240 ms for a notice, a panel, a bet or a reaction, 600 ms for winnings rising, and `--ease-in-out` for the loops (a waiting lamp, the turn, a speaker). The seat to act does not bob as it does in the pixel look: its gold ring breathes in place (`turn`, P5C.6), since a smooth bob never stands still and moved a name or a menu from under a finger. `prefers-reduced-motion` stops them all, as in the pixel look. |

**Contrast.** Every pair of text and background that the pages use meets WCAG 2.2 AA, measured by [`clean.spec.ts`](../web/src/styles/clean.spec.ts) from the values in `clean.css`, so a change that breaks one fails the tests. Text on the surfaces it sits on (4.5:1 needed):

| Text | night `#11141b` | ink `#0a0c11` | deep-slate `#181c25` | slate `#232935` | felt-dark `#12352d` | felt `#174237` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| paper `#eceff4` | 16.0 | 17.0 | 14.8 | 12.7 | 11.6 | 9.7 |
| paper-shade `#cdd3de` | 12.3 | 13.0 | 11.3 | 9.7 | 8.9 | 7.5 |
| mist `#b3bbca` | 9.5 | 10.1 | 8.8 | 7.6 | 6.9 | 5.8 |
| haze `#a1a9ba` | 7.8 | 8.3 | 7.2 | 6.2 | 5.7 | 4.8 |
| gold `#f0bd4f` | 10.6 | 11.3 | 9.8 | 8.4 | 7.7 | 6.5 |
| gold-light `#ffdc8a` | 13.9 | 14.8 | 12.9 | 11.0 | 10.1 | 8.5 |
| green-light `#7fd9a2` | 10.8 | 11.5 | 10.0 | 8.6 | 7.9 | 6.6 |
| red-light `#ff8f86` | 8.4 | 8.9 | 7.7 | 6.6 | 6.1 | 5.1 |
| violet-light `#b0a1f5` | 8.1 | 8.6 | 7.5 | 6.4 | 5.9 | 5.0 |
| blue-light `#8fbcff` | 9.5 | 10.1 | 8.8 | 7.5 | 6.9 | 5.8 |
| amber and warn `#e8923a` | 7.5 | 8.0 | 7.0 | 6.0 | 5.5 | 4.6 |

Text on a colour of its own (4.5:1): paper on a slate button 12.7, white on a red, blue or green button 5.5, 5.4 and 5.3, ink on an amber or gold button 8.0 and 11.3, ink on paper 17.0, amber-deep on a chosen gold option 8.1, violet-light (the “Bot” tag) on ink 8.6, and each suit on the card face: clubs 6.0, diamonds 6.8, hearts 6.5, spades 16.6.

Controls and focus (3:1): a slate button's or a field's edge (dusk) on night 3.8, on deep-slate 3.5 and on ink 4.0; the red, blue and green button faces on night 3.4, 3.4 and 3.5, and amber 7.5; the focus ring and the slider's thumb (gold) on night 10.6, ink 11.3, deep-slate 9.8, slate 8.4 and felt 6.5; a chosen option's focus ring (gold-light) on deep-slate 12.9; the error frame's ring (red) on its red-deep ground 3.9.

**The kit.** `clean.css` draws every class of the pixel kit without an image file, and keeps its geometry: frames and fields keep their 3-pixel border, transparent, under the surface, with the edge drawn as a ring just outside it, and buttons keep the same total border width with the label centred, so a box takes the same room in either look and only its drawing differs. The sizes of sprites and the compact hand's window are shared by both looks in [`kit.css`](../web/src/styles/kit.css).

| Class | Clean drawing |
| --- | --- |
| `.px-panel`, `.px-raised`, `.px-inset`, `.px-paper` | Rounded cards: deep-slate with a faint edge and a soft shadow, slate, a sunken ink well, and paper with ink text. |
| `.px-gold`, `.px-glow`, `.px-danger` | A 2px gold ring for the viewer's seat; a gold-light ring with a soft gold halo for the seat to act; a red ring on red-deep for an error. |
| `.px-btn` and its colours | A rounded face with a 1px edge and a small shadow, the label in semibold. Slate by default; red, blue and green with white labels, amber and gold with ink labels. Pressing darkens the face and sinks it with an inner shadow; the label never moves. Disabled is deep-slate with a haze label. |
| `.px-btn.choice` | Gold with an ink label when chosen, pressed or checked. |
| `.px-field`, `select.px-field` | An ink well with a dusk edge; a select's caret is a chevron of two gradients. |
| `.px-range` | A slim rounded groove and a round gold thumb as large as the pixel chip. |
| `.px-table` | A deep felt lit from above (a radial gradient) inside a dark rail, with the same corner radius as the pixel table's nine-slice. |

**Sprites** (P5C.4). Every pixel sprite has a hand-drawn SVG counterpart in [`web/src/lib/art/clean/ui/`](../web/src/lib/art/clean/ui/), drawn by [`web/scripts/clean-art/ui.js`](../web/scripts/clean-art/ui.js) from the clean palette at the size `kit.css` gives the sprite, in CSS pixels, and written by `pnpm art`. [`clean-sprites.css`](../web/src/styles/clean-sprites.css) puts each behind the pixel sprite's class under the clean look, so the markup is shared. The chips are a face, a rim and eight stripes; the pot is three stacks seen from the side; the dealer button's D is a stroke; people and bots sit in a round slate badge, a person as head, hair and shoulders and a bot as a robot in its kind's colour (the page still tags it “Bot”, D-7); the RiverMind mark is a gold spade with a river across it; the mini cards are two burgundy backs fanned; and the voice glyphs are paper strokes inside an ink outline, so they read on their ink tag at 11 and 22 pixels. No letter in them is text. `clean.spec.ts` gives them the deck's drift and safety checks, and fails if a pixel sprite has no clean one, if one is not the kit's size, or if the stylesheet does not use it. The caret, the felt and the rail are CSS (above). `/style` shows the kit of the look it is viewed in; the header's switch shows the other.

**The icons** (P5C.4, P5C.7). The favicon, its PNG fallback and the home-screen icon are the clean mark, gold on a night square, one set for both looks: an SVG favicon (`static/favicon.svg`, 32 × 32 with rounded corners), a 48 × 48 PNG of it for browsers that take no SVG icon, and a 180 × 180 PNG for the home screen, whose square is left unrounded because the phone rounds it. `theme-color` is the clean night, `#11141b`. [`web/scripts/clean-art/icons.js`](../web/scripts/clean-art/icons.js) draws the SVG and renders the PNGs from the same shapes with a small rasteriser of its own (paths flattened to lines, 8 × 8 samples a pixel), so `pnpm art` writes the same bytes on any machine, and `clean.spec.ts` fails if a file drifts, if an icon's shapes are not the header mark's, or if `app.html` names other icons or another theme colour. The pixel look keeps its emblem in the header; its icons left with P5C.7.

**The switch** (P5C.5). Every page's header ends with the look switch, `LookSwitch.svelte`: a group labelled “Look” with two buttons, Clean and Pixel, the chosen one pressed. It changes the look at once, without a reload, and keeps it. Its label and buttons have fixed widths, 32 and 64 pixels (48 on a phone, where the label is not shown, the group keeping its name “Look” for a screen reader, and the buttons are 38 pixels tall, so the header keeps its height), so it takes the same room in both looks and switching moves nothing beside it. To leave a phone's header room for the player's name, the site's name drops “Poker” below 460 pixels wide. In the clean look the connection lamp is round, a link drawn as a button has no underline, the table list's seat markers are dots, and where the replay's board places overlap, each empty slot's edge is cut out of the card before it, so the row reads as single edges.

### The clean deck

The clean look's cards (P5C.3) are the code-drawn cards of the owner's FeltPrep project, redrawn on RiverMind's 71 × 95 card box so every slot, fan and peek keeps its geometry: a large rank at the top left, a small pip under it and a large pip at the bottom right, in the four suit colours above on warm white with a thin edge, with FeltPrep's own pip shapes. FeltPrep sets the rank in the system's sans-serif; an SVG shown as an image takes whatever font the device has, so here each rank is drawn as round strokes instead, the same on every device, and the ten always keeps its two digits clear of the edge. The backs are FeltPrep's burgundy lattice and the same lattice in navy and green (`lattice-burgundy`, the default, `lattice-navy`, `lattice-green`), each the same after a half turn, and the empty board slot is a card's outline sunk into the felt.

[`web/scripts/clean-art/deck.js`](../web/scripts/clean-art/deck.js) draws them from the clean palette in `clean.css`, and `pnpm art` writes them as SVG files into [`web/src/lib/art/clean/cards/`](../web/src/lib/art/clean/cards/) beside the pixel art; `pnpm art --preview <dir>` also writes `clean.html`, the deck on the felt and on the page at `--k` 0.75 to 2, to open at each device-pixel ratio. Never edit a file there by hand. `PlayingCard` shows the look's deck in the same `<img>`, with the same alt text and the same size by `--k`, drawn smooth with a soft shadow and an eased deal; `card-assets.ts` gives each look's faces, backs and slot (`cardFacePath(card, look)` and so on), and a back of the other deck's draws as the look's default. [`clean.spec.ts`](../web/src/lib/art/clean.spec.ts) fails if a file drifts from the generator or the directory holds another, if a file is not well-formed SVG of drawing alone (no script, style or external reference), if a colour is off the clean palette, if a face does not show its own rank and suit, if the ten comes within 3 units of the edge, or if a back changes under a half turn. The drawings' provenance is in [`licenses/FeltPrep-cards.txt`](../licenses/FeltPrep-cards.txt): FeltPrep is AGPL-3.0 with its artwork reserved, and the owner, who holds both projects, contributes these drawings to RiverMind under GPL-3.0-or-later (D-18).

## The table

[`NlTable.svelte`](../web/src/lib/nl/NlTable.svelte) lays out three screens:

- **Wide (landscape, 900px and up).** The table on the left; the action dock, the seat tools and the hand log in a column on the right (360px from 1280px, 300px below). Opponents’ cards ask for `--k: 1`, the viewer’s and the board’s for `--k: 1.4` (1 below 1280px); on a 2x screen that is 2 and 3 device pixels per art pixel.
- **Tall (phones, and tablets held upright).** The game is the first screen, and everything else is below it. The bar, the table and a zone as tall as the action panel add up to the small viewport (`100svh`, what the browser leaves with its toolbars showing), so on arriving nothing is cut off and nothing needs scrolling, and the table never changes size. A phone leaves the site header out at a table; its bar carries the way back to the lobby, the hand, the blinds, the connection lamp and, at its far end, a menu (•••) that opens over the table and holds the look switch (P5C.6). To keep the bar to one line in voice at a private table, a phone's bar has 4px gaps and its blinds no chip. The dock is pinned to the bottom of the screen: while waiting it is a strip, with the seat tools above it at the top of the zone, and on the viewer’s turn the action panel rises over the zone and stops at the table’s edge. The hand log and the play-money note follow below. Opponents are compact pods with a small card-back badge (the red back in miniature): one row across the top, a pod each side below the board, and at eight and nine seats a pod on each bottom corner of the rail beside the viewer, so a 9-seat table fits a felt 356px tall and never covers the board. A bot’s pod shows the part of its name that tells it apart (“Easy 4”, under its “Bot” tag). Bets sit under a pod in the top row, beside one at the side and just above one on a bottom corner. Cards a pod shows sit by it in a 58 × 50 art-pixel window, fanned tight so the first card’s index and the second card’s corner show, at 2 or more device pixels per art pixel; upright tablets show the whole cards. The viewer keeps a full seat with `--k: 1` cards (1.4 on tablets).
- **Narrow landscape** (below 900px) uses the single column with the wide table, the seat tools above it. A phone held sideways gets this layout and does not fit it: the dock covers the table.

Nothing moves under a finger when the turn’s action panel opens. On the wide screens the dock keeps its height; on the tall ones the panel covers the seat tools without moving them, and its presets and slider, not Fold, Call or Raise, are what lands where they were. Seats wear their avatar (a robot for every bot, labelled “Bot”, per D-7), name, stack and a turn clock (green, gold when under 30%, red in the time bank): twelve lamps in the pixel look, one smooth rounded bar in the clean look, both drawn in the same SVG, each look hiding the other's (P5C.6). Bets sit between each seat and the pot with a chip whose color follows the bet’s size in big blinds.

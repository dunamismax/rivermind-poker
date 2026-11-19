# RiverMind Poker card artwork

The [artwork source](../web/scripts/card-art/) defines the rank and suit paths, pip layouts, mirrored court portraits, and back patterns. The Jack is a river pilot, the Queen carries an iris sceptre, and the King wears a crenellated crown. Each ace has a different frame around its suit. The backs use a gold river bend, a blue current, and a burgundy lattice, respectively. The original artwork and generator are licensed under [GPL-3.0-or-later](../LICENSE).

From `web/` with Node 26, run:

```sh
pnpm cards
```

The generator writes [81 standalone SVG files](../web/static/cards/) and a contact sheet at `artifacts/card-art/preview.html`, which Git ignores. [`render.js`](../web/scripts/card-art/render.js) builds every file in memory, and `pnpm test` fails if a committed SVG no longer matches it, so commit the generator changes and the regenerated SVGs together. Open the sheet through a local web server (for example `python3 -m http.server` from the repository root), not as a `file://` page, to see both complete treatments and all three backs at review size and at 34 × 48 px, the smallest table dimensions. Each SVG contains its own geometry and colours, with no styles or scripts, so it works under the site’s Content-Security-Policy.

Both face treatments cover ranks 2 through ace. Standard uses black spades and clubs and red hearts and diamonds. Four-colour uses green clubs and blue diamonds and shares the standard hearts and spades.

[`card-assets.ts`](../web/src/lib/card-assets.ts) defines the treatment and back options for P6.5. [`PlayingCard.svelte`](../web/src/lib/components/PlayingCard.svelte) accepts either option and defaults to the standard faces and RiverMind back.

The SvelteKit build copies `web/static/cards/` to `/cards/`. These files are not content-hashed, so they are served to revalidate rather than cached as immutable. A card that first appears mid-hand is fetched at that moment.

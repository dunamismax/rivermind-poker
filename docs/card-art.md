# RiverMind Poker card artwork

The deck is drawn in code: every curve and coordinate is chosen in the [artwork source](../web/scripts/card-art/) and written out as standalone SVG files. Nothing is traced, generated from images or taken from another deck or typeface. The artwork and generator are licensed under [GPL-3.0-or-later](../LICENSE), and every source file and SVG carries the SPDX header.

## Design

**Card.** Warm card stock (`#fdfbf4`) with a fine sand-coloured edge and a 15.25-unit corner on the 168 × 232 viewBox. [`PlayingCard.svelte`](../web/src/lib/components/PlayingCard.svelte) uses a matching `border-radius: 9.1% / 6.6%`, so the clip and the drawn corner agree at every size.

**Big indices.** Each corner carries a numeral 54 units tall with a 9.5-unit stroke (the 10 is set at 8.5 so both figures fit), centred 25 units from the edge, over a suit 26 units wide. On the smallest table card, 34 × 48 px, the numeral is **11.2 px tall** with strokes about 2 px thick. The previous deck’s numeral measured about 8.2 px including its stroke. The new numeral is 13.5 px tall at 42 × 58 and 17.2 px at 54 × 74. The numerals are condensed grotesque forms drawn as stroked centre lines and clipped to the index box, so diagonals end square on the baseline and the cap line. They use no font or `<text>`.

**Inks.** Black `#14161b`, red `#d3202c`, green `#08806a` and blue `#2b34c4`. They were chosen by searching for the set that keeps the four suits furthest apart in OKLab under simulated protan, deutan and tritan vision. The closest pair in any simulation is about 11 units apart, against 2 for the previous deck’s green and blue under tritan vision. Every ink has a contrast ratio of at least 4.7:1 with the card stock. Standard uses black spades and clubs and red hearts and diamonds. Four-colour uses green clubs and blue diamonds and shares hearts and spades.

**Pips.** The four suit outlines are drawn for this deck: a spade and club with flared feet, a full heart and a diamond with gently concave sides. Pip cards use the traditional layouts on two columns 47 units apart, so no pip comes near an index. The outer rows sit 32 units from each end and the inner rows divide the height in thirds. Pips below the middle are turned.

**Courts.** The King, Queen and Jack are drawn once each as the upper half of a framed portrait and turned end for end below a river that crosses the middle of the card. The river is an odd curve about the centre, so it is the same either way up. The King has a full beard, a five-pointed crown, an ermine cape, an upright sword and an orb. The Queen wears an iris coronet and a laced bodice and holds a water lily and a gold fan. The Jack is a river ferryman in a plumed cap, with a punt pole and a lantern. The main garments use the suit ink with a gold brocade over them. The second fabric is felt green beside red and blue inks and wine beside black and green. Hair and beard colours change by suit, so all twelve courts differ. Each figure wears its suit in a small gold medallion.

**Aces.** Each ace sets a large pip in the same beaded gold ring with leaf sprays above and below. Inside the ring, spades have gold rays, hearts drop into river ripples, clubs stand before crossed bulrushes and diamonds sit on an eight-pointed gold star.

**Backs.** All three backs share a white margin, a double rule and corner fans, and every element is centred or paired with its copy turned 180°. *RiverMind* (the default) has a guilloché of crossing waves on felt green and a gold roundel with the river bending through it. *Current* has bands of a blue river and the rings a stone leaves in it. *Lattice* has a gold trellis on wine, with a rosette at every crossing and an eight-petal rose at the centre. A pixel comparison of each back with its 180° rotation differs only in anti-aliasing at the outer corners.

## Source

- [`glyphs.js`](../web/scripts/card-art/glyphs.js) contains the rank numerals and the suit outlines.
- [`palette.js`](../web/scripts/card-art/palette.js) contains the stock, inks and theme colours.
- [`faces.js`](../web/scripts/card-art/faces.js) builds the card, the indices and the pip layouts.
- [`courts.js`](../web/scripts/card-art/courts.js) contains the court figures, the frame and the river.
- [`aces.js`](../web/scripts/card-art/aces.js) contains the ace centrepieces.
- [`backs.js`](../web/scripts/card-art/backs.js) contains the three backs.
- [`svg.js`](../web/scripts/card-art/svg.js) contains the shared helpers: number rounding, path tidying, the 180° turn and centred dashes.
- [`render.js`](../web/scripts/card-art/render.js) builds every file in memory.

Each SVG reuses its suit outline and index through `<use>`. The files are 1 to 12 KB each, and the 81 files total about 330 KB.

## Regenerate

From `web/` with Node 26, run:

```sh
pnpm cards
```

The generator writes the [81 standalone SVG files](../web/static/cards/). It also writes a contact sheet at `artifacts/card-art/preview.html`, which Git ignores. The sheet shows both treatments and the three backs at review size and at the four table sizes (54 × 74, 42 × 58, 46 × 64 and 34 × 48 px). Open it through a local web server (for example `python3 -m http.server` from the repository root) rather than as a `file://` page.

`pnpm test` fails in either of these cases:

- A committed SVG no longer matches the generator. Commit the generator changes and the regenerated SVGs together.
- A file breaks the house rules: SPDX header, no styles, scripts, event handlers, text, images or external URLs, unique IDs with every reference resolving, and under 25 KB.

The SVGs use presentation attributes only, so they work under the site’s Content-Security-Policy.

[`card-assets.ts`](../web/src/lib/card-assets.ts) defines the treatment and back options for P6.5. [`PlayingCard.svelte`](../web/src/lib/components/PlayingCard.svelte) accepts either option and defaults to standard faces and the RiverMind back. The SvelteKit build copies `web/static/cards/` to `/cards/`. These files are not content-hashed, so they are served to revalidate rather than cached as immutable, and a card that first appears mid-hand is fetched at that moment.

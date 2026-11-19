// RiverMind Poker card artwork. SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CARD_BACKS, CARD_RANKS, cardBackPath, cardFacePath } from '../src/lib/card-assets.ts';
import { cardName } from '../src/lib/wording.ts';
import { SUITS, renderCardSvgs } from './card-art/render.js';

const WEB = resolve(import.meta.dirname, '..');

function write(output, content) {
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, content);
}

const assets = renderCardSvgs();
for (const [path, svg] of assets) {
	write(resolve(WEB, 'static', path), svg);
}

const image = (path, alt) => `<img src="../../web/static/${path}" alt="${alt}">`;

function faceRows(treatment) {
	return SUITS.map(
		(suit) =>
			`<div class="row">${CARD_RANKS.map((rank) => {
				const card = { rank, suit };
				return image(cardFacePath(card, treatment), cardName(card));
			}).join('')}</div>`
	).join('\n');
}

const backNames = { rivermind: 'RiverMind', current: 'Current', lattice: 'Lattice' };
const backs = CARD_BACKS.map((back) => image(cardBackPath(back), `${backNames[back]} back`)).join(
	''
);

const preview = resolve(WEB, '../artifacts/card-art/preview.html');
write(
	preview,
	`<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>RiverMind Poker card artwork</title>
	<link rel="icon" type="image/svg+xml" href="../../web/static/${cardBackPath()}">
	<link rel="stylesheet" href="../../web/scripts/card-art/preview.css">
</head>
<body>
<main>
	<h1>RiverMind Poker card artwork</h1>
	<section>
		<h2>Standard deck</h2>
		${faceRows('standard')}
	</section>
	<section>
		<h2>Four-colour deck</h2>
		${faceRows('four-colour')}
	</section>
	<section>
		<h2>RiverMind, Current and Lattice backs</h2>
		<div class="row">${backs}</div>
	</section>
	<section class="phone">
		<h2>Smallest table size · 34 × 48 px</h2>
		<h3>Standard deck</h3>
		${faceRows('standard')}
		<h3>Four-colour deck</h3>
		${faceRows('four-colour')}
		<h3>Backs</h3>
		<div class="row">${backs}</div>
	</section>
</main>
</body>
</html>
`
);
console.log(`Generated ${assets.size} SVGs and ${preview}`);

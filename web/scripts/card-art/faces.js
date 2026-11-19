// RiverMind Poker card artwork. SPDX-License-Identifier: GPL-3.0-or-later
// Card faces: the stock, the big corner indices and the pip layouts. Courts
// and aces supply their own centrepieces.
import { ace } from './aces.js';
import { court } from './courts.js';
import { RANKS, RANK_HEIGHT, RANK_STROKE, SUITS } from './glyphs.js';
import { EDGE, INKS, STOCK } from './palette.js';
import { HALF_TURN, n } from './svg.js';

// The corner index: a numeral 54 units tall (about 11 px on a 34 × 48 card)
// over a suit 33 units wide, centred on a column 25 units from the edge.
const INDEX = { x: 25, top: 10, suitY: 83, suitScale: 0.245 };

// Pip grid. The columns sit inside the indices, and the outer rows are 34
// units from each end; the rows between them divide the height in thirds.
const PIP_SCALE = 0.285;
const L = 60.5;
const C = 84;
const R = 107.5;
const TOP = 32;
const BOTTOM = 200;
const MID = 116;
const THIRD = (BOTTOM - TOP) / 3;
const ROW2 = TOP + THIRD;
const ROW3 = BOTTOM - THIRD;

const PIPS = {
	2: [
		[C, TOP],
		[C, BOTTOM]
	],
	3: [
		[C, TOP],
		[C, MID],
		[C, BOTTOM]
	],
	4: [L, R].flatMap((x) => [
		[x, TOP],
		[x, BOTTOM]
	]),
	5: [
		...[L, R].flatMap((x) => [
			[x, TOP],
			[x, BOTTOM]
		]),
		[C, MID]
	],
	6: [L, R].flatMap((x) => [
		[x, TOP],
		[x, MID],
		[x, BOTTOM]
	]),
	7: [
		...[L, R].flatMap((x) => [
			[x, TOP],
			[x, MID],
			[x, BOTTOM]
		]),
		[C, (TOP + MID) / 2]
	],
	8: [
		...[L, R].flatMap((x) => [
			[x, TOP],
			[x, MID],
			[x, BOTTOM]
		]),
		[C, (TOP + MID) / 2],
		[C, (MID + BOTTOM) / 2]
	],
	9: [
		...[L, R].flatMap((x) => [
			[x, TOP],
			[x, ROW2],
			[x, ROW3],
			[x, BOTTOM]
		]),
		[C, MID]
	],
	10: [
		...[L, R].flatMap((x) => [
			[x, TOP],
			[x, ROW2],
			[x, ROW3],
			[x, BOTTOM]
		]),
		[C, (TOP + ROW2) / 2],
		[C, (ROW3 + BOTTOM) / 2]
	]
};

/** A pip from the shared suit outline; pips below the middle face down. */
export function pip(x, y, scale, turned = y > MID) {
	const turn = turned ? ' rotate(180)' : '';
	return `<use href="#pip" transform="translate(${n(x)} ${n(y)})${turn} scale(${scale})"/>`;
}

function index(rank) {
	const glyph = RANKS[rank];
	const half = glyph.half;
	const x = INDEX.x + (glyph.shift ?? 0);
	const turn = glyph.turned ? ` rotate(180 0 ${RANK_HEIGHT / 2})` : '';
	return `<clipPath id="rank-box"><rect x="${x - half}" y="${INDEX.top}" width="${2 * half}" height="${RANK_HEIGHT}"/></clipPath>
<g id="index">
	<g clip-path="url(#rank-box)"><path d="${glyph.d}" transform="translate(${x} ${INDEX.top})${turn}" fill="none" stroke="currentColor" stroke-width="${glyph.stroke ?? RANK_STROKE}" stroke-miterlimit="3"/></g>
	${pip(INDEX.x, INDEX.suitY, INDEX.suitScale, false)}
</g>`;
}

export function face(rank, suit, treatment) {
	const ink = INKS[treatment][suit];
	let centre;
	let defs = '';
	if (rank === 14) {
		({ defs = '', art: centre } = ace(suit, ink));
	} else if (rank >= 11) {
		({ defs = '', art: centre } = court(rank, suit, ink));
	} else {
		centre = PIPS[rank].map(([x, y]) => pip(x, y, PIP_SCALE)).join('');
	}
	return `<defs>
<path id="pip" d="${SUITS[suit]}"/>
${index(rank)}
${defs}
</defs>
<rect x=".75" y=".75" width="166.5" height="230.5" rx="15.25" fill="${STOCK}" stroke="${EDGE}" stroke-width="1.5"/>
<g color="${ink}" fill="currentColor">
${centre}
<use href="#index"/>
<use href="#index" transform="${HALF_TURN}"/>
</g>`;
}

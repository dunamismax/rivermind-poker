// The clean look's deck (P5C.3, D-18): FeltPrep's code-drawn cards, redrawn on
// RiverMind's 71 × 95 card box so every slot, fan and peek keeps its geometry.
// A large rank at the top left, a small pip under it and a large pip at the
// bottom right, in four suit colours on warm white with a thin edge; FeltPrep's
// own pip shapes; and its burgundy lattice back, with navy and green ones drawn
// the same way. The owner, who holds both projects, contributes these drawings
// to RiverMind under GPL-3.0-or-later (licenses/FeltPrep-cards.txt).
//
// FeltPrep sets the rank in the system's sans-serif. An SVG shown as an image
// takes whatever font the device has, so here each rank is drawn as strokes
// instead: the same on every device, and a ten that always keeps its two digits
// clear of the edge. Every colour comes from the clean palette in clean.css.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const CARD_W = 71;
export const CARD_H = 95;
export const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
/** The backs, the clean look's default first. */
export const BACKS = ['lattice-burgundy', 'lattice-navy', 'lattice-green'];
export const DIR = 'src/lib/art/clean/cards';

const WEB = resolve(import.meta.dirname, '../..');

/** The clean palette, by name, from the stylesheet that defines it. */
export function cleanPalette() {
	const css = readFileSync(resolve(WEB, 'src/styles/clean.css'), 'utf8');
	return new Map(
		[...css.matchAll(/--color-([a-z-]+): (#[0-9a-f]{6});/g)].map(([, n, h]) => [n, h])
	);
}

/** FeltPrep's suit shapes, each in a 100 × 100 box (SuitPip.svelte there). */
export const PIPS = {
	diamonds:
		'<path d="M50 3C60 20 74 36 90 50C74 64 60 80 50 97C40 80 26 64 10 50C26 36 40 20 50 3Z"/>',
	hearts:
		'<path d="M50 94C24 72 5 55 5 33C5 17 17 6 31 6C40 6 46 11 50 19C54 11 60 6 69 6C83 6 95 17 95 33C95 55 76 72 50 94Z"/>',
	spades:
		'<path d="M50 4C74 26 95 42 95 62C95 75 85 83 73 83C65 83 58 79 54 72C55 83 59 90 67 96L33 96C41 90 45 83 46 72C42 79 35 83 27 83C15 83 5 75 5 62C5 42 26 26 50 4Z"/>',
	clubs:
		'<circle cx="50" cy="27" r="21"/><circle cx="26" cy="60" r="21"/><circle cx="74" cy="60" r="21"/><path d="M44 44L56 44C56 70 60 86 68 96L32 96C40 86 44 70 44 44Z"/>'
};

/**
 * The rank glyphs as stroke centre lines, in a box 13 wide and 22 tall (the
 * one is 6 wide), drawn with a 4.4-unit round stroke. Each is [width, markup].
 */
const SIX =
	'M11.6 2.2C10.3 0.8 8.6 0 6.6 0C2.6 0 0 4.4 0 11.4C0 18.4 2.6 22 6.5 22C10.4 22 13 19.2 13 15.3C13 11.4 10.4 8.7 6.7 8.7C3.6 8.7 1.2 10.4 0.2 13.2';
export const GLYPHS = {
	A: [13, '<path d="M0 22L6.5 0L13 22M2.7 14.6H10.3"/>'],
	K: [13, '<path d="M0.5 0V22M12.5 0L0.5 13.2M5.3 7.9L13 22"/>'],
	Q: [13, '<ellipse cx="6.5" cy="11" rx="6.5" ry="11"/><path d="M8.6 16.4L13.4 22.6"/>'],
	J: [12, '<path d="M4 0H11.5V15.2C11.5 19.6 9.2 22 5.8 22C2.9 22 0.8 20.3 0 17.4"/>'],
	1: [6, '<path d="M0 4.6L5.4 0V22"/>'],
	0: [13, '<ellipse cx="6.5" cy="11" rx="6.5" ry="11"/>'],
	2: [
		13,
		'<path d="M0.4 5.4C1 2.2 3.4 0 6.6 0C10.2 0 12.6 2.4 12.6 5.9C12.6 9.8 9.6 12.6 0 22H13"/>'
	],
	3: [
		13,
		'<path d="M0.6 3.2C1.9 1.1 4 0 6.5 0C9.9 0 12.2 2.1 12.2 5.4C12.2 8.5 9.8 10.5 6.2 10.5M6.2 10.5C10.2 10.5 13 12.8 13 16.3C13 19.8 10.3 22 6.5 22C3.6 22 1.4 20.9 0 18.8"/>'
	],
	4: [13, '<path d="M9.6 22V0L0 15.3H13"/>'],
	5: [
		13,
		'<path d="M12.2 0H1.6L0.6 10.2C2 9.1 3.9 8.5 6 8.5C10.2 8.5 13 11.2 13 15.2C13 19.4 10.2 22 6.2 22C3.5 22 1.4 20.9 0 18.9"/>'
	],
	6: [13, `<path d="${SIX}"/>`],
	7: [13, '<path d="M0 0H13L4.6 22"/>'],
	8: [
		13,
		'<ellipse cx="6.5" cy="5.4" rx="5.3" ry="5.4"/><ellipse cx="6.5" cy="16" rx="6.5" ry="6"/>'
	],
	9: [13, `<path transform="rotate(180 6.5 11)" d="${SIX}"/>`]
};
const STROKE = 4.4;
const GAP = 2.2;

/** The printed rank: 2 to 10, J, Q, K, A. */
export function printed(rank) {
	return { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[rank] ?? String(rank);
}

const NAMES = { 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' };
/** What the card is, as the site's alt text says it: "Ace of spades". */
export function cardTitle(rank, suit) {
	return `${NAMES[rank] ?? rank} of ${suit}`;
}

const round = (n) => Number(n.toFixed(2));

/** The rank's strokes, its top left at (x, y) on the card, in the suit's colour. */
function rankMarkup(rank, x, y, color) {
	const glyphs = [...printed(rank)];
	let at = x + STROKE / 2;
	const parts = [];
	for (const g of glyphs) {
		const [width, markup] = GLYPHS[g];
		parts.push(`<g transform="translate(${round(at)} ${round(y + STROKE / 2)})">${markup}</g>`);
		// The next glyph's strokes start a gap after this one's.
		at += width + STROKE + GAP;
	}
	return (
		`<g class="rank" fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">` +
		parts.join('') +
		'</g>'
	);
}

/** The width a rank takes on the card, its strokes included. */
export function rankWidth(rank) {
	const glyphs = [...printed(rank)];
	return round(
		glyphs.reduce((sum, g) => sum + GLYPHS[g][0], 0) + STROKE + (glyphs.length - 1) * (STROKE + GAP)
	);
}

function pip(suit, x, y, size, color) {
	return `<g class="pip" fill="${color}" transform="translate(${x} ${y}) scale(${round(size / 100)})">${PIPS[suit]}</g>`;
}

function svg(title, body) {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}">\n` +
		`<title>${title}</title>\n` +
		body.map((line) => `${line}\n`).join('') +
		'</svg>\n'
	);
}

/** The card's outline: warm white with a thin edge, its corners rounded. */
function blank(palette) {
	return `<rect x="0.75" y="0.75" width="69.5" height="93.5" rx="6" fill="${palette.get('card')}" stroke="${palette.get('card-edge')}" stroke-width="1.5"/>`;
}

/** Where a face's parts go: FeltPrep's layout, scaled onto 71 × 95. */
export const LAYOUT = {
	rank: { x: 6, y: 6, height: 22 + STROKE },
	small: { x: 6, y: 38, size: 15 },
	large: { x: 31, y: 53, size: 34 }
};

export function face(rank, suit, palette) {
	const color = palette.get(`suit-${suit}`);
	const { rank: r, small, large } = LAYOUT;
	// A ten is wider than the others: it starts closer to the edge, as in FeltPrep.
	const x = rank === 10 ? 4.5 : r.x;
	return svg(cardTitle(rank, suit), [
		blank(palette),
		rankMarkup(rank, x, r.y, color),
		pip(suit, small.x, small.y, small.size, color),
		pip(suit, large.x, large.y, large.size, color)
	]);
}

/** A row of diamonds every 12 units, centred on the card, so the lattice is the same upside down. */
function lattice() {
	const cx = CARD_W / 2;
	const cy = CARD_H / 2;
	const d = [];
	for (let row = -3; row < 3; row++) {
		const y = cy + row * 12 + 6;
		for (const col of [-1, 0, 1]) {
			const x = cx + col * 13;
			d.push(`M${round(x)} ${round(y - 6)}l6.5 6l-6.5 6l-6.5 -6Z`);
		}
	}
	return d.join('');
}

export function back(name, palette) {
	const color = palette.get(`card-${name.replace('lattice-', 'back-')}`);
	const mark = palette.get('card-back-mark');
	return svg('Face-down card', [
		blank(palette),
		`<rect x="5" y="5" width="61" height="85" rx="3.5" fill="${color}"/>`,
		`<g fill="none" stroke="${mark}" stroke-width="1.2" stroke-opacity="0.85">`,
		'<rect x="9" y="9" width="53" height="77" rx="2"/>',
		`<path d="${lattice()}"/>`,
		'</g>'
	]);
}

/** The empty board slot: a card's outline, sunk into the felt. */
export function slot(palette) {
	return svg('Empty card slot', [
		`<rect x="0.75" y="0.75" width="69.5" height="93.5" rx="6" fill="${palette.get('felt-deep')}" fill-opacity="0.55" stroke="${palette.get('felt-glow')}" stroke-width="1.5" stroke-dasharray="4 3"/>`
	]);
}

/** Every file of the deck, by its path under web/. */
export function renderDeck(palette = cleanPalette()) {
	const files = new Map();
	for (const suit of SUITS)
		for (const rank of RANKS)
			files.set(`${DIR}/faces/${rank}-${suit}.svg`, face(rank, suit, palette));
	for (const name of BACKS) files.set(`${DIR}/backs/${name}.svg`, back(name, palette));
	files.set(`${DIR}/slot.svg`, slot(palette));
	return files;
}

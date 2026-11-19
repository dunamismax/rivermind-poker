// The deck: 52 faces and 18 backs, imported pixel-art sprites kept as PNG in
// web/art/cards/ (fronts/<rank>-<suit>.png and backs/<name>.png), plus the
// empty board slot, drawn here by rule on the palette.
//
// The sprites are 73 × 97 pixel art saved at a whole-number scale (the fronts
// at 12x, the backs at 13x). Reading one checks that every scaled-up pixel is
// a solid block, fully opaque or clear (alpha 8 of 255 or less), so it shrinks
// back to 1x without losing anything visible. Every card leaves its outer pixel ring clear, so that ring
// is cropped too, and a card is 71 × 95 on the site.
import { readFileSync, readdirSync } from 'node:fs';
import { ART, Canvas } from './canvas.js';
import { decodePng } from './png.js';

const SPRITE_W = 73;
const SPRITE_H = 97;
const MARGIN = 1;
const FAINT = 8;
export const CARD_W = SPRITE_W - 2 * MARGIN;
export const CARD_H = SPRITE_H - 2 * MARGIN;
export const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const RANK_NAMES = { 11: 'jack', 12: 'queen', 13: 'king', 14: 'ace' };
/** The backs, the site's default first. */
export const BACKS = [
	'classic-red',
	'classic-blue',
	'classic-green',
	'classic-amber',
	'classic-slate',
	'classic-dusk',
	'parchment',
	'argyle',
	'confetti',
	'maze',
	'tracks',
	'moons',
	'nebula',
	'marble-rose',
	'contour-blue',
	'contour-rainbow',
	'swirl-violet',
	'shapes'
];

const CARDS = new URL('cards/', ART);
export const frontSource = (rank, suit) => `fronts/${RANK_NAMES[rank] ?? rank}-${suit}.png`;
export const backSource = (name) => `backs/${name}.png`;

/**
 * Reads one sprite at 1x, cropped to the card.
 * @param {string} path under web/art/cards/
 * @returns {{ width: number, height: number, data: Uint8Array }}
 */
export function loadCard(path) {
	const png = decodePng(new Uint8Array(readFileSync(new URL(path, CARDS))));
	const k = png.width / SPRITE_W;
	if (!Number.isInteger(k) || png.height !== SPRITE_H * k) {
		throw new Error(`${path}: ${png.width} × ${png.height} is not 73 × 97 at a whole scale`);
	}
	const src = new Uint32Array(png.data.buffer, png.data.byteOffset, png.data.length / 4);
	const out = new Uint8Array(CARD_W * CARD_H * 4);
	for (let y = 0; y < SPRITE_H; y++) {
		for (let x = 0; x < SPRITE_W; x++) {
			const first = src[y * k * png.width + x * k];
			for (let j = 0; j < k; j++) {
				for (let i = 0; i < k; i++) {
					if (src[(y * k + j) * png.width + x * k + i] !== first) {
						throw new Error(`${path}: pixel (${x}, ${y}) is not a solid ${k} × ${k} block`);
					}
				}
			}
			const at = (y * k * png.width + x * k) * 4;
			// The parchment back carries a few invisible strays (alpha 2 and 4
			// of 255) along its torn edge; they count as clear.
			const alpha = png.data[at + 3] <= FAINT ? 0 : png.data[at + 3];
			if (alpha !== 0 && alpha !== 255) {
				throw new Error(`${path}: pixel (${x}, ${y}) is partly transparent`);
			}
			const cx = x - MARGIN;
			const cy = y - MARGIN;
			if (cx < 0 || cy < 0 || cx >= CARD_W || cy >= CARD_H) {
				if (alpha) throw new Error(`${path}: pixel (${x}, ${y}) is outside the card`);
				continue;
			}
			// Clear pixels are stored as 0, 0, 0, 0 whatever color they held.
			if (alpha) out.set(png.data.subarray(at, at + 4), (cy * CARD_W + cx) * 4);
		}
	}
	return { width: CARD_W, height: CARD_H, data: out };
}

/** Fails unless `dir` holds exactly the expected sprites (dotfiles aside). */
function expectSources(dir, expected) {
	const found = readdirSync(new URL(`${dir}/`, CARDS)).filter((f) => !f.startsWith('.'));
	const want = new Set(expected.map((p) => p.slice(dir.length + 1)));
	const extra = found.filter((f) => !want.has(f));
	const missing = [...want].filter((f) => !found.includes(f));
	if (extra.length || missing.length) {
		throw new Error(
			`web/art/cards/${dir}: unexpected ${extra.join(', ') || 'none'}; missing ${missing.join(', ') || 'none'}`
		);
	}
}

/** Every card image (raw RGBA) by its path under src/lib/art/. */
export function renderDeck() {
	const fronts = SUITS.flatMap((suit) => RANKS.map((rank) => [rank, suit]));
	expectSources(
		'fronts',
		fronts.map(([rank, suit]) => frontSource(rank, suit))
	);
	expectSources('backs', BACKS.map(backSource));
	const out = new Map();
	for (const [rank, suit] of fronts) {
		out.set(`cards/faces/${rank}-${suit}.png`, loadCard(frontSource(rank, suit)));
	}
	for (const name of BACKS) out.set(`cards/backs/${name}.png`, loadCard(backSource(name)));
	return out;
}

/**
 * An empty place on the board: the cards' own outline, dashed in felt light
 * on felt dark. The outline is taken from the ace of spades, whose shape every
 * face and the plain backs share.
 */
export function slot() {
	const ace = loadCard(frontSource(14, 'spades'));
	const inCard = (x, y) =>
		x >= 0 && y >= 0 && x < CARD_W && y < CARD_H && ace.data[(y * CARD_W + x) * 4 + 3] !== 0;
	const edge = (x, y) =>
		inCard(x, y) &&
		(!inCard(x - 1, y) || !inCard(x + 1, y) || !inCard(x, y - 1) || !inCard(x, y + 1));
	const c = new Canvas(CARD_W, CARD_H);
	c.where(inCard, 'felt dark');
	// Dashes of three pixels with gaps of two, counted along each side from
	// the middle so both halves match.
	const along = (x, y) =>
		y <= 2 || y >= CARD_H - 3 ? Math.abs(x - (CARD_W >> 1)) : Math.abs(y - (CARD_H >> 1));
	c.where((x, y) => edge(x, y) && along(x, y) % 5 < 3, 'felt light');
	return c;
}

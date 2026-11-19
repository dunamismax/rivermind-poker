// Lays out the 52 card faces, in standard and four-colour inks, and the three
// backs, from the hand-drawn parts in web/art/cards.pxl.
//
// A card is 33 × 45 art pixels: odd in both directions, so pips centre on a
// real pixel column and row and the lower half is the upper half turned 180°.
import { Canvas, loadSprites, paint } from './canvas.js';

export const CARD_W = 33;
export const CARD_H = 45;
export const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
export const BACKS = ['rivermind', 'current', 'lattice'];

/** Ink sets per suit: the index and pips, with the aces' light and shadow. */
const INKS = {
	black: { ink: 'night', suit: 'night', light: 'dusk', dark: 'ink' },
	red: { ink: 'red dark', suit: 'red', light: 'red light', dark: 'red dark' },
	blue: { ink: 'blue dark', suit: 'blue', light: 'blue light', dark: 'blue dark' },
	green: { ink: 'green dark', suit: 'green dark', light: 'green', dark: 'green deep' }
};

export function inksFor(suit, treatment) {
	if (treatment === 'four-colour' && suit === 'diamonds') return INKS.blue;
	if (treatment === 'four-colour' && suit === 'clubs') return INKS.green;
	return suit === 'hearts' || suit === 'diamonds' ? INKS.red : INKS.black;
}

/** Court colors by suit: the robe ramp and each court's hair. */
const ROBES = {
	spades: { robe: 'blue', 'robe-dark': 'blue dark', 'robe-light': 'blue light' },
	hearts: { robe: 'red', 'robe-dark': 'red dark', 'robe-light': 'red light' },
	diamonds: { robe: 'amber', 'robe-dark': 'amber dark', 'robe-light': 'gold' },
	clubs: { robe: 'green', 'robe-dark': 'green dark', 'robe-light': 'green light' }
};
const HAIR = {
	spades: { 11: ['wood', 'wood dark'], 12: ['night', 'ink'], 13: ['mist', 'haze'] },
	hearts: { 11: ['gold', 'amber'], 12: ['amber', 'amber dark'], 13: ['paper shade', 'paper deep'] },
	diamonds: { 11: ['night', 'ink'], 12: ['wood', 'wood dark'], 13: ['wood light', 'wood'] },
	clubs: { 11: ['wood light', 'wood'], 12: ['gold', 'amber'], 13: ['haze', 'dusk'] }
};

/** Pip columns and rows (centres) for the number cards; rows below 22 are upright. */
const L = 11;
const C = 16;
const R = 21;
const LAYOUTS = {
	2: [
		[C, 7],
		[C, 37]
	],
	3: [
		[C, 7],
		[C, 22],
		[C, 37]
	],
	4: [
		[L, 7],
		[R, 7],
		[L, 37],
		[R, 37]
	],
	5: [
		[L, 7],
		[R, 7],
		[C, 22],
		[L, 37],
		[R, 37]
	],
	6: [
		[L, 7],
		[R, 7],
		[L, 22],
		[R, 22],
		[L, 37],
		[R, 37]
	],
	7: [
		[L, 7],
		[R, 7],
		[C, 14],
		[L, 22],
		[R, 22],
		[L, 37],
		[R, 37]
	],
	8: [
		[L, 7],
		[R, 7],
		[C, 14],
		[L, 22],
		[R, 22],
		[C, 30],
		[L, 37],
		[R, 37]
	],
	9: [
		[L, 7],
		[R, 7],
		[L, 17],
		[R, 17],
		[C, 22],
		[L, 27],
		[R, 27],
		[L, 37],
		[R, 37]
	],
	// The 10's side columns sit one pixel in, leaving a clear column between
	// its wider index and the pips.
	10: [
		[L + 1, 7],
		[R - 1, 7],
		[C, 12],
		[L + 1, 17],
		[R - 1, 17],
		[L + 1, 27],
		[R - 1, 27],
		[C, 32],
		[L + 1, 37],
		[R - 1, 37]
	]
};

const sprites = loadSprites('cards.pxl');
const sprite = (name) => {
	const s = sprites.get(name);
	if (!s) throw new Error(`cards.pxl has no sprite "${name}"`);
	return s;
};

/** Whether (x, y) is inside a card's rounded outline. */
function inCard(x, y, w = CARD_W, h = CARD_H) {
	const edge = Math.min(y, h - 1 - y);
	const inset = edge === 0 ? 2 : edge === 1 ? 1 : 0;
	return x >= inset && x <= w - 1 - inset;
}

/** A blank card: ink outline, paper, lit from the top-left. */
export function blankCard(fill = 'paper') {
	const c = new Canvas(CARD_W, CARD_H);
	c.where((x, y) => inCard(x, y), fill);
	c.where(
		(x, y) =>
			inCard(x, y) &&
			(!inCard(x - 1, y) || !inCard(x + 1, y) || !inCard(x, y - 1) || !inCard(x, y + 1)),
		'ink'
	);
	return c;
}

/** Adds the 1 px bevel inside the outline: highlight top-left, shade bottom-right. */
function bevel(c, light, shade) {
	const inner = (x, y) => inCard(x, y) && c.get(x, y) !== 'ink';
	const snapshot = (x, y) => inner(x, y);
	const marks = [];
	for (let y = 0; y < CARD_H; y++) {
		for (let x = 0; x < CARD_W; x++) {
			if (!snapshot(x, y)) continue;
			if (!snapshot(x, y - 1) || !snapshot(x - 1, y)) marks.push([x, y, light]);
			else if (!snapshot(x, y + 1) || !snapshot(x + 1, y)) marks.push([x, y, shade]);
		}
	}
	for (const [x, y, color] of marks) c.px(x, y, color);
}

/** Adds a 1 px outline around every opaque shape of `part`, within its box. */
function outlined(part, color = 'ink') {
	const out = new Canvas(part.width, part.height);
	out.stamp(part, 0, 0);
	for (let y = 0; y < part.height; y++) {
		for (let x = 0; x < part.width; x++) {
			if (part.get(x, y) !== null) continue;
			const near = [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1]
			].some(([dx, dy]) => part.get(x + dx, y + dy) !== null);
			if (near) out.px(x, y, color);
		}
	}
	return out;
}

function index(c, rank, suit, inks) {
	const glyph = paint(sprite(`rank-${rank}`), { ink: inks.ink });
	const pip = paint(sprite(`pip-${suit}`), { suit: inks.suit });
	// Every index keeps a one-pixel margin inside the outline and bevel.
	const gx = 2;
	c.stamp(glyph, gx, 2);
	c.stamp(pip, 2, 10);
	// The same index turned 180° in the bottom-right corner.
	c.stamp(glyph, CARD_W - gx - glyph.width, CARD_H - 2 - glyph.height, { rotate: true });
	c.stamp(pip, CARD_W - 2 - pip.width, CARD_H - 10 - pip.height, { rotate: true });
}

/**
 * One face.
 * @param {number} rank 2 to 14
 * @param {string} suit
 * @param {'standard' | 'four-colour'} treatment
 */
export function face(rank, suit, treatment = 'standard') {
	const inks = inksFor(suit, treatment);
	const c = blankCard();
	bevel(c, 'white', 'paper shade');
	index(c, rank, suit, inks);
	const pip = paint(sprite(`pip-${suit}`), { suit: inks.suit });
	if (rank <= 10) {
		// A pip's centre row is its third; a six-row pip hangs its stem below
		// (or, turned, above).
		for (const [x, y] of LAYOUTS[rank]) {
			const turned = y > 22;
			c.stamp(pip, x - 2, turned ? y + 2 - (pip.height - 1) : y - 2, { rotate: turned });
		}
	} else if (rank === 14) {
		const big = paint(sprite(`ace-${suit}`), inks);
		// A gold ring around the ace of spades, the deck's signature card.
		if (suit === 'spades') {
			c.where((x, y) => Math.abs(Math.hypot(x - 16, y - 22) - 10) < 0.5, 'gold');
			c.where((x, y) => Math.abs(Math.hypot(x - 16, y - 22) - 11) < 0.5 && y > 22, 'amber dark');
		}
		c.stamp(big, 16 - (big.width >> 1), 22 - (big.height >> 1));
	} else {
		// The court's window: an ink frame on paper shade, the figure outlined.
		c.rect(8, 3, 17, 39, 'ink', true);
		c.rect(9, 4, 15, 37, 'paper shade');
		const [hair, hairDark] = HAIR[suit][rank];
		const figure = paint(sprite(`court-${rank}`), { ...ROBES[suit], hair, 'hair-dark': hairDark });
		c.stamp(outlined(figure), 9, 4);
		// The suit on the chest, in gold.
		c.stamp(paint(sprite(`pip-${suit}`), { suit: 'gold light' }), 14, 23);
	}
	return c;
}

/** The three backs. Each looks the same turned 180°. */
export function back(name) {
	const BASES = {
		rivermind: { base: 'felt dark', line: 'felt light', rim: 'gold', deep: 'felt deep' },
		current: { base: 'blue dark', line: 'blue', rim: 'blue light', deep: 'blue deep' },
		lattice: { base: 'red dark', line: 'red', rim: 'gold', deep: 'red deep' }
	};
	const b = BASES[name];
	if (!b) throw new Error(`no back "${name}"`);
	const c = blankCard('paper');
	bevel(c, 'white', 'paper shade');
	// The pattern panel inside a white border.
	const x0 = 3;
	const y0 = 3;
	const w = CARD_W - 6;
	const h = CARD_H - 6;
	c.rect(x0, y0, w, h, b.base);
	for (let j = 0; j < h; j++) {
		for (let i = 0; i < w; i++) {
			let on = false;
			if (name === 'rivermind') on = (i + j) % 4 === 0 && (i - j + 400) % 8 < 4;
			if (name === 'current') {
				const wave = [0, 0, 1, 2, 2, 1][i % 6];
				on = (j - wave + 400) % 5 === 0;
			}
			if (name === 'lattice') on = (i + j) % 6 === 0 || (i - j + 600) % 6 === 0;
			if (on) c.px(x0 + i, y0 + j, b.line);
			if (name === 'lattice' && (i + j) % 6 === 0 && (i - j + 600) % 6 === 0)
				c.px(x0 + i, y0 + j, 'gold');
		}
	}
	c.rect(x0, y0, w, h, b.rim, true);
	if (name === 'rivermind') {
		const emblem = paint(sprite('back-emblem'), { base: b.deep });
		c.stamp(emblem, (CARD_W - emblem.width) >> 1, (CARD_H - emblem.height) >> 1);
	}
	// Enforce 180° symmetry: the lower half is the upper half turned.
	for (let y = 0; y < CARD_H; y++) {
		for (let x = 0; x < CARD_W; x++) {
			const ry = CARD_H - 1 - y;
			const rx = CARD_W - 1 - x;
			if (y * CARD_W + x < ry * CARD_W + rx) c.px(rx, ry, c.get(x, y));
		}
	}
	return c;
}

/** An empty place on the board: a dashed card outline on the felt. */
export function slot() {
	const c = new Canvas(CARD_W, CARD_H);
	const edge = (x, y) =>
		inCard(x, y) &&
		(!inCard(x - 1, y) || !inCard(x + 1, y) || !inCard(x, y - 1) || !inCard(x, y + 1));
	c.where((x, y) => inCard(x, y), 'felt dark');
	// Dashes of two pixels along the edge, in step around the corners.
	const along = (x, y) => (y === 0 || y === CARD_H - 1 ? x : y);
	c.where((x, y) => edge(x, y) && Math.floor(along(x, y) / 2) % 2 === 0, 'felt light');
	return c;
}

/** Every card file by its path under src/lib/art/. */
export function renderCards() {
	const out = new Map();
	for (const treatment of ['standard', 'four-colour']) {
		for (const suit of SUITS) {
			if (treatment === 'four-colour' && (suit === 'spades' || suit === 'hearts')) continue;
			for (const rank of RANKS)
				out.set(`cards/${treatment}/${rank}-${suit}.png`, face(rank, suit, treatment));
		}
	}
	for (const name of BACKS) out.set(`cards/backs/${name}.png`, back(name));
	out.set('cards/slot.png', slot());
	return out;
}

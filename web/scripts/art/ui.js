// The site's interface art (P5C.4): a hand-drawn SVG for every sprite, at the
// size the kit gives it (kit.css), in CSS pixels: the seven chips, the pot pile,
// the dealer button, six people and a robot for each bot kind (still tagged
// "Bot" by the page, D-7), the RiverMind mark, the mini cards and table voice's
// glyphs. sprites.css puts each behind its class. Every colour comes from the
// palette in theme.css, and nothing in a file is text: a letter is drawn as
// strokes.
import { readPalette } from './deck.js';

export const DIR = 'src/lib/art/ui';

const round = (n) => Number(n.toFixed(2));

function svg(width, height, body) {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n` +
		body.map((line) => `${line}\n`).join('') +
		'</svg>\n'
	);
}

/** The chips, by name: face, rim and the stripes on the rim. */
export const CHIPS = {
	white: ['paper', 'paper-deep', 'blue'],
	red: ['red', 'red-dark', 'paper'],
	blue: ['blue', 'blue-dark', 'paper'],
	green: ['green', 'green-dark', 'paper'],
	black: ['slate', 'dusk', 'paper-shade'],
	violet: ['violet', 'violet-deep', 'paper'],
	gold: ['gold', 'amber-dark', 'amber-deep']
};

function chip(name, c) {
	const [face, rim, stripe] = CHIPS[name].map((n) => c(n));
	// Eight stripes round the rim: a circle of radius 8.4 is 52.78 long.
	const dash = round((2 * Math.PI * 8.4) / 16);
	return svg(22, 22, [
		`<circle cx="11" cy="11" r="10.25" fill="${face}" stroke="${rim}" stroke-width="1.5"/>`,
		`<circle cx="11" cy="11" r="8.4" fill="none" stroke="${stripe}" stroke-width="2.6" stroke-dasharray="${dash} ${dash}"/>`,
		`<circle cx="11" cy="11" r="5.4" fill="${face}" stroke="${rim}" stroke-width="1"/>`
	]);
}

/** Three stacks of chips seen from the side, as the pot. */
function pot(c) {
	const stacks = [
		[11, 5, 'red', 'red-dark'],
		[29, 6, 'blue', 'blue-dark'],
		[47, 4, 'gold', 'amber-dark']
	];
	const body = [];
	for (const [cx, n, face, rim] of stacks) {
		for (let i = 0; i < n; i++) {
			const y = 27 - i * 4;
			body.push(
				`<rect x="${cx - 8}" y="${y}" width="16" height="4.5" rx="2" fill="${c(face)}" stroke="${c(rim)}" stroke-width="0.8"/>`,
				`<rect x="${cx - 1.5}" y="${y + 1}" width="3" height="2.5" fill="${c('paper')}" fill-opacity="0.85"/>`
			);
		}
		const top = 27 - (n - 1) * 4;
		body.push(
			`<ellipse cx="${cx}" cy="${top + 0.6}" rx="7.2" ry="1.4" fill="${c('white')}" fill-opacity="0.25"/>`
		);
	}
	return svg(58, 32, body);
}

function dealer(c) {
	return svg(22, 22, [
		`<circle cx="11" cy="11" r="10.25" fill="${c('paper')}" stroke="${c('paper-deep')}" stroke-width="1.5"/>`,
		`<path d="M8.2 6.4V15.6H10.6C13.4 15.6 15.2 13.8 15.2 11C15.2 8.2 13.4 6.4 10.6 6.4Z" fill="none" stroke="${c('ink')}" stroke-width="2" stroke-linejoin="round"/>`
	]);
}

/** The people: skin, hair and shirt. */
export const PEOPLE = [
	['skin-light', 'amber-deep', 'blue'],
	['skin', 'ink', 'red'],
	['skin-deep', 'ink', 'amber'],
	['skin-light', 'amber', 'green'],
	['skin', 'amber-deep', 'violet'],
	['skin-deep', 'mist', 'felt-glow']
];

/** A round badge, 32 across, that every avatar sits in. */
const badge = (c) =>
	`<circle cx="16" cy="16" r="15.25" fill="${c('slate')}" stroke="${c('dusk')}" stroke-width="1.5"/>`;

function person([skin, hair, shirt], c) {
	return svg(32, 32, [
		badge(c),
		// Shoulders, their lower edge on the badge's circle.
		`<path d="M6.6 27.6C7.6 23.2 11.2 20.6 16 20.6C20.8 20.6 24.4 23.2 25.4 27.6A15 15 0 0 1 6.6 27.6Z" fill="${c(shirt)}"/>`,
		`<circle cx="16" cy="13.2" r="5.6" fill="${c(skin)}"/>`,
		`<path d="M10.3 12.8C10.2 8.9 12.8 6.9 16 6.9C19.2 6.9 21.8 8.9 21.7 12.8C20.2 10.9 18 10.2 16 10.2C14 10.2 11.8 10.9 10.3 12.8Z" fill="${c(hair)}"/>`
	]);
}

/** The bots: a robot in the colour of its kind. */
export const BOTS = {
	heuristic: 'green',
	random: 'violet-light',
	'calling-station': 'haze',
	medium: 'blue',
	hard: 'red',
	bot: 'amber'
};

function robot(colour, c) {
	return svg(32, 32, [
		badge(c),
		`<path d="M16 9V5.6" stroke="${c(colour)}" stroke-width="1.6" stroke-linecap="round"/>`,
		`<circle cx="16" cy="4.8" r="1.8" fill="${c(colour)}"/>`,
		`<rect x="5.2" y="14" width="2.6" height="6" rx="1.2" fill="${c(colour)}"/>`,
		`<rect x="24.2" y="14" width="2.6" height="6" rx="1.2" fill="${c(colour)}"/>`,
		`<rect x="7.5" y="9" width="17" height="15" rx="4" fill="${c(colour)}"/>`,
		`<rect x="10" y="12.4" width="12" height="6" rx="3" fill="${c('ink')}"/>`,
		`<circle cx="13.2" cy="15.4" r="1.4" fill="${c('gold-light')}"/>`,
		`<circle cx="18.8" cy="15.4" r="1.4" fill="${c('gold-light')}"/>`,
		`<path d="M12.5 21H19.5" stroke="${c('ink')}" stroke-width="1.4" stroke-linecap="round" stroke-opacity="0.6"/>`,
		`<path d="M9 30C10.4 27 12.8 25.6 16 25.6C19.2 25.6 21.6 27 23 30" fill="none" stroke="${c(colour)}" stroke-width="2" stroke-linecap="round"/>`
	]);
}

/**
 * The RiverMind mark, on its 30 × 34 box: a gold spade (FeltPrep's, in a 100 × 100
 * box, placed by `transform`) with a river in the night colour running across it.
 * The icons (icons.js) draw the same shapes.
 */
export const MARK = {
	spade: {
		transform: 'translate(0 2) scale(0.3)',
		d: 'M50 4C74 26 95 42 95 62C95 75 85 83 73 83C65 83 58 79 54 72C55 83 59 90 67 96L33 96C41 90 45 83 46 72C42 79 35 83 27 83C15 83 5 75 5 62C5 42 26 26 50 4Z'
	},
	river: { d: 'M5.4 19.4C8.4 16.6 11.2 16.6 14 18.6C16.8 20.6 19.6 20.6 24.6 17.2', width: 2 }
};

/** The mark's two shapes as SVG elements. */
export function markShapes(c) {
	return [
		`<path transform="${MARK.spade.transform}" d="${MARK.spade.d}" fill="${c('gold')}"/>`,
		`<path d="${MARK.river.d}" fill="none" stroke="${c('night')}" stroke-width="${MARK.river.width}" stroke-linecap="round"/>`
	];
}

/** The RiverMind mark: a gold spade with a river running across it. */
function emblem(c) {
	return svg(30, 34, markShapes(c));
}

/** Two card backs fanned, the deck's burgundy in miniature: a pod's hidden hand. */
function miniCards(c) {
	const card = (x, angle) =>
		`<g transform="rotate(${angle} ${x + 7} 21)"><rect x="${x}" y="3" width="14" height="19" rx="2" fill="${c('card-back-burgundy')}" stroke="${c('card')}" stroke-width="1.4"/><rect x="${x + 3}" y="6" width="8" height="13" rx="1" fill="none" stroke="${c('card-back-mark')}" stroke-width="0.8"/></g>`;
	return svg(28, 26, [card(4, -10), card(10, 10)]);
}

/** A stroke in the face colour inside an ink outline, so it reads on any tag. */
function outlined(d, c, face = 'paper') {
	return [
		`<path d="${d}" fill="none" stroke="${c('ink')}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`,
		`<path d="${d}" fill="none" stroke="${c(face)}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
	];
}

function mic(c, face = 'paper') {
	return [
		...outlined(
			'M5.6 10.6C5.6 13.9 8 16.4 11 16.4C14 16.4 16.4 13.9 16.4 10.6M11 16.4V19.2M7.8 19.2H14.2',
			c,
			face
		),
		`<rect x="7.9" y="2.4" width="6.2" height="10.6" rx="3.1" fill="${c(face)}" stroke="${c('ink')}" stroke-width="1.2"/>`
	];
}

function phones(c) {
	return [
		...outlined('M4.6 13.4V11.2C4.6 6.8 7.4 3.8 11 3.8C14.6 3.8 17.4 6.8 17.4 11.2V13.4', c),
		`<rect x="2.6" y="11.6" width="5" height="7.6" rx="1.8" fill="${c('paper')}" stroke="${c('ink')}" stroke-width="1.2"/>`,
		`<rect x="14.4" y="11.6" width="5" height="7.6" rx="1.8" fill="${c('paper')}" stroke="${c('ink')}" stroke-width="1.2"/>`
	];
}

const slash = (c) => outlined('M3.6 18.4L18.4 3.6', c, 'red-light');

/** Every file of the interface art, by its path under web/. */
export function renderUi(palette = readPalette()) {
	const c = (name) => {
		const hex = palette.get(name);
		if (!hex) throw new Error(`no colour ${name}`);
		return hex;
	};
	const files = new Map();
	for (const name of Object.keys(CHIPS)) files.set(`${DIR}/chip-${name}.svg`, chip(name, c));
	files.set(`${DIR}/pot.svg`, pot(c));
	files.set(`${DIR}/dealer.svg`, dealer(c));
	PEOPLE.forEach((p, i) => files.set(`${DIR}/avatar-person-${i}.svg`, person(p, c)));
	for (const [kind, colour] of Object.entries(BOTS))
		files.set(`${DIR}/avatar-${kind}.svg`, robot(colour, c));
	files.set(`${DIR}/emblem.svg`, emblem(c));
	files.set(`${DIR}/mini-cards.svg`, miniCards(c));
	files.set(`${DIR}/voice-mic.svg`, svg(22, 22, mic(c)));
	files.set(`${DIR}/voice-mic-muted.svg`, svg(22, 22, [...mic(c), ...slash(c)]));
	files.set(`${DIR}/voice-phones.svg`, svg(22, 22, phones(c)));
	files.set(`${DIR}/voice-phones-muted.svg`, svg(22, 22, [...phones(c), ...slash(c)]));
	files.set(`${DIR}/voice-out.svg`, svg(22, 22, mic(c, 'haze')));
	return files;
}

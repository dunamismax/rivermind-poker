// The interface art: chips, the dealer button, avatars, the emblem, and the
// nine-slice frames for panels, buttons and the table, drawn from
// web/art/ui.pxl and by rule.
//
// Nine-slice frames are drawn at their smallest: corners plus one stretchable
// pixel. The CSS (src/lib/art/pixel.css) scales them by whole numbers with
// border-image, so every frame keeps square pixels at any size.
import { Canvas, loadSprites, paint } from './canvas.js';

const sprites = loadSprites('ui.pxl');
const sprite = (name) => {
	const s = sprites.get(name);
	if (!s) throw new Error(`ui.pxl has no sprite "${name}"`);
	return s;
};

/** Adds a 1 px ink outline around every opaque shape, within the canvas. */
export function outlined(part, color = 'ink') {
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

export const CHIPS = {
	white: { chip: 'paper', 'chip-dark': 'paper deep', 'chip-light': 'white', stripe: 'blue' },
	red: { chip: 'red', 'chip-dark': 'red dark', 'chip-light': 'red light', stripe: 'white' },
	blue: { chip: 'blue', 'chip-dark': 'blue dark', 'chip-light': 'blue light', stripe: 'white' },
	green: { chip: 'green', 'chip-dark': 'green dark', 'chip-light': 'green light', stripe: 'white' },
	black: { chip: 'deep slate', 'chip-dark': 'night', 'chip-light': 'dusk', stripe: 'mist' },
	violet: {
		chip: 'violet',
		'chip-dark': 'violet deep',
		'chip-light': 'violet light',
		stripe: 'white'
	},
	gold: { chip: 'gold', 'chip-dark': 'amber dark', 'chip-light': 'gold light', stripe: 'white' }
};

/** A pile of three stacks seen edge-on, for the pot. */
function pile() {
	const edge = (color) => paint(sprite('chip-edge'), CHIPS[color]);
	const stacks = [
		{ x: 0, colors: ['red', 'red', 'blue', 'red'] },
		{ x: 18, colors: ['gold', 'black', 'gold'] },
		{ x: 9, colors: ['blue', 'blue', 'green', 'blue', 'white'] }
	];
	const c = new Canvas(29, 16);
	for (const { x, colors } of stacks) {
		colors.forEach((color, i) => c.stamp(edge(color), x, c.height - 4 - i * 2));
	}
	return c;
}

const PEOPLE = [
	{
		skin: 'skin light',
		'skin-dark': 'skin',
		hair: 'wood',
		'hair-dark': 'wood dark',
		shirt: 'blue',
		'shirt-dark': 'blue dark'
	},
	{
		skin: 'skin',
		'skin-dark': 'skin deep',
		hair: 'night',
		'hair-dark': 'ink',
		shirt: 'red',
		'shirt-dark': 'red dark'
	},
	{
		skin: 'skin deep',
		'skin-dark': 'wood dark',
		hair: 'ink',
		'hair-dark': 'ink',
		shirt: 'gold',
		'shirt-dark': 'amber dark'
	},
	{
		skin: 'skin light',
		'skin-dark': 'skin',
		hair: 'amber',
		'hair-dark': 'amber dark',
		shirt: 'green',
		'shirt-dark': 'green dark'
	},
	{
		skin: 'skin',
		'skin-dark': 'skin deep',
		hair: 'wood light',
		'hair-dark': 'wood',
		shirt: 'violet light',
		'shirt-dark': 'violet'
	},
	{
		skin: 'skin deep',
		'skin-dark': 'wood dark',
		hair: 'mist',
		'hair-dark': 'haze',
		shirt: 'felt glow',
		'shirt-dark': 'felt light'
	}
];

const BOTS = {
	heuristic: {
		metal: 'felt glow',
		'metal-dark': 'felt',
		'metal-light': 'green light',
		eye: 'blue light'
	},
	random: { metal: 'violet light', 'metal-dark': 'violet', 'metal-light': 'mist', eye: 'gold' },
	calling_station: { metal: 'haze', 'metal-dark': 'dusk', 'metal-light': 'mist', eye: 'red light' },
	medium: { metal: 'blue', 'metal-dark': 'blue dark', 'metal-light': 'blue light', eye: 'gold' },
	hard: { metal: 'red', 'metal-dark': 'red dark', 'metal-light': 'red light', eye: 'gold light' },
	bot: {
		metal: 'amber',
		'metal-dark': 'amber dark',
		'metal-light': 'gold light',
		eye: 'blue light'
	}
};

/**
 * A nine-slice frame: a 1 px ink outline with cut corners, a 1 px bevel lit
 * from the top-left, a fill, and an optional lip below (a button's edge).
 */
function frame({
	fill,
	light,
	shade,
	rim = 'ink',
	lip = 0,
	lipColor = 'ink',
	pressed = false,
	size = 7
}) {
	const w = size;
	const body = size;
	const h = body + lip;
	const c = new Canvas(w, h);
	const top = pressed ? lip : 0;
	const inBody = (x, y) => {
		const yy = y - top;
		if (yy < 0 || yy >= body || x < 0 || x >= w) return false;
		const cornerX = x === 0 || x === w - 1;
		const cornerY = yy === 0 || yy === body - 1;
		return !(cornerX && cornerY);
	};
	if (!pressed && lip) {
		for (let y = body - 1; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const last = y === h - 1;
				const edge = x === 0 || x === w - 1;
				if (last && edge) continue;
				c.px(x, y, last || edge ? rim : lipColor);
			}
		}
	}
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (!inBody(x, y)) continue;
			const outer =
				!inBody(x - 1, y) || !inBody(x + 1, y) || !inBody(x, y - 1) || !inBody(x, y + 1);
			if (outer) {
				c.px(x, y, rim);
				continue;
			}
			const yy = y - top;
			if (yy === 1 || x === 1) c.px(x, y, light);
			else if (yy === body - 2 || x === w - 2) c.px(x, y, shade);
			else c.px(x, y, fill);
		}
	}
	return c;
}

export const BUTTONS = {
	red: { fill: 'red', light: 'red light', shade: 'red dark', lipColor: 'red deep' },
	blue: { fill: 'blue', light: 'blue light', shade: 'blue dark', lipColor: 'blue deep' },
	amber: { fill: 'amber', light: 'gold', shade: 'amber dark', lipColor: 'amber deep' },
	green: { fill: 'green', light: 'green light', shade: 'green dark', lipColor: 'green deep' },
	slate: { fill: 'slate', light: 'dusk', shade: 'deep slate', lipColor: 'night' },
	gold: { fill: 'gold', light: 'gold light', shade: 'amber', lipColor: 'amber dark' }
};

export const PANELS = {
	panel: { fill: 'deep slate', light: 'slate', shade: 'night' },
	raised: { fill: 'slate', light: 'dusk', shade: 'deep slate' },
	inset: { fill: 'night', light: 'ink', shade: 'deep slate' },
	gold: { fill: 'deep slate', light: 'slate', shade: 'night', rim: 'gold' },
	glow: { fill: 'deep slate', light: 'slate', shade: 'night', rim: 'green light' },
	paper: { fill: 'paper', light: 'white', shade: 'paper shade' },
	danger: { fill: 'red dark', light: 'red', shade: 'red deep', rim: 'ink' }
};

/** Two small face-down cards, 14 × 13: an opponent's hand on a phone. */
function miniCards() {
	const c = new Canvas(14, 13);
	const card = (x0, y0) => {
		for (let y = 0; y < 11; y++) {
			for (let x = 0; x < 9; x++) {
				const corner = (x === 0 || x === 8) && (y === 0 || y === 10);
				if (corner) continue;
				const edge = x === 0 || x === 8 || y === 0 || y === 10;
				const border = x === 1 || x === 7 || y === 1 || y === 9;
				c.px(x0 + x, y0 + y, edge ? 'ink' : border ? 'white' : 'red light');
			}
		}
		// The default back (classic red) in miniature: a white diamond at its heart.
		for (const [dx, dy] of [
			[4, 4],
			[3, 5],
			[5, 5],
			[4, 6]
		])
			c.px(x0 + dx, y0 + dy, 'white');
	};
	card(0, 2);
	card(5, 0);
	return c;
}

/** A small down-pointing caret for menus, 7 × 4. */
function caret() {
	const c = new Canvas(7, 4);
	for (let y = 0; y < 4; y++) c.rect(y, y, 7 - 2 * y, 1, 'paper');
	return c;
}

/**
 * The table: a wooden rail with a brass trim around the felt, as a nine-slice
 * with round corners of radius R. Lit from the top-left.
 */
export const TABLE_R = 48;
function table() {
	const R = TABLE_R;
	const S = 2 * R + 1;
	const c = new Canvas(S, S);
	for (let y = 0; y < S; y++) {
		for (let x = 0; x < S; x++) {
			// Distance inward from the outer edge, and which way the edge faces.
			const cx = Math.min(Math.max(x + 0.5, R), S - R);
			const cy = Math.min(Math.max(y + 0.5, R), S - R);
			const dx = x + 0.5 - cx;
			const dy = y + 0.5 - cy;
			const dist = Math.hypot(dx, dy);
			const corner = dx !== 0 && dy !== 0;
			let depth;
			let nx;
			let ny;
			if (corner) {
				depth = R - dist;
				nx = dx / dist;
				ny = dy / dist;
			} else {
				const toLeft = x + 0.5;
				const toRight = S - x - 0.5;
				const toTop = y + 0.5;
				const toBottom = S - y - 0.5;
				depth = Math.min(toLeft, toRight, toTop, toBottom);
				nx = toLeft === depth ? -1 : toRight === depth ? 1 : 0;
				ny = toTop === depth ? -1 : toBottom === depth ? 1 : 0;
			}
			if (depth < 0) continue;
			const lit = -nx - ny > 0.35;
			const dark = nx + ny > 0.35;
			const d = Math.floor(depth);
			let color;
			if (d === 0) color = 'ink';
			else if (d <= 2) color = lit ? 'wood light' : dark ? 'wood dark' : 'wood';
			else if (d <= 6)
				color = d === 3 && lit ? 'wood light' : dark && d >= 5 ? 'wood dark' : 'wood';
			else if (d === 7) color = 'wood deep';
			else if (d === 8) color = lit ? 'gold' : 'brass';
			else if (d === 9) color = 'ink';
			else if (d <= 11) color = lit ? 'felt deep' : 'felt dark';
			else color = 'felt';
			c.px(x, y, color);
		}
	}
	return c;
}

/** The page's wallpaper: faint suits on night, 32 × 32, tiled. */
function wallpaper() {
	const c = new Canvas(32, 32);
	c.rect(0, 0, 32, 32, 'night');
	const pips = {
		spades: ['..S..', '.SSS.', 'SSSSS', '..S..', '.SSS.'],
		hearts: ['.S.S.', 'SSSSS', 'SSSSS', '.SSS.', '..S..'],
		diamonds: ['..S..', '.SSS.', 'SSSSS', '.SSS.', '..S..'],
		clubs: ['.SSS.', 'SSSSS', 'SSSSS', 'S.S.S', '..S..']
	};
	const place = [
		['spades', 5, 5],
		['hearts', 21, 5],
		['diamonds', 13, 21],
		['clubs', 29, 21]
	];
	for (const [suit, x0, y0] of place) {
		pips[suit].forEach((row, j) =>
			[...row].forEach((ch, i) => ch === 'S' && c.px((x0 + i) % 32, (y0 + j) % 32, 'deep slate'))
		);
	}
	return c;
}

/** Every interface file by its path under src/lib/art/. */
export function renderUi() {
	const out = new Map();
	for (const [name, colors] of Object.entries(CHIPS)) {
		out.set(`ui/chip-${name}.png`, paint(sprite('chip'), colors));
	}
	out.set('ui/pot.png', pile());
	out.set('ui/dealer.png', paint(sprite('dealer')));
	PEOPLE.forEach((colors, i) =>
		out.set(`ui/avatar-person-${i}.png`, outlined(paint(sprite('person'), colors)))
	);
	for (const [kind, colors] of Object.entries(BOTS)) {
		out.set(`ui/avatar-${kind.replace('_', '-')}.png`, outlined(paint(sprite('bot'), colors)));
	}
	out.set('ui/emblem.png', paint(sprite('emblem')));
	// Table voice's glyphs (P4C.6): bright for people in voice, dim for someone who is not.
	const bright = { face: 'paper', shade: 'paper deep' };
	const dim = { face: 'dusk', shade: 'slate' };
	for (const name of ['mic', 'mic-muted', 'phones', 'phones-muted']) {
		out.set(`ui/voice-${name}.png`, paint(sprite(`voice-${name}`), bright));
	}
	out.set('ui/voice-out.png', paint(sprite('voice-mic'), dim));
	for (const [name, colors] of Object.entries(PANELS))
		out.set(`ui/frame-${name}.png`, frame(colors));
	for (const [name, colors] of Object.entries(BUTTONS)) {
		out.set(`ui/button-${name}.png`, frame({ ...colors, lip: 2 }));
		out.set(`ui/button-${name}-down.png`, frame({ ...colors, lip: 2, pressed: true }));
	}
	out.set('ui/caret.png', caret());
	out.set('ui/mini-cards.png', miniCards());
	out.set('ui/table.png', table());
	out.set('ui/wallpaper.png', wallpaper());
	return out;
}

/** The favicon (the emblem at 2x on 36 × 36) and a 180 × 180 home-screen icon. */
export function renderIcons() {
	const emblem = paint(sprite('emblem'));
	const icon = new Canvas(36, 36);
	icon.stamp(emblem.scale(2), 3, 1);
	const touch = new Canvas(180, 180);
	touch.rect(0, 0, 180, 180, 'night');
	const big = emblem.scale(9);
	touch.stamp(big, (180 - big.width) >> 1, (180 - big.height) >> 1);
	return new Map([
		['favicon.png', icon],
		['apple-touch-icon.png', touch]
	]);
}

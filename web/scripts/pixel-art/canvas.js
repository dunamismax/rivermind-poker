// Pixel canvases, the named palette and the sprite-grid source format.
//
// Every pixel is a palette color name (or null for transparent), so art can
// never leave the palette. Sources are text grids in web/art/*.pxl, after the
// pixel grids of the owner's Lorehallow art tools:
//
//   legend
//   K ink            one character per color, by palette name
//   S @suit          or by role, filled in when the sprite is drawn
//   . clear
//
//   sprite spade-small
//   ..K..
//   .KKK.
//
// A legend applies to the sprites after it until the next legend. A line
// starting with "#" outside a grid is a comment.
import { readFileSync } from 'node:fs';

export const ART = new URL('../../art/', import.meta.url);

/** @returns {Map<string, [number, number, number]>} */
export function loadPalette() {
	const palette = new Map();
	for (const raw of readFileSync(new URL('palette.hex', ART), 'utf8').split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith(';')) continue;
		const [hex, name] = line.split(';').map((s) => s.trim());
		if (!/^[0-9a-f]{6}$/.test(hex) || !name) throw new Error(`palette: bad line "${raw}"`);
		if (palette.has(name)) throw new Error(`palette: "${name}" twice`);
		palette.set(
			name,
			[0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
		);
	}
	return palette;
}

export const PALETTE = loadPalette();

export class Canvas {
	/** @param {number} width @param {number} height */
	constructor(width, height) {
		this.width = width;
		this.height = height;
		/** @type {(string | null)[]} */
		this.cells = new Array(width * height).fill(null);
	}

	/** @param {number} x @param {number} y @param {string | null} color */
	px(x, y, color) {
		if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
		if (color !== null && !PALETTE.has(color)) throw new Error(`not a palette color: "${color}"`);
		this.cells[y * this.width + x] = color;
	}

	/** @param {number} x @param {number} y */
	get(x, y) {
		if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
		return this.cells[y * this.width + x];
	}

	/** Fills a rectangle; with `rim` only its 1 px edge. */
	rect(x, y, w, h, color, rim = false) {
		for (let j = y; j < y + h; j++) {
			for (let i = x; i < x + w; i++) {
				if (!rim || j === y || j === y + h - 1 || i === x || i === x + w - 1) this.px(i, j, color);
			}
		}
		return this;
	}

	/**
	 * Copies another canvas's opaque pixels with its top-left at (x, y),
	 * optionally rotated 180° (a card's lower half) or mirrored.
	 */
	stamp(part, x, y, { rotate = false, mirror = false } = {}) {
		for (let j = 0; j < part.height; j++) {
			for (let i = 0; i < part.width; i++) {
				const c = part.get(
					rotate || mirror ? part.width - 1 - i : i,
					rotate ? part.height - 1 - j : j
				);
				if (c !== null) this.px(x + i, y + j, c);
			}
		}
		return this;
	}

	/** A copy with colors replaced by the map (unlisted colors stay). */
	swap(map) {
		const out = new Canvas(this.width, this.height);
		out.cells = this.cells.map((c) => (c !== null && c in map ? map[c] : c));
		return out;
	}

	/** Pixels where `test(x, y)` is true become `color`. */
	where(test, color) {
		for (let y = 0; y < this.height; y++) {
			for (let x = 0; x < this.width; x++) if (test(x, y)) this.px(x, y, color);
		}
		return this;
	}

	/** Scales by a whole number, for previews. */
	scale(k) {
		const out = new Canvas(this.width * k, this.height * k);
		for (let y = 0; y < out.height; y++) {
			for (let x = 0; x < out.width; x++)
				out.cells[y * out.width + x] = this.get(Math.floor(x / k), Math.floor(y / k));
		}
		return out;
	}

	/** RGBA bytes for the PNG writer. */
	rgba() {
		const data = new Uint8Array(this.width * this.height * 4);
		this.cells.forEach((c, i) => {
			if (c === null) return;
			const [r, g, b] = PALETTE.get(c);
			data.set([r, g, b, 255], i * 4);
		});
		return { width: this.width, height: this.height, data };
	}
}

/**
 * Reads a .pxl source into sprites. Role colors ("@suit") stay as role names
 * until `paint` fills them in.
 * @param {string} file name under web/art/
 * @returns {Map<string, { width: number, height: number, rows: string[], legend: Map<string, string | null> }>}
 */
export function loadSprites(file) {
	const src = readFileSync(new URL(file, ART), 'utf8');
	const sprites = new Map();
	/** @type {Map<string, string | null>} */
	let legend = new Map();
	let mode = 'none';
	let name = '';
	/** @type {string[]} */
	let rows = [];
	const finish = (n) => {
		if (mode === 'sprite') {
			if (!rows.length) throw new Error(`${file}:${n}: sprite "${name}" is empty`);
			const width = rows[0].length;
			rows.forEach((row, i) => {
				if (row.length !== width)
					throw new Error(
						`${file}: sprite "${name}" row ${i + 1} is ${row.length} wide, not ${width}`
					);
				for (const ch of row) {
					if (!legend.has(ch))
						throw new Error(`${file}: sprite "${name}" uses "${ch}", not in its legend`);
				}
			});
			if (sprites.has(name)) throw new Error(`${file}: sprite "${name}" twice`);
			sprites.set(name, { width, height: rows.length, rows, legend });
		}
		mode = 'none';
		rows = [];
	};
	src.split('\n').forEach((raw, i) => {
		const n = i + 1;
		const line = raw.replace(/\s+$/, '');
		if (mode === 'none' && (line === '' || line.startsWith('#'))) return;
		if (line === '') return finish(n);
		if (mode === 'none' && line === 'legend') {
			legend = new Map();
			mode = 'legend';
		} else if (mode === 'none' && line.startsWith('sprite ')) {
			name = line.slice(7).trim();
			mode = 'sprite';
		} else if (mode === 'legend') {
			const ch = line[0];
			const value = line.slice(1).trim();
			if (value === 'clear') legend.set(ch, null);
			else if (value.startsWith('@') || PALETTE.has(value)) legend.set(ch, value);
			else throw new Error(`${file}:${n}: "${value}" is not a palette color`);
		} else if (mode === 'sprite') rows.push(line.trim());
		else throw new Error(`${file}:${n}: unexpected "${line}"`);
	});
	finish(src.split('\n').length);
	return sprites;
}

/**
 * Draws a sprite onto a new canvas, filling role colors from `roles`.
 * @param {{ width: number, height: number, rows: string[], legend: Map<string, string | null> }} sprite
 * @param {Record<string, string>} [roles]
 */
export function paint(sprite, roles = {}) {
	const c = new Canvas(sprite.width, sprite.height);
	sprite.rows.forEach((row, y) => {
		[...row].forEach((ch, x) => {
			let color = sprite.legend.get(ch) ?? null;
			if (color?.startsWith('@')) {
				const role = color.slice(1);
				if (!(role in roles)) throw new Error(`no color for role @${role}`);
				color = roles[role];
			}
			c.px(x, y, color);
		});
	});
	return c;
}

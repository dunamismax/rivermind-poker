// The site's icons (P5C.4), drawn from the RiverMind mark: an SVG favicon, a
// 48 × 48 PNG of it for browsers that take no SVG icon, and the 180 × 180
// home-screen icon, which must be a PNG.
//
// The PNGs come from the same shapes as the SVG, through the small rasteriser
// below: a path is flattened to straight lines, and each pixel takes the mean of
// 8 × 8 samples, each the colour of the topmost shape that holds it. Nothing in
// it depends on the platform, so the files are the same wherever they are drawn.
import { readPalette } from './deck.js';
import { MARK } from './ui.js';

/** The mark's box (ui.js). */
const MARK_W = 30;
const MARK_H = 34;

/**
 * Each icon: its size, the rounding of its night square (0 fills it: the home
 * screen rounds the corners itself) and the scale the mark is drawn at.
 */
export const ICONS = {
	'static/favicon.svg': { size: 32, radius: 7, scale: 0.75 },
	'static/favicon.png': { size: 48, radius: 10.5, scale: 1.125 },
	'static/apple-touch-icon.png': { size: 180, radius: 0, scale: 3.3 }
};

const round = (n) => Number(n.toFixed(3));

/** Where the mark sits in an icon: centred. */
function placement({ size, scale }) {
	return { x: round((size - MARK_W * scale) / 2), y: round((size - MARK_H * scale) / 2) };
}

function iconSvg(icon, c) {
	const { size, radius, scale } = icon;
	const { x, y } = placement(icon);
	const square = radius
		? `<rect width="${size}" height="${size}" rx="${radius}" fill="${c('night')}"/>`
		: `<rect width="${size}" height="${size}" fill="${c('night')}"/>`;
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">\n` +
		`${square}\n` +
		`<g transform="translate(${x} ${y}) scale(${scale})">\n` +
		`<path transform="${MARK.spade.transform}" d="${MARK.spade.d}" fill="${c('gold')}"/>\n` +
		`<path d="${MARK.river.d}" fill="none" stroke="${c('night')}" stroke-width="${MARK.river.width}" stroke-linecap="round"/>\n` +
		'</g>\n' +
		'</svg>\n'
	);
}

// --- The rasteriser. ---------------------------------------------------------------

/** An affine map [a, b, c, d, e, f]: (x, y) → (a x + c y + e, b x + d y + f). */
const apply = ([a, b, c, d, e, f], [x, y]) => [a * x + c * y + e, b * x + d * y + f];
const compose = (m, n) => {
	// m after n.
	const [a, b, c, d, e, f] = m;
	const [p, q, r, s, t, u] = n;
	return [
		a * p + c * q,
		b * p + d * q,
		a * r + c * s,
		b * r + d * s,
		a * t + c * u + e,
		b * t + d * u + f
	];
};
const translate = (x, y) => [1, 0, 0, 1, x, y];
const scaling = (k) => [k, 0, 0, k, 0, 0];

/** `translate(x y) scale(k)`, the only transforms the mark uses. */
function parseTransform(text) {
	let m = [1, 0, 0, 1, 0, 0];
	for (const [, name, args] of text.matchAll(/(translate|scale)\(([^)]*)\)/g)) {
		const n = args
			.trim()
			.split(/[\s,]+/)
			.map(Number);
		m = compose(m, name === 'translate' ? translate(n[0], n[1] ?? 0) : scaling(n[0]));
	}
	return m;
}

/** A path of M, L, C and Z, in absolute coordinates, as polylines under `m`. */
function flatten(d, m, steps = 24) {
	const tokens = d.match(/[MLCZ]|-?\d*\.?\d+/g);
	const lines = [];
	let line = null;
	let at = [0, 0];
	let command = '';
	for (let i = 0; i < tokens.length;) {
		if (/[MLCZ]/.test(tokens[i])) command = tokens[i++];
		const take = () => [Number(tokens[i++]), Number(tokens[i++])];
		if (command === 'M') {
			at = take();
			line = [apply(m, at)];
			lines.push(line);
			command = 'L';
		} else if (command === 'L') {
			at = take();
			line.push(apply(m, at));
		} else if (command === 'C') {
			const [p1, p2, p3] = [take(), take(), take()];
			for (let s = 1; s <= steps; s++) {
				const t = s / steps;
				const u = 1 - t;
				const point = [0, 1].map(
					(k) =>
						u * u * u * at[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * p3[k]
				);
				line.push(apply(m, point));
			}
			at = p3;
		} else if (command === 'Z') {
			line.push(line[0]);
		} else throw new Error(`unsupported path command ${command}`);
	}
	return lines;
}

function bounds(lines, pad = 0) {
	const xs = lines.flat().map(([x]) => x);
	const ys = lines.flat().map(([, y]) => y);
	return [
		Math.min(...xs) - pad,
		Math.min(...ys) - pad,
		Math.max(...xs) + pad,
		Math.max(...ys) + pad
	];
}

/** Non-zero winding: is (x, y) inside the closed polylines? */
function filled(lines, x, y) {
	let winding = 0;
	for (const line of lines) {
		for (let i = 1; i < line.length; i++) {
			const [x0, y0] = line[i - 1];
			const [x1, y1] = line[i];
			if (y0 <= y ? y1 > y : y1 <= y) {
				const cross = (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0);
				if (y1 > y0 ? cross > 0 : cross < 0) winding += y1 > y0 ? 1 : -1;
			}
		}
	}
	return winding !== 0;
}

/** Within `half` of the polylines: a stroke with round caps and joins. */
function stroked(lines, half, x, y) {
	const limit = half * half;
	for (const line of lines) {
		for (let i = 1; i < line.length; i++) {
			const [x0, y0] = line[i - 1];
			const [x1, y1] = line[i];
			const dx = x1 - x0;
			const dy = y1 - y0;
			const length = dx * dx + dy * dy;
			const t = length ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / length)) : 0;
			const ex = x - (x0 + t * dx);
			const ey = y - (y0 + t * dy);
			if (ex * ex + ey * ey <= limit) return true;
		}
	}
	return false;
}

/** Inside a square of `size` with corners rounded to `radius`. */
function inSquare(size, radius, x, y) {
	if (x < 0 || y < 0 || x > size || y > size) return false;
	if (!radius) return true;
	const cx = Math.max(radius, Math.min(size - radius, x));
	const cy = Math.max(radius, Math.min(size - radius, y));
	return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/**
 * Which shape each of a pixel's samples falls in, topmost first: for every pixel, how
 * many of its `samples` × `samples` land in the river, the spade and the square.
 */
export function coverage(icon, samples = 8) {
	const { size, radius, scale } = icon;
	const { x, y } = placement(icon);
	const group = compose(translate(x, y), scaling(scale));
	const spade = flatten(MARK.spade.d, compose(group, parseTransform(MARK.spade.transform)));
	const river = flatten(MARK.river.d, group);
	const half = (MARK.river.width * scale) / 2;
	const spadeBox = bounds(spade);
	const riverBox = bounds(river, half);
	const within = ([x0, y0, x1, y1], px, py) => px >= x0 && px <= x1 && py >= y0 && py <= y1;
	const counts = new Uint16Array(size * size * 3);
	for (let py = 0; py < size; py++) {
		for (let px = 0; px < size; px++) {
			const at = (py * size + px) * 3;
			for (let j = 0; j < samples; j++) {
				for (let i = 0; i < samples; i++) {
					const sx = px + (i + 0.5) / samples;
					const sy = py + (j + 0.5) / samples;
					if (within(riverBox, sx, sy) && stroked(river, half, sx, sy)) counts[at]++;
					else if (within(spadeBox, sx, sy) && filled(spade, sx, sy)) counts[at + 1]++;
					else if (inSquare(size, radius, sx, sy)) counts[at + 2]++;
				}
			}
		}
	}
	return { size, samples, counts };
}

/**
 * The icon as RGBA, from the same shapes as its SVG: each pixel the mean of its samples'
 * colours. `style` is for the iPhone app's icons (swift.js): without a background the
 * river cuts through the spade to nothing, and the spade may take another colour.
 */
export function rasterise(
	icon,
	c,
	samples = 8,
	style = { background: true, spade: 'gold' },
	covered = coverage(icon, samples)
) {
	const { size, counts } = covered;
	const night = rgb(c('night'));
	const colours = [
		style.background ? night : null,
		rgb(c(style.spade)),
		style.background ? night : null
	];
	const data = new Uint8Array(size * size * 4);
	for (let p = 0; p < size * size; p++) {
		let r = 0;
		let g = 0;
		let b = 0;
		let a = 0;
		for (let k = 0; k < 3; k++) {
			const n = counts[p * 3 + k];
			if (!n || !colours[k]) continue;
			r += n * colours[k][0];
			g += n * colours[k][1];
			b += n * colours[k][2];
			a += n;
		}
		const at = p * 4;
		if (a) {
			data[at] = Math.round(r / a);
			data[at + 1] = Math.round(g / a);
			data[at + 2] = Math.round(b / a);
		}
		data[at + 3] = Math.round((a * 255) / (samples * samples));
	}
	return { width: size, height: size, data };
}

/** Every icon, by its path under web/: the SVG as text, and each PNG as an RGBA image. */
export function renderIcons(palette = readPalette()) {
	const c = (name) => {
		const hex = palette.get(name);
		if (!hex) throw new Error(`no colour ${name}`);
		return hex;
	};
	const svgs = new Map();
	const images = new Map();
	for (const [path, icon] of Object.entries(ICONS)) {
		if (path.endsWith('.svg')) svgs.set(path, iconSvg(icon, c));
		else images.set(path, rasterise(icon, c));
	}
	return { svgs, images };
}

/** What the page's theme colour is: the palette's night (app.html). */
export const THEME_COLOR = () => readPalette().get('night');

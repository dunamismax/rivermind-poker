// The site's look for the iPhone app (P5D.5): the tokens of theme.css and the
// kit's colours in kit.css, every card of the deck and every sprite of the
// interface as drawing data, and the app's icons and launch colour, all written
// from the same sources as the site's own art so the two cannot drift. `pnpm art`
// writes them beside the site's art, and art.spec.ts fails on a file that drifts.
//
// The cards and sprites are not copied as SVG files. Each SVG the generators draw
// is read back here into a list of shapes (a path, a rect, a circle or an
// ellipse, with its transform, fill and stroke as SVG works them out), and that
// list is written as Swift data that RiverMindKit's `ArtView` draws natively.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderDeck, readPalette } from './deck.js';
import { ICONS, coverage, rasterise } from './icons.js';
import { renderUi } from './ui.js';
import { CONTROLS, LABELS, SURFACES, TEXT } from '../../src/styles/contrast.ts';

const WEB = resolve(import.meta.dirname, '../..');
/** Where each file goes, relative to web/. */
export const KIT = '../ios/RiverMindKit/Sources/RiverMindKit/Look';
export const ASSETS = '../ios/RiverMind/Assets.xcassets';

const HEADER =
	'// Written by `pnpm art` (web/scripts/art/swift.js) from the site’s own sources.\n' +
	'// Never edit it by hand: change the source, run `pnpm art`, and commit both.\n';

/** palette-name → paletteName, the Swift spelling. */
export const swiftName = (name) => name.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());

const number = (n) => {
	const r = Number(n.toFixed(4));
	return Number.isInteger(r) ? `${r}` : `${r}`;
};
const hex = (h) => `0x${h.slice(1).toLowerCase()}`;

// --- Tokens. ---------------------------------------------------------------------

function strip(css) {
	return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** A CSS colour as [rgb hex, opacity]: var(--color-x), #rrggbb or rgb(r g b / a). */
function colour(value, palette) {
	value = value.trim();
	let m = value.match(/^var\(--color-([a-z0-9-]+)\)$/);
	if (m) {
		if (!palette.has(m[1])) throw new Error(`no colour ${m[1]}`);
		return { name: m[1], opacity: 1 };
	}
	m = value.match(/^#([0-9a-f]{6})$/i);
	if (m) return { hex: `#${m[1].toLowerCase()}`, opacity: 1 };
	m = value.match(/^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/);
	if (m) {
		const h = '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
		return { hex: h, opacity: m[4] === undefined ? 1 : Number(m[4]) };
	}
	throw new Error(`not a colour the kit uses: ${value}`);
}

/** A colour as Swift: a palette member, or an RGB of its own, with its opacity. */
function swiftColour(c, palette) {
	const named = c.name ?? [...palette].find(([, h]) => h === c.hex)?.[0];
	const base = named ? `Palette.${swiftName(named)}` : `RGB(${hex(c.hex)})`;
	return c.opacity === 1 ? `Paint(${base})` : `Paint(${base}, opacity: ${number(c.opacity)})`;
}

/** `0 4px 14px rgb(0 0 0 / 0.35)` as a Swift Shadow. */
function shadow(value, palette) {
	const m = value.trim().match(/^0 ([\d.]+)px ([\d.]+)px (rgb\([^)]*\))$/);
	if (!m) throw new Error(`not a shadow: ${value}`);
	return `Shadow(y: ${number(Number(m[1]))}, blur: ${number(Number(m[2]))}, paint: ${swiftColour(colour(m[3], palette), palette)})`;
}

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css, selector) {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const m = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
	if (!m) throw new Error(`no rule ${selector}`);
	return new Map(
		[...m[1].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [
			k,
			v.replace(/\s+/g, ' ').trim()
		])
	);
}

export function renderTokens(palette = readPalette()) {
	const theme = strip(readFileSync(resolve(WEB, 'src/styles/theme.css'), 'utf8'));
	const kit = strip(readFileSync(resolve(WEB, 'src/styles/kit.css'), 'utf8'));
	const value = (name) => {
		const m = theme.match(new RegExp(`--${name}:\\s*([^;]+);`));
		if (!m) throw new Error(`no --${name} in theme.css`);
		return m[1].replace(/\s+/g, ' ').trim();
	};
	const px = (name) => Number(value(name).replace(/px$/, ''));
	const lines = [
		HEADER,
		'// The tokens: web/src/styles/theme.css and kit.css.',
		'',
		'import Foundation',
		''
	];

	lines.push('/// The palette (theme.css), by the site’s names.', 'public enum Palette {');
	for (const [name, h] of palette)
		lines.push(`    public static let ${swiftName(name)} = RGB(${hex(h)})`);
	lines.push('', '    /// Every colour, by the site’s name, in theme.css’s order.');
	lines.push('    public static let all: [(name: String, rgb: RGB)] = [');
	for (const [name] of palette) lines.push(`        ("${name}", ${swiftName(name)}),`);
	lines.push('    ]', '}', '');

	const contrastPairs = (pairs) => pairs.map(([a, b]) => `        ("${a}", "${b}"),`);
	lines.push(
		'/// The pairs theme.spec.ts measures (src/styles/contrast.js): text on the surfaces the',
		'/// pages use and on colours of its own (4.5:1), and controls on what they sit on (3:1).',
		'public enum ContrastPairs {',
		`    public static let surfaces = [${SURFACES.map((s) => `"${s}"`).join(', ')}]`,
		`    public static let text = [${TEXT.map((s) => `"${s}"`).join(', ')}]`,
		'    public static let labels: [(String, String)] = [',
		...contrastPairs(LABELS),
		'    ]',
		'    public static let controls: [(String, String)] = [',
		...contrastPairs(CONTROLS),
		'    ]',
		'}',
		''
	);

	lines.push(
		'/// Sizes in points, which are the site’s CSS pixels.',
		'public enum Metrics {',
		`    /// The spacing step: the kit’s sizes count in it.`,
		`    public static let step: Double = ${number(px('spacing'))}`,
		...['xs', 's', 'm', 'l', 'xl'].map(
			(s) => `    public static let text${s.toUpperCase()}: Double = ${number(px(`text-${s}`))}`
		),
		...['s', 'm', 'l'].map(
			(s) => `    public static let radius${s.toUpperCase()}: Double = ${number(px(`radius-${s}`))}`
		),
		'}',
		''
	);

	lines.push(
		'/// The soft shadows: under panels and buttons, and under text on art.',
		'public enum Shadows {',
		...[1, 2, 3].map(
			(n) => `    public static let elevation${n} = ${shadow(value(`elevation-${n}`), palette)}`
		),
		`    public static let textInk = ${shadow(value('text-shadow-ink'), palette)}`,
		`    public static let textTitle = ${shadow(value('text-shadow-title'), palette)}`,
		`    /// A faint edge round a frame.`,
		`    public static let edge = ${swiftColour(colour(value('edge'), palette), palette)}`,
		'}',
		''
	);

	const curve = (name) => {
		const m = value(name).match(/^cubic-bezier\(([^)]*)\)$/);
		if (!m) throw new Error(`--${name} is not a cubic-bezier`);
		return m[1].split(',').map((n) => number(Number(n)));
	};
	const curves = { out: curve('ease-out'), 'in-out': curve('ease-in-out') };
	lines.push(
		'/// Motion: each of the site’s animations, its length and its curve.',
		'public enum Motion {',
		...Object.entries(curves).map(
			([n, [a, b, c, d]]) =>
				`    public static let ${swiftName(`ease-${n}`)} = Curve(${a}, ${b}, ${c}, ${d})`
		)
	);
	for (const [, name, kf, seconds, ease, infinite] of theme.matchAll(
		/--animate-([a-z]+): ([a-z]+) ([\d.]+)s var\(--ease-([a-z-]+)\)( infinite)?;/g
	)) {
		lines.push(
			`    /// \`--animate-${name}\` (keyframes \`${kf}\`).`,
			`    public static let ${name} = KitAnimation(duration: ${number(Number(seconds))}, curve: ${swiftName(`ease-${ease}`)}, repeats: ${infinite ? 'true' : 'false'})`
		);
	}
	lines.push('}', '');

	// The kit's buttons and frames, as kit.css colours them.
	const btn = (selector) => {
		const r = rule(kit, selector);
		return ['bg', 'down', 'fg', 'edge'].map((k) => {
			const v = r.get(`--btn-${k}`);
			if (!v) throw new Error(`${selector} has no --btn-${k}`);
			return swiftColour(colour(v, palette), palette);
		});
	};
	const kinds = {
		slate: '.ui-btn',
		red: '.ui-btn.red',
		blue: '.ui-btn.blue',
		amber: '.ui-btn.amber',
		green: '.ui-btn.green',
		gold: '.ui-btn.gold'
	};
	const disabled = btn(
		'.ui-btn:disabled,\n.ui-btn.gold:disabled,\n.ui-btn.red:disabled,\n.ui-btn.blue:disabled,\n.ui-btn.amber:disabled,\n.ui-btn.green:disabled'
	);
	const chosen = btn(".ui-btn.choice[aria-pressed='true'],\ninput:checked + .ui-btn.choice");
	const colours = ([bg, down, fg, edge]) =>
		`ButtonColours(face: ${bg}, down: ${down}, label: ${fg}, edge: ${edge})`;
	lines.push(
		'/// The kit’s buttons (kit.css `.ui-btn`): face, face when pressed, label and edge.',
		'public enum ButtonPalette {',
		...Object.entries(kinds).map(([k, sel]) => `    public static let ${k} = ${colours(btn(sel))}`),
		`    public static let disabled = ${colours(disabled)}`,
		`    /// A choice that is the one chosen.`,
		`    public static let chosen = ${colours(chosen)}`,
		`    public static let height: Double = ${number(Number(rule(kit, '.ui-btn').get('min-height').replace('px', '')))}`,
		`    public static let smallHeight: Double = ${number(Number(rule(kit, '.ui-btn.small').get('min-height').replace('px', '')))}`,
		'}',
		''
	);

	// Frames: the surface and the ring just outside it (kit.css's frames).
	const frames = ['panel', 'raised', 'inset', 'paper', 'gold', 'glow', 'danger'];
	const base = rule(
		kit,
		'.ui-panel,\n.ui-raised,\n.ui-inset,\n.ui-paper,\n.ui-gold,\n.ui-glow,\n.ui-danger'
	);
	lines.push(
		'/// The kit’s frames (kit.css `.ui-panel` and its kin): surface, rings and shadow.',
		'public enum FramePalette {'
	);
	for (const frame of frames) {
		const own = frame === 'panel' ? new Map() : rule(kit, `.ui-${frame}`);
		const bg = own.get('background-color') ?? base.get('background-color');
		const shadows = (own.get('box-shadow') ?? base.get('box-shadow'))
			.split(/,(?![^(]*\))/)
			.map((s) => s.trim());
		const rings = [];
		let drop = 'nil';
		let inner = 'nil';
		for (const s of shadows) {
			let m = s.match(/^0 0 0 ([\d.]+)px (.+)$/);
			if (m) {
				const c = m[2] === 'var(--edge)' ? value('edge') : m[2];
				rings.push(
					`Ring(width: ${number(Number(m[1]))}, paint: ${swiftColour(colour(c, palette), palette)})`
				);
				continue;
			}
			m = s.match(/^var\(--elevation-(\d)\)$/);
			if (m) {
				drop = `Shadows.elevation${m[1]}`;
				continue;
			}
			m = s.match(/^inset (0 [\d.]+px [\d.]+px rgb\([^)]*\))$/);
			if (m) {
				inner = shadow(m[1], palette);
				continue;
			}
			throw new Error(`.ui-${frame}: a shadow the kit does not draw: ${s}`);
		}
		lines.push(
			`    public static let ${frame} = FrameColours(surface: ${swiftColour(colour(bg, palette), palette)}, rings: [${rings.join(', ')}], shadow: ${drop}, inner: ${inner})`
		);
	}
	lines.push('}', '');
	return lines.join('\n');
}

// --- Art: the SVGs the generators draw, read back into shapes. ---------------------

/** An affine map [a, b, c, d, e, f]: (x, y) → (a x + c y + e, b x + d y + f). */
const IDENTITY = [1, 0, 0, 1, 0, 0];
function compose(m, n) {
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
}
function parseTransform(text) {
	let m = IDENTITY;
	for (const [, name, args] of text.matchAll(/(translate|scale|rotate)\(([^)]*)\)/g)) {
		const n = args
			.trim()
			.split(/[\s,]+/)
			.map(Number);
		let t;
		if (name === 'translate') t = [1, 0, 0, 1, n[0], n[1] ?? 0];
		else if (name === 'scale') t = [n[0], 0, 0, n[1] ?? n[0], 0, 0];
		else {
			const a = (n[0] * Math.PI) / 180;
			const [cos, sin] = [Math.cos(a), Math.sin(a)];
			const [cx, cy] = [n[1] ?? 0, n[2] ?? 0];
			t = compose(compose([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0]), [
				1,
				0,
				0,
				1,
				-cx,
				-cy
			]);
		}
		m = compose(m, t);
	}
	return m;
}

const PAINT_ATTRS = [
	'fill',
	'fill-opacity',
	'stroke',
	'stroke-width',
	'stroke-opacity',
	'stroke-linecap',
	'stroke-linejoin',
	'stroke-dasharray'
];
/** SVG's own defaults for what a shape inherits. */
const DEFAULTS = {
	fill: '#000000',
	'fill-opacity': '1',
	stroke: 'none',
	'stroke-width': '1',
	'stroke-opacity': '1',
	'stroke-linecap': 'butt',
	'stroke-linejoin': 'miter',
	'stroke-dasharray': 'none'
};

/** The shapes of one of the generators' SVGs, painted as SVG paints them. */
export function readSvg(svg) {
	const size = svg.match(/<svg [^>]*width="([\d.]+)" height="([\d.]+)"/);
	if (!size) throw new Error('no size');
	const shapes = [];
	const stack = [{ transform: IDENTITY, paint: { ...DEFAULTS } }];
	for (const m of svg.matchAll(/<(\/?)([a-z]+)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/g)) {
		const [, closing, name, attrText, self] = m;
		if (name === 'svg' || name === 'title') continue;
		if (closing) {
			if (name === 'g') stack.pop();
			continue;
		}
		const attrs = Object.fromEntries(
			[...attrText.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v])
		);
		const top = stack.at(-1);
		const transform = attrs.transform
			? compose(top.transform, parseTransform(attrs.transform))
			: top.transform;
		const paint = { ...top.paint };
		for (const k of PAINT_ATTRS) if (attrs[k] !== undefined) paint[k] = attrs[k];
		if (name === 'g') {
			if (!self) stack.push({ transform, paint });
			continue;
		}
		let geometry;
		const n = (k) => Number(attrs[k] ?? 0);
		if (name === 'path') geometry = { path: attrs.d };
		else if (name === 'rect')
			geometry = { rect: [n('x'), n('y'), n('width'), n('height'), n('rx')] };
		else if (name === 'circle') geometry = { circle: [n('cx'), n('cy'), n('r')] };
		else if (name === 'ellipse') geometry = { ellipse: [n('cx'), n('cy'), n('rx'), n('ry')] };
		else throw new Error(`<${name}> is not drawn`);
		shapes.push({ geometry, transform, paint });
	}
	return { width: Number(size[1]), height: Number(size[2]), shapes };
}

function swiftShape({ geometry, transform, paint }, palette) {
	const g = geometry.path
		? `.path("${geometry.path}")`
		: geometry.rect
			? `.rect(${geometry.rect.map(number).join(', ')})`
			: geometry.circle
				? `.circle(${geometry.circle.map(number).join(', ')})`
				: `.ellipse(${geometry.ellipse.map(number).join(', ')})`;
	const paintOf = (h, opacity) => {
		const c = { hex: h.toLowerCase(), opacity: Number(opacity) };
		if (c.hex !== '#000000' && ![...palette.values()].includes(c.hex))
			throw new Error(`${c.hex} is off the palette`);
		return swiftColour(c, palette);
	};
	const parts = [g];
	if (transform.some((v, i) => Math.abs(v - IDENTITY[i]) > 1e-9))
		parts.push(`transform: [${transform.map(number).join(', ')}]`);
	parts.push(`fill: ${paint.fill === 'none' ? 'nil' : paintOf(paint.fill, paint['fill-opacity'])}`);
	if (paint.stroke !== 'none') {
		const dash =
			paint['stroke-dasharray'] === 'none'
				? []
				: paint['stroke-dasharray'].split(/[\s,]+/).map(Number);
		parts.push(
			`stroke: Pen(${paintOf(paint.stroke, paint['stroke-opacity'])}, width: ${number(Number(paint['stroke-width']))}, cap: .${paint['stroke-linecap']}, join: .${paint['stroke-linejoin']}${dash.length ? `, dash: [${dash.map(number).join(', ')}]` : ''})`
		);
	}
	return `ArtShape(${parts.join(', ')})`;
}

/** Every card and sprite: its name in Swift, its file and its shapes. */
export function artPieces(palette = readPalette()) {
	const pieces = [];
	for (const [path, svg] of [...renderDeck(palette), ...renderUi(palette)]) {
		const name = path
			.replace(/^.*\/(cards|ui)\//, '')
			.replace(/\.svg$/, '')
			.replace(/^faces\//, '')
			.replace(/^backs\//, 'back-');
		pieces.push({ name, path, svg, art: readSvg(svg) });
	}
	return pieces;
}

export function renderArt(palette = readPalette()) {
	const lines = [
		HEADER,
		'// The art: every card of web/scripts/art/deck.js and every sprite of ui.js, read back',
		'// from the SVG each draws into the shapes `ArtView` draws.',
		'',
		'public enum ArtLibrary {',
		'    /// Each piece by the name of its file: `14-spades`, `back-lattice-burgundy`, `slot`,',
		'    /// `chip-red`, `avatar-hard`, `emblem` and so on.',
		'    public static let pieces: [String: Art] = ['
	];
	for (const { name, art } of artPieces(palette)) {
		lines.push(
			`        "${name}": Art(width: ${number(art.width)}, height: ${number(art.height)}, shapes: [`
		);
		for (const shape of art.shapes) lines.push(`            ${swiftShape(shape, palette)},`);
		lines.push('        ]),');
	}
	lines.push('    ]', '}', '');
	return lines.join('\n');
}

// --- The app's icons and launch screen. ------------------------------------------------

/**
 * The App Store and home-screen icon at 1024, in iOS's three styles: the mark on night;
 * dark, the mark alone on nothing, for the system's dark background; and tinted, the mark
 * in white on nothing, which the system tints by its lightness.
 */
export const APP_ICON = {
	size: 1024,
	radius: 0,
	scale: (ICONS['static/apple-touch-icon.png'].scale * 1024) / 180
};
export const APP_ICON_STYLES = {
	'icon.png': { background: true, spade: 'gold' },
	'icon-dark.png': { background: false, spade: 'gold' },
	'icon-tinted.png': { background: false, spade: 'white' }
};

function json(value) {
	return JSON.stringify(value, null, 2) + '\n';
}

function colourSet(h) {
	const [r, g, b] = [1, 3, 5].map((i) => `0x${h.slice(i, i + 2).toUpperCase()}`);
	return json({
		colors: [
			{
				color: { 'color-space': 'srgb', components: { alpha: '1.000', blue: b, green: g, red: r } },
				idiom: 'universal'
			}
		],
		info: { author: 'xcode', version: 1 }
	});
}

/** The asset catalog: its files as text, and the icons as RGBA images. */
export function renderAssets(palette = readPalette(), samples = 4) {
	const c = (name) => {
		const h = palette.get(name);
		if (!h) throw new Error(`no colour ${name}`);
		return h;
	};
	const text = new Map();
	const images = new Map();
	text.set(`${ASSETS}/Contents.json`, json({ info: { author: 'xcode', version: 1 } }));
	text.set(
		`${ASSETS}/AppIcon.appiconset/Contents.json`,
		json({
			images: [
				{ filename: 'icon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
				{
					appearances: [{ appearance: 'luminosity', value: 'dark' }],
					filename: 'icon-dark.png',
					idiom: 'universal',
					platform: 'ios',
					size: '1024x1024'
				},
				{
					appearances: [{ appearance: 'luminosity', value: 'tinted' }],
					filename: 'icon-tinted.png',
					idiom: 'universal',
					platform: 'ios',
					size: '1024x1024'
				}
			],
			info: { author: 'xcode', version: 1 }
		})
	);
	const covered = coverage(APP_ICON, samples);
	for (const [file, style] of Object.entries(APP_ICON_STYLES))
		images.set(
			`${ASSETS}/AppIcon.appiconset/${file}`,
			rasterise(APP_ICON, c, samples, style, covered)
		);
	// The launch screen is the lobby's night, as Apple asks: the first screen without its content.
	text.set(`${ASSETS}/Night.colorset/Contents.json`, colourSet(c('night')));
	// The accent: system controls, alerts and the share sheet take the site's gold.
	text.set(`${ASSETS}/AccentColor.colorset/Contents.json`, colourSet(c('gold')));
	return { text, images };
}

/** Every Swift file, by its path under web/. */
export function renderSwift(palette = readPalette()) {
	return new Map([
		[`${KIT}/Tokens.swift`, renderTokens(palette)],
		[`${KIT}/ArtLibrary.swift`, renderArt(palette)]
	]);
}

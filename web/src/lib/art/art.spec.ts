// The site's art (P5C.3, P5C.4): the committed SVG files are exactly what the
// generators draw, each is well-formed XML with nothing in it but drawing (no
// script, style or external reference), every colour is on the palette, every
// face shows its own rank and suit, every back is the same upside down, and the
// icons are the mark.
import { readFileSync, readdirSync } from 'node:fs';
import { relative } from 'node:path';
import { expect, test } from 'vitest';
import {
	CARD_BACKS,
	CARD_RANKS,
	CARD_SIZE,
	DEFAULT_BACK,
	allCardUrls,
	cardBackPath,
	cardFacePath,
	tableCardUrls
} from '../card-assets.ts';
import type { Suit } from '../protocol.ts';

type Deck = {
	renderDeck: () => Map<string, string>;
	readPalette: () => Map<string, string>;
	printed: (rank: number) => string;
	cardTitle: (rank: number, suit: string) => string;
	rankWidth: (rank: number) => number;
	CARD_W: number;
	CARD_H: number;
	BACKS: string[];
	DIR: string;
	PIPS: Record<Suit, string>;
	GLYPHS: Record<string, [number, string]>;
	LAYOUT: { rank: { x: number } };
};
// The generator is plain JavaScript, loaded by URL so svelte-check does not type-check it.
const deck = (await import(
	/* @vite-ignore */ new URL('../../../scripts/art/deck.js', import.meta.url).href
)) as Deck;
const ui = (await import(
	/* @vite-ignore */ new URL('../../../scripts/art/ui.js', import.meta.url).href
)) as { renderUi: () => Map<string, string>; DIR: string };

const WEB = new URL('../../../', import.meta.url);
const files = deck.renderDeck();
const sprites = ui.renderUi();
const palette = deck.readPalette();
const suits: Suit[] = ['spades', 'hearts', 'diamonds', 'clubs'];
const read = (path: string) => readFileSync(new URL(path, WEB), 'utf8');

/**
 * A strict check of the little XML the deck uses: elements with quoted
 * attributes, text and comments, every element closed in order, one root.
 * Throws on anything else.
 */
function checkXml(text: string): string[] {
	const stack: string[] = [];
	const names: string[] = [];
	let roots = 0;
	const token =
		/<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
	for (const m of text.matchAll(token)) {
		const [, closing, name, , selfClosing, chars, stray] = m;
		if (stray) throw new Error(`stray < at ${m.index}`);
		if (chars !== undefined) {
			if (stack.length === 0 && chars.trim()) throw new Error('text outside the root');
			if (/&(?!(amp|lt|gt|quot|apos);)/.test(chars)) throw new Error('bad entity');
			continue;
		}
		if (!name) continue;
		if (closing) {
			if (stack.pop() !== name) throw new Error(`</${name}> closes the wrong element`);
			continue;
		}
		if (stack.length === 0) roots++;
		names.push(name);
		if (!selfClosing) stack.push(name);
	}
	if (stack.length) throw new Error(`unclosed ${stack.join(', ')}`);
	if (roots !== 1) throw new Error(`${roots} root elements`);
	return names;
}

test('the committed art matches its generators, and holds nothing else', () => {
	expect(files.size).toBe(52 + deck.BACKS.length + 1);
	for (const [dir, made] of [
		[deck.DIR, files],
		[ui.DIR, sprites]
	] as const) {
		for (const [path, svg] of made) expect(read(path), path).toBe(svg);
		const committed = readdirSync(new URL(`${dir}/`, WEB), { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => relative(WEB.pathname, `${entry.parentPath}/${entry.name}`));
		expect(committed.sort()).toEqual([...made.keys()].sort());
	}
});

test('every file is well-formed SVG of drawing alone, on the palette', () => {
	const allowed = new Set(['svg', 'title', 'g', 'path', 'rect', 'circle', 'ellipse']);
	const colours = new Set(palette.values());
	for (const [path, svg] of [...files, ...sprites]) {
		const names = checkXml(svg);
		expect(names[0], path).toBe('svg');
		for (const name of names) expect(allowed.has(name), `${path}: <${name}>`).toBe(true);
		expect(svg, path).not.toMatch(/<script|<style|style=|href|url\(|@import|<image|foreignObject/i);
		expect(svg, path).not.toMatch(/\son\w+=/i);
		// The namespace is the only address in a file, and it is never fetched.
		expect(svg.match(/https?:\/\/[^"]*/g), path).toEqual(['http://www.w3.org/2000/svg']);
		for (const hex of svg.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])
			expect(colours.has(hex), `${path}: ${hex} is off the palette`).toBe(true);
		if (files.has(path))
			expect(svg, path).toContain(
				`width="${CARD_SIZE.width}" height="${CARD_SIZE.height}" viewBox="0 0 ${CARD_SIZE.width} ${CARD_SIZE.height}"`
			);
	}
});

test('there is a sprite for every sprite class, drawn at the size the kit gives it', () => {
	const css = read('src/styles/sprites.css');
	const named = [...css.matchAll(/url\('\.\.\/lib\/art\/ui\/([a-z0-9-]+)\.svg'\)/g)].map(
		([, n]) => n
	);
	const drawn = [...sprites.keys()].map((path) => path.split('/').pop()!.replace('.svg', ''));
	expect(drawn.sort()).toEqual([...new Set(named)].sort());
	// kit.css: 11 × 11 spacing steps for a chip, the dealer button and a voice glyph, and so on, at 2px each.
	const size = (name: string) =>
		name.startsWith('avatar-')
			? [32, 32]
			: name === 'pot'
				? [58, 32]
				: name === 'emblem'
					? [30, 34]
					: name === 'mini-cards'
						? [28, 26]
						: [22, 22];
	for (const [path, svg] of sprites) {
		const [w, h] = size(path.split('/').pop()!.replace('.svg', ''));
		expect(svg, path).toContain(`width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"`);
	}
});

test('every face shows its own rank and suit', () => {
	for (const suit of suits) {
		const colour = palette.get(`suit-${suit}`);
		expect(colour).toBeDefined();
		for (const rank of CARD_RANKS) {
			const path = `${deck.DIR}/faces/${rank}-${suit}.svg`;
			const svg = files.get(path) ?? '';
			expect(svg, path).toContain(`<title>${deck.cardTitle(rank, suit)}</title>`);
			// The rank: the glyphs of its printed form, in order, in the suit's colour.
			const rankGroup = svg.match(/<g class="rank"[^>]*>([\s\S]*?)<\/g>\n/)?.[1] ?? '';
			expect(svg, path).toContain(`<g class="rank" fill="none" stroke="${colour}"`);
			const drawn = [...rankGroup.matchAll(/<g transform="[^"]*">([\s\S]*?)<\/g>/g)].map(
				([, markup]) => markup
			);
			expect(drawn, path).toEqual([...deck.printed(rank)].map((g) => deck.GLYPHS[g][1]));
			// Two pips of the suit's own shape and colour, and no other suit's.
			const pips = [...svg.matchAll(/<g class="pip" fill="([^"]*)"[^>]*>([\s\S]*?)<\/g>/g)];
			expect(
				pips.map(([, fill]) => fill),
				path
			).toEqual([colour, colour]);
			for (const [, , shape] of pips) expect(shape, path).toBe(deck.PIPS[suit]);
			for (const other of suits.filter((s) => s !== suit))
				expect(svg, path).not.toContain(palette.get(`suit-${other}`));
		}
	}
	expect(deck.printed(10)).toBe('10');
	expect(deck.printed(14)).toBe('A');
});

test('the ten keeps its two digits clear of the edge and of the large pip', () => {
	const svg = files.get(`${deck.DIR}/faces/10-hearts.svg`) ?? '';
	const first = Number(svg.match(/<g class="rank"[^>]*><g transform="translate\(([\d.]+)/)?.[1]);
	// The stroke's left edge, and the right edge of the second digit.
	const left = first - 2.2;
	const right = left + deck.rankWidth(10);
	expect(left).toBeGreaterThanOrEqual(3);
	expect(right).toBeLessThanOrEqual(deck.CARD_W / 2);
	for (const rank of CARD_RANKS) expect(deck.rankWidth(rank)).toBeLessThanOrEqual(31);
});

test('the deck maps every card to its own face, and the backs are distinct', () => {
	const urls = suits.flatMap((suit) => CARD_RANKS.map((rank) => cardFacePath({ rank, suit })));
	expect(new Set(urls).size).toBe(52);
	expect(new Set(CARD_BACKS.map((b) => cardBackPath(b))).size).toBe(CARD_BACKS.length);
	expect(DEFAULT_BACK).toBe('lattice-burgundy');
	expect(cardBackPath()).toBe(cardBackPath('lattice-burgundy'));
	// 52 faces, the backs and the slot; a table fetches the faces, one back and the slot.
	expect(allCardUrls()).toHaveLength(52 + CARD_BACKS.length + 1);
	expect(tableCardUrls()).toHaveLength(54);
	expect(tableCardUrls('lattice-navy')).toContain(cardBackPath('lattice-navy'));
});

test('every back is the same after a half turn', () => {
	expect(deck.BACKS).toEqual([...CARD_BACKS]);
	const cx = deck.CARD_W / 2;
	const cy = deck.CARD_H / 2;
	for (const name of deck.BACKS) {
		const svg = files.get(`${deck.DIR}/backs/${name}.svg`) ?? '';
		for (const [, x, y, w, h] of svg.matchAll(
			/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g
		)) {
			expect(Number(x) + Number(w) / 2, name).toBeCloseTo(cx, 6);
			expect(Number(y) + Number(h) / 2, name).toBeCloseTo(cy, 6);
		}
		// The lattice: each diamond's top point, turned about the centre, is another's bottom point.
		const d = svg.match(/<path d="([^"]*)"/)?.[1] ?? '';
		const tops = [...d.matchAll(/M([\d.]+) ([\d.]+)/g)].map(([, x, y]) => [Number(x), Number(y)]);
		expect(tops.length, name).toBeGreaterThan(0);
		const key = ([x, y]: number[]) => `${x.toFixed(2)},${y.toFixed(2)}`;
		const bottoms = new Set(tops.map(([x, y]) => key([x, y + 12])));
		for (const [x, y] of tops) expect(bottoms.has(key([2 * cx - x, 2 * cy - y])), name).toBe(true);
		expect(svg).toContain('<title>Face-down card</title>');
	}
});

// The site's icons (P5C.4, P5C.7): the mark on night.
type Raster = { width: number; height: number; data: Uint8Array };
const icons = (await import(
	/* @vite-ignore */ new URL('../../../scripts/art/icons.js', import.meta.url).href
)) as {
	ICONS: Record<string, { size: number; radius: number; scale: number }>;
	renderIcons: () => { svgs: Map<string, string>; images: Map<string, Raster> };
};
const { decodePng } = (await import(
	/* @vite-ignore */ new URL('../../../scripts/art/png.js', import.meta.url).href
)) as { decodePng: (png: Uint8Array) => Raster };

test('the icons are the mark, drawn as their generator draws them, and the page names them', () => {
	const { svgs, images } = icons.renderIcons();
	expect([...svgs.keys(), ...images.keys()].sort()).toEqual(Object.keys(icons.ICONS).sort());
	// Nothing else is in static/ but robots.txt.
	expect(readdirSync(new URL('static/', WEB)).sort()).toEqual(
		[...Object.keys(icons.ICONS).map((p) => p.replace('static/', '')), 'robots.txt'].sort()
	);
	const colours = new Set(palette.values());
	for (const [path, svg] of svgs) {
		expect(read(path), `${path} is stale: run pnpm art`).toBe(svg);
		const names = checkXml(svg);
		for (const name of names)
			expect(['svg', 'rect', 'g', 'path'], `${path}: <${name}>`).toContain(name);
		expect(svg).not.toMatch(/<script|<style|style=|href|url\(|<image|foreignObject|\son\w+=/i);
		for (const hex of svg.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])
			expect(colours.has(hex), hex).toBe(true);
		// The same two shapes as the mark the header shows.
		const mark = sprites.get(`${ui.DIR}/emblem.svg`) ?? '';
		for (const shape of mark.match(/<path [^>]*\/>/g) ?? []) expect(svg).toContain(shape);
	}
	const night = palette.get('night')!;
	const gold = palette.get('gold')!;
	const rgba = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255);
	for (const [path, image] of images) {
		const committed = decodePng(new Uint8Array(readFileSync(new URL(path, WEB))));
		expect(committed, `${path} is stale: run pnpm art`).toEqual(image);
		const { size, radius } = icons.ICONS[path];
		expect([image.width, image.height]).toEqual([size, size]);
		const at = (x: number, y: number) => [
			...image.data.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)
		];
		// Night at the edge (or nothing, where the corner is rounded), gold in the spade's lobes.
		expect(at(0, 0)).toEqual(radius ? [0, 0, 0, 0] : rgba(night));
		expect(at(size >> 1, 1)).toEqual(rgba(night));
		expect(at(Math.round(size * 0.34), Math.round(size * 0.66))).toEqual(rgba(gold));
		expect(at(Math.round(size * 0.66), Math.round(size * 0.66))).toEqual(rgba(gold));
	}
	// The page's head: the SVG first, the PNG for browsers without SVG icons, the home-screen
	// icon, and a theme colour that is the palette's night.
	const head = read('src/app.html');
	expect(head).toContain(
		'<link rel="icon" type="image/svg+xml" href="%sveltekit.assets%/favicon.svg" />'
	);
	expect(head).toContain(
		'<link rel="icon" type="image/png" sizes="48x48" href="%sveltekit.assets%/favicon.png" />'
	);
	expect(head).toContain(
		'<link rel="apple-touch-icon" href="%sveltekit.assets%/apple-touch-icon.png" />'
	);
	expect(head).toContain(`<meta name="theme-color" content="${night}" />`);
});

// The iPhone app's look (P5D.5): its tokens and art in Swift and its asset catalog are
// what scripts/art/swift.js writes from the same sources, and the catalog holds nothing else.
const swift = (await import(
	/* @vite-ignore */ new URL('../../../scripts/art/swift.js', import.meta.url).href
)) as {
	ASSETS: string;
	renderSwift: () => Map<string, string>;
	renderAssets: () => { text: Map<string, string>; images: Map<string, Raster> };
	artPieces: () => { name: string; svg: string }[];
};

test("the iPhone app's tokens, art and icons are what pnpm art writes", () => {
	for (const [path, text] of swift.renderSwift())
		expect(read(path), `${path} is stale: run pnpm art`).toBe(text);
	const { text, images } = swift.renderAssets();
	for (const [path, json] of text) expect(read(path), `${path} is stale: run pnpm art`).toBe(json);
	for (const [path, image] of images) {
		const committed = decodePng(new Uint8Array(readFileSync(new URL(path, WEB))));
		expect(committed, `${path} is stale: run pnpm art`).toEqual(image);
		expect([image.width, image.height]).toEqual([1024, 1024]);
	}
	const catalog = new URL(`${swift.ASSETS}/`, WEB);
	const committed = readdirSync(catalog, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(WEB.pathname, `${entry.parentPath}/${entry.name}`));
	expect(committed.sort()).toEqual([...text.keys(), ...images.keys()].sort());
	// Every card and every sprite, once each.
	const names = swift.artPieces().map((piece) => piece.name);
	expect(new Set(names).size).toBe(files.size + sprites.size);
	// The default icon is the mark on night, edge to edge; the dark and tinted ones are the
	// mark alone, on nothing.
	const icon = (name: string) => images.get(`${swift.ASSETS}/AppIcon.appiconset/${name}`)!;
	const pixel = (image: Raster, x: number, y: number) => [
		...image.data.subarray((y * 1024 + x) * 4, (y * 1024 + x) * 4 + 4)
	];
	const rgba = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255);
	expect(pixel(icon('icon.png'), 0, 0)).toEqual(rgba(palette.get('night')!));
	expect(pixel(icon('icon-dark.png'), 0, 0)).toEqual([0, 0, 0, 0]);
	expect(pixel(icon('icon-tinted.png'), 0, 0)).toEqual([0, 0, 0, 0]);
	expect(pixel(icon('icon.png'), 348, 676)).toEqual(rgba(palette.get('gold')!));
	expect(pixel(icon('icon-dark.png'), 348, 676)).toEqual(rgba(palette.get('gold')!));
	expect(pixel(icon('icon-tinted.png'), 348, 676)).toEqual(rgba(palette.get('white')!));
}, 30_000);

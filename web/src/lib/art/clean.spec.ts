// The clean look's deck (P5C.3): the committed SVG files are exactly what the
// generator draws, each is well-formed XML with nothing in it but drawing (no
// script, style or external reference), every colour is on the clean palette,
// every face shows its own rank and suit, and every back is the same upside down.
import { readFileSync, readdirSync } from 'node:fs';
import { relative } from 'node:path';
import { expect, test } from 'vitest';
import { CARD_RANKS, CARD_SIZE, CLEAN_CARD_BACKS } from '../card-assets.ts';
import type { Suit } from '../protocol.ts';

type Deck = {
	renderDeck: () => Map<string, string>;
	cleanPalette: () => Map<string, string>;
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
	/* @vite-ignore */ new URL('../../../scripts/clean-art/deck.js', import.meta.url).href
)) as Deck;
const ui = (await import(
	/* @vite-ignore */ new URL('../../../scripts/clean-art/ui.js', import.meta.url).href
)) as { renderUi: () => Map<string, string>; DIR: string };

const WEB = new URL('../../../', import.meta.url);
const files = deck.renderDeck();
const sprites = ui.renderUi();
const palette = deck.cleanPalette();
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

test('the committed clean art matches its generators, and holds nothing else', () => {
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

test('every file is well-formed SVG of drawing alone, on the clean palette', () => {
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
			expect(colours.has(hex), `${path}: ${hex} is off the clean palette`).toBe(true);
		if (files.has(path))
			expect(svg, path).toContain(
				`width="${CARD_SIZE.width}" height="${CARD_SIZE.height}" viewBox="0 0 ${CARD_SIZE.width} ${CARD_SIZE.height}"`
			);
	}
});

test('there is a clean sprite for every pixel sprite, drawn at the size the shared kit gives it', () => {
	const pixel = readdirSync(new URL('src/lib/art/ui/', WEB))
		.filter((name) => name.endsWith('.png'))
		.map((name) => name.replace('.png', ''))
		// What the clean look draws in CSS instead: the frames, buttons, the caret, the
		// table and the wallpaper (P5C.2).
		.filter((name) => !/^(frame|button)-|^(caret|table|wallpaper)$/.test(name));
	const clean = [...sprites.keys()].map((path) => path.split('/').pop()!.replace('.svg', ''));
	expect(clean.sort()).toEqual(pixel.sort());
	// kit.css: 11 × 11 art pixels for a chip, the dealer button and a voice glyph, and so on, at 2px each.
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
	// And the clean stylesheet puts each one behind its class.
	const css = read('src/styles/clean-sprites.css');
	for (const name of clean) expect(css, name).toContain(`url('../lib/art/clean/ui/${name}.svg')`);
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

test('every back is the same after a half turn', () => {
	expect(deck.BACKS).toEqual([...CLEAN_CARD_BACKS]);
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

import { readFileSync, readdirSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
	CARD_BACKS,
	CARD_SIZE,
	DEFAULT_BACK,
	allCardUrls,
	cardBackPath,
	cardFacePath,
	tableCardUrls
} from '../card-assets.ts';
import type { Suit } from '../protocol.ts';

// The generator is plain JavaScript, loaded by URL so svelte-check does not
// type-check it.
type Bytes = Uint8Array;
type Image = { width: number; height: number; data: Bytes };
const load = async <T>(path: string): Promise<T> =>
	(await import(/* @vite-ignore */ new URL(path, import.meta.url).href)) as T;

const WEB = new URL('../../../', import.meta.url);
const suits: Suit[] = ['spades', 'hearts', 'diamonds', 'clubs'];
const ranks = Array.from({ length: 13 }, (_, i) => i + 2);

// Rendering every file is a few seconds of CPU, and several times that on a busy machine.
const RENDER = { timeout: 60_000 };

test('the committed art matches its sources', RENDER, async () => {
	const { renderAll } = await load<{ renderAll: () => Map<string, Bytes> }>(
		'../../../scripts/pixel-art/render.js'
	);
	const { decodePng } = await load<{ decodePng: (png: Bytes) => Image }>(
		'../../../scripts/pixel-art/png.js'
	);
	const { woffTables } = await load<{ woffTables: (woff: Bytes) => Map<string, Bytes> }>(
		'../../../scripts/pixel-art/woff.js'
	);
	const files = renderAll();
	expect(files.size).toBeGreaterThan(110);
	for (const [path, bytes] of files) {
		const committed = new Uint8Array(readFileSync(new URL(path, WEB)));
		const stale = `${path} is stale: run pnpm art`;
		// Compare what the files hold, not zlib's bytes, which can vary by version.
		if (path.endsWith('.png')) {
			expect(decodePng(committed), stale).toEqual(decodePng(bytes));
		} else if (path.endsWith('.woff')) {
			expect(woffTables(committed), stale).toEqual(woffTables(bytes));
		} else {
			expect(new TextDecoder().decode(committed), stale).toBe(new TextDecoder().decode(bytes));
		}
	}
	// The site bundles every card file, so only the generated ones may be there.
	const cards = readdirSync(new URL('src/lib/art/cards/', WEB), { recursive: true })
		.map(String)
		.filter((p) => p.endsWith('.png'))
		.map((p) => `src/lib/art/cards/${p}`);
	expect(cards.sort()).toEqual([...files.keys()].filter((p) => p.includes('/cards/')).sort());
});

test('the drawn art is on the palette and the slot is card-sized', async () => {
	const { renderImages } = await load<{
		renderImages: () => Map<string, { width: number; height: number; cells: (string | null)[] }>;
	}>('../../../scripts/pixel-art/render.js');
	const { PALETTE } = await load<{ PALETTE: Map<string, number[]> }>(
		'../../../scripts/pixel-art/canvas.js'
	);
	for (const [path, canvas] of renderImages()) {
		for (const cell of canvas.cells) if (cell !== null) expect(PALETTE.has(cell), path).toBe(true);
		if (path.includes('/cards/')) expect([canvas.width, canvas.height], path).toEqual([71, 95]);
	}
});

test("the theme offers the palette, the font and the kit's sizes, and nothing of Tailwind's own", async () => {
	const { themeCss, ART_PIXEL, TEXT_SIZES, FONT_FAMILY } = await load<{
		themeCss: () => string;
		ART_PIXEL: number;
		TEXT_SIZES: Record<string, number>;
		FONT_FAMILY: string;
	}>('../../../scripts/pixel-art/render.js');
	const { PALETTE } = await load<{ PALETTE: Map<string, number[]> }>(
		'../../../scripts/pixel-art/canvas.js'
	);
	const css = themeCss();
	// The committed file is the generated one (the first test compares every generated file).
	expect(readFileSync(new URL('src/lib/art/theme.css', WEB), 'utf8')).toBe(css);
	// One static block that first clears Tailwind's default theme.
	expect(css.match(/@theme[^{]*\{/g)).toEqual(['@theme static {']);
	expect(css.indexOf('--*: initial;')).toBeLessThan(css.indexOf('--color-'));
	// Every palette color, in order, and no other.
	const hex = (rgb: number[]) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
	expect(
		[...css.matchAll(/--color-([a-z-]+): (#[0-9a-f]{6});/g)].map(([, n, h]) => [n, h])
	).toEqual([...PALETTE].map(([name, rgb]) => [name.replace(/ /g, '-'), hex(rgb)]));
	expect(css.match(/#[0-9a-f]{3,8}\b/g)).toHaveLength(PALETTE.size);
	// Spacing counts whole art pixels; text is 15px or a multiple of 10px.
	expect(ART_PIXEL).toBe(2);
	expect(css).toContain(`--spacing: ${ART_PIXEL}px;`);
	const sizes = [...css.matchAll(/--text-([a-z]+): (\d+)px;/g)].map(([, n, px]) => [n, Number(px)]);
	expect(sizes).toEqual(Object.entries(TEXT_SIZES));
	for (const [, px] of sizes) expect(px === 15 || (px as number) % 10 === 0).toBe(true);
	expect(css).toContain(`--font-pixel: ${FONT_FAMILY};`);
});

test('the deck is 52 faces and the backs, each 71 × 95 with hard edges', RENDER, async () => {
	const { renderDeck } = await load<{ renderDeck: () => Map<string, Image> }>(
		'../../../scripts/pixel-art/cards.js'
	);
	const deck = renderDeck();
	expect([...deck.keys()].filter((p) => p.startsWith('cards/faces/'))).toHaveLength(52);
	expect([...deck.keys()].filter((p) => p.startsWith('cards/backs/')).sort()).toEqual(
		CARD_BACKS.map((b) => `cards/backs/${b}.png`).sort()
	);
	for (const [path, image] of deck) {
		expect([image.width, image.height], path).toEqual([CARD_SIZE.width, CARD_SIZE.height]);
		for (let i = 3; i < image.data.length; i += 4) {
			if (image.data[i] !== 0 && image.data[i] !== 255) expect.fail(`${path} has soft alpha`);
		}
	}
});

test('the deck maps every card to its own face', () => {
	const urls = suits.flatMap((suit) => ranks.map((rank) => cardFacePath({ rank, suit })));
	expect(new Set(urls).size).toBe(52);
});

test('the backs are distinct, with the classic red as the default', () => {
	expect(new Set(CARD_BACKS.map((b) => cardBackPath(b))).size).toBe(CARD_BACKS.length);
	expect(DEFAULT_BACK).toBe('classic-red');
	expect(cardBackPath()).toBe(cardBackPath('classic-red'));
	// 52 faces, the backs and the slot; a table fetches the faces, one back and the slot.
	expect(allCardUrls()).toHaveLength(52 + CARD_BACKS.length + 1);
	expect(tableCardUrls()).toHaveLength(54);
	expect(tableCardUrls('nebula')).toContain(cardBackPath('nebula'));
});

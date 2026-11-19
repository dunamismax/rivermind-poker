import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
	CARD_BACKS,
	CARD_TREATMENTS,
	allCardUrls,
	cardBackPath,
	cardFacePath
} from '../card-assets.ts';
import type { Suit } from '../protocol.ts';

// The generator is plain JavaScript, loaded by URL so svelte-check does not
// type-check it.
type Bytes = Uint8Array;
const load = async <T>(path: string): Promise<T> =>
	(await import(/* @vite-ignore */ new URL(path, import.meta.url).href)) as T;

const WEB = new URL('../../../', import.meta.url);
const suits: Suit[] = ['spades', 'hearts', 'diamonds', 'clubs'];
const ranks = Array.from({ length: 13 }, (_, i) => i + 2);

test('the committed art matches its sources', async () => {
	const { renderAll } = await load<{ renderAll: () => Map<string, Bytes> }>(
		'../../../scripts/pixel-art/render.js'
	);
	const { decodePng } = await load<{
		decodePng: (png: Bytes) => { width: number; height: number; data: Bytes };
	}>('../../../scripts/pixel-art/png.js');
	const { woffTables } = await load<{ woffTables: (woff: Bytes) => Map<string, Bytes> }>(
		'../../../scripts/pixel-art/woff.js'
	);
	const files = renderAll();
	expect(files.size).toBeGreaterThan(120);
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
});

test('every pixel is on the palette and every card is 33 × 45', async () => {
	const { renderImages } = await load<{
		renderImages: () => Map<string, { width: number; height: number; cells: (string | null)[] }>;
	}>('../../../scripts/pixel-art/render.js');
	const { PALETTE } = await load<{ PALETTE: Map<string, number[]> }>(
		'../../../scripts/pixel-art/canvas.js'
	);
	for (const [path, canvas] of renderImages()) {
		for (const cell of canvas.cells) if (cell !== null) expect(PALETTE.has(cell), path).toBe(true);
		if (path.includes('/cards/')) expect([canvas.width, canvas.height], path).toEqual([33, 45]);
	}
});

test('the backs look the same turned 180°', async () => {
	const { back } = await load<{
		back: (name: string) => { width: number; height: number; cells: (string | null)[] };
	}>('../../../scripts/pixel-art/cards.js');
	for (const name of CARD_BACKS) {
		const { cells } = back(name);
		expect(cells, name).toEqual([...cells].reverse());
	}
});

test.each(CARD_TREATMENTS)('%s maps the full deck to 52 distinct faces', (treatment) => {
	const urls = suits.flatMap((suit) =>
		ranks.map((rank) => cardFacePath({ rank, suit }, treatment))
	);
	expect(new Set(urls).size).toBe(52);
});

test('the three backs are distinct, with RiverMind as the default', () => {
	expect(new Set(CARD_BACKS.map((b) => cardBackPath(b))).size).toBe(3);
	expect(cardBackPath()).toBe(cardBackPath('rivermind'));
	// 52 standard faces, 26 four-colour clubs and diamonds, 3 backs and the slot.
	expect(allCardUrls()).toHaveLength(82);
});

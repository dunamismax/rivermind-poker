import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import type { Suit } from './protocol.ts';
import { CARD_BACKS, CARD_TREATMENTS, cardBackPath, cardFacePath } from './card-assets.ts';

const suits: Suit[] = ['spades', 'hearts', 'diamonds', 'clubs'];
const ranks = Array.from({ length: 13 }, (_, i) => i + 2);

test.each(CARD_TREATMENTS)('%s maps the full deck to 52 distinct SVG faces', (treatment) => {
	const paths = suits.flatMap((suit) =>
		ranks.map((rank) => cardFacePath({ rank, suit }, treatment))
	);

	expect(new Set(paths).size).toBe(52);
	for (const path of paths) {
		expect(readFileSync(new URL(`../../static/${path}`, import.meta.url), 'utf8')).toMatch(
			/^<svg /
		);
	}
});

test('the three backs have distinct SVGs, with RiverMind as the default', () => {
	const artwork = CARD_BACKS.map((back) =>
		readFileSync(new URL(`../../static/${cardBackPath(back)}`, import.meta.url), 'utf8')
	);
	expect(new Set(artwork).size).toBe(3);
	expect(artwork.every((svg) => svg.startsWith('<svg '))).toBe(true);
	expect(cardBackPath()).toBe(cardBackPath('rivermind'));
});

test('the committed SVGs match the generator', async () => {
	// Loaded by URL so svelte-check does not type-check the untyped generator scripts.
	const generator = new URL('../../scripts/card-art/render.js', import.meta.url).href;
	const { renderCardSvgs } = (await import(/* @vite-ignore */ generator)) as {
		renderCardSvgs: () => Map<string, string>;
	};
	const assets = renderCardSvgs();
	expect(assets.size).toBe(81); // 52 standard, 26 four-colour clubs and diamonds, 3 backs
	for (const [path, svg] of assets) {
		const committed = readFileSync(new URL(`../../static/${path}`, import.meta.url), 'utf8');
		expect(committed, `${path} is stale: run pnpm cards`).toBe(svg);
	}
});

test('every card SVG is self-contained, licensed and free of styles and scripts', async () => {
	const generator = new URL('../../scripts/card-art/render.js', import.meta.url).href;
	const { renderCardSvgs } = (await import(/* @vite-ignore */ generator)) as {
		renderCardSvgs: () => Map<string, string>;
	};
	for (const [path, svg] of renderCardSvgs()) {
		expect(svg, path).toContain('SPDX-License-Identifier: GPL-3.0-or-later');
		// The site CSP blocks inline styles and scripts; fonts and images would also be fetched.
		expect(svg, path).not.toMatch(
			/<style|\sstyle=|<script|\son[a-z]+=|<text|<image|<foreignObject|@import/i
		);
		// The only URL is the SVG namespace; every reference points inside the file.
		expect(svg.replaceAll('http://www.w3.org/2000/svg', ''), path).not.toMatch(/https?:|data:/);
		const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
		expect(new Set(ids).size, `${path} repeats an id`).toBe(ids.length);
		for (const [, ref] of svg.matchAll(/(?:href="#|url\(#)([^")]+)/g)) {
			expect(ids, `${path} refers to a missing #${ref}`).toContain(ref);
		}
		expect(svg.length, `${path} is too large for phones`).toBeLessThan(25_000);
	}
});

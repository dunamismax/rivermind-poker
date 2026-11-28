// The iPhone app's reference for the site's art (P5D.5): every card and sprite as
// Chromium draws its SVG, at 2 and 3 device pixels per CSS pixel, in one sheet per
// scale, for RiverMindKit's ArtParityTests to compare its own drawing with. The
// sheet's index (art.json) records each piece's place and the SHA-256 of the SVG it
// was drawn from.
//
// This test fails while the committed index names an SVG that has since changed.
// `pnpm ios:fixtures` draws the sheets again (it starts Chromium); a change to the art
// is drawn again with it, in the same commit.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { expect, test } from 'vitest';

type Piece = { name: string; svg: string; art: { width: number; height: number } };
const swift = (await import(
	/* @vite-ignore */ new URL('../../../scripts/art/swift.js', import.meta.url).href
)) as { artPieces: () => Piece[] };

const FIXTURES = new URL('../../../../ios/RiverMindKit/Fixtures/', import.meta.url);
const INDEX = new URL('art.json', FIXTURES);
const CELL = { width: 72, height: 96 };
const COLUMNS = 12;
const SCALES = [2, 3];

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function index(pieces: Piece[]) {
	return {
		note: 'Written by pnpm ios:fixtures (web/src/lib/art/ios-art.spec.ts). Never edit by hand.',
		cell: CELL,
		columns: COLUMNS,
		scales: SCALES,
		pieces: pieces.map((piece, i) => ({
			name: piece.name,
			x: (i % COLUMNS) * CELL.width,
			y: Math.floor(i / COLUMNS) * CELL.height,
			width: piece.art.width,
			height: piece.art.height,
			sha256: sha256(piece.svg)
		}))
	};
}

/** The sheet as a page: each SVG as an image at its own size, in its cell. */
function page(pieces: Piece[], layout: ReturnType<typeof index>) {
	const images = layout.pieces
		.map((spot, i) => {
			const data = Buffer.from(pieces[i].svg).toString('base64');
			return `<img src="data:image/svg+xml;base64,${data}" width="${spot.width}" height="${spot.height}" style="position:absolute;left:${spot.x}px;top:${spot.y}px" alt="">`;
		})
		.join('');
	return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}</style><body>${images}`;
}

test('the art reference is drawn from the art as it is now', async () => {
	const pieces = swift.artPieces();
	const layout = index(pieces);
	const text = JSON.stringify(layout, null, '\t') + '\n';
	if (process.env.IOS_FIXTURES === 'write') {
		const rows = Math.ceil(pieces.length / COLUMNS);
		const browser = await chromium.launch();
		try {
			for (const scale of SCALES) {
				const context = await browser.newContext({
					viewport: { width: COLUMNS * CELL.width, height: rows * CELL.height },
					deviceScaleFactor: scale
				});
				const tab = await context.newPage();
				await tab.setContent(page(pieces, layout));
				await tab.evaluate(() => Promise.all([...document.images].map((image) => image.decode())));
				const png = await tab.screenshot({ omitBackground: true, fullPage: true });
				writeFileSync(new URL(`art@${scale}x.png`, FIXTURES), png);
				await context.close();
			}
		} finally {
			await browser.close();
		}
		writeFileSync(INDEX, text);
	}
	expect(readFileSync(INDEX, 'utf8'), 'the art reference is stale: run pnpm ios:fixtures').toBe(
		text
	);
}, 60_000);

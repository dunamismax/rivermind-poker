// Writes the site's pixel art (see scripts/pixel-art/render.js) and removes
// any card image it no longer makes. With --preview DIR it also writes
// contact sheets there for review: every card, every interface sprite and a
// font specimen, at 1x and 4x (the cards also at 2x).
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { Canvas, PALETTE } from './pixel-art/canvas.js';
import { BACKS, CARD_H, CARD_W, RANKS, SUITS, slot } from './pixel-art/cards.js';
import { decodePng, encodePng } from './pixel-art/png.js';
import { loadFont, renderAll, renderImages } from './pixel-art/render.js';

const WEB = resolve(import.meta.dirname, '..');
const files = renderAll();
for (const [path, bytes] of files) {
	const target = resolve(WEB, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, bytes);
}
console.log(`Wrote ${files.size} files.`);

// The site bundles every PNG under src/lib/art/cards/, so nothing else may stay there.
const cardsDir = resolve(WEB, 'src/lib/art/cards');
for (const entry of readdirSync(cardsDir, { recursive: true, withFileTypes: true })) {
	const path = relative(WEB, resolve(entry.parentPath, entry.name));
	if (entry.isFile() && !files.has(path)) {
		rmSync(resolve(WEB, path));
		console.log(`Removed ${path}`);
	}
}
for (const entry of readdirSync(cardsDir, { withFileTypes: true })) {
	const dir = resolve(cardsDir, entry.name);
	if (entry.isDirectory() && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
}

const at = process.argv.indexOf('--preview');
if (at > 0) {
	const dir = resolve(process.argv[at + 1] ?? '.');
	mkdirSync(dir, { recursive: true });
	const save = (name, canvas, k) =>
		writeFileSync(resolve(dir, name), encodePng(canvas.scale(k).rgba()));
	// The deck on felt: a row per suit, then the backs and the slot.
	const image = (path) => decodePng(files.get(`src/lib/art/cards/${path}`)).data;
	const gap = 4;
	const cols = 13;
	const rows = 4 + Math.ceil((BACKS.length + 1) / cols);
	const sheetW = gap + cols * (CARD_W + gap);
	const sheetH = gap + rows * (CARD_H + gap);
	const deckSheet = new Uint8Array(sheetW * sheetH * 4);
	const felt = [...PALETTE.get('felt'), 255];
	for (let i = 0; i < sheetW * sheetH; i++) deckSheet.set(felt, i * 4);
	const place = (rgba, col, row) => {
		const x0 = gap + col * (CARD_W + gap);
		const y0 = gap + row * (CARD_H + gap);
		for (let y = 0; y < CARD_H; y++) {
			for (let x = 0; x < CARD_W; x++) {
				const at = (y * CARD_W + x) * 4;
				if (rgba[at + 3])
					deckSheet.set(rgba.subarray(at, at + 4), ((y0 + y) * sheetW + x0 + x) * 4);
			}
		}
	};
	SUITS.forEach((suit, j) =>
		RANKS.forEach((rank, i) => place(image(`faces/${rank}-${suit}.png`), i, j))
	);
	[...BACKS.map((name) => image(`backs/${name}.png`)), slot().rgba().data].forEach((rgba, n) =>
		place(rgba, n % cols, 4 + Math.floor(n / cols))
	);
	for (const k of [1, 2, 4]) {
		const big = new Uint8Array(sheetW * k * sheetH * k * 4);
		for (let y = 0; y < sheetH * k; y++) {
			for (let x = 0; x < sheetW * k; x++) {
				const at = (Math.floor(y / k) * sheetW + Math.floor(x / k)) * 4;
				big.set(deckSheet.subarray(at, at + 4), (y * sheetW * k + x) * 4);
			}
		}
		writeFileSync(
			resolve(dir, `cards-${k}x.png`),
			encodePng({ width: sheetW * k, height: sheetH * k, data: big })
		);
	}
	const ui = [...renderImages()].filter(([path]) => path.includes('/ui/'));
	const width = 400;
	let x = 2;
	let y = 2;
	let row = 0;
	const spots = ui.map(([, c]) => {
		if (x + c.width > width - 2) {
			x = 2;
			y += row + 3;
			row = 0;
		}
		const spot = [c, x, y];
		x += c.width + 3;
		row = Math.max(row, c.height);
		return spot;
	});
	const sheet = new Canvas(width, y + row + 2);
	sheet.rect(0, 0, width, sheet.height, 'felt');
	for (const [c, sx, sy] of spots) sheet.stamp(c, sx, sy);
	save('ui-4x.png', sheet, 4);
	const font = loadFont();
	const sample = [
		'ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789',
		'abcdefghijklmnopqrstuvwxyz !?.,:;’“”…–—·×',
		"#$%&'()*+-/<=>@[\\]^_`{|}~ ←→ ♠♥♦♣"
	];
	const spec = new Canvas(
		Math.max(...sample.map((s) => font.measure(s))) + 6,
		sample.length * 11 + 4
	);
	spec.rect(0, 0, spec.width, spec.height, 'deep slate');
	sample.forEach((s, i) => font.draw(spec, s, 3, 3 + i * 11, 'paper'));
	save('font-4x.png', spec, 4);
	console.log(`Previews in ${dir}`);
}

// Writes the site's pixel art (see scripts/pixel-art/render.js). With
// --preview DIR it also writes contact sheets there for review: every card,
// every interface sprite and a font specimen, at 1x and 4x.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Canvas } from './pixel-art/canvas.js';
import { BACKS, CARD_H, CARD_W, RANKS, SUITS, back, face } from './pixel-art/cards.js';
import { encodePng } from './pixel-art/png.js';
import { loadFont, renderAll, renderImages } from './pixel-art/render.js';

const WEB = resolve(import.meta.dirname, '..');
const files = renderAll();
for (const [path, bytes] of files) {
	const target = resolve(WEB, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, bytes);
}
console.log(`Wrote ${files.size} files.`);

const at = process.argv.indexOf('--preview');
if (at > 0) {
	const dir = resolve(process.argv[at + 1] ?? '.');
	mkdirSync(dir, { recursive: true });
	const save = (name, canvas, k) =>
		writeFileSync(resolve(dir, name), encodePng(canvas.scale(k).rgba()));
	for (const treatment of ['standard', 'four-colour']) {
		const sheet = new Canvas(13 * (CARD_W + 3) + 3, 5 * (CARD_H + 3) + 3);
		sheet.rect(0, 0, sheet.width, sheet.height, 'felt');
		SUITS.forEach((suit, j) =>
			RANKS.forEach((rank, i) =>
				sheet.stamp(face(rank, suit, treatment), 3 + i * (CARD_W + 3), 3 + j * (CARD_H + 3))
			)
		);
		BACKS.forEach((name, i) => sheet.stamp(back(name), 3 + i * (CARD_W + 3), 3 + 4 * (CARD_H + 3)));
		save(`cards-${treatment}-1x.png`, sheet, 1);
		save(`cards-${treatment}-4x.png`, sheet, 4);
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

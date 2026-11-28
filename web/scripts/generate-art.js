// Writes the site's art: the deck and the interface sprites (scripts/art/deck.js
// and ui.js, P5C.3 and P5C.4), the site's icons (scripts/art/icons.js) and the
// iPhone app's tokens, art and icons (scripts/art/swift.js, P5D.5), and
// removes any card or sprite it no longer makes. With --preview DIR it also
// writes a page there for review (art.html), the deck and the sprites at the
// sizes the site draws them, to open in a browser at each density.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { renderDeck } from './art/deck.js';
import { renderIcons } from './art/icons.js';
import { encodePng } from './art/png.js';
import { renderAssets, renderSwift } from './art/swift.js';
import { renderUi } from './art/ui.js';

const WEB = resolve(import.meta.dirname, '..');
const deck = renderDeck();
const ui = renderUi();
const icons = renderIcons();
// The iPhone app's look (P5D.5): its tokens and art in Swift, and its asset catalog.
const swift = renderSwift();
const assets = renderAssets();
const files = new Map([
	...deck,
	...ui,
	...icons.svgs,
	...[...icons.images].map(([path, image]) => [path, encodePng(image)]),
	...swift,
	...assets.text,
	...[...assets.images].map(([path, image]) => [path, encodePng(image)])
]);
for (const [path, bytes] of files) {
	const target = resolve(WEB, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, bytes);
}
console.log(`Wrote ${files.size} files.`);

// The site bundles every card file under the deck's directory, and the sprites are named by
// their stylesheet, so nothing else may stay there.
for (const artDir of ['src/lib/art/cards', 'src/lib/art/ui'].map((d) => resolve(WEB, d))) {
	for (const entry of readdirSync(artDir, { recursive: true, withFileTypes: true })) {
		const path = relative(WEB, resolve(entry.parentPath, entry.name));
		if (entry.isFile() && !files.has(path)) {
			rmSync(resolve(WEB, path));
			console.log(`Removed ${path}`);
		}
	}
	for (const entry of readdirSync(artDir, { withFileTypes: true })) {
		const dir = resolve(artDir, entry.name);
		if (entry.isDirectory() && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
	}
}

const at = process.argv.indexOf('--preview');
if (at > 0) {
	const dir = resolve(process.argv[at + 1] ?? '.');
	const artDir = resolve(dir, 'art');
	mkdirSync(artDir, { recursive: true });
	// The deck and the sprites as a page: on the felt and on the page's night, at the sizes
	// a table asks for. Open it at each device-pixel ratio to review it.
	const names = [...deck.keys()].map((path) => {
		const name = path.split('/').slice(-2).join('-').replace('cards-', '');
		writeFileSync(resolve(artDir, name), deck.get(path));
		return name;
	});
	const sections = [0.75, 1, 1.4, 2]
		.map(
			(k) =>
				`<h2>--k: ${k}</h2><div>${names.map((n) => `<img src="art/${n}" width="${71 * k}" height="${95 * k}" alt="${n}">`).join('')}</div>`
		)
		.join('');
	const sprites = [...ui.keys()]
		.map((path) => {
			const name = `ui-${path.split('/').pop()}`;
			const svg = ui.get(path);
			writeFileSync(resolve(artDir, name), svg);
			const [, w, h] = svg.match(/width="(\d+)" height="(\d+)"/);
			return [1, 2]
				.map((k) => `<img src="art/${name}" width="${w * k}" height="${h * k}" alt="${name}">`)
				.join('');
		})
		.join('');
	writeFileSync(
		resolve(dir, 'art.html'),
		`<!doctype html><meta charset="utf-8"><title>RiverMind art</title><style>body{margin:8px;background:#174237;color:#eceff4;font:13px system-ui}div{display:flex;flex-wrap:wrap;gap:6px}h2{font-size:13px}.night{background:#11141b;padding:8px}</style><body><h2>Sprites</h2><div>${sprites}</div>${sections}<section class="night"><div>${sprites}</div>${sections}</section>`
	);
	console.log(`Preview in ${dir}`);
}

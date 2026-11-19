// Renders every piece of the site's pixel art from the sources in web/art/:
// cards, interface sprites, the font, the palette as CSS and the icons.
// scripts/generate-pixel-art.js writes the result; src/lib/art/art.spec.ts
// fails when a committed file no longer matches.
import { readFileSync } from 'node:fs';
import { ART, PALETTE } from './canvas.js';
import { renderCards } from './cards.js';
import { PixelFont } from './font.js';
import { encodePng } from './png.js';
import { renderIcons, renderUi } from './ui.js';
import { fromSfnt } from './woff.js';

/** Canvases by path: `lib/...` under web/src/, `static/...` under web/. */
export function renderImages() {
	const out = new Map();
	for (const [path, canvas] of renderCards()) out.set(`src/lib/art/${path}`, canvas);
	for (const [path, canvas] of renderUi()) out.set(`src/lib/art/${path}`, canvas);
	for (const [path, canvas] of renderIcons()) out.set(`static/${path}`, canvas);
	return out;
}

export function loadFont() {
	return PixelFont.parse(readFileSync(new URL('rivermind-pixel.font', ART), 'utf8'));
}

/** The palette as CSS custom properties, one per color name. */
export function paletteCss() {
	const lines = [...PALETTE].map(([name, [r, g, b]]) => {
		const hex = [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
		return `\t--${name.replace(/ /g, '-')}: #${hex};`;
	});
	return (
		'/* Generated from web/art/palette.hex by pnpm art; do not edit. */\n:root {\n' +
		lines.join('\n') +
		'\n}\n'
	);
}

/** Every generated file as bytes, by path relative to web/. */
export function renderAll() {
	const out = new Map();
	for (const [path, canvas] of renderImages()) out.set(path, encodePng(canvas.rgba()));
	out.set('src/lib/art/fonts/rivermind-pixel.woff', fromSfnt(loadFont().ttf()));
	out.set('src/lib/art/palette.css', new TextEncoder().encode(paletteCss()));
	return out;
}

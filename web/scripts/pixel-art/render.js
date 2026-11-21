// Renders every piece of the site's pixel art from the sources in web/art/:
// the cards, interface sprites, the font, the Tailwind theme and the icons.
// scripts/generate-pixel-art.js writes the result; src/lib/art/art.spec.ts
// fails when a committed file no longer matches.
import { readFileSync } from 'node:fs';
import { ART, PALETTE } from './canvas.js';
import { renderDeck, slot } from './cards.js';
import { PixelFont } from './font.js';
import { encodePng } from './png.js';
import { renderIcons, renderUi } from './ui.js';
import { fromSfnt } from './woff.js';

/**
 * The art drawn on the palette, as canvases by path relative to web/. The
 * imported card sprites are not on the palette; see renderDeck.
 */
export function renderImages() {
	const out = new Map();
	out.set('src/lib/art/cards/slot.png', slot());
	for (const [path, canvas] of renderUi()) out.set(`src/lib/art/${path}`, canvas);
	for (const [path, canvas] of renderIcons()) out.set(`static/${path}`, canvas);
	return out;
}

export function loadFont() {
	return PixelFont.parse(readFileSync(new URL('rivermind-pixel.font', ART), 'utf8'));
}

/** The font's CSS family name and its fallbacks. */
export const FONT_FAMILY = "'RiverMind Pixel', ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

/** One art pixel of the interface in CSS pixels: frames, buttons and icons draw at 2x. */
export const ART_PIXEL = 2;

/**
 * Text sizes in CSS pixels. The font is pixel-exact at multiples of 10px; the
 * small size is 15px, which is exact on 2x screens.
 */
export const TEXT_SIZES = { xs: 10, s: 15, m: 20, l: 30, xl: 40 };

/**
 * The kit as Tailwind theme variables (P4B.2): the palette, the font, the
 * spacing step and the text sizes, and nothing of Tailwind's own theme, so the
 * utilities offer only these. `static` writes every variable into the page's
 * CSS, so the kit's own stylesheets can use any of them.
 */
export function themeCss() {
	const colors = [...PALETTE].map(([name, [r, g, b]]) => {
		const hex = [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
		return `\t--color-${name.replace(/ /g, '-')}: #${hex};`;
	});
	const sizes = Object.entries(TEXT_SIZES).map(([name, px]) => `\t--text-${name}: ${px}px;`);
	return [
		'/* Generated from web/art/palette.hex and scripts/pixel-art/render.js by pnpm art; do not edit. */',
		'@theme static {',
		"\t/* Nothing of Tailwind's default theme. */",
		'\t--*: initial;',
		'',
		'\t/* The palette: bg-felt, text-gold, border-ink and so on. */',
		...colors,
		'',
		'\t/* The pixel font: font-pixel. */',
		`\t--font-pixel: ${FONT_FAMILY};`,
		'\t--default-font-family: var(--font-pixel);',
		'\t--default-mono-font-family: var(--font-pixel);',
		'',
		'\t/* One art pixel on screen: p-3 is three art pixels. */',
		`\t--spacing: ${ART_PIXEL}px;`,
		'',
		'\t/* Text sizes: text-xs to text-xl. */',
		...sizes,
		'',
		'\t/* The hard one-pixel shadow under light text: text-shadow-ink. */',
		'\t--text-shadow-ink: 0 var(--spacing) 0 var(--color-ink);',
		'}',
		''
	].join('\n');
}

/** Every generated file as bytes, by path relative to web/. */
export function renderAll() {
	const out = new Map();
	for (const [path, image] of renderDeck()) out.set(`src/lib/art/${path}`, encodePng(image));
	for (const [path, canvas] of renderImages()) out.set(path, encodePng(canvas.rgba()));
	out.set('src/lib/art/fonts/rivermind-pixel.woff', fromSfnt(loadFont().ttf()));
	out.set('src/lib/art/theme.css', new TextEncoder().encode(themeCss()));
	return out;
}

// The site's tokens and kit (P5C.2): every palette name has one value, every
// pair of text and background the pages use meets WCAG 2.2 AA, controls and the
// focus ring stand out from what they sit on, and the kit draws in CSS alone.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const theme = read('./theme.css');
const kitCss = read('./kit.css');

const named = [...theme.matchAll(/--color-([a-z-]+): (#[0-9a-f]{6});/g)];
const PALETTE = new Map(named.map(([, n, h]) => [n, h]));

/** WCAG 2.2 relative luminance of an sRGB colour. */
function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of two colours, by palette name. */
export function contrast(a: string, b: string): number {
	const [x, y] = [a, b].map((name) => {
		const hex = PALETTE.get(name);
		if (!hex) throw new Error(`no colour ${name}`);
		return luminance(hex);
	});
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// Where the pages put text: the page, the header and wells, panels, raised panels
// and slate buttons, and the felt.
const SURFACES = ['night', 'ink', 'deep-slate', 'slate', 'felt-dark', 'felt'];
const TEXT = [
	'paper',
	'paper-shade',
	'mist',
	'haze',
	'gold',
	'gold-light',
	'green-light',
	'red-light',
	'violet-light',
	'blue-light',
	'amber',
	'warn'
];

/** Text on a colour of its own: button faces, tags, paper and a chosen option's note. */
export const LABELS: [string, string][] = [
	['paper', 'slate'],
	['white', 'red-dark'],
	['white', 'blue-dark'],
	['white', 'green-dark'],
	['ink', 'amber'],
	['ink', 'gold'],
	['ink', 'paper'],
	['amber-deep', 'gold'],
	['violet-light', 'ink'],
	['suit-clubs', 'card'],
	['suit-diamonds', 'card'],
	['suit-hearts', 'card'],
	['suit-spades', 'card']
];

/** Controls and their states against what they sit on (3:1): edges, faces, the thumb and focus. */
export const CONTROLS: [string, string][] = [
	['dusk', 'night'],
	['dusk', 'deep-slate'],
	['dusk', 'ink'],
	['red-dark', 'night'],
	['blue-dark', 'night'],
	['green-dark', 'night'],
	['amber', 'night'],
	['gold', 'night'],
	['gold', 'ink'],
	['gold', 'deep-slate'],
	['gold', 'slate'],
	['gold', 'felt'],
	['gold-light', 'deep-slate'],
	['red', 'red-deep']
];

describe('the palette', () => {
	test('names each colour once, as a hex value, and every name the pages use', () => {
		expect(PALETTE.size).toBe(named.length);
		expect(theme.match(/--color-[a-z-]+:/g)).toHaveLength(named.length);
		for (const name of new Set([...SURFACES, ...TEXT, ...LABELS.flat(), ...CONTROLS.flat()]))
			expect(PALETTE.has(name), name).toBe(true);
	});

	test('meets 4.5:1 for every text colour on every surface the pages use', () => {
		for (const text of TEXT)
			for (const surface of SURFACES)
				expect(contrast(text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
		for (const [text, surface] of LABELS)
			expect(contrast(text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
	});

	test('meets 3:1 for controls and focus', () => {
		for (const [control, surface] of CONTROLS)
			expect(contrast(control, surface), `${control} on ${surface}`).toBeGreaterThanOrEqual(3);
	});
});

describe('the theme and the kit', () => {
	const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
	const tokens = strip(theme);
	const kit = strip(kitCss);

	test('draw without image files, a font file or stepped motion', () => {
		for (const css of [tokens, kit]) {
			expect(css).not.toMatch(/url\(|@font-face/);
			expect(css).not.toMatch(/pixelated|crisp-edges/);
			expect(css).not.toMatch(/steps\(/);
			expect(css).not.toMatch(/border-image/);
			expect(css).not.toMatch(/data-look/);
		}
	});

	test('have five text sizes, the theme variables and every kit class', () => {
		expect(tokens.match(/@theme[^{]*\{/g)).toEqual(['@theme static {']);
		expect(tokens.indexOf('--*: initial;')).toBeLessThan(tokens.indexOf('--color-'));
		expect(tokens).toMatch('--spacing: 2px;');
		for (const size of ['xs', 's', 'm', 'l', 'xl']) expect(tokens).toMatch(`--text-${size}: `);
		for (const name of ['--font-sans', '--text-shadow-ink', '--text-shadow-title'])
			expect(tokens).toMatch(`${name}:`);
		for (const name of ['blink', 'wait', 'drop', 'slide', 'pop', 'fade', 'rise', 'speak'])
			expect(tokens).toMatch(`--animate-${name}: ${name} `);
		// The seat to act glows in place rather than bobbing (P5C.6): a smooth bob never
		// stands still, so its name moved under a finger and Playwright could not click it.
		expect(tokens).toMatch('--animate-nudge: turn ');
		const turn = /@keyframes turn \{([\s\S]*?)\n\t\}/.exec(tokens)?.[1] ?? '';
		expect(turn).toMatch(/box-shadow/);
		expect(turn).not.toMatch(/transform|translate|scale|margin|inset|top|left/);
		for (const kitClass of [
			'.ui-panel',
			'.ui-raised',
			'.ui-inset',
			'.ui-paper',
			'.ui-gold',
			'.ui-glow',
			'.ui-danger',
			'.ui-table',
			'.ui-btn',
			'.ui-btn.red',
			'.ui-btn.blue',
			'.ui-btn.amber',
			'.ui-btn.green',
			'.ui-btn.gold',
			'.ui-btn.small',
			'.ui-btn.choice',
			'.ui-field',
			'select.ui-field',
			'input.ui-range'
		])
			expect(kit).toContain(kitClass);
	});
});

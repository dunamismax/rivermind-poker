// The clean look's tokens and kit (P5C.2): every palette name has a clean value,
// every pair of text and background the pages use meets WCAG 2.2 AA, controls
// and the focus ring stand out from what they sit on, and nothing pixel is left.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const clean = read('./clean.css');
const theme = read('../lib/art/theme.css');

const hexes = (css: string) =>
	new Map([...css.matchAll(/--color-([a-z-]+): (#[0-9a-f]{6});/g)].map(([, n, h]) => [n, h]));
const CLEAN = hexes(clean);
const PIXEL = hexes(theme);

/** WCAG 2.2 relative luminance of an sRGB colour. */
function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((i) => {
		const c = parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of two clean colours, by palette name. */
export function contrast(a: string, b: string): number {
	const [x, y] = [a, b].map((name) => {
		const hex = CLEAN.get(name);
		if (!hex) throw new Error(`no clean colour ${name}`);
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

describe('the clean palette', () => {
	test('gives every palette name a clean value, and adds only role tokens', () => {
		expect([...CLEAN.keys()].filter((name) => !PIXEL.has(name))).toEqual([
			'warn',
			'card',
			'card-edge',
			'card-back-burgundy',
			'card-back-navy',
			'card-back-green',
			'card-back-mark',
			'suit-clubs',
			'suit-diamonds',
			'suit-hearts',
			'suit-spades'
		]);
		for (const name of PIXEL.keys()) expect(CLEAN.has(name), name).toBe(true);
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

describe('the clean kit', () => {
	const kit = clean.replace(/\/\*[\s\S]*?\*\//g, '');

	test('draws without image files, the pixel font or stepped motion', () => {
		expect(kit).not.toMatch(/url\(/);
		expect(kit).not.toMatch(/RiverMind Pixel/);
		expect(kit).not.toMatch(/pixelated|crisp-edges/);
		expect(kit).not.toMatch(/steps\(/);
		expect(kit).not.toMatch(/border-image/);
	});

	test('has five text sizes, the theme variables and every kit class', () => {
		for (const size of ['xs', 's', 'm', 'l', 'xl']) expect(kit).toMatch(`--text-${size}: `);
		for (const name of ['--font-pixel', '--text-shadow-ink', '--text-shadow-title'])
			expect(kit).toMatch(`${name}:`);
		for (const name of ['blink', 'wait', 'drop', 'slide', 'pop', 'fade', 'rise', 'speak'])
			expect(kit).toMatch(`--animate-${name}: ${name} `);
		// The seat to act glows in place rather than bobbing (P5C.6): a smooth bob never
		// stands still, so its name moved under a finger and Playwright could not click it.
		expect(kit).toMatch('--animate-nudge: turn ');
		const turn = /@keyframes turn \{([\s\S]*?)\n\}/.exec(kit)?.[1] ?? '';
		expect(turn).toMatch(/box-shadow/);
		expect(turn).not.toMatch(/transform|translate|scale|margin|inset|top|left/);
		for (const kitClass of [
			'.px-panel',
			'.px-raised',
			'.px-inset',
			'.px-paper',
			'.px-gold',
			'.px-glow',
			'.px-danger',
			'.px-table',
			'.px-btn',
			'.px-btn.red',
			'.px-btn.blue',
			'.px-btn.amber',
			'.px-btn.green',
			'.px-btn.gold',
			'.px-btn.small',
			'.px-btn.choice',
			'.px-field',
			'select.px-field',
			'input.px-range'
		])
			expect(kit).toContain(kitClass);
	});

	test('is scoped to the clean look', () => {
		const blocks = [...kit.matchAll(/^([^\s{}][^{}]*)\{/gm)].map(([, selector]) => selector.trim());
		expect(blocks.length).toBeGreaterThan(0);
		// Keyframes have no selector: only the clean look's own animation variables name them.
		for (const selector of blocks)
			expect(selector).toMatch(/^(:where\(\[data-look='clean'\]\)|@keyframes (turn)$)/);
	});
});

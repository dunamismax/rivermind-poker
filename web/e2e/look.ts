// The look the browser tests see (Phase 5C). `E2E_LOOK=clean` or `E2E_LOOK=pixel`
// keeps that look in every browser context a test opens, as a player's own choice
// would be kept; without it each context gets the site's default. A test of the
// switch itself opens a context without `withLook`, since the kept choice is put
// back on every page load.
import {
	expect,
	type Browser,
	type BrowserContext,
	type BrowserContextOptions,
	type Page
} from '@playwright/test';
import { LOOK_KEY, LOOK_NAMES, isLook, type Look } from '../src/lib/look.ts';

function chosen(): Look | null {
	const value = process.env.E2E_LOOK;
	if (!value) return null;
	if (!isLook(value)) throw new Error(`E2E_LOOK is ${value}, not a look`);
	return value;
}

/** The look the tests asked for, or null for the site's default. */
export const LOOK = chosen();

/** Keep `look` (by default the one the tests asked for) in a context, before any page of it loads. */
export async function withLook(
	context: BrowserContext,
	look: Look | null = LOOK
): Promise<BrowserContext> {
	if (look) {
		await context.addInitScript(
			([key, value]) => {
				try {
					localStorage.setItem(key, value);
				} catch {
					// A page with no storage keeps the default, as a player's would.
				}
			},
			[LOOK_KEY, look] as const
		);
	}
	return context;
}

/** A new context in the tests' look. */
export async function newContext(
	browser: Browser,
	options?: BrowserContextOptions
): Promise<BrowserContext> {
	return withLook(await browser.newContext(options));
}

/**
 * Switch the page to its other look where a player would: the site header, or at a table
 * on a phone, where the header is left out, the table bar's menu (P5C.6). Returns the look.
 */
export async function switchLook(page: Page): Promise<Look> {
	const next: Look =
		(await page.evaluate(() => document.documentElement.dataset.look)) === 'clean'
			? 'pixel'
			: 'clean';
	const menu = page.getByRole('button', { name: 'Table menu' });
	const inMenu = await menu.isVisible();
	if (inMenu) await menu.click();
	await page
		.getByRole('group', { name: 'Look' })
		.getByRole('button', { name: LOOK_NAMES[next], exact: true })
		.click();
	await expect(page.locator('html')).toHaveAttribute('data-look', next);
	if (inMenu) {
		await page
			.getByRole('dialog', { name: 'Table menu' })
			.getByRole('button', { name: 'Close' })
			.click();
		await expect(page.getByRole('dialog', { name: 'Table menu' })).toHaveCount(0);
	}
	return next;
}

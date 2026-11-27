// The look the browser tests see (Phase 5C). `E2E_LOOK=clean` or `E2E_LOOK=pixel`
// keeps that look in every browser context a test opens, as a player's own choice
// would be kept; without it each context gets the site's default. A test of the
// switch itself opens a context without `withLook`, since the kept choice is put
// back on every page load.
import type { Browser, BrowserContext, BrowserContextOptions } from '@playwright/test';
import { LOOK_KEY, isLook, type Look } from '../src/lib/look.ts';

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

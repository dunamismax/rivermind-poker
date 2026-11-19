import { test as base, expect, type Page } from '@playwright/test';
import { TableServer } from './server.ts';

/** Records Content-Security-Policy violations; tests assert there are none. */
export const withCsp = base.extend<{ cspViolations: string[] }>({
	cspViolations: async ({ page }, use) => {
		const violations: string[] = [];
		await page.exposeFunction('__reportCsp', (text: string) => violations.push(text));
		await page.addInitScript(() => {
			document.addEventListener('securitypolicyviolation', (e) => {
				(window as unknown as { __reportCsp: (t: string) => void }).__reportCsp(
					`${e.violatedDirective} ${e.blockedURI}`
				);
			});
		});
		await use(violations);
	}
});

// One `serve-nl` per worker, on its own port, so projects run in parallel.
export const test = withCsp.extend<object, { server: TableServer }>({
	server: [
		// eslint-disable-next-line no-empty-pattern
		async ({}, use, workerInfo) => {
			const server = new TableServer(8700 + workerInfo.parallelIndex);
			await server.start();
			await use(server);
			await server.dispose();
		},
		{ scope: 'worker', timeout: 90_000 }
	],
	baseURL: async ({ server }, use) => use(server.url)
});

export { expect };

/** Start a table from the lobby and wait for the player's seat. */
export async function sitDown(
	page: Page,
	seats: number,
	{ bots = /Calling bot/, buyIn }: { bots?: RegExp; buyIn?: RegExp } = {}
): Promise<void> {
	await page.goto('/');
	await page.getByRole('radio', { name: String(seats), exact: true }).check({ force: true });
	await page.getByRole('radio', { name: bots }).check({ force: true });
	if (buyIn) {
		const select = page.getByRole('combobox', { name: 'Buy-in' });
		const option = select.getByRole('option', { name: buyIn });
		await select.selectOption((await option.getAttribute('value')) ?? '');
	}
	await page.getByRole('button', { name: 'Sit down' }).click();
	await expect(page.getByRole('group', { name: /^Your seat/ })).toBeVisible();
}

export async function handNumber(page: Page): Promise<number> {
	const text = (await page.locator('.meta').textContent()) ?? '';
	return Number(/Hand #(\d+)/.exec(text)?.[1] ?? 0);
}

/** Check, call (up to ten big blinds) or fold on each of our turns until `done` holds. */
export async function playUntil(
	page: Page,
	done: () => Promise<boolean>,
	timeoutMs = 45_000
): Promise<void> {
	const panel = page.getByRole('group', { name: 'Your action' });
	const call = panel.getByRole('button', { name: /^(Check|Call \d+)$/ });
	const fold = panel.getByRole('button', { name: 'Fold' });
	const deadline = Date.now() + timeoutMs;
	while (!(await done()) && Date.now() < deadline) {
		if (await call.isVisible()) {
			const amount = Number(/(\d+)$/.exec((await call.textContent()) ?? '')?.[1] ?? 0);
			const big = amount > 1000 && (await fold.isVisible());
			// A short timeout: the turn may end as we click, and the button with it.
			await (big ? fold : call).click({ timeout: 1000 }).catch(() => {});
		} else {
			await page.waitForTimeout(100);
		}
	}
	expect(await done()).toBe(true);
}

export async function playUntilHand(page: Page, target: number, timeoutMs?: number): Promise<void> {
	await playUntil(page, async () => (await handNumber(page)) >= target, timeoutMs);
}

export async function noOverflow(page: Page): Promise<void> {
	const widths = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
	expect(widths[0]).toBeLessThanOrEqual(widths[1]);
}

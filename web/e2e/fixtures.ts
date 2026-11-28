import { test as base, expect, type Browser, type Page } from '@playwright/test';
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

// One site (the Node server) per worker, on its own ports, so projects run in parallel.
export const test = withCsp.extend<object, { server: TableServer }>({
	server: [
		// eslint-disable-next-line no-empty-pattern
		async ({}, use, workerInfo) => {
			const server = new TableServer(8800 + workerInfo.parallelIndex);
			await server.start();
			await use(server);
			await server.dispose();
		},
		{ scope: 'worker', timeout: 90_000 }
	],
	baseURL: async ({ server }, use) => use(server.url)
});

export { expect };

/** The lobby's form for starting a table (the table list has its own buttons). */
export function newTableForm(page: Page) {
	return page.getByRole('region', { name: 'Start a table' });
}

/** Start a table from the lobby and wait for the player's seat. */
export async function sitDown(
	page: Page,
	seats: number,
	{
		bots = /Calling bot/,
		buyIn,
		privateTable = false
	}: { bots?: RegExp; buyIn?: RegExp; privateTable?: boolean } = {}
): Promise<void> {
	await page.goto('/');
	await expect(page.getByText('Looking for tables…')).toHaveCount(0);
	const form = newTableForm(page);
	// The live table list above the form can change height between scrolling
	// and clicking, so the choices are clicked in place rather than by position.
	for (const choice of [
		form.getByRole('radio', { name: String(seats), exact: true }),
		form.getByRole('radio', { name: bots }),
		...(privateTable ? [form.getByRole('checkbox', { name: /Private table/ })] : [])
	]) {
		// (Playwright's dispatchEvent crashes Firefox pages here; the element's own click does not.)
		await choice.evaluate((input: HTMLInputElement) => input.click());
		await expect(choice).toBeChecked();
	}
	if (buyIn) {
		const select = form.getByRole('combobox', { name: 'Buy-in' });
		const option = select.getByRole('option', { name: buyIn });
		await select.selectOption((await option.getAttribute('value')) ?? '');
	}
	await form.getByRole('button', { name: 'Sit down' }).click();
	await expect(page.getByRole('group', { name: /^Your seat/ })).toBeVisible();
}

/** The id of the table the page is at, as the page keeps it for a reload. */
export async function tableIdOf(page: Page): Promise<string> {
	const saved = await page.evaluate(() => localStorage.getItem('rivermind.nl.table'));
	return JSON.parse(saved ?? 'null') as string;
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
		// After an action the panel stays up, disabled, until the table answers. Deciding then
		// would read the last turn's button, and the click would wait and land on the next
		// turn's (a bot's big bet), so decide only on an enabled button. Bounded: if the turn
		// ends after isVisible, an unbounded isEnabled waits for our next turn, and when the
		// other player's loop has already stopped, that turn comes only after their action
		// clock and time bank run out (about 50 s).
		if ((await call.isVisible()) && (await call.isEnabled({ timeout: 1000 }).catch(() => false))) {
			// Bounded, like the click: the turn (and the button) can end between the two calls.
			const label = (await call.textContent({ timeout: 1000 }).catch(() => null))?.trim();
			if (!label) continue;
			const amount = Number(/(\d+)$/.exec(label)?.[1] ?? 0);
			const big = amount > 1000 && (await fold.isVisible());
			// Click the very button decided on: if the turn moves on first, its label changes,
			// nothing matches, and the short timeout lets the next pass decide again.
			const target = big ? fold : panel.getByRole('button', { name: label, exact: true });
			await target.click({ timeout: 1000 }).catch(() => {});
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

/** Another person: a new browser context, so a new player. */
export async function stranger(browser: Browser): Promise<Page> {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	return context.newPage();
}

export async function nameOf(page: Page): Promise<string> {
	const me = page.locator('header .me');
	await expect(me).toHaveText(/\S/);
	return (await me.textContent()) ?? '';
}

/** A table's row in the lobby list. */
export function row(page: Page, tableId: string) {
	return page.locator(`li[data-table="${tableId}"]`);
}

/** The viewer's own seat at the table. */
export const seated = (page: Page) => page.getByRole('group', { name: /^Your seat/ });

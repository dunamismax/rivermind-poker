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

// One server per worker, on its own port, so projects run in parallel.
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

/** Start a table from the lobby, against random bots unless told otherwise. */
export async function sitDown(page: Page, opponents: RegExp = /Random bots/): Promise<void> {
	await page.goto('/');
	await page.getByRole('radio', { name: opponents }).check();
	await page.getByRole('button', { name: 'Sit down' }).click();
	await expect(page.getByRole('region', { name: 'Your seat' })).toBeVisible();
}

/** Check or call until the hand is over; returns the result line. */
export async function playHand(page: Page): Promise<string> {
	const next = page.getByRole('button', { name: 'Next hand' });
	const call = page.getByRole('button', { name: /^(Check|Call \d+)$/ });
	for (let i = 0; i < 60; i += 1) {
		await expect(next.or(call)).toBeEnabled();
		if (await next.isVisible()) break;
		await call.click();
	}
	await expect(next).toBeEnabled();
	const result = page.locator('.result');
	await expect(result).toHaveText(/wins? \d+/);
	return (await result.textContent()) ?? '';
}

// The no-limit server (serve-nl, protocol v2), one per worker on its own port.
export const testNl = withCsp.extend<object, { nlServer: TableServer }>({
	nlServer: [
		// eslint-disable-next-line no-empty-pattern
		async ({}, use, workerInfo) => {
			const server = new TableServer(8800 + workerInfo.parallelIndex, 'serve-nl');
			await server.start();
			await use(server);
			await server.dispose();
		},
		{ scope: 'worker', timeout: 90_000 }
	],
	baseURL: async ({ nlServer }, use) => use(nlServer.url)
});

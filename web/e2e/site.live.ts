import { execSync } from 'node:child_process';
import { expect, playHand, sitDown, withCsp as test } from './fixtures.ts';

// Runs against a deployed site; see playwright.live.config.ts.

test.afterEach(({ cspViolations }) => {
	expect(cspViolations).toEqual([]);
});

test('serves the client with the site headers', async ({ page, request }) => {
	const html = await request.get('/');
	expect(html.status()).toBe(200);
	expect(html.headers()['cache-control']).toBe('no-cache');
	expect(html.headers()['content-security-policy']).toContain("script-src 'self';");
	const fallback = await request.get('/some/route');
	expect(fallback.status()).toBe(200);
	expect(await fallback.text()).toBe(await html.text());
	const asset = (await html.text()).match(/\/_app\/immutable\/[^"']+\.js/)?.[0];
	expect(asset).toBeTruthy();
	const script = await request.get(asset!);
	expect(script.status()).toBe(200);
	expect(script.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
	expect((await request.get('/_app/immutable/missing.js')).status()).toBe(404);
	expect((await request.get('/api/config')).ok()).toBe(true);
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Sit down' })).toBeVisible();
});

for (const [name, label] of [
	['random bots', /Random bots/],
	['RiverMind bots', /RiverMind bots/]
] as const) {
	test(`completes a hand against ${name}`, async ({ page }) => {
		await sitDown(page, label);
		await playHand(page);
		await page.getByRole('button', { name: 'Leave table' }).click();
	});
}

test('continues a hand across a service restart', async ({ page }) => {
	const restart = process.env.LIVE_RESTART_COMMAND;
	test.skip(!restart, 'set LIVE_RESTART_COMMAND to check a live restart');
	await sitDown(page, /RiverMind bots/);
	const call = page.getByRole('button', { name: /^(Check|Call \d+)$/ });
	await call.click();
	await expect(call.or(page.getByRole('button', { name: 'Next hand' }))).toBeEnabled();
	await expect(page.locator('.log li:not(.shown)')).toHaveCount(0);
	const table = page.getByRole('region', { name: 'Table' });
	const before = await table.ariaSnapshot();
	execSync(restart!, { stdio: 'inherit' });
	await expect(page.locator('.status')).toHaveAttribute('data-state', 'closed', {
		timeout: 30_000
	});
	await expect(page.locator('.status')).toHaveAttribute('data-state', 'open', {
		timeout: 120_000
	});
	expect(await table.ariaSnapshot()).toBe(before);
	await playHand(page);
});

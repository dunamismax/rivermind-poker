import { execSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import {
	expect,
	handNumber,
	newTableForm,
	noOverflow,
	playUntil,
	playUntilHand,
	sitDown,
	withCsp as test
} from './fixtures.ts';

// Runs against a deployed site; see playwright.live.config.ts. Live hands are
// slower (a 3 s pause between hands, 0.6 s per bot action), so waits are longer.

const LIVE_HAND_MS = 150_000;

test.afterEach(({ cspViolations }) => {
	expect(cspViolations).toEqual([]);
});

async function leave(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Leave table' }).click();
	await expect(newTableForm(page).getByRole('button', { name: 'Sit down' })).toBeVisible();
}

async function myCards(page: Page): Promise<(string | null)[]> {
	return page
		.getByRole('group', { name: /^Your seat/ })
		.locator('img')
		.evaluateAll((cards) => cards.map((card) => card.getAttribute('alt')));
}

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
	const config = await request.get('/api/config');
	expect(config.ok()).toBe(true);
	expect((await config.json()).protocol).toBe(2);
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'No-limit hold’em' })).toBeVisible();
	await expect(newTableForm(page).getByRole('button', { name: 'Sit down' })).toBeVisible();
});

for (const seats of [2, 6, 9]) {
	test(`plays a hand at ${seats} seats`, async ({ page }) => {
		await sitDown(page, seats, { bots: /RiverMind Easy/ });
		await expect(page.locator('.seat[data-seat]')).toHaveCount(seats);
		await expect(page.locator('.seat .bot')).toHaveCount(seats - 1);
		await playUntilHand(page, 2, LIVE_HAND_MS);
		await noOverflow(page);
		await leave(page);
	});
}

test('sits out, comes back and rebuys', async ({ page }) => {
	await sitDown(page, 3, { bots: /Calling bot/, buyIn: /40 big blinds/ });
	await expect(page.locator('.seat.acting .clock')).toHaveCount(1); // a turn clock is running
	await page.getByRole('button', { name: 'Sit out next hand' }).click();
	const sittingOut = page.getByText('You are sitting out.');
	await playUntil(page, () => sittingOut.isVisible(), LIVE_HAND_MS);
	await page.getByRole('button', { name: 'I’m back' }).click();
	await expect(page.getByRole('group', { name: 'Your action' })).toBeVisible({ timeout: 60_000 });
	await page.getByRole('spinbutton', { name: 'Rebuy amount' }).fill('25');
	await page.getByRole('button', { name: 'Rebuy' }).click();
	await expect(
		page
			.getByText(/^\+25 after this hand$/)
			.or(page.getByRole('region', { name: 'Hand log' }).getByText(/adds 25/))
	).toBeVisible();
	await leave(page);
});

test('continues a hand across a service restart', async ({ page }) => {
	const restart = process.env.LIVE_RESTART_COMMAND;
	test.skip(!restart, 'set LIVE_RESTART_COMMAND to check a live restart');
	await sitDown(page, 6, { bots: /Calling bot/ });
	const panel = page.getByRole('group', { name: 'Your action' });
	await expect(panel).toBeVisible({ timeout: 60_000 }); // mid-hand, our turn
	const hand = await handNumber(page);
	const cards = await myCards(page);
	const call = await panel.getByRole('button', { name: /^(Check|Call \d+)$/ }).textContent();
	execSync(restart!, { stdio: 'inherit' });
	await expect(page.locator('.status')).toHaveAttribute('data-state', 'closed', {
		timeout: 30_000
	});
	await expect(page.locator('.status')).toHaveAttribute('data-state', 'open', {
		timeout: 120_000
	});
	// The same hand, the same cards, and still our turn with the same choice.
	expect(await handNumber(page)).toBe(hand);
	expect(await myCards(page)).toEqual(cards);
	await expect(panel.getByRole('button', { name: /^(Check|Call \d+)$/ })).toHaveText(call ?? '');
	await playUntilHand(page, hand + 1, LIVE_HAND_MS);
	await leave(page);
});

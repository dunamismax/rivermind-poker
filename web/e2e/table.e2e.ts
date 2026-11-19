import type { Page } from '@playwright/test';
import { expect, playHand, sitDown, test } from './fixtures.ts';

const tableText = (page: Page) => page.getByRole('region', { name: 'Table' }).innerText();

/** Act once so the table is mid-hand with history, and wait for the bots. */
async function actOnce(page: Page) {
	await page.getByRole('button', { name: /^(Check|Call \d+)$/ }).click();
	await expect(
		page
			.getByRole('button', { name: /^(Check|Call \d+)$/ })
			.or(page.getByRole('button', { name: 'Next hand' }))
	).toBeEnabled();
	await expect(page.locator('.log li:not(.shown)')).toHaveCount(0);
}

async function expectNoHorizontalOverflow(page: Page) {
	const { scrollWidth, clientWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth
	}));
	expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test.afterEach(({ cspViolations }) => {
	expect(cspViolations).toEqual([]);
});

test('plays three consecutive hands against random bots', async ({ page }) => {
	await sitDown(page);
	let balance = 0;
	for (let hand = 1; hand <= 3; hand += 1) {
		await expect(page.locator('.log li').first()).toHaveText(`Hand ${hand}`);
		await playHand(page);
		const payout = Number(await page.locator('[aria-label="Your seat"] .payout').innerText());
		balance += payout;
		await expect(page.locator('.balance')).toHaveText(
			`Session ${balance > 0 ? '+' : ''}${balance}`
		);
		if (hand < 3) await page.getByRole('button', { name: 'Next hand' }).click();
	}
});

test('rejoins the same seat after a mid-hand reload', async ({ page }) => {
	await sitDown(page);
	await actOnce(page);
	const before = await tableText(page);
	await page.reload();
	await expect(page.locator('.status')).toHaveAttribute('data-state', 'open');
	await expect(page.locator('.log li:not(.shown)')).toHaveCount(0);
	expect(await tableText(page)).toBe(before);
	await playHand(page);
});

test('continues after the server process is killed and restarted', async ({ page, server }) => {
	await sitDown(page);
	await actOnce(page);
	const before = await tableText(page);
	await server.stop();
	await expect(page.locator('.status')).toHaveAttribute('data-state', 'closed');
	await expect(
		page
			.getByText('Reconnecting…')
			.or(page.getByRole('button', { name: /^(Check|Call|Next)/ }).first())
	).toBeVisible();
	await server.start();
	await expect(page.locator('.status')).toHaveAttribute('data-state', 'open', { timeout: 20_000 });
	expect(await tableText(page)).toBe(before);
	await playHand(page);
	await page.getByRole('button', { name: 'Next hand' }).click();
	await expect(page.locator('.log li').first()).toHaveText(/^Hand \d+$/);
});

test('shows the closed-table message when the saved table is gone', async ({ page }) => {
	await sitDown(page);
	await page.evaluate(() =>
		localStorage.setItem('rivermind.seat', JSON.stringify({ table_id: 'gone', token: 'x' }))
	);
	await page.reload();
	await expect(
		page.getByRole('status').filter({ hasText: 'That table has closed. Start a new one.' })
	).toBeVisible();
	expect(await page.evaluate(() => localStorage.getItem('rivermind.seat'))).toBeNull();
	await page.getByRole('button', { name: 'Sit down' }).click();
	await expect(page.getByRole('region', { name: 'Your seat' })).toBeVisible();
});

test('leaves the table for the lobby', async ({ page }) => {
	await sitDown(page);
	await page.getByRole('button', { name: 'Leave table' }).click();
	await expect(page.getByRole('button', { name: 'Sit down' })).toBeVisible();
	await page.reload();
	await expect(page.getByRole('button', { name: 'Sit down' })).toBeVisible();
});

test('has no horizontal overflow at 375×812', async ({ page }) => {
	await page.setViewportSize({ width: 375, height: 812 });
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Sit down' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await sitDown(page);
	await expectNoHorizontalOverflow(page);
	await playHand(page);
	await expectNoHorizontalOverflow(page);
});

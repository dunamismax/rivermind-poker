import type { Page } from '@playwright/test';
import { expect, handNumber, noOverflow, seated, tableIdOf, test } from './fixtures.ts';

// One-click practice at any balance (P6.0b): a guest starts a heads-up hand
// against the labelled RiverMind Easy bot from the lobby with one click,
// resumes it after a reload and plays again after running out of chips. The
// wallet never changes.

async function balance(page: Page): Promise<number> {
	return page.evaluate(async () => {
		const response = await fetch('/api/wallet');
		return ((await response.json()) as { balance: number }).balance;
	});
}

async function practise(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Practice vs bots' }).click();
	await expect(seated(page)).toBeVisible();
	await expect(page.getByText('Practice', { exact: true })).toBeVisible();
	await expect(page.locator('.seat .bot')).toHaveCount(1);
	await expect(page.locator('.seat[data-seat]')).toHaveCount(2);
	await expect(page.locator('.seat[data-seat="1"]')).toContainText('RiverMind Easy');
}

/**
 * Check or call at every turn until the guest is out of practice chips.
 * RiverMind Easy folds to most raises but bets its strong hands, so calling
 * them down is the sure way to lose; the test server's practice stack is 300.
 */
async function callUntilBust(page: Page): Promise<void> {
	const panel = page.getByRole('group', { name: 'Your action' });
	const call = panel.getByRole('button', { name: /^(Check|Call \d+)/ });
	const out = page.getByRole('group', { name: 'Out of practice chips' });
	const deadline = Date.now() + 150_000;
	while (!(await out.isVisible()) && Date.now() < deadline) {
		// A short timeout: the turn may end as we click, and the button with it.
		if (await call.isVisible()) await call.click({ timeout: 1000 }).catch(() => {});
		else await page.waitForTimeout(100);
	}
	await expect(out).toBeVisible();
}

/** Wait until the hand number reaches `target` without acting (the guest may be out of chips). */
async function dealt(page: Page, target: number): Promise<void> {
	await expect.poll(() => handNumber(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(target);
}

test('a new guest practises in one click, reloads and plays again after a bust', async ({
	page,
	cspViolations
}) => {
	test.setTimeout(240_000);
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Practice vs bots' })).toBeVisible();
	const before = await balance(page);
	await practise(page);
	await noOverflow(page);
	// The first hand is dealt at once, with no buy-in.
	await dealt(page, 1);
	await expect(seated(page).locator('img')).toHaveCount(2);

	// A reload comes back to the same practice table.
	const tableId = await tableIdOf(page);
	await page.reload();
	await expect(seated(page)).toBeVisible();
	expect(await tableIdOf(page)).toBe(tableId);
	await expect(page.getByText('Practice', { exact: true })).toBeVisible();
	await callUntilBust(page);
	await noOverflow(page);
	const bust = await handNumber(page);
	await page.getByRole('button', { name: /^Play again with 300 chips$/ }).click();
	await expect(page.getByRole('group', { name: 'Out of practice chips' })).toHaveCount(0);
	await dealt(page, bust + 1);
	expect(await balance(page)).toBe(before);

	// Practice hands are labelled in “Your hands”, and leaving keeps the wallet as it was.
	await page.getByRole('button', { name: /Leave table/ }).click();
	await expect(page.getByRole('button', { name: 'Practice vs bots' })).toBeVisible();
	expect(await balance(page)).toBe(before);
	await page.goto('/hands');
	const rows = page.getByRole('region', { name: 'Hands' }).getByRole('listitem');
	await expect(rows.first()).toContainText('Practice');
	expect(cspViolations).toEqual([]);
});

test('a guest with no chips left can still practise', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Practice vs bots' })).toBeVisible();
	// Spend the whole wallet on two tables.
	await page.evaluate(async () => {
		for (let i = 0; i < 2; i += 1) {
			const response = await fetch('/api/tables', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ seats: 2, bots: 'random', big_blind: 100, buy_in: 10000 })
			});
			if (!response.ok) throw new Error(await response.text());
		}
	});
	expect(await balance(page)).toBe(0);
	await page.reload();
	await expect(page.getByRole('status').filter({ hasText: 'Your play chips' })).toContainText('0');
	await practise(page);
	await dealt(page, 1);
	await expect(seated(page).locator('img')).toHaveCount(2);
	expect(await balance(page)).toBe(0);
});

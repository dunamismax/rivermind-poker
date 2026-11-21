// The player journey P5.9 verifies, for the test server (journey.e2e.ts) and a
// deployed site (journey.live.ts): practice in one click, the evaluated
// heads-up opponent, a finished hand opened from its result, and another hand
// at the same table, with the wallet unchanged.
import type { Page } from '@playwright/test';
import { expect, handNumber, noOverflow, playUntil, seated, tableIdOf } from './fixtures.ts';
import { checkReview, felt, keepPlaying, ourTurn, panel, review } from './review.ts';

const bot = (page: Page) => page.locator('.seat[data-seat="1"]');

/**
 * Practice, RiverMind Hard, a finished hand reviewed from its result, and another hand.
 *
 * @param wallet Reads the guest's wallet; what it returns must be the same afterwards.
 * @param handMs How long a hand may take: live tables pause between hands and bots take their time.
 */
export async function journey(
	page: Page,
	wallet: () => Promise<unknown>,
	handMs = 90_000
): Promise<void> {
	const before = await wallet();

	// One click starts a practice hand against RiverMind Easy.
	await page.getByRole('button', { name: 'Practice vs bots' }).click();
	await expect(seated(page)).toBeVisible();
	await expect(page.getByText('Practice', { exact: true })).toBeVisible();
	await expect(bot(page)).toContainText('RiverMind Easy');
	await expect.poll(() => handNumber(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
	const tableId = await tableIdOf(page);

	// Choose the evaluated opponent: it sits down when the hand in progress ends.
	await page.getByRole('button', { name: 'Opponent', exact: true }).click();
	const choices = page.getByRole('group', { name: 'Practice opponent' });
	await choices.getByRole('button', { name: 'RiverMind Hard', exact: true }).click();
	await expect(choices).toHaveCount(0);
	await keepPlaying(page, async () =>
		((await bot(page).textContent()) ?? '').includes('RiverMind Hard')
	);
	const arrived = await handNumber(page);

	// Finish a hand against it. Sitting out keeps its result on the table.
	await keepPlaying(page, async () => (await handNumber(page)) > arrived, handMs);
	await ourTurn(page, handMs);
	await page.getByRole('button', { name: 'Sit out next hand' }).click();
	await expect(page.getByRole('button', { name: 'I’m back' })).toBeVisible();
	const reviewHand = page.getByRole('button', { name: 'Review hand', exact: true });
	await playUntil(page, () => reviewHand.isVisible(), handMs);
	const settled = await handNumber(page);

	// Open that hand from its result: it is the stored hand, played against the trained bot.
	await reviewHand.click();
	const stored = await checkReview(page, settled);
	expect(stored.hand.practice).toBe(true);
	expect(stored.hand.table_id).toBe(tableId);
	expect(stored.seats.find((seat) => !seat.you)).toMatchObject({ kind: 'bot', bot: 'hard' });
	await expect(
		review(page).getByRole('listitem').filter({ hasText: 'RiverMind Hard' })
	).toHaveCount(1);
	await noOverflow(page);

	// Return to the same table and play again.
	await review(page).getByRole('button', { name: 'Close' }).click();
	await expect(review(page)).toHaveCount(0);
	expect(await tableIdOf(page)).toBe(tableId);
	expect(await handNumber(page)).toBe(settled);
	await page.getByRole('button', { name: 'I’m back' }).click();
	await keepPlaying(page, async () => (await handNumber(page)) > settled, handMs);
	await ourTurn(page, handMs);
	const next = await felt(page);
	await panel(page)
		.getByRole('button', { name: /^(Check|Call \d+)$/ })
		.click();
	await expect.poll(() => felt(page), { timeout: 15_000 }).not.toBe(next);
	await expect(bot(page)).toContainText('RiverMind Hard');

	// Practice never touched the wallet: the same balance and the same ledger, entry for entry.
	await page.getByRole('button', { name: /Leave table/ }).click();
	await expect(page.getByRole('button', { name: 'Practice vs bots' })).toBeVisible();
	expect(await wallet()).toEqual(before);
}

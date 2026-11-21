import type { Locator, Page } from '@playwright/test';
import { expect, handNumber, noOverflow, playUntil, sitDown, tableIdOf, test } from './fixtures.ts';
import { checkReview, felt, keepPlaying, ourTurn, panel, review } from './review.ts';

// Replay from the table (P6.1): a player reviews a settled hand without leaving
// the table, steps through it, plays on with the review open, closes it and
// acts in the next hand. Checked at a practice table and at a wallet-backed one,
// on desktop and phone, against the hand the server stored.

/** Open a review, play on under it, close it, then review the settled hand and play again. */
async function reviewAndReturn(page: Page, close: (button: Locator) => Promise<void>) {
	// A hand has finished and another is under way, at our turn: nothing moves until we act.
	await keepPlaying(page, async () => (await handNumber(page)) >= 2);
	await ourTurn(page);
	const last = (await handNumber(page)) - 1;
	await page.getByRole('button', { name: 'Review last hand' }).click();
	await expect(review(page)).toBeVisible();
	await expect(page.getByRole('region', { name: 'Hand log' })).toHaveCount(0);
	await checkReview(page, last);

	// The hand in progress is still ours to play: the review says so, with the
	// clock, and the action panel is on screen and takes the action.
	await ourTurn(page);
	await expect(review(page).getByText('Your turn at the table')).toBeVisible();
	await expect(review(page)).toContainText(/\d+s/);
	const call = panel(page).getByRole('button', { name: /^(Check|Call \d+)$/ });
	await expect(call).toBeEnabled();
	await expect(call).toBeInViewport();
	const before = await felt(page);
	await call.click();
	await expect.poll(() => felt(page), { timeout: 15_000 }).not.toBe(before);
	// Hands come and go under the review, which keeps the hand it opened.
	const during = await handNumber(page);
	await keepPlaying(page, async () => (await handNumber(page)) > during);
	await expect(
		review(page).getByRole('heading', { name: `Hand #${last}`, exact: true })
	).toBeVisible();
	await noOverflow(page);
	await close(review(page).getByRole('button', { name: 'Close' }));
	await expect(review(page)).toHaveCount(0);
	await expect(page.getByRole('region', { name: 'Hand log' })).toBeVisible();

	// “Review hand” on a settled result opens that very hand. Sitting out keeps
	// the result on the table: nothing is dealt while the only person sits out.
	await ourTurn(page);
	await page.getByRole('button', { name: 'Sit out next hand' }).click();
	await expect(page.getByRole('button', { name: 'I’m back' })).toBeVisible();
	const reviewHand = page.getByRole('button', { name: 'Review hand', exact: true });
	await playUntil(page, () => reviewHand.isVisible());
	const settled = await handNumber(page);
	await reviewHand.click();
	await checkReview(page, settled);
	await close(review(page).getByRole('button', { name: 'Close' }));
	await expect(review(page)).toHaveCount(0);

	// Back at the same table, the next hand is dealt and played.
	expect(await handNumber(page)).toBe(settled);
	await page.getByRole('button', { name: 'I’m back' }).click();
	await keepPlaying(page, async () => (await handNumber(page)) > settled);
	await ourTurn(page);
	const next = await felt(page);
	await panel(page)
		.getByRole('button', { name: /^(Check|Call \d+)$/ })
		.click();
	await expect.poll(() => felt(page), { timeout: 15_000 }).not.toBe(next);
}

test('a guest reviews a practice hand, plays on and returns to the table', async ({
	page,
	cspViolations
}) => {
	test.setTimeout(240_000);
	await page.goto('/');
	await page.getByRole('button', { name: 'Practice vs bots' }).click();
	await expect(page.getByRole('group', { name: /^Your seat/ })).toBeVisible();
	const tableId = await tableIdOf(page);
	await reviewAndReturn(page, (button) => button.click());
	expect(await tableIdOf(page)).toBe(tableId);
	await expect(page.getByText('Practice', { exact: true })).toBeVisible();
	expect(cspViolations).toEqual([]);
});

test('a player reviews a hand at a wallet-backed table and plays on', async ({
	page,
	cspViolations
}) => {
	test.setTimeout(240_000);
	await sitDown(page, 2);
	const tableId = await tableIdOf(page);
	// The keyboard closes the review as well as a click does.
	await reviewAndReturn(page, async (button) => {
		await button.focus();
		await page.keyboard.press('Enter');
	});
	expect(await tableIdOf(page)).toBe(tableId);
	expect(cspViolations).toEqual([]);
});

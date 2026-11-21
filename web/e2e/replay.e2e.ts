import type { Locator, Page } from '@playwright/test';
import type { HandDetail } from '../src/lib/protocol-v2.ts';
import { expect, handNumber, noOverflow, playUntil, sitDown, tableIdOf, test } from './fixtures.ts';

// Replay from the table (P6.1): a player reviews a settled hand without leaving
// the table, steps through it, plays on with the review open, closes it and
// acts in the next hand. Checked at a practice table and at a wallet-backed one,
// on desktop and phone, against the hand the server stored.

const signed = (n: number) => (n > 0 ? `+${n.toLocaleString('en-US')}` : n.toLocaleString('en-US'));
const panel = (page: Page) => page.getByRole('group', { name: 'Your action' });
const review = (page: Page) => page.getByRole('region', { name: 'Hand review' });

/**
 * Check, call or fold until `done` holds. The test server's practice stack is
 * three big blinds, so a guest often runs out: a fresh one is one click.
 */
async function keepPlaying(page: Page, done: () => Promise<boolean>): Promise<void> {
	const again = page.getByRole('button', { name: /^Play again with/ });
	await playUntil(
		page,
		async () => {
			if (await again.isVisible()) await again.click({ timeout: 1000 }).catch(() => {});
			return done();
		},
		90_000
	);
}

/**
 * Wait for our turn without acting, so nothing moves until we do. (Not
 * `keepPlaying` until the panel shows: it may act on a panel that came up
 * after it last looked, and then report the turn that action ended.)
 */
async function ourTurn(page: Page): Promise<void> {
	const again = page.getByRole('button', { name: /^Play again with/ });
	const call = panel(page).getByRole('button', { name: /^(Check|Call \d+)$/ });
	await expect(async () => {
		if (await again.isVisible()) await again.click({ timeout: 1000 }).catch(() => {});
		await expect(call).toBeEnabled({ timeout: 500 });
	}).toPass({ timeout: 60_000 });
}

/** The hand as the server stored it for this player. */
async function storedHand(page: Page, handNo: number): Promise<HandDetail> {
	const tableId = await tableIdOf(page);
	return page.evaluate(
		async ([table, wanted]) => {
			const list = (await (await fetch('/api/hands?limit=50')).json()) as {
				hands: { hand_id: string; table_id: string; hand_no: number }[];
			};
			const found = list.hands.find((h) => h.table_id === table && h.hand_no === wanted);
			if (!found) throw new Error(`hand ${wanted} is not among this player's hands`);
			return (await fetch(`/api/hands/${found.hand_id}`)).json();
		},
		[tableId, handNo] as const
	);
}

/** What the table shows of the hand in progress, to tell that an action was taken. */
async function felt(page: Page): Promise<string> {
	return page.locator('.nl-table .meta, .nl-table .centre').allInnerTexts().then(String);
}

/** The open review shows hand `handNo` as the server stored it, and steps through it. */
async function checkReview(page: Page, handNo: number): Promise<void> {
	const open = review(page);
	await expect(open.getByRole('heading', { name: `Hand #${handNo}`, exact: true })).toBeVisible();
	const replay = open.locator('.replay');
	const status = replay.getByRole('status');
	const steps = Number(await replay.getAttribute('data-steps'));
	expect(steps).toBeGreaterThanOrEqual(2);
	// It opens on the result: who won each pot and why, and what the hand cost or paid each seat.
	await expect(replay).toHaveAttribute('data-step', String(steps));
	const stored = await storedHand(page, handNo);
	const rows = open.getByRole('listitem');
	await expect(rows).toHaveCount(stored.seats.length);
	const nameOf = (seat: number) => stored.seats.find((s) => s.seat === seat)!.name;
	for (const seat of stored.seats) {
		await expect(rows.filter({ hasText: seat.name }).locator('.net')).toHaveText(signed(seat.net));
	}
	for (const pot of stored.pots) {
		await expect(status).toContainText(`of ${pot.amount.toLocaleString('en-US')}`);
		for (const winner of pot.winners) await expect(status).toContainText(nameOf(winner));
	}
	if (!stored.hand.showdown) await expect(status).toContainText('everyone else folded');
	// Only cards the viewer may see: their own, and the hands shown at showdown.
	const mine = rows.filter({ hasText: 'You' });
	const others = rows.filter({ hasNotText: 'You' });
	const shown = stored.seats.filter((s) => !s.you && s.shown).length;
	await expect(mine.locator('img.face')).toHaveCount(2);
	await expect(others.locator('img.face')).toHaveCount(2 * shown);
	await noOverflow(page);

	// Back at the blinds: no board yet, and every other hand face down.
	await open.getByRole('button', { name: 'First' }).click();
	await expect(replay).toHaveAttribute('data-step', '1');
	await expect(status).toContainText(/posts the (small|big) blind/);
	await expect(replay.locator('.board img.slot')).toHaveCount(5);
	await expect(mine.locator('img.face')).toHaveCount(2);
	await expect(others.locator('img.face')).toHaveCount(0);
	await expect(open.getByRole('button', { name: 'Back' })).toBeDisabled();
	// The arrow keys step from anywhere on the page; the buttons do the same.
	await page.keyboard.press('ArrowRight');
	await expect(replay).toHaveAttribute('data-step', '2');
	await page.keyboard.press('ArrowLeft');
	await expect(replay).toHaveAttribute('data-step', '1');
	await open.getByRole('button', { name: 'Next' }).click();
	await expect(replay).toHaveAttribute('data-step', '2');
	await open.getByRole('button', { name: 'Last' }).click();
	await expect(replay).toHaveAttribute('data-step', String(steps));
	await expect(open.getByRole('button', { name: 'Next' })).toBeDisabled();
}

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

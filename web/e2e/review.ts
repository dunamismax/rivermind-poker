// Reviewing a hand at the table (P6.1), for the tests that do it: waiting for
// our turn, playing on, and checking an open review against the stored hand.
import type { Page } from '@playwright/test';
import type { HandDetail } from '../src/lib/protocol-v2.ts';
import { expect, noOverflow, playUntil, tableIdOf } from './fixtures.ts';

export const signed = (n: number) =>
	n > 0 ? `+${n.toLocaleString('en-US')}` : n.toLocaleString('en-US');
export const panel = (page: Page) => page.getByRole('group', { name: 'Your action' });
export const review = (page: Page) => page.getByRole('region', { name: 'Hand review' });

/**
 * Check, call or fold until `done` holds. The test server's practice stack is
 * three big blinds, so a guest often runs out: a fresh one is one click.
 */
export async function keepPlaying(
	page: Page,
	done: () => Promise<boolean>,
	timeoutMs = 90_000
): Promise<void> {
	const again = page.getByRole('button', { name: /^Play again with/ });
	await playUntil(
		page,
		async () => {
			if (await again.isVisible()) await again.click({ timeout: 1000 }).catch(() => {});
			return done();
		},
		timeoutMs
	);
}

/**
 * Wait for our turn without acting, so nothing moves until we do. (Not
 * `keepPlaying` until the panel shows: it may act on a panel that came up
 * after it last looked, and then report the turn that action ended.)
 */
export async function ourTurn(page: Page, timeoutMs = 60_000): Promise<void> {
	const again = page.getByRole('button', { name: /^Play again with/ });
	const call = panel(page).getByRole('button', { name: /^(Check|Call \d+)$/ });
	await expect(async () => {
		if (await again.isVisible()) await again.click({ timeout: 1000 }).catch(() => {});
		await expect(call).toBeEnabled({ timeout: 500 });
	}).toPass({ timeout: timeoutMs });
}

/** The hand as the server stored it for this player. */
export async function storedHand(page: Page, handNo: number): Promise<HandDetail> {
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
export async function felt(page: Page): Promise<string> {
	return page.locator('.nl-table .meta, .nl-table .centre').allInnerTexts().then(String);
}

/** The open review shows hand `handNo` as the server stored it, and steps through it. Returns the stored hand. */
export async function checkReview(page: Page, handNo: number): Promise<HandDetail> {
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
	return stored;
}

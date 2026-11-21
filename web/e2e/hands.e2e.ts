import type { Locator } from '@playwright/test';
import type { Card } from '../src/lib/protocol-v2.ts';
import { cardName } from '../src/lib/wording.ts';
import { expect, nameOf, noOverflow, playUntilHand, sitDown, test } from './fixtures.ts';

// Fair dealing and transparency (P4.6): a player opens the hands they played,
// with their cards and the board, and reads how dealing works.

test('a player reviews the hands they played', async ({ page, cspViolations }) => {
	test.setTimeout(150_000);
	await sitDown(page, 2);
	const me = await nameOf(page);
	await playUntilHand(page, 3, 90_000);
	await page.goto('/hands');
	const hands = page.getByRole('region', { name: 'Hands' });
	const rows = hands.getByRole('listitem');
	await expect(rows.first()).toBeVisible();
	expect(await rows.count()).toBeGreaterThanOrEqual(2);
	await expect(rows.first()).toContainText(/hand #\d+/);
	await noOverflow(page);

	await rows.first().getByRole('button').click();
	const detail = page.getByRole('region', { name: /^Hand \d+ at / });
	await expect(detail).toBeVisible();
	const mine = detail.getByRole('listitem').filter({ hasText: 'You' });
	await expect(mine).toContainText(me);
	await expect(mine.locator('img')).toHaveCount(2);
	await expect(detail.locator('pre')).toContainText(me);
	await expect(detail.locator('pre')).toContainText('*** Result ***');
	await noOverflow(page);

	// The hand opens on its result and steps back to the blinds and forward again (P6.1).
	const replay = detail.locator('.replay');
	const steps = await replay.getAttribute('data-steps');
	await expect(replay).toHaveAttribute('data-step', steps!);
	await expect(replay.getByRole('status')).toContainText(/the pot of [\d,]+/);
	await expect(mine.locator('.net')).toHaveText(/^[+-]?[\d,]+$/);
	await detail.getByRole('button', { name: 'First' }).click();
	await expect(replay).toHaveAttribute('data-step', '1');
	await expect(replay.getByRole('status')).toContainText(`posts the`);
	await expect(replay.locator('.board img.slot')).toHaveCount(5);
	await expect(mine.locator('img.face')).toHaveCount(2);
	await page.keyboard.press('ArrowRight');
	await expect(replay).toHaveAttribute('data-step', '2');
	await detail.getByRole('button', { name: 'Last' }).click();
	await expect(replay).toHaveAttribute('data-step', steps!);
	await noOverflow(page);

	// Another hand opened over this one shows its own board and cards, not the first hand's.
	const second = await page.evaluate(async () => {
		const list = (await (await fetch('/api/hands?limit=2')).json()) as {
			hands: { hand_id: string; hand_no: number }[];
		};
		const hand = list.hands[1];
		const stored = (await (await fetch(`/api/hands/${hand.hand_id}`)).json()) as {
			hand: { board: { rank: number; suit: string }[]; cards: { rank: number; suit: string }[] };
		};
		return { handNo: hand.hand_no, board: stored.hand.board, cards: stored.hand.cards };
	});
	await rows.nth(1).getByRole('button').click();
	const other = page.getByRole('region', { name: new RegExp(`^Hand ${second.handNo} at `) });
	await expect(other).toBeVisible();
	const alts = (cards: Locator) =>
		cards.evaluateAll((imgs) => imgs.map((img) => img.getAttribute('alt')));
	await expect
		.poll(() => alts(other.locator('.replay .board img.face')))
		.toEqual(second.board.map((card) => cardName(card as Card)));
	await expect
		.poll(() => alts(other.getByRole('listitem').filter({ hasText: 'You' }).locator('img')))
		.toEqual(second.cards.map((card) => cardName(card as Card)));

	// The link to a hand opens it again.
	const url = new URL(page.url());
	const handId = await page.evaluate(async () => {
		const response = await fetch('/api/hands?limit=1');
		return ((await response.json()) as { hands: { hand_id: string }[] }).hands[0].hand_id;
	});
	await page.goto(`/hands?hand=${handId}`);
	await expect(page.getByRole('region', { name: /^Hand \d+ at / })).toBeVisible();
	expect(url.pathname).toBe('/hands');

	await page.getByRole('link', { name: 'How dealing works' }).click();
	await expect(page.getByRole('heading', { name: 'Rules and fair dealing' })).toBeVisible();
	await expect(page.getByText('crypto.randomInt')).toBeVisible();
	await noOverflow(page);
	await page.getByRole('link', { name: 'Your hands' }).click();
	await expect(page).toHaveURL(/\/hands$/);
	expect(cspViolations).toEqual([]);
});

test('the lobby links to the hands and the rules', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('link', { name: 'Rules and fair dealing' }).click();
	await expect(page).toHaveURL(/\/fairness$/);
	await page.goBack();
	await page.getByRole('link', { name: 'Your hands' }).click();
	await expect(page.getByText(/No hands yet/)).toBeVisible();
});

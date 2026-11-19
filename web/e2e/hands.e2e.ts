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
	await expect(page.getByText('secrets.SystemRandom')).toBeVisible();
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

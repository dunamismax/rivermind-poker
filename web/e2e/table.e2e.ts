import { expect, playHand, sitDown, test } from './fixtures.ts';

test('plays three consecutive hands against random bots', async ({ page, cspViolations }) => {
	await sitDown(page);
	for (let hand = 1; hand <= 3; hand += 1) {
		await expect(page.locator('.log li').first()).toHaveText(`Hand ${hand}`);
		await playHand(page);
		await expect(page.locator('.balance')).toHaveText(/^Session [+-]?\d+$/);
		if (hand < 3) await page.getByRole('button', { name: 'Next hand' }).click();
	}
	expect(cspViolations).toEqual([]);
});

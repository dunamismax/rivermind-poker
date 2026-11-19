import type { Page } from '@playwright/test';
import { expect, testNl as test } from './fixtures.ts';

// The no-limit table (P3.6) against a real `serve-nl`, at 2, 6 and 9 seats.

async function sitDown(
	page: Page,
	seats: number,
	{ bots = /Calling bot/, buyIn }: { bots?: RegExp; buyIn?: RegExp } = {}
): Promise<void> {
	await page.goto('/nl');
	await page.getByRole('radio', { name: String(seats), exact: true }).check({ force: true });
	await page.getByRole('radio', { name: bots }).check({ force: true });
	if (buyIn) {
		const select = page.getByRole('combobox', { name: 'Buy-in' });
		const option = select.getByRole('option', { name: buyIn });
		await select.selectOption((await option.getAttribute('value')) ?? '');
	}
	await page.getByRole('button', { name: 'Sit down' }).click();
	await expect(page.getByRole('group', { name: /^Your seat/ })).toBeVisible();
}

async function handNumber(page: Page): Promise<number> {
	const text = (await page.locator('.meta').textContent()) ?? '';
	return Number(/Hand #(\d+)/.exec(text)?.[1] ?? 0);
}

/** Check or call on each of our turns until `done` holds. */
async function playUntil(page: Page, done: () => Promise<boolean>): Promise<void> {
	const panel = page.getByRole('group', { name: 'Your action' });
	const call = panel.getByRole('button', { name: /^(Check|Call \d+)$/ });
	for (let i = 0; i < 300 && !(await done()); i += 1) {
		if (await call.isVisible()) {
			await call.click({ timeout: 1000 }).catch(() => {}); // the turn may end as we click
		} else {
			await page.waitForTimeout(100);
		}
	}
	expect(await done()).toBe(true);
}

async function playUntilHand(page: Page, target: number): Promise<void> {
	await playUntil(page, async () => (await handNumber(page)) >= target);
}

async function noOverflow(page: Page): Promise<void> {
	const widths = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
	expect(widths[0]).toBeLessThanOrEqual(widths[1]);
}

for (const seats of [2, 6, 9]) {
	test(`plays hands at ${seats} seats`, async ({ page, cspViolations }) => {
		await sitDown(page, seats);
		await expect(page.locator('.seat[data-seat]')).toHaveCount(seats);
		await expect(page.locator('.seat .bot')).toHaveCount(seats - 1); // every bot is labelled
		await expect(page.getByRole('group', { name: /^Your seat/ }).locator('img')).toHaveCount(2);
		await expect(page.locator('.seat.acting .ring')).toHaveCount(1); // someone's clock is running
		await playUntilHand(page, 3);
		await expect(page.getByRole('region', { name: 'Hand log' })).toContainText(
			/Hand #\d+ · .+ has the button/
		);
		await noOverflow(page);
		expect(cspViolations).toEqual([]);
	});
}

test('bets with the presets and the slider', async ({ page, cspViolations }) => {
	await sitDown(page, 6);
	const panel = page.getByRole('group', { name: 'Your action' });
	const raise = panel.getByRole('button', { name: /^(Bet|Raise to) \d+/ });
	await expect(raise).toBeVisible({ timeout: 15_000 });
	const pot = panel.getByRole('button', { name: /^Pot: \d+$/ });
	const amount = Number(/(\d+)$/.exec((await pot.getAttribute('aria-label')) ?? '')?.[1]);
	await pot.click();
	await expect(raise).toHaveText(new RegExp(`^(Bet|Raise to) ${amount}`));
	// A typed amount past the maximum is clamped to the all-in.
	const allIn = panel.getByRole('button', { name: /^All-in: \d+$/ });
	const max = Number(/(\d+)$/.exec((await allIn.getAttribute('aria-label')) ?? '')?.[1]);
	const box = panel.getByRole('spinbutton');
	await box.fill(String(max + 5000));
	await box.blur();
	await expect(raise).toHaveText(new RegExp(`${max} \\(all-in\\)$`));
	await panel.getByRole('button', { name: /^Min: \d+$/ }).click();
	const min = Number(/(\d+)$/.exec((await raise.textContent()) ?? '')?.[1]);
	await raise.click();
	await expect(page.getByRole('region', { name: 'Hand log' })).toContainText(
		new RegExp(`(bets|raises to) ${min}`)
	);
	expect(cspViolations).toEqual([]);
});

test('sits out, comes back, rebuys and leaves', async ({ page, cspViolations }) => {
	await sitDown(page, 3, { buyIn: /40 big blinds/ });
	await expect(page.getByRole('group', { name: /^Your seat/ })).toContainText(/39\d\d|4000/);
	await page.getByRole('button', { name: 'Sit out next hand' }).click();
	await expect(page.getByRole('button', { name: 'I’m back' })).toBeVisible();
	// The hand plays out; then no hand is dealt while the only person sits out.
	const sittingOut = page.getByText('You are sitting out.');
	await playUntil(page, () => sittingOut.isVisible());
	const hand = await handNumber(page);
	await page.waitForTimeout(1500);
	expect(await handNumber(page)).toBe(hand);
	await page.getByRole('button', { name: 'I’m back' }).click();
	await expect(page.getByRole('group', { name: 'Your action' })).toBeVisible({ timeout: 15_000 });
	// Down the blinds, there is room to rebuy, added when the hand ends.
	const rebuy = page.getByRole('spinbutton', { name: 'Rebuy amount' });
	await rebuy.fill('25');
	await page.getByRole('button', { name: 'Rebuy' }).click();
	await expect(
		page
			.getByText(/^\+25 after this hand$/)
			.or(page.getByRole('region', { name: 'Hand log' }).getByText(/adds 25/))
	).toBeVisible();
	await page.getByRole('button', { name: 'Leave table' }).click();
	await expect(page.getByRole('button', { name: 'Sit down' })).toBeVisible();
	expect(cspViolations).toEqual([]);
});

test('rejoins the same table after a reload', async ({ page }) => {
	await sitDown(page, 9);
	await playUntilHand(page, 2);
	const names = await page.locator('.seat .name').allTextContents();
	const mine = await page
		.getByRole('group', { name: /^Your seat/ })
		.locator('img')
		.evaluateAll((cards) => cards.map((card) => card.getAttribute('alt')));
	const hand = await handNumber(page);
	await page.reload();
	await expect(page.getByRole('group', { name: /^Your seat/ })).toBeVisible();
	expect(await page.locator('.seat .name').allTextContents()).toEqual(names);
	if ((await handNumber(page)) === hand) {
		const again = await page
			.getByRole('group', { name: /^Your seat/ })
			.locator('img')
			.evaluateAll((cards) => cards.map((card) => card.getAttribute('alt')));
		expect(again).toEqual(mine); // the same hand, the same cards
	}
	await playUntilHand(page, hand + 1);
});

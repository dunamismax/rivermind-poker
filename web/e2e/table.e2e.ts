import {
	expect,
	handNumber,
	newTableForm,
	noOverflow,
	playUntil,
	playUntilHand,
	sitDown,
	test
} from './fixtures.ts';
import { newContext } from './look.ts';

// The no-limit table (P3.6) against the Node table server, at 2, 6 and 9 seats.

for (const seats of [2, 6, 9]) {
	test(`plays hands at ${seats} seats`, async ({ page, cspViolations }) => {
		await sitDown(page, seats);
		await expect(page.locator('.seat[data-seat]')).toHaveCount(seats);
		await expect(page.locator('.seat .bot')).toHaveCount(seats - 1); // every bot is labelled
		await expect(page.getByRole('group', { name: /^Your seat/ }).locator('img')).toHaveCount(2);
		await expect(page.locator('.seat.acting .clock')).toHaveCount(1); // someone's clock is running
		await noOverflow(page); // the ring stays inside the page at the edge seats too
		await playUntilHand(page, 3);
		await expect(page.getByRole('region', { name: 'Hand log' })).toContainText(
			/Hand #\d+ · .+ has the button/
		);
		await noOverflow(page);
		expect(cspViolations).toEqual([]);
	});
}

// A phone's first screen is the whole game: the bar, every seat, the board, the viewer's cards
// and the action panel, with nothing under the panel and nothing to scroll for. The sizes are
// what an iPhone's browser leaves with its toolbars showing (402 × 677 is Brave on a 17 Pro).
for (const [seats, width, height] of [
	[9, 402, 677],
	[9, 440, 760],
	[6, 390, 664],
	[2, 402, 677]
]) {
	test(`shows a ${seats}-seat table and the action panel on one ${width} × ${height} screen`, async ({
		page,
		cspViolations
	}, testInfo) => {
		test.skip(!testInfo.project.name.endsWith('-phone'), 'the phone layout');
		await page.setViewportSize({ width, height });
		// The lobby's form is below its first screen, so the page is scrolled when the table opens.
		await sitDown(page, seats);
		await expect(page.getByRole('group', { name: 'Your action' })).toBeVisible({ timeout: 15_000 });
		await expect(page.locator('header.topbar')).toBeHidden();
		await expect(page.locator('.bar .lamp')).toBeVisible();
		const misplaced = () =>
			page.evaluate(() => {
				const out: string[] = [];
				if (scrollY !== 0) out.push(`scrolled to ${scrollY}`);
				const panel = document.querySelector('.panel')!.getBoundingClientRect();
				if (panel.bottom > innerHeight + 0.5) out.push('the panel is below the screen');
				const parts =
					'.bar, .felt, .board, .pot-line, .bet, .seat .plate, .seat .tags > *, .seat .clock, .seat.me .hand img, .seat .mini-cards';
				for (const part of document.querySelectorAll(parts)) {
					const box = part.getBoundingClientRect();
					if (box.width === 0 || box.height === 0) continue;
					const name = `${part.closest('.seat')?.getAttribute('aria-label') ?? ''} ${part.classList[0]}`;
					if (box.top < 0 || box.left < 0 || box.right > innerWidth + 0.5) {
						out.push(`${name} is off the screen`);
					}
					if (box.bottom > panel.top + 0.5) {
						out.push(`${name} is ${Math.round(box.bottom - panel.top)}px under the panel`);
					}
				}
				return out;
			});
		// Retried, while the panel slides into place and the bets land.
		await expect.poll(misplaced).toEqual([]);
		await noOverflow(page);
		// The seat tools, the hand log and the play-money note are below, a scroll away.
		const log = page.getByRole('region', { name: 'Hand log' });
		await expect(log).not.toBeInViewport();
		await log.scrollIntoViewIfNeeded();
		await expect(log).toBeInViewport();
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
	// The action panel opens above these buttons on the first turn and moves
	// them; click once it is open, while nothing moves until we act.
	await expect(page.getByRole('group', { name: 'Your action' })).toBeVisible({ timeout: 15_000 });
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
	await expect(newTableForm(page).getByRole('button', { name: 'Sit down' })).toBeVisible();
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

test('keeps the player in an HttpOnly session cookie', async ({ page, context, browser }) => {
	await page.goto('/');
	const me = page.locator('header .me');
	await expect(me).toHaveText(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{1,2}$/);
	const name = await me.textContent();
	const [cookie] = (await context.cookies()).filter((c) => c.name === 'rm_session');
	expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
	expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 170 * 24 * 3600);
	// The page can neither read the session nor keeps a token of its own.
	expect(await page.evaluate(() => document.cookie)).not.toContain('rm_session');
	expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toMatch(/token|s1\./);
	// The same browser is the same player after a reload; another browser is someone else.
	await sitDown(page, 2);
	await expect(page.getByRole('group', { name: /^Your seat/ })).toContainText(name ?? '');
	await page.reload();
	await expect(me).toHaveText(name ?? '');
	const other = await newContext(browser);
	const stranger = await other.newPage();
	await stranger.goto(page.url());
	await expect(stranger.locator('header .me')).toHaveText(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{1,2}$/);
	expect(await stranger.locator('header .me').textContent()).not.toBe(name);
	await other.close();
});

test('pays buy-ins from the play-chip wallet and cashes out on leaving', async ({
	page,
	cspViolations
}) => {
	await page.goto('/');
	const wallet = page.getByRole('status').filter({ hasText: 'Your play chips' });
	await expect(wallet).toContainText('20,000');
	await expect(page.getByText(/^Play money only: chips can never be bought/)).toBeVisible();
	// Blinds of 500/1000 need at least 40,000.
	const blinds = newTableForm(page).getByRole('combobox', { name: 'Blinds' });
	await blinds.selectOption('1000');
	await expect(page.getByText(/^Not enough play chips for these blinds/)).toBeVisible();
	await expect(newTableForm(page).getByRole('button', { name: 'Sit down' })).toBeDisabled();
	await blinds.selectOption('100');
	await sitDown(page, 2, { buyIn: /40 big blinds/ });
	await expect(page.getByText(/^Play chips only: they can never be bought/)).toBeVisible();
	await playUntilHand(page, 2);
	await page.getByRole('button', { name: 'Leave table' }).click();
	await expect(newTableForm(page).getByRole('button', { name: 'Sit down' })).toBeVisible();
	// 16,000 stayed in the wallet; whatever the 4,000 became came back.
	const ledger = await page.evaluate(async () => (await fetch('/api/wallet')).json());
	const kinds = ledger.entries.map((e: { kind: string }) => e.kind).reverse();
	const cashOut = ledger.balance - 16_000;
	expect(kinds).toEqual(cashOut > 0 ? ['grant', 'buy_in', 'cash_out'] : ['grant', 'buy_in']);
	await expect(wallet).toContainText(ledger.balance.toLocaleString('en-US'));
	expect(cspViolations).toEqual([]);
});

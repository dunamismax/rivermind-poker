import {
	expect,
	handNumber,
	nameOf,
	playUntil,
	playUntilHand,
	row,
	seated,
	sitDown,
	stranger,
	tableIdOf,
	test
} from './fixtures.ts';

// Two people and a bot at one table (P4.4): they play several hands, one
// loses the connection and comes back to the same seat, and play goes on.

test('two people and a bot play on through a disconnect', async ({
	page,
	browser,
	cspViolations
}) => {
	await sitDown(page, 3);
	const tableId = await tableIdOf(page);
	const bob = await stranger(browser);
	await bob.goto('/');
	await row(bob, tableId).getByRole('button', { name: 'Sit down' }).click();
	await playUntil(page, async () => seated(bob).isVisible());
	const bobName = await nameOf(bob);
	const bobAtAlice = page.locator('.seat').filter({ hasText: bobName });
	await expect(page.locator('.seat .bot')).toHaveCount(1);
	await expect(bob.locator('.seat').filter({ hasText: await nameOf(page) })).toBeVisible();

	let target = (await handNumber(page)) + 2;
	await Promise.all([playUntilHand(page, target, 60_000), playUntilHand(bob, target, 60_000)]);

	// Bob's connection drops: leaving the page closes his socket. His seat
	// stays his, marked away, and the others play on.
	const seat = await seated(bob).getAttribute('data-seat');
	expect(seat).not.toBeNull();
	await bob.goto('about:blank');
	await expect(bobAtAlice).toContainText('Away');
	// Bob comes back to the same seat, no longer away.
	await bob.goto('/');
	await expect(seated(bob)).toHaveAttribute('data-seat', seat!);
	await expect(bobAtAlice).not.toContainText('Away');

	target = (await handNumber(page)) + 2;
	await Promise.all([playUntilHand(page, target, 90_000), playUntilHand(bob, target, 90_000)]);
	await expect(seated(bob).locator('img')).toHaveCount(2);
	await bob.context().close();
	expect(cspViolations).toEqual([]);
});

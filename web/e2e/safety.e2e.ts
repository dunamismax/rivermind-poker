import {
	expect,
	nameOf,
	playUntil,
	row,
	seated,
	sitDown,
	stranger,
	tableIdOf,
	test
} from './fixtures.ts';

// Safety at the table (P4.5): preset reactions show beside the seat, and a
// player can mute, block and report another from the seat's menu.

test('people react, mute, block and report at the table', async ({
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

	// Both sit out, so no turn's action panel moves the controls while they use them.
	for (const p of [page, bob]) await p.getByRole('button', { name: 'Sit out next hand' }).click();
	const out = (p: typeof page) => async () => p.getByText('You are sitting out.').isVisible();
	await Promise.all([playUntil(page, out(page), 60_000), playUntil(bob, out(bob), 60_000)]);

	const bobAtAlice = page.locator('.seat').filter({ hasText: bobName });
	const react = async (text: string) => {
		const group = bob.getByRole('group', { name: 'Reactions' });
		if (!(await group.isVisible())) await bob.getByRole('button', { name: 'React' }).click();
		await group.getByRole('button', { name: text }).click();
	};
	await react('Nice hand');
	await expect(bobAtAlice.locator('.bubble')).toContainText('Nice hand');
	await expect(seated(bob).locator('.bubble')).toContainText('Nice hand');
	await expect(bobAtAlice.locator('.bubble')).toHaveCount(0, { timeout: 8000 });

	// Alice mutes Bob: his reactions no longer reach her.
	await page.getByRole('button', { name: `${bobName}: mute, block or report` }).click();
	const menu = page.getByRole('dialog', { name: `Player ${bobName}` });
	await menu.getByRole('button', { name: 'Mute' }).click();
	await expect(bobAtAlice).toContainText('Muted');
	await expect(menu.getByRole('button', { name: 'Unmute' })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await react('Wow');
	await expect(seated(bob).locator('.bubble')).toContainText('Wow');
	await page.waitForTimeout(1000);
	await expect(bobAtAlice.locator('.bubble')).toHaveCount(0);

	// A report is sent once a day.
	await menu.getByRole('combobox', { name: 'Reason' }).selectOption({ label: 'Playing as a team' });
	await menu.getByRole('button', { name: 'Report' }).click();
	await expect(menu.getByRole('status')).toHaveText('Thanks: the report was sent for review.');
	await menu.getByRole('button', { name: 'Report' }).click();
	await expect(menu.getByRole('status')).toHaveText(
		'You already reported this today; it counts once.'
	);
	// A report of something said in voice says no audio goes with it (P4C.8).
	await expect(menu.locator('[data-report="voice"]')).toHaveCount(0);
	await menu
		.getByRole('combobox', { name: 'Reason' })
		.selectOption({ label: 'Something said in voice' });
	await expect(menu.locator('[data-report="voice"]')).toContainText(
		'Voice is never recorded, so there is no audio to send with this report.'
	);
	await menu.getByRole('button', { name: 'Report' }).click();
	await expect(menu.getByRole('status')).toHaveText('Thanks: the report was sent for review.');

	// A block replaces the mute; unblocking clears it.
	await menu.getByRole('button', { name: 'Block' }).click();
	await expect(bobAtAlice).toContainText('Blocked');
	await menu.getByRole('button', { name: 'Unblock' }).click();
	await expect(bobAtAlice).not.toContainText('Blocked');
	await react('Thanks');
	await expect(bobAtAlice.locator('.bubble')).toContainText('Thanks');
	await menu.getByRole('button', { name: 'Close' }).click();
	await expect(menu).toHaveCount(0);

	// Bots and one's own seat have no menu.
	await expect(page.locator('.seat .name.pick')).toHaveCount(1);
	await bob.context().close();
	expect(cspViolations).toEqual([]);
});

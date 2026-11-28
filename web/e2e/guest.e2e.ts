import { expect, nameOf, noOverflow, sitDown, tableIdOf, test } from './fixtures.ts';

// Deleting a guest (P5D.11): from the lobby a guest opens “Your guest”, deletes
// it after saying so twice, and the next visit is a new guest. A guest still
// seated leaves the table, which closes once no person is at it.

test('a guest deletes themself and starts again as someone new', async ({
	page,
	cspViolations
}) => {
	test.setTimeout(90_000);
	await page.goto('/');
	const link = page
		.getByRole('navigation', { name: 'More' })
		.getByRole('link', { name: 'Your guest' });
	await expect(link).toHaveAttribute('href', '/guest');
	await sitDown(page, 2);
	const me = await nameOf(page);
	const tableId = await tableIdOf(page);
	const before = (await (await page.request.post('/api/session')).json()) as { player_id: string };

	await page.goto('/guest');
	await expect(page.locator('.who .name')).toHaveText(me);
	await noOverflow(page);

	// The first press asks again; keeping the guest changes nothing.
	await page.getByRole('button', { name: 'Delete my guest' }).click();
	await page.getByRole('button', { name: 'Keep my guest' }).click();
	await expect(page.getByRole('button', { name: 'Delete my guest' })).toBeVisible();

	await page.getByRole('button', { name: 'Delete my guest' }).click();
	await page.getByRole('button', { name: 'Delete it for good' }).click();
	await expect(page.getByRole('status')).toContainText('Your guest has been deleted.');
	await noOverflow(page);

	// Their session is gone: the API no longer knows them, and their table seat is a bot's.
	expect((await page.request.get('/api/wallet')).status()).toBe(401);
	await page.getByRole('link', { name: 'Play as a new guest' }).click();
	const after = (await (await page.request.post('/api/session')).json()) as {
		player_id: string;
		name: string;
		created: boolean;
	};
	expect(after.player_id).not.toBe(before.player_id);
	// A hand under way keeps the seat until it ends (they check or fold); then the
	// table, with no person left, closes.
	const listed = async () =>
		(
			(await (await page.request.get('/api/tables')).json()) as {
				tables: { table_id: string }[];
			}
		).tables.map((t) => t.table_id);
	await expect.poll(listed, { timeout: 30_000 }).not.toContain(tableId);
	expect(cspViolations).toEqual([]);
});

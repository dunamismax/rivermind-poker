import type { Browser, Page } from '@playwright/test';
import {
	expect,
	handNumber,
	newTableForm,
	noOverflow,
	playUntil,
	playUntilHand,
	sitDown,
	tableIdOf,
	test
} from './fixtures.ts';

// The lobby (P4.3): people find each other's tables in the live list, take a
// bot's seat, join a private table by its invite link and wait in line for a
// full table. Each person is a separate browser context, so a separate player.

async function stranger(browser: Browser): Promise<Page> {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	return context.newPage();
}

async function nameOf(page: Page): Promise<string> {
	const me = page.locator('header .me');
	await expect(me).toHaveText(/\S/);
	return (await me.textContent()) ?? '';
}

function row(page: Page, tableId: string) {
	return page.locator(`li[data-table="${tableId}"]`);
}

const seated = (page: Page) => page.getByRole('group', { name: /^Your seat/ });

test('two people find each other in the lobby and play together', async ({
	page,
	browser,
	cspViolations
}) => {
	await sitDown(page, 3);
	const tableId = await tableIdOf(page);
	const bob = await stranger(browser);
	await bob.goto('/');
	const listed = row(bob, tableId);
	await expect(listed).toContainText('1 person · 2 bots');
	await noOverflow(bob);
	// Bob takes a bot's seat; the bot finishes its hand first, then Bob sits.
	await listed.getByRole('button', { name: 'Sit down' }).click();
	await expect(bob.getByRole('button', { name: 'Lobby' }).or(seated(bob))).toBeVisible();
	await playUntil(page, async () => seated(bob).isVisible());
	const bobName = await nameOf(bob);
	await expect(page.locator('.seat').filter({ hasText: bobName })).toBeVisible();
	await expect(page.locator('.seat .bot')).toHaveCount(1); // one bot left, still labelled
	// Both play on; each sees only their own cards.
	const target = (await handNumber(page)) + 2;
	await Promise.all([playUntilHand(page, target, 60_000), playUntilHand(bob, target, 60_000)]);
	await expect(seated(bob).locator('img')).toHaveCount(2);
	await bob.context().close();
	expect(cspViolations).toEqual([]);
});

test('joins a private table with its invite link', async ({ page, browser, cspViolations }) => {
	await sitDown(page, 2, { privateTable: true });
	const tableId = await tableIdOf(page);
	await page.getByRole('button', { name: 'Invite' }).click();
	const link = await page.getByRole('textbox', { name: 'Invite link' }).inputValue();
	expect(link).toMatch(/\/\?invite=[\w-]{16}$/);
	const bob = await stranger(browser);
	await bob.goto('/');
	await expect(
		bob.getByRole('list', { name: 'Open tables' }).or(bob.getByText(/^No tables match/))
	).toBeVisible();
	await expect(row(bob, tableId)).toHaveCount(0); // private tables are not listed
	await bob.goto(link);
	const invite = bob.getByRole('region', { name: 'You are invited' });
	await expect(invite).toContainText('2-seat table');
	await invite.getByRole('button', { name: 'Take a seat' }).click();
	await expect(bob).toHaveURL(/\/$/); // the code leaves the address bar
	await playUntil(page, async () => seated(bob).isVisible());
	await expect(page.locator('.seat .bot')).toHaveCount(0); // the bot gave Bob its seat
	await bob.context().close();
	expect(cspViolations).toEqual([]);
});

test('waits in line for a full table', async ({ page, browser, cspViolations }) => {
	await sitDown(page, 2, { bots: /No bots/ });
	const tableId = await tableIdOf(page);
	const bob = await stranger(browser);
	const carol = await stranger(browser);
	await bob.goto('/');
	await row(bob, tableId).getByRole('button', { name: 'Sit down' }).click();
	await expect(seated(bob)).toBeVisible();
	await carol.goto('/');
	const line = row(carol, tableId);
	await expect(line).toContainText('2 people');
	await line.getByRole('button', { name: 'Join the waitlist' }).click();
	await expect(line).toContainText('Number 1 in line');
	// Bob leaves; when his hand ends the seat is held for Carol.
	await bob.getByRole('button', { name: 'Leave table' }).click();
	await expect(newTableForm(bob)).toBeVisible();
	await playUntil(
		page,
		async () => (await line.textContent())?.includes('Your seat is ready') ?? false
	);
	await line.getByRole('button', { name: 'Sit down' }).click();
	await expect(seated(carol)).toBeVisible();
	await expect(page.locator('.seat').filter({ hasText: await nameOf(carol) })).toBeVisible();
	await bob.context().close();
	await carol.context().close();
	expect(cspViolations).toEqual([]);
});

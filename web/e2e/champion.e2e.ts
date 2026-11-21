import type { Page } from '@playwright/test';
import {
	expect,
	handNumber,
	newTableForm,
	noOverflow,
	playUntil,
	seated,
	test
} from './fixtures.ts';
import { LEGACY } from './server.ts';

// The evaluated heads-up opponent (P5.7a): a guest can practise against
// RiverMind Hard, the trained bot, as well as RiverMind Easy, change between
// them at the practice table, and choose it for a two-seat table. Its label
// links to the published evaluation. The test server serves a small champion
// written by global-setup; serve-nl, the rollback, runs no trained bot.
test.skip(LEGACY, 'serve-nl runs no trained bot');

const bot = (page: Page) => page.locator('.seat[data-seat="1"]');

async function balance(page: Page): Promise<number> {
	return page.evaluate(async () => {
		const response = await fetch('/api/wallet');
		return ((await response.json()) as { balance: number }).balance;
	});
}

/**
 * Play to hand number `target`. The test server's practice stack is three big
 * blinds and the test champion bets at random, so the guest often runs out:
 * a fresh practice stack is one click.
 */
async function playToHand(page: Page, target: number): Promise<void> {
	const again = page.getByRole('button', { name: /^Play again with/ });
	await playUntil(
		page,
		async () => {
			if (await again.isVisible()) await again.click({ timeout: 1000 }).catch(() => {});
			return (await handNumber(page)) >= target;
		},
		60_000
	);
}

/** Choose a practice opponent from the table's own control. */
async function playAgainst(page: Page, label: string): Promise<void> {
	await page.getByRole('button', { name: 'Opponent', exact: true }).click();
	const choices = page.getByRole('group', { name: 'Practice opponent' });
	await choices.getByRole('button', { name: label, exact: true }).click();
	await expect(choices).toHaveCount(0);
}

test('a guest practises against RiverMind Hard and changes opponents between hands', async ({
	page,
	cspViolations
}) => {
	test.setTimeout(180_000);
	await page.goto('/');
	// One click still starts practice against RiverMind Easy.
	await expect(page.getByRole('button', { name: 'Practice vs bots' })).toBeVisible();
	const before = await balance(page);
	// The trained bot is offered beside it, with its measured result and a link to how it was measured.
	const trained = page.getByRole('group', { name: 'RiverMind Hard' });
	await expect(trained).toContainText(
		'Over 40,000 hands it won +58.8 big blinds per 100 hands against RiverMind Easy (95% interval +50.1 to +67.5).'
	);
	await expect(trained.getByRole('link', { name: 'How it was measured' })).toHaveAttribute(
		'href',
		/\/bots$/
	);
	await noOverflow(page);
	await trained.getByRole('button', { name: 'Practice vs RiverMind Hard' }).click();
	await expect(seated(page)).toBeVisible();
	await expect(page.getByText('Practice', { exact: true })).toBeVisible();
	await expect(bot(page)).toContainText('RiverMind Hard');
	// Its own avatar (phones show names only).
	await expect(bot(page).locator('.avatar-hard')).toHaveCount(1);
	await noOverflow(page);
	// Whole hands against it.
	await playToHand(page, 3);

	// Change to RiverMind Easy: at once between hands, else when the hand ends.
	await playAgainst(page, 'RiverMind Easy');
	const changed = await handNumber(page);
	await playToHand(page, changed + 1);
	await expect(bot(page)).toContainText('RiverMind Easy');
	await expect(page.getByText(/sits down after this hand/)).toHaveCount(0);
	await playToHand(page, changed + 2);

	// And back, after a reload, which keeps the table and its opponent.
	await page.reload();
	await expect(seated(page)).toBeVisible();
	await expect(bot(page)).toContainText('RiverMind Easy');
	await playAgainst(page, 'RiverMind Hard');
	const again = await handNumber(page);
	await playToHand(page, again + 1);
	await expect(bot(page)).toContainText('RiverMind Hard');
	await noOverflow(page);

	// Practice never touches the wallet, whoever the opponent is.
	await page.getByRole('button', { name: /Leave table/ }).click();
	await expect(page.getByRole('button', { name: 'Practice vs bots' })).toBeVisible();
	expect(await balance(page)).toBe(before);
	// The stored hands name the bot each was played against.
	await page.goto('/hands');
	const rows = page.getByRole('region', { name: 'Hands' }).getByRole('listitem');
	await expect(rows.first()).toContainText('Practice');
	await expect(rows.filter({ hasText: 'RiverMind Hard' }).first()).toBeVisible();
	await expect(rows.filter({ hasText: 'RiverMind Easy' }).first()).toBeVisible();
	expect(cspViolations).toEqual([]);
});

test('RiverMind Hard takes a two-seat table and no other', async ({ page, cspViolations }) => {
	await page.goto('/');
	await expect(page.getByText('Looking for tables…')).toHaveCount(0);
	const form = newTableForm(page);
	const hard = form.getByRole('radio', { name: /RiverMind Hard/ });
	// Six seats by default: the trained bot plays heads-up only, so it is not offered.
	await expect(form.getByRole('radio', { name: /RiverMind Easy/ })).toBeChecked();
	await expect(hard).toHaveCount(0);
	const two = form.getByRole('radio', { name: '2', exact: true });
	await two.evaluate((input: HTMLInputElement) => input.click());
	await expect(hard).toHaveCount(1);
	await hard.evaluate((input: HTMLInputElement) => input.click());
	await expect(hard).toBeChecked();
	// Back at a bigger table the choice returns to RiverMind Easy.
	const six = form.getByRole('radio', { name: '6', exact: true });
	await six.evaluate((input: HTMLInputElement) => input.click());
	await expect(hard).toHaveCount(0);
	await expect(form.getByRole('radio', { name: /RiverMind Easy/ })).toBeChecked();
	await two.evaluate((input: HTMLInputElement) => input.click());
	await hard.evaluate((input: HTMLInputElement) => input.click());
	const before = await balance(page);
	await form.getByRole('button', { name: 'Sit down' }).click();
	await expect(seated(page)).toBeVisible();
	await expect(bot(page)).toContainText('RiverMind Hard');
	// A wallet-backed table: the buy-in left the wallet, and its opponent cannot be changed.
	expect(await balance(page)).toBeLessThan(before);
	await expect(page.getByRole('button', { name: 'Opponent', exact: true })).toHaveCount(0);
	await playToHand(page, 2);
	expect(cspViolations).toEqual([]);
});

test('the bots page shows the published evaluation', async ({ page, cspViolations }) => {
	await page.goto('/');
	await page.getByRole('link', { name: 'The bots' }).click();
	await expect(page).toHaveURL(/\/bots$/);
	await expect(page.getByRole('heading', { name: 'The bots' })).toBeVisible();
	// The registry this build was made with: the served strategy's gate, with intervals.
	const served = page.getByRole('table').first();
	const easy = served.getByRole('row', { name: /RiverMind Easy\* 100 bb/ });
	await expect(easy).toContainText('40,000');
	await expect(easy).toContainText(/\+\d+\.\d to \+\d+\.\d/);
	await expect(served.getByRole('row', { name: /Calling bot\* 100 bb/ })).toBeVisible();
	await expect(
		page.getByText(/They measure play against these bots, not against people/)
	).toBeVisible();
	await expect(page.getByRole('link', { name: 'The full report' }).first()).toHaveAttribute(
		'href',
		/docs\/evaluations\/.+-served\.md$/
	);
	await expect(page.getByRole('link', { name: 'The model registry' })).toHaveAttribute(
		'href',
		/docs\/models\.md$/
	);
	await noOverflow(page);
	await page.getByRole('link', { name: 'Play' }).click();
	await expect(page.getByRole('button', { name: 'Practice vs bots' })).toBeVisible();
	expect(cspViolations).toEqual([]);
});

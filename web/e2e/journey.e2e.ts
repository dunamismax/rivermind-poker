import type { Page } from '@playwright/test';
import type { WalletResponse } from '../src/lib/protocol-v2.ts';
import { execute, testDatabaseUrl } from '../src/lib/server/db/testing.ts';
import { expect, nameOf, withCsp } from './fixtures.ts';
import { JOURNEY_URL_ENV } from './journey-setup.ts';
import { journey } from './journey.ts';

// The three player priorities together (P5.9), against the real Node server on a
// disposable PostgreSQL database: a guest starts practice in one click, chooses
// the evaluated heads-up opponent, finishes a hand against it, opens that hand
// from its result, returns to the table and plays again (journey.ts). The wallet
// and its ledger are the same afterwards, for a new guest and for one with no
// chips left before their next top-up.

const journeyUrl = process.env[JOURNEY_URL_ENV];
const test = withCsp;
test.use({ baseURL: journeyUrl });
test.skip(!journeyUrl, 'needs RIVERMIND_TEST_DATABASE_URL, a disposable PostgreSQL database');

/** The wallet as the API gives it and as the database holds it. */
async function wallet(page: Page) {
	const api = await page.evaluate(async () => {
		const response = await fetch('/api/wallet');
		if (!response.ok) throw new Error(`/api/wallet answered ${response.status}`);
		return (await response.json()) as WalletResponse;
	});
	const handle = await nameOf(page);
	const stored = await execute(
		testDatabaseUrl()!,
		`SELECT p.balance::bigint AS balance,
			(SELECT count(*) FROM ledger_entries e WHERE e.player_id = p.id)::int AS entries,
			coalesce((SELECT sum(e.amount) FROM ledger_entries e WHERE e.player_id = p.id), 0)::bigint AS total
		FROM players p WHERE p.handle = $1`,
		[handle]
	);
	expect(stored.rows).toHaveLength(1);
	const row = stored.rows[0] as { balance: string; entries: number; total: string };
	// The ledger adds up to the balance, and the API reports that balance.
	expect(Number(row.total)).toBe(Number(row.balance));
	expect(api.balance).toBe(Number(row.balance));
	return { balance: api.balance, entries: row.entries, newest: api.entries };
}

test('a new guest practises, plays RiverMind Hard, reviews the hand and plays on', async ({
	page,
	cspViolations
}) => {
	test.setTimeout(240_000);
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Practice vs bots' })).toBeVisible();
	// The first visit's grant is the whole ledger.
	expect(await wallet(page)).toMatchObject({ balance: 20_000, entries: 1 });
	await journey(page, () => wallet(page));
	expect(cspViolations).toEqual([]);
});

test('a guest with no chips left takes the same journey before any top-up', async ({
	page,
	cspViolations
}) => {
	test.setTimeout(240_000);
	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Practice vs bots' })).toBeVisible();
	// Spend the whole wallet on two tables. The next top-up is a day away.
	await page.evaluate(async () => {
		for (let i = 0; i < 2; i += 1) {
			const response = await fetch('/api/tables', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ seats: 2, bots: 'random', big_blind: 100, buy_in: 10000 })
			});
			if (!response.ok) throw new Error(await response.text());
		}
	});
	await page.reload();
	await expect(page.getByRole('status').filter({ hasText: 'Your play chips' })).toContainText('0');
	// The grant and two buy-ins, and nothing left.
	expect(await wallet(page)).toMatchObject({ balance: 0, entries: 3 });
	await journey(page, () => wallet(page));
	expect(cspViolations).toEqual([]);
});

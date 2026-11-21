import type { WalletResponse } from '../src/lib/protocol-v2.ts';
import { expect, withCsp as test } from './fixtures.ts';
import { journey } from './journey.ts';

// The three player priorities together on a deployed site (P5.9); see
// playwright.live.config.ts. A new guest starts practice in one click, chooses
// RiverMind Hard, finishes a hand against it, opens that hand from its result,
// returns to the table and plays again, and the wallet is as it was. A site
// that serves no champion skips this.

const LIVE_HAND_MS = 150_000;

test.afterEach(({ cspViolations }) => {
	expect(cspViolations).toEqual([]);
});

test('a new guest practises, plays RiverMind Hard, reviews the hand and plays on', async ({
	page,
	request
}) => {
	const config = (await (await request.get('/api/config')).json()) as {
		bots: { kind: string; champion?: { name: string } }[];
	};
	test.skip(!config.bots.some((b) => b.kind === 'hard'), 'this site serves no champion');

	await page.goto('/');
	await expect(page.getByRole('button', { name: 'Practice vs bots' })).toBeVisible();
	const wallet = () =>
		page.evaluate(async () => {
			const response = await fetch('/api/wallet');
			if (!response.ok) throw new Error(`/api/wallet answered ${response.status}`);
			const { balance, entries } = (await response.json()) as WalletResponse;
			return { balance, entries };
		});
	// A new guest: the first visit's grant and nothing else.
	expect((await wallet()).entries).toHaveLength(1);
	await journey(page, wallet, LIVE_HAND_MS);
});

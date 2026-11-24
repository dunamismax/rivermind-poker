import { expect, handNumber, noOverflow, playUntil, seated, withCsp as test } from './fixtures.ts';

// The evaluated heads-up opponent on a deployed site (P5.7a, P5.9), and the
// six-seat one beside it where the site serves one (P5.7); see
// playwright.live.config.ts. A site that serves no champion skips this, which
// `deploy/update.sh` warns about after a deploy.

const LIVE_HAND_MS = 150_000;

test.afterEach(({ cspViolations }) => {
	expect(cspViolations).toEqual([]);
});

test('a guest practises against RiverMind Hard, changes to RiverMind Easy and reads the evaluation', async ({
	page,
	request
}) => {
	const config = (await (await request.get('/api/config')).json()) as {
		bots: {
			kind: string;
			seats?: number[];
			champion?: { name: string };
			champions?: { name: string; seats?: number[] }[];
		}[];
	};
	const hard = config.bots.find((b) => b.kind === 'hard');
	test.skip(!hard, 'this site serves no champion');
	// Two seats are the heads-up champion's; a six-seat champion adds the sizes it plays.
	const models = hard!.champions ?? [{ name: hard!.champion!.name, seats: [2] }];
	expect(models[0].seats).toEqual([2]);
	expect(hard!.seats).toEqual(models.flatMap((m) => m.seats ?? []));
	expect(hard!.champion!.name).toMatch(/\S/);

	await page.goto('/');
	const trained = page.getByRole('group', { name: 'RiverMind Hard' });
	await expect(trained).toContainText(
		/it won \+\d+\.\d big blinds per 100 hands against RiverMind Easy/
	);
	await trained.getByRole('button', { name: 'Practice vs RiverMind Hard' }).click();
	await expect(seated(page)).toBeVisible();
	const bot = page.locator('.seat[data-seat="1"]');
	await expect(bot).toContainText('RiverMind Hard');
	await noOverflow(page);
	const again = page.getByRole('button', { name: /^Play again with/ });
	const playTo = (target: number) =>
		playUntil(
			page,
			async () => {
				if (await again.isVisible()) await again.click({ timeout: 1000 }).catch(() => {});
				return (await handNumber(page)) >= target;
			},
			LIVE_HAND_MS
		);
	// A whole hand against the champion, then one against RiverMind Easy at the same table.
	await playTo(2);
	await page.getByRole('button', { name: 'Opponent', exact: true }).click();
	await page
		.getByRole('group', { name: 'Practice opponent' })
		.getByRole('button', { name: 'RiverMind Easy', exact: true })
		.click();
	const changed = await handNumber(page);
	await playTo(changed + 1);
	await expect(bot).toContainText('RiverMind Easy');
	await playTo(changed + 2);
	await page.getByRole('button', { name: /Leave table/ }).click();

	// The label links to the published evaluation of the model the server said it plays.
	await page.getByRole('group', { name: 'RiverMind Hard' }).getByRole('link').click();
	await expect(page).toHaveURL(/\/bots$/);
	for (const model of models) await expect(page.getByText(model.name).first()).toBeVisible();
	await expect(
		page
			.getByRole('table')
			.first()
			.getByRole('row', { name: /RiverMind Easy\* 100 bb/ })
	).toContainText(/\+\d+\.\d to \+\d+\.\d/);
	await noOverflow(page);
});

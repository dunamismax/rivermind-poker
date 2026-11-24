// A test-only tool (P7.1b): the warning for someone in a table's voice group
// who is not seated, brought about on a deployed site and seen on a screen
// with the microphone held. Run by hand, never in CI or `pnpm e2e:live`:
//
//   pnpm exec playwright test --config playwright.voice-stranger.config.ts
//
// against https://rivermindpoker.com, or LIVE_URL. Nothing in the site or the
// voice service changes for it: stranger.ts says how the ghost stays in the
// group. Here six members hang, so the observer, in Firefox with its fake
// microphone, is warned for about six seconds after it joins.
//
// It prints what the observer's screen showed, each change with its time from
// the click on “Join voice”, and saves a screenshot of each change, and of the
// warning, to artifacts/voice-stranger/. A site from before the panel opened by
// itself for the warning leaves it closed: the tool then opens it, as a person
// would from the bar, and says so.
//
// It plays at a real table on the site: eight guests, play chips only.
import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { canTransform } from '../voice/check/browsers.ts';
import { ghostTable, leaveTable, takeSeat, watch, type GhostTable } from './stranger.ts';
import { card, openPanel, person, type Person } from './voice.ts';

test.describe.configure({ timeout: 600_000 });

const HUNG = 6;
const OUT = resolve(import.meta.dirname, '../../artifacts/voice-stranger');

test('someone in the group who is not seated is shown, with the microphone held', async ({
	baseURL,
	request
}, testInfo) => {
	const offer = await request.get('/api/voice');
	test.skip(!offer.ok() || (await offer.json()).offered !== true, 'this site does not offer voice');
	test.skip(!canTransform('firefox'), 'this build of Firefox cannot seal frames');
	mkdirSync(OUT, { recursive: true });
	let table: GhostTable | null = null;
	let observer: Person | null = null;
	try {
		table = await ghostTable(testInfo, baseURL!, HUNG);
		observer = await person('firefox', testInfo, baseURL!, { mic: true });
		const page = observer.page;
		await takeSeat(page, table.link);
		await expect(card(page)).toBeVisible({ timeout: 30_000 });
		const joined = Date.now();
		await card(page).getByRole('button', { name: 'Join voice' }).click();

		let openedByHand: number | null = null;
		let shot = false;
		const seen = await watch(page, joined, 90_000 + HUNG * 1000, async (moment) => {
			await page.screenshot({ path: resolve(OUT, `at-${moment.ms}.png`) });
			if (moment.warned && !shot) {
				// The microphone is held: nothing reads as live anywhere on the page.
				await expect(page.getByRole('img', { name: 'Microphone live' })).toHaveCount(0);
				await page.screenshot({ path: resolve(OUT, 'warning.png') });
				shot = true;
			}
			// In voice, held, and the panel closed: open it, as a person would.
			if (moment.phase === 'in' && !moment.live && !moment.panel && openedByHand === null) {
				openedByHand = moment.ms;
				await openPanel(page);
			}
		});
		const report = {
			site: baseURL,
			hung: HUNG,
			at: new Date(joined).toISOString(),
			panelOpenedByItself: openedByHand === null,
			openedByHandAtMs: openedByHand,
			seen
		};
		console.log(JSON.stringify(report, null, 2));
		await testInfo.attach('report', { body: JSON.stringify(report, null, 2) });

		expect(shot, 'the warning was shown').toBe(true);
		expect(
			seen.filter((one) => one.warned).every((one) => !one.live),
			'the microphone was held while warned'
		).toBe(true);
		expect(seen.at(-1)!.warned).toBe(false);
		expect(seen.at(-1)!.live, 'the microphone sends once the ghost is gone').toBe(true);

		// Everyone leaves, so the table pays back and closes.
		await leaveTable(page);
		await table.leave();
	} finally {
		await observer?.close();
		await table?.close();
	}
});

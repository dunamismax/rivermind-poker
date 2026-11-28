import { writeFileSync } from 'node:fs';
import { expect, test, webkit, type Page } from '@playwright/test';
import { handNumber, nameOf, playUntil, row, seated, sitDown, tableIdOf } from './fixtures.ts';

// Cross-play (P5D.7): two people in browsers, one in Chromium on a desktop and one in
// WebKit at a phone's size, and the iPhone app in the Simulator share a table with no
// bots and play complete hands. Each side records the result each hand ended with, and
// ios/crossplay.sh checks that every screen ended every hand the same. Run by that script.

const HANDS = Number(process.env.CROSSPLAY_HANDS ?? 3);

/** The result under the board, one line per pot, while a settled hand shows. */
async function resultOf(page: Page): Promise<string> {
	return (
		await page
			.locator('.result')
			.innerText({ timeout: 1000 })
			.catch(() => '')
	).trim();
}

test('people in browsers and the app play hands at one table', async ({ page }) => {
	const tableFile = process.env.CROSSPLAY_TABLE_FILE;
	const resultsFile = process.env.CROSSPLAY_RESULTS;
	test.skip(!tableFile || !resultsFile, 'run by ios/crossplay.sh');

	await sitDown(page, 3, { bots: /No bots/ });
	const tableId = await tableIdOf(page);
	const phone = await webkit.launch();
	const bob = await (
		await phone.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true })
	).newPage();
	await bob.goto('/');
	await row(bob, tableId).getByRole('button', { name: 'Sit down' }).click();
	await expect(seated(bob)).toBeVisible();
	const names = [await nameOf(page), await nameOf(bob)];
	writeFileSync(tableFile!, JSON.stringify({ tableId, names }));

	// The app takes the third seat once its UI test starts. The two play on meanwhile, so
	// neither runs out of time and sits out.
	const full = (p: Page) => async () => (await p.locator('.seat[data-seat]').count()) === 3;
	await Promise.all([playUntil(page, full(page), 300_000), playUntil(bob, full(bob), 300_000)]);

	const target = (await handNumber(page)) + HANDS + 1;
	const results: Record<string, Record<number, string>> = { chromium: {}, webkit: {} };
	const watch = (who: string, p: Page) => async () => {
		const hand = await handNumber(p);
		const text = await resultOf(p);
		if (text) results[who][hand] = text;
		return hand >= target;
	};
	await Promise.all([
		playUntil(page, watch('chromium', page), 300_000),
		playUntil(bob, watch('webkit', bob), 300_000)
	]);

	// Each browser saw the app's player act: someone who is neither of them.
	const actors = async (p: Page) =>
		(await p.getByRole('region', { name: 'Hand log' }).locator('li').allInnerTexts())
			.map((line) => /^(.+?) (checks|calls|folds|bets|raises)/.exec(line)?.[1])
			.filter((name): name is string => Boolean(name) && !names.includes(name!));
	const app = (await actors(page))[0];
	expect(app).toBeTruthy();
	expect(await actors(bob)).toContain(app);
	writeFileSync(resultsFile!, JSON.stringify({ names, app, results }));
	await phone.close();
});

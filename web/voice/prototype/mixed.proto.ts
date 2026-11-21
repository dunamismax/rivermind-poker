// One room shared by all three engines (P4C.1): three people in Chromium,
// three in Firefox and three in WebKit, each hearing the other eight. It shows
// that every engine hands the same bytes to the transform: a frame one engine
// encrypts, the other two decrypt and decode.
import { chromium, expect, firefox, test, webkit } from '@playwright/test';
import { launch } from './browsers.ts';
import { everyoneHearsEveryone, join, leave, tapsOf, type Person } from './room.ts';

test('nine people in three engines hear each other', async () => {
	test.setTimeout(300_000);
	const browsers = [
		await chromium.launch(launch.chromium),
		await firefox.launch(launch.firefox),
		// Each WebKit person gets a browser of their own from this one's type (room.ts).
		await webkit.launch(launch.webkit)
	];
	const room = 'mixed-nine';
	const people: Person[] = [];
	for (let kid = 0; kid < 9; kid++) people.push(await join(browsers[kid % 3], room, kid));

	const reports = await everyoneHearsEveryone(people);
	expect(reports.map((one) => one.handler)).toEqual(
		Array.from({ length: 9 }, (_, kid) => ['Chrome111', 'Firefox120', 'Safari12'][kid % 3])
	);
	for (const one of reports) expect(one.audioLevelNegotiated).toBe(false);
	for (const tap of await tapsOf(room, 9)) {
		expect(tap.sframeFrames).toBe(tap.packets);
		expect(tap.headerExtensionIds).not.toContain(tap.audioLevelId);
	}
	await leave(people);
	for (const browser of browsers) await browser.close();
});

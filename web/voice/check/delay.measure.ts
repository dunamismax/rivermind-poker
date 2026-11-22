// Mouth-to-ear delay through the voice service on this machine (P4C.7), with
// a marked tone: every person plays marks into the call and times the marks
// they hear from the others (delay.ts). Run with `pnpm voice:measure delay`;
// the figures go in docs/voice.md. One engine a project; the pairs across
// engines run in the Chromium project.
import { test, type BrowserType } from '@playwright/test';
import { canTransform, launch } from './browsers.ts';
import type { DelayOptions } from './delay.ts';
import {
	delays,
	hasWebAudio,
	measured,
	reportOf,
	settled,
	summarise,
	type Engine,
	type Measured
} from './measure.ts';
import { newTable } from './people.ts';

const SECONDS = Number(process.env.MEASURE_SECONDS ?? 40);

test.beforeEach(({ browserName }) => {
	test.skip(!canTransform(browserName), 'this build of the engine has no RTCRtpScriptTransform');
});

const everyMs = (seat: number) => 487 + 26 * seat;

// Measure for a while, then say what each ear timed and what WebRTC counted.
async function measure(label: string, people: Measured[], site: boolean): Promise<void> {
	await settled(people);
	// Let the jitter buffers settle before the marks count.
	await people[0].page.waitForTimeout(3000);
	for (const person of people) await person.page.evaluate(() => window.delay.clear());
	await people[0].page.waitForTimeout(SECONDS * 1000);
	const reports = await Promise.all(people.map(reportOf));
	for (const [at, mine] of reports.entries()) {
		const to = people[at];
		const stats = mine.stats;
		const mean = (values: (number | null)[]) => {
			const known = values.filter((value): value is number => value !== null);
			return known.length
				? Math.round((known.reduce((sum, value) => sum + value, 0) / known.length) * 10) / 10
				: null;
		};
		const concealed =
			stats.reduce((sum, one) => sum + one.concealedSamples, 0) /
			Math.max(
				1,
				stats.reduce((sum, one) => sum + one.totalSamplesReceived, 0)
			);
		const all: number[] = [];
		for (const [other, theirs] of reports.entries()) {
			if (other === at || !theirs.sent.length) continue;
			all.push(...delays(theirs, mine, everyMs(people[other].seat), site));
		}
		console.log(
			`[delay] ${JSON.stringify({
				run: label,
				ear: `${to.engine} seat ${to.seat}`,
				output: mine.output,
				mouths: reports.filter((one, other) => other !== at && one.sent.length).length,
				delayMs: summarise(all),
				jitterBufferMs: mean(stats.map((one) => one.jitterBufferMs)),
				jitterBufferTargetMs: mean(stats.map((one) => one.jitterBufferTargetMs)),
				roundTripMs: mine.roundTripMs === null ? null : Math.round(mine.roundTripMs * 10) / 10,
				concealed: Math.round(concealed * 10000) / 100,
				baseLatencyMs: mine.baseLatencyMs,
				outputLatencyMs: mine.outputLatencyMs,
				earBlocks: mine.blocks
			})}`
		);
	}
	for (const person of people) await person.close();
}

async function pair(
	label: string,
	a: BrowserType,
	b: BrowserType,
	more: Partial<DelayOptions> = {}
): Promise<void> {
	const table = newTable();
	const people = [
		await measured(a, table, 0, [0, 1], more),
		await measured(b, table, 1, [0, 1], more)
	];
	await measure(label, people, more.playback === 'site');
}

test('two people, each track as it arrives', async ({ playwright, browserName }) => {
	const type = playwright[browserName as Engine];
	await pair(`${browserName} pair, raw`, type, type);
});

test('two people, as the site sends and plays: RNNoise, and the playback graph', async ({
	playwright,
	browserName
}) => {
	test.skip(!hasWebAudio(browserName as Engine), 'no Web Audio in this engine here');
	const type = playwright[browserName as Engine];
	await pair(`${browserName} pair, playback graph`, type, type, { playback: 'site' });
	await pair(`${browserName} pair, RNNoise and playback graph`, type, type, {
		playback: 'site',
		denoise: true,
		mark: 'voice'
	});
	await pair(`${browserName} pair, voice marks, playback graph`, type, type, {
		playback: 'site',
		mark: 'voice'
	});
});

test('across engines', async ({ playwright, browserName }) => {
	test.skip(browserName !== 'chromium', 'the pairs across engines run once');
	await pair('chromium and firefox, raw', playwright.chromium, playwright.firefox);
	await pair('chromium and firefox, as the site', playwright.chromium, playwright.firefox, {
		playback: 'site',
		denoise: true,
		mark: 'voice'
	});
	// WebKit is read by its statistics alone: what its jitter buffer holds of
	// the others' marked tones, and what theirs hold of its mock microphone.
	const table = newTable();
	const people = [
		await measured(playwright.chromium, table, 0, [0, 1, 2]),
		await measured(playwright.firefox, table, 1, [0, 1, 2]),
		await measured(playwright.webkit, table, 2, [0, 1, 2])
	];
	await measure('chromium, firefox and webkit, raw', people, false);
});

test('nine people in a room, one of them playing marks', async ({ playwright, browserName }) => {
	const type = playwright[browserName as Engine];
	const table = newTable();
	const seats = [0, 1, 2, 3, 4, 5, 6, 7, 8];
	// One browser for all nine where the engine allows it: nine browsers of
	// some engines are more than this machine runs smoothly.
	const shared = browserName === 'webkit' ? null : await type.launch(launch[browserName as Engine]);
	const people: Measured[] = [];
	for (const seat of seats) {
		const more: Partial<DelayOptions> = seat === 0 ? {} : { source: 'quiet' };
		people.push(await measured(type, table, seat, seats, more, undefined, shared));
	}
	await measure(`${browserName}, nine in a room, raw`, people, false);
	await shared?.close();
});

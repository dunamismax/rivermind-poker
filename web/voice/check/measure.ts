// What the voice measurements share (delay.measure.ts, loss.measure.ts): a
// person on the measuring page, and the arithmetic.
import { expect, type Browser, type BrowserType, type Page } from '@playwright/test';
import { launch, canCapture } from './browsers.ts';
import type { DelayOptions, DelayReport } from './delay.ts';
import { identity, token } from './people.ts';
import { VOICE_URL } from './vite.config.ts';

export type Engine = 'chromium' | 'firefox' | 'webkit';
export type Measured = { page: Page; seat: number; engine: Engine; close: () => Promise<void> };

// Playwright's WebKit stops rendering Web Audio once it captures, and it
// connects only from a page that has (browsers.ts): it sends its mock
// microphone and is read by WebRTC's statistics alone. So is Firefox on a
// machine with no sound device, as a container is, where its AudioContext
// never starts.
export const hasWebAudio = (engine: Engine): boolean =>
	engine !== 'webkit' && !(engine === 'firefox' && process.platform === 'linux');

// Someone on the measuring page: in a browser of their own, or in a context
// of `shared`, which WebKit cannot be (one page of a browser captures there).
export async function measured(
	type: BrowserType,
	table: string,
	seat: number,
	seated: number[],
	more: Partial<DelayOptions> = {},
	url = VOICE_URL,
	shared: Browser | null = null
): Promise<Measured> {
	const engine = type.name() as Engine;
	const browser: Browser = shared ?? (await type.launch(launch[engine]));
	// Named for every engine: the project's own permissions would otherwise be
	// given to a browser of another engine, and Firefox knows no `microphone`.
	const context = await browser.newContext({
		baseURL: `http://127.0.0.1:4391`,
		permissions: engine === 'firefox' ? [] : ['microphone']
	});
	const page = await context.newPage();
	if (process.env.VOICE_DEBUG) {
		page.on('console', (message) => console.log(`[${engine} ${seat}] ${message.text()}`));
		page.on('pageerror', (error) => console.log(`[${engine} ${seat}] ${error}`));
	}
	await page.goto('/delay.html');
	await expect(page.locator('body')).toHaveAttribute('data-delay', 'ready');
	const webAudio = hasWebAudio(engine);
	const options: DelayOptions = {
		url,
		table,
		token: token(table, seat),
		seated: seated.map(identity),
		source: webAudio ? 'marks' : canCapture(engine) ? 'capture' : 'quiet',
		mark: 'tone',
		// A different pace a seat, never a multiple of the 20 ms frame, so marks
		// fall everywhere in a frame.
		everyMs: 487 + 26 * seat,
		denoise: false,
		playback: 'raw',
		webAudio,
		...more
	};
	if (!webAudio) {
		Object.assign(options, {
			source: 'capture',
			speech: undefined,
			denoise: false,
			playback: 'raw'
		});
	}
	await page.evaluate((given) => window.delay.join(given), options);
	return { page, seat, engine, close: () => (shared ? context.close() : browser.close()) };
}

export const reportOf = (person: Measured): Promise<DelayReport> =>
	person.page.evaluate(() => window.delay.report());

// Everyone hears everyone: packets arriving on every stream.
export async function settled(people: Measured[]): Promise<void> {
	await expect(async () => {
		for (const person of people) {
			const mine = await reportOf(person);
			expect(mine.stats).toHaveLength(people.length - 1);
			for (const one of mine.stats) expect(one.packetsReceived).toBeGreaterThan(25);
		}
	}).toPass({ timeout: 60_000 });
}

export type Summary = { n: number; p50: number; p95: number; max: number; mean: number };

export function summarise(values: number[]): Summary | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const at = (share: number) =>
		sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
	const round = (value: number) => Math.round(value * 10) / 10;
	return {
		n: sorted.length,
		p50: round(at(0.5)),
		p95: round(at(0.95)),
		max: round(sorted[sorted.length - 1]),
		mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length)
	};
}

// How long each of `from`'s marks took to reach `to`'s ear: each arrival is
// the first after the mark it follows, and no mark is counted twice.
export function delays(
	from: DelayReport,
	to: DelayReport,
	everyMs: number,
	site: boolean
): number[] {
	const arrivals = to.heard
		.filter(({ leaf }) => (site ? leaf === null : leaf === from.leaf))
		.map(({ at }) => at)
		.sort((a, b) => a - b);
	const taken: number[] = [];
	let next = 0;
	for (const mark of [...from.sent].sort((a, b) => a.at - b.at)) {
		while (next < arrivals.length && arrivals[next] <= mark.at) next += 1;
		if (next >= arrivals.length) break;
		const delay = arrivals[next] - mark.at;
		if (delay < everyMs * 0.9) {
			taken.push(delay);
			next += 1;
		}
	}
	return taken;
}

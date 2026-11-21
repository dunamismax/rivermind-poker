// People in a table's voice room on the real voice service (P4C.4), one
// engine a project: they make and join the table's MLS group over voice
// signalling v1, key every frame from its epochs, and hear each other through
// mediasoup, on a page built as the site's client is and served under its CSP.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { WebSocket } from 'ws';
import { publicRef } from '../../src/lib/server/api/auth.ts';
import { issueToken, voiceKey } from '../../src/lib/server/voice/tokens.ts';
import type { Identity } from '../../src/lib/voice/group.ts';
import { launch, canCapture, canTransform } from './browsers.ts';
import type { JoinOptions, RoomReport } from './room.ts';
import { ORIGIN, VOICE_PORT, VOICE_SECRET, VOICE_URL } from './vite.config.ts';

const key = voiceKey(new TextEncoder().encode(VOICE_SECRET));
const identity = (seat: number): Identity => ({ player: publicRef(`p_check-seat-${seat}`), seat });
const token = (table: string, seat: number) =>
	issueToken(key, { table, ...identity(seat) }, Date.now() / 1000);
let tables = 0;
const newTable = () => `check-${process.pid}-${(tables += 1)}`;

type Person = { page: Page; seat: number };

// A person's page. WebKit lets one page of a browser capture at a time, so a
// WebKit person has a browser of their own (browsers.ts).
async function open(browser: Browser): Promise<Page> {
	const engine = browser.browserType().name();
	const own = engine === 'webkit' ? await browser.browserType().launch(launch.webkit) : null;
	const context = await (own ?? browser).newContext(
		engine === 'firefox' ? {} : { permissions: ['microphone'] }
	);
	const page = await context.newPage();
	page.on('close', () => void own?.close());
	if (process.env.VOICE_DEBUG) {
		page.on('console', (message) => console.log(`[room] ${message.text()}`));
		page.on('pageerror', (error) => console.log(`[room] ${error}`));
	}
	await page.goto('/room.html');
	await expect(page.locator('body')).toHaveAttribute('data-room', 'ready');
	return page;
}

// Someone sits at `seat` and joins voice: a fake microphone where the engine's
// works here and a tone where it does not. Only Chromium is given Web Audio;
// the others are judged by WebRTC's statistics (browsers.ts).
function joining(engine: string, table: string, seat: number, seated: number[]): JoinOptions {
	return {
		url: VOICE_URL,
		table,
		token: token(table, seat),
		seated: seated.map(identity),
		source: canCapture(engine) ? 'capture' : 'tone',
		freq: 400 + 150 * seat,
		webAudio: engine === 'chromium'
	};
}

async function join(browser: Browser, table: string, seat: number, seated: number[]) {
	const page = await open(browser);
	const options = joining(browser.browserType().name(), table, seat, seated);
	await page.evaluate((given) => window.room.join(given), options);
	return { page, seat };
}

const report = (person: Person, listenMs = 0): Promise<RoomReport> =>
	person.page.evaluate((ms) => window.room.report(ms), listenMs);

const none = {
	malformed: 0,
	'unknown-key': 0,
	'stale-epoch': 0,
	'wrong-sender': 0,
	tampered: 0,
	replayed: 0
};

// Everyone is on one epoch with one voice code, hears everyone else's audio
// opened under the group's keys, and refused nothing.
async function everyoneHearsEveryone(people: Person[]): Promise<RoomReport[]> {
	let reports: RoomReport[] = [];
	await expect(async () => {
		reports = await Promise.all(people.map((person) => report(person, 1200)));
		const [first] = reports;
		expect(first.epoch).not.toBeNull();
		for (const mine of reports) {
			expect(mine.epoch).toBe(first.epoch);
			expect(mine.code).toEqual(first.code);
			expect(mine.code).toHaveLength(4);
			expect(mine.seatsOk).toBe(true);
			expect(mine.connection).toEqual({ send: 'connected', recv: 'connected' });
			const others = reports.filter((other) => other !== mine).map((other) => other.leaf);
			expect(mine.heard.map(({ leaf }) => leaf)).toEqual(others.sort((a, b) => a! - b!));
			for (const heard of mine.heard) {
				const label = `leaf ${heard.leaf} at leaf ${mine.leaf}`;
				if (heard.rms !== null) expect(heard.rms, `${label}: rms`).toBeGreaterThan(0.005);
				else expect(heard.energy, `${label}: energy`).toBeGreaterThan(0.0001);
				expect(heard.totalSamplesReceived, `${label}: samples`).toBeGreaterThan(24_000);
				expect(heard.concealedSamples / heard.totalSamplesReceived, label).toBeLessThan(0.5);
			}
			const sent = mine.transforms.find(({ direction }) => direction === 'encrypt')!;
			expect(sent.frames).toBeGreaterThan(50);
			expect(sent.unsent).toBe(0);
			for (const one of mine.transforms.filter(({ direction }) => direction === 'decrypt')) {
				expect(one.refused, `${one.id} at leaf ${mine.leaf}`).toEqual(none);
			}
			expect(mine.refused).toEqual([]);
		}
	}).toPass({ timeout: 60_000 });
	return reports;
}

test.beforeEach(({ browserName }) => {
	test.skip(!canTransform(browserName), 'this build of the engine has no RTCRtpScriptTransform');
});

test('two people at a table talk through the voice service, keyed from their group', async ({
	browser
}) => {
	const table = newTable();
	const a = await join(browser, table, 0, [0, 4]);
	const b = await join(browser, table, 4, [0, 4]);
	const reports = await everyoneHearsEveryone([a, b]);
	// Where the audio went: VOICE_REMOTE runs this against a service elsewhere.
	console.log(
		`[${browser.browserType().name()}] ${JSON.stringify(reports.map(({ path }) => path))}`
	);
	// The first made the group at epoch 0; the second's join made epoch 1.
	expect(reports.map(({ leaf, epoch }) => ({ leaf, epoch }))).toEqual([
		{ leaf: 0, epoch: 1 },
		{ leaf: 1, epoch: 1 }
	]);
	for (const person of [a, b]) await person.page.context().close();
});

test('someone joins and leaves, and everyone moves to each new epoch without a gap', async ({
	browser
}) => {
	const table = newTable();
	const a = await join(browser, table, 1, [1, 2, 6]);
	const b = await join(browser, table, 2, [1, 2, 6]);
	const two = await everyoneHearsEveryone([a, b]);
	const c = await join(browser, table, 6, [1, 2, 6]);
	const three = await everyoneHearsEveryone([a, b, c]);
	expect(three[0].epoch).toBe(2);
	expect(three[0].code).not.toEqual(two[0].code);
	// c stands up and closes the page: the service proposes their removal and
	// the lowest leaf commits it, so the two who stay move to a fourth epoch.
	for (const person of [a, b]) {
		await person.page.evaluate((seated) => window.room.seats(seated), [identity(1), identity(2)]);
	}
	await c.page.context().close();
	const after = await everyoneHearsEveryone([a, b]);
	expect(after[0].epoch).toBe(3);
	expect(after[0].code).not.toEqual(three[0].code);
	for (const person of [a, b]) await person.page.context().close();
});

test('on a network that blocks UDP, people talk over TCP on the same port', async ({
	browserName,
	playwright
}) => {
	test.skip(browserName !== 'chromium', 'Chromium is the engine that can be told to avoid UDP');
	// Chromium's own switch for a network that lets no UDP through.
	const browser = await playwright.chromium.launch({
		args: [
			...(launch.chromium.args ?? []),
			'--force-webrtc-ip-handling-policy=disable_non_proxied_udp'
		]
	});
	const table = newTable();
	const a = await join(browser, table, 0, [0, 1]);
	const b = await join(browser, table, 1, [0, 1]);
	const reports = await everyoneHearsEveryone([a, b]);
	console.log(`[tcp] ${JSON.stringify(reports.map(({ path }) => path))}`);
	for (const { path } of reports) {
		expect(path.send).toMatch(/^tcp .*:\d+$/);
		expect(path.recv).toMatch(/^tcp .*:\d+$/);
	}
	await browser.close();
});

test('a page with a token that is not genuine gets no voice', async ({ browser }) => {
	const table = newTable();
	const page = await open(browser);
	const options = joining(browser.browserType().name(), table, 3, [3]);
	options.token = options.token.slice(0, -1) + (options.token.endsWith('0') ? '1' : '0');
	const failed = await page.evaluate(
		(given) =>
			window.room.join(given).then(
				() => 'joined',
				(error: Error) => error.message
			),
		options
	);
	expect(failed).toBe('hello refused: bad-token');
	await page.context().close();
});

test('the service refuses a socket opened from another origin', async ({ browserName }) => {
	test.skip(browserName !== 'chromium', 'one engine is enough: no browser is involved');
	const status = (origin: string) =>
		new Promise<number>((resolve) => {
			const socket = new WebSocket(`ws://127.0.0.1:${VOICE_PORT}/voice`, { origin });
			socket.on('open', () => {
				socket.close();
				resolve(101);
			});
			socket.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
			socket.on('error', () => {});
		});
	expect(await status('https://elsewhere.example')).toBe(403);
	expect(await status(ORIGIN)).toBe(101);
});

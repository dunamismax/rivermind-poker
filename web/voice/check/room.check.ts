// People in a table's voice room on the real voice service (P4C.4), one
// engine a project: they make and join the table's MLS group over voice
// signalling v1, key every frame from its epochs, and hear each other through
// mediasoup, on a page built as the site's client is and served under its CSP.
import { expect, test, type Browser } from '@playwright/test';
import { WebSocket } from 'ws';
import { launch, canTransform } from './browsers.ts';
import {
	everyoneHearsEveryone,
	identity,
	join,
	joining,
	newTable,
	none,
	open,
	report,
	startVoice,
	stopVoice,
	token,
	type Person
} from './people.ts';
import { signSeats } from '../../src/lib/server/voice/seats.ts';
import { voiceKey } from '../../src/lib/server/voice/tokens.ts';
import { ORIGIN, RESTART_PORT, VOICE_PORT, VOICE_SECRET } from './vite.config.ts';

const key = voiceKey(new TextEncoder().encode(VOICE_SECRET));

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

test('a mute stops that person’s audio at the service, from the start and when it changes', async ({
	browser
}) => {
	const table = newTable();
	const seated = [0, 1, 2];
	const a = await join(browser, table, 0, seated);
	const b = await join(browser, table, 1, seated);
	// c has muted b before: b's audio never reaches c's page.
	const c = await join(browser, table, 2, seated, [1]);
	const packets = async (listener: Person, from: Person) => {
		const mine = await report(listener);
		const leaf = (await report(from)).leaf;
		return mine.heard.find((one) => one.leaf === leaf)!;
	};
	await expect(async () => {
		expect((await packets(a, b)).packetsReceived).toBeGreaterThan(50);
		expect((await packets(c, a)).packetsReceived).toBeGreaterThan(50);
	}).toPass({ timeout: 30_000 });
	const muted = await packets(c, b);
	expect(muted).toMatchObject({ player: identity(1).player, muted: true, packetsReceived: 0 });
	// a mutes b: the service stops sending b's audio to a, and a's count stops.
	await a.page.evaluate((player) => window.room.mute(player, true), identity(1).player);
	await a.page.waitForTimeout(300);
	const stopped = (await packets(a, b)).packetsReceived;
	await a.page.waitForTimeout(1500);
	expect((await packets(a, b)).packetsReceived - stopped).toBeLessThan(5);
	expect((await packets(c, b)).packetsReceived).toBe(0);
	// Unmuted, b is heard again by each.
	await a.page.evaluate((player) => window.room.mute(player, false), identity(1).player);
	await c.page.evaluate((player) => window.room.mute(player, false), identity(1).player);
	await expect(async () => {
		expect((await packets(a, b)).packetsReceived - stopped).toBeGreaterThan(25);
		expect((await packets(c, b)).packetsReceived).toBeGreaterThan(25);
	}).toPass({ timeout: 30_000 });
	for (const person of [a, b, c]) await person.page.context().close();
});

test('after the voice service restarts, everyone is back in a new group within 5 seconds, mutes kept', async ({
	browser
}) => {
	let service = await startVoice(RESTART_PORT);
	try {
		await restartCheck(browser, async () => {
			await stopVoice(service);
			service = await startVoice(RESTART_PORT);
		});
	} finally {
		await stopVoice(service);
	}
});

async function restartCheck(browser: Browser, restart: () => Promise<void>): Promise<void> {
	const table = newTable();
	const seated = [0, 1, 2];
	const people: Person[] = [];
	for (const [seat, muted] of [
		[0, []],
		[1, []],
		[2, [1]]
	] as [number, number[]][]) {
		const page = await open(browser);
		await page.exposeFunction('voiceToken', async () => token(table, seat));
		const options = joining(browser.browserType().name(), table, seat, seated);
		options.url = `ws://127.0.0.1:${RESTART_PORT}/voice`;
		options.refresh = true;
		options.muted = muted.map((one) => identity(one).player);
		await page.evaluate((given) => window.room.join(given), options);
		people.push({ page, seat });
	}
	// Everyone hears everyone, except that c has b muted.
	const together = async (unlike: string[] | null) => {
		const reports = await Promise.all(people.map((person) => report(person)));
		const [first] = reports;
		for (const [index, mine] of reports.entries()) {
			expect(mine.connected).toBe(true);
			expect(mine.epoch).toBe(first.epoch);
			expect(mine.code).toEqual(first.code);
			const others = reports.filter((other) => other !== mine).map((other) => other.leaf);
			expect(mine.heard.map(({ leaf }) => leaf)).toEqual(others.sort((a, b) => a! - b!));
			for (const heard of mine.heard) {
				const fromB = heard.player === identity(1).player;
				if (index === 2 && fromB) expect(heard).toMatchObject({ muted: true, packetsReceived: 0 });
				else expect(heard.packetsReceived).toBeGreaterThan(10);
			}
			// Everyone rejoins at once, so a newcomer can be handed a few frames sealed
			// before it joined, under an epoch it never holds: those it must refuse.
			for (const one of mine.transforms.filter(({ direction }) => direction === 'decrypt')) {
				expect({ ...one.refused, 'unknown-key': 0 }).toEqual(none);
				expect(one.refused['unknown-key']).toBeLessThan(50);
			}
		}
		if (unlike) expect(first.code).not.toEqual(unlike);
		return first.code;
	};
	let code: string[] = [];
	await expect(async () => {
		code = await together(null);
	}).toPass({ timeout: 30_000 });

	// The service restarts, as a deploy that changes it would.
	const started = performance.now();
	await restart();
	await expect(async () => {
		await together(code);
	}).toPass({ timeout: 10_000, intervals: [100] });
	const back = performance.now() - started;
	console.log(
		`[${browser.browserType().name()}] back together ${Math.round(back)} ms after the restart began`
	);
	expect(back).toBeLessThan(5000);
	for (const person of people) await person.page.context().close();
}

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

// Tell the voice service who a table has in voice, as the table server does,
// signed with the voice key (P4C.5), with whoever may not speak (P4C.8).
async function seatList(table: string, seats: number[], silenced: [number, number][] = []) {
	const body = JSON.stringify({
		table,
		at: Date.now(),
		seats: seats.map((seat) => ({ seat, player: identity(seat).player })),
		blocks: [],
		silenced: silenced.map(([seat, until]) => [identity(seat).player, until])
	});
	const response = await fetch(`http://127.0.0.1:${VOICE_PORT}/seats`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...signSeats(key, body, Date.now()) },
		body
	});
	expect(response.status).toBe(204);
}

test('someone suspended from speaking is heard by nobody, still hears, and speaks again after (P4C.8)', async ({
	browser
}) => {
	const table = newTable();
	await seatList(table, [0, 1]);
	const a = await join(browser, table, 0, [0, 1]);
	const b = await join(browser, table, 1, [0, 1]);
	await everyoneHearsEveryone([a, b]);
	// Voice reports suspend a for four seconds: a's page stops sending, and b's
	// stream of a ends at the service.
	const until = Date.now() + 4000;
	await seatList(table, [0, 1], [[0, until]]);
	await expect
		.poll(async () => {
			const [mine, theirs] = [await report(a), await report(b)];
			return [mine.silencedUntil, mine.producing, theirs.heard.length];
		})
		.toEqual([until, false, 0]);
	// a still hears b.
	const before = (await report(a)).heard[0].packetsReceived;
	await a.page.waitForTimeout(1000);
	expect((await report(a)).heard[0].packetsReceived - before).toBeGreaterThan(25);
	// When it ends, a sends again and b hears a.
	await expect.poll(async () => (await report(a)).silencedUntil, { timeout: 10_000 }).toBeNull();
	await everyoneHearsEveryone([a, b]);
	for (const person of [a, b]) await person.page.context().close();
});

// What the service answers a handshake: 101 when it opens the socket.
const handshake = (origin: string, headers: Record<string, string> = {}) =>
	new Promise<number>((resolve) => {
		const socket = new WebSocket(`ws://127.0.0.1:${VOICE_PORT}/voice`, { origin, headers });
		socket.on('open', () => {
			socket.close();
			resolve(101);
		});
		socket.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
		socket.on('error', () => {});
	});

test('the service refuses a socket opened from another origin', async ({ browserName }) => {
	test.skip(browserName !== 'chromium', 'one engine is enough: no browser is involved');
	expect(await handshake('https://elsewhere.example')).toBe(403);
	expect(await handshake(ORIGIN)).toBe(101);
});

test('the service lets one address open only so many sockets (P4C.8)', async ({ browserName }) => {
	test.skip(browserName !== 'chromium', 'one engine is enough: no browser is involved');
	// As Caddy passes them on: the client's address last in X-Forwarded-For.
	const from = (address: string) => handshake(ORIGIN, { 'x-forwarded-for': address });
	const answers: number[] = [];
	for (let tries = 0; tries < 31; tries += 1) answers.push(await from('203.0.113.50'));
	expect(answers.slice(0, 30)).toEqual(Array(30).fill(101));
	expect(answers[30]).toBe(429);
	// Another address is not held back, nor is this machine itself.
	expect(await from('203.0.113.51')).toBe(101);
	expect(await handshake(ORIGIN)).toBe(101);
});

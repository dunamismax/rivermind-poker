// What brings a table's voice back by itself (P4C.7), one engine a project: a
// media worker that dies, a network that goes away and comes back as another,
// and a service with no room left, each through the site's own VoiceRoom on a
// voice service of the check's own.
import { execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { expect, test, type Browser } from '@playwright/test';
import { canTransform } from './browsers.ts';
import {
	identity,
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
import { Relay } from './relay.ts';
import type { JoinOptions, RoomReport } from './room.ts';
import { RELAYED_MEDIA_PORT, RELAYED_PORT, RESTART_PORT } from './vite.config.ts';

test.beforeEach(({ browserName }) => {
	test.skip(!canTransform(browserName), 'this build of the engine has no RTCRtpScriptTransform');
});

const lan = Object.values(networkInterfaces())
	.flat()
	.find((address) => address?.family === 'IPv4' && !address.internal)?.address;

// Someone joins a room that comes back by itself: it asks the test for each token.
async function joinFor(
	browser: Browser,
	port: number,
	table: string,
	seat: number,
	seated: number[],
	more: Partial<JoinOptions> = {}
): Promise<Person> {
	const page = await open(browser);
	await page.exposeFunction('voiceToken', async () => token(table, seat));
	const options = {
		...joining(browser.browserType().name(), table, seat, seated),
		url: `ws://127.0.0.1:${port}/voice`,
		refresh: true,
		...more
	};
	await page.evaluate((given) => window.room.join(given), options);
	return { page, seat };
}

// What each person has received from each seat, by seat.
function packetsBySeat(reports: RoomReport[], seats: number[]): Map<string, number> {
	const seatOf = new Map(reports.map((one, at) => [one.leaf, seats[at]]));
	const packets = new Map<string, number>();
	for (const [at, mine] of reports.entries()) {
		for (const heard of mine.heard) {
			packets.set(`${seats[at]}<${seatOf.get(heard.leaf)}`, heard.packetsReceived);
		}
	}
	return packets;
}

test('after the media worker dies, everyone is back in a new group within 5 seconds, every control as it was', async ({
	browser
}) => {
	const service = await startVoice(RESTART_PORT);
	try {
		const table = newTable();
		const seats = [0, 1, 2, 3];
		// Seat 0 has muted seat 1; seat 2 has muted themself; seat 3 has deafened.
		const people = [
			await joinFor(browser, RESTART_PORT, table, 0, seats, { muted: [identity(1).player] }),
			await joinFor(browser, RESTART_PORT, table, 1, seats),
			await joinFor(browser, RESTART_PORT, table, 2, seats, { selfMuted: true }),
			await joinFor(browser, RESTART_PORT, table, 3, seats, { deafened: true })
		];
		const together = async (unlike: string[] | null) => {
			const reports = await Promise.all(people.map((person) => report(person)));
			const [first] = reports;
			for (const mine of reports) {
				expect(mine.connected).toBe(true);
				expect(mine.epoch).toBe(first.epoch);
				expect(mine.code).toEqual(first.code);
				expect(mine.heard).toHaveLength(3);
			}
			if (unlike) expect(first.code).not.toEqual(unlike);
			const packets = packetsBySeat(reports, seats);
			// Who talks is heard by who listens: seats 0 and 1 talk.
			expect(packets.get('1<0')).toBeGreaterThan(10);
			expect(packets.get('2<0')).toBeGreaterThan(10);
			expect(packets.get('2<1')).toBeGreaterThan(10);
			// Seat 0's mute of seat 1 holds at the service, and seat 3 hears nobody.
			expect(packets.get('0<1')).toBe(0);
			expect(reports[0].heard.find(({ player }) => player === identity(1).player)?.muted).toBe(
				true
			);
			for (const from of [0, 1, 2]) expect(packets.get(`3<${from}`)).toBe(0);
			// Everyone else still sees seat 2 muted and seat 3 deafened.
			const seen = reports[1].people;
			expect(seen.find(({ seat }) => seat === 2)).toMatchObject({ muted: true, deafened: false });
			expect(seen.find(({ seat }) => seat === 3)).toMatchObject({ deafened: true });
			return first.code;
		};
		let code: string[] = [];
		await expect(async () => {
			code = await together(null);
		}).toPass({ timeout: 30_000 });

		// mediasoup's worker is the service's one child process.
		const worker = execFileSync('pgrep', ['-P', String(service.pid)])
			.toString()
			.trim();
		expect(worker).toMatch(/^\d+$/);
		const started = performance.now();
		process.kill(Number(worker), 'SIGKILL');
		await expect(async () => {
			await together(code);
		}).toPass({ timeout: 10_000, intervals: [100] });
		const back = performance.now() - started;
		console.log(
			`[${browser.browserType().name()}] back together ${Math.round(back)} ms after the media worker died`
		);
		expect(back).toBeLessThan(5000);
		// The service itself never stopped.
		expect(service.exitCode).toBeNull();
		for (const person of people) await person.page.context().close();
	} finally {
		await stopVoice(service);
	}
});

test('after the network goes and comes back as another, ICE starts again and the group stands', async ({
	browser
}) => {
	test.skip(!lan, 'the relay needs an address beside loopback');
	// The service's media port is on loopback, and it announces the relay.
	const relay = await Relay.start(
		{ address: lan!, port: RELAYED_MEDIA_PORT },
		{ address: '127.0.0.1', port: RELAYED_MEDIA_PORT }
	);
	const service = await startVoice(RELAYED_PORT, '../server.ts', {
		VOICE_LISTEN_IPS: '127.0.0.1',
		VOICE_MEDIA_PORT: String(RELAYED_MEDIA_PORT),
		VOICE_ANNOUNCED_ADDRESS: lan!
	});
	try {
		const table = newTable();
		const people = [
			await joinFor(browser, RELAYED_PORT, table, 0, [0, 1]),
			await joinFor(browser, RELAYED_PORT, table, 1, [0, 1])
		];
		const received = async () => {
			const reports = await Promise.all(people.map((person) => report(person)));
			for (const mine of reports) {
				expect(mine.connected).toBe(true);
				expect(mine.heard).toHaveLength(1);
			}
			return reports;
		};
		let before: RoomReport[] = [];
		await expect(async () => {
			before = await received();
			for (const mine of before) expect(mine.heard[0].packetsReceived).toBeGreaterThan(50);
		}).toPass({ timeout: 30_000 });
		// Everything went through the relay, both ways (WebKit names no addresses).
		expect(relay.counts.up).toBeGreaterThan(100);
		expect(relay.counts.down).toBeGreaterThan(100);

		// The network is gone for a second and a half. What follows is another:
		// the service has never seen the address either page now comes from.
		relay.gap(1500);
		await people[0].page.waitForTimeout(1500);
		const held = await received();
		const started = performance.now();
		// The browser says so, as it does when a phone moves to another network.
		for (const person of people) {
			await person.page.evaluate(() => window.dispatchEvent(new Event('online')));
		}
		let after: RoomReport[] = [];
		await expect(async () => {
			after = await received();
			for (const [at, mine] of after.entries()) {
				expect(mine.connection).toEqual({ send: 'connected', recv: 'connected' });
				expect(mine.heard[0].packetsReceived).toBeGreaterThan(
					held[at].heard[0].packetsReceived + 5
				);
				expect(mine.iceRestarts).toBeGreaterThanOrEqual(2);
			}
		}).toPass({ timeout: 10_000, intervals: [50] });
		const back = performance.now() - started;
		console.log(
			`[${browser.browserType().name()}] audio both ways ${Math.round(back)} ms after the network came back`
		);
		expect(back).toBeLessThan(5000);
		// Nobody left the group or the room: the same epoch, code and connection.
		for (const [at, mine] of after.entries()) {
			expect(mine.epoch).toBe(before[at].epoch);
			expect(mine.code).toEqual(before[at].code);
			expect(mine.reconnects).toBe(0);
		}
		for (const person of people) await person.page.context().close();
	} finally {
		await stopVoice(service);
		relay.close();
	}
});

test('a join and a leave through a network that delays and loses packets cost no frame its key', async ({
	browser
}) => {
	test.skip(!lan, 'the relay needs an address beside loopback');
	const relay = await Relay.start(
		{ address: lan!, port: RELAYED_MEDIA_PORT },
		{ address: '127.0.0.1', port: RELAYED_MEDIA_PORT }
	);
	const service = await startVoice(RELAYED_PORT, '../server.ts', {
		VOICE_LISTEN_IPS: '127.0.0.1',
		VOICE_MEDIA_PORT: String(RELAYED_MEDIA_PORT),
		VOICE_ANNOUNCED_ADDRESS: lan!
	});
	try {
		// Audio is up to 60 ms late each way and out of order, and 5% of it is
		// lost; the group's messages travel beside it, on time. Frames sealed
		// under the epoch before arrive after the epoch has changed.
		relay.impairment = { loss: 0.05, delayMs: 30, jitterMs: 30, legs: 'both' };
		const table = newTable();
		const seats = [0, 1, 2];
		const a = await joinFor(browser, RELAYED_PORT, table, 0, seats);
		const b = await joinFor(browser, RELAYED_PORT, table, 1, seats);
		const settled = async (people: Person[], epoch: number) => {
			await expect(async () => {
				const reports = await Promise.all(people.map((person) => report(person)));
				for (const mine of reports) {
					expect(mine.epoch).toBe(epoch);
					expect(mine.heard).toHaveLength(people.length - 1);
					for (const heard of mine.heard) expect(heard.packetsReceived).toBeGreaterThan(100);
				}
			}).toPass({ timeout: 30_000 });
		};
		await settled([a, b], 1);
		const c = await joinFor(browser, RELAYED_PORT, table, 2, seats);
		await settled([a, b, c], 2);
		for (const person of [a, b]) {
			await person.page.evaluate((seated) => window.room.seats(seated), [identity(0), identity(1)]);
		}
		await c.page.context().close();
		await settled([a, b], 3);
		// Long enough for everything sealed under an earlier epoch to have arrived.
		await a.page.waitForTimeout(1500);
		for (const person of [a, b]) {
			const mine = await report(person);
			for (const one of mine.transforms.filter(({ direction }) => direction === 'decrypt')) {
				expect(one.refused, one.id).toEqual(none);
			}
			expect(mine.refused).toEqual([]);
		}
		expect(relay.counts.lost).toBeGreaterThan(20);
		for (const person of [a, b]) await person.page.context().close();
	} finally {
		await stopVoice(service);
		relay.close();
	}
});

test('on a network that lets signalling through and no audio, the room ends and says so', async ({
	browser
}) => {
	test.skip(!lan, 'the relay needs an address beside loopback');
	const relay = await Relay.start(
		{ address: lan!, port: RELAYED_MEDIA_PORT },
		{ address: '127.0.0.1', port: RELAYED_MEDIA_PORT }
	);
	const service = await startVoice(RELAYED_PORT, '../server.ts', {
		VOICE_LISTEN_IPS: '127.0.0.1',
		VOICE_MEDIA_PORT: String(RELAYED_MEDIA_PORT),
		VOICE_ANNOUNCED_ADDRESS: lan!
	});
	try {
		// Nothing passes the relay, and nothing listens for TCP at its address.
		relay.gap(600_000);
		const table = newTable();
		const quick = { connectMs: 2000, iceGiveUpMs: 1000 };
		const a = await joinFor(browser, RELAYED_PORT, table, 0, [0, 1], quick);
		const b = await joinFor(browser, RELAYED_PORT, table, 1, [0, 1], quick);
		// Each tries twice, a new connection each time, and then stops trying.
		await expect
			.poll(async () => [(await report(a)).closed, (await report(b)).closed], { timeout: 60_000 })
			.toEqual([4504, 4504]);
		expect(relay.counts.up).toBe(0);
		for (const person of [a, b]) await person.page.context().close();
	} finally {
		await stopVoice(service);
		relay.close();
	}
});

test('a full service says so, and a room that cannot come back ends', async ({ browser }) => {
	let service = await startVoice(RESTART_PORT, '../server.ts', { VOICE_MAX_PEOPLE: '2' });
	try {
		const table = newTable();
		const seats = [0, 1, 2];
		const a = await joinFor(browser, RESTART_PORT, table, 0, seats, { giveUpMs: 3000 });
		const b = await joinFor(browser, RESTART_PORT, table, 1, seats, { giveUpMs: 3000 });
		// A third person finds voice full.
		const page = await open(browser);
		const options = {
			...joining(browser.browserType().name(), table, 2, seats),
			url: `ws://127.0.0.1:${RESTART_PORT}/voice`
		};
		const refused = await page.evaluate(
			(given) =>
				window.room.join(given).then(
					() => 'joined',
					(error: Error) => error.message
				),
			options
		);
		expect(refused).toBe('hello refused: full');
		await page.context().close();
		await expect.poll(async () => (await report(a)).connected).toBe(true);

		// The service comes back with room for one: one of the two is back in
		// voice, and the other is told voice is full, not left trying.
		await stopVoice(service);
		service = await startVoice(RESTART_PORT, '../server.ts', { VOICE_MAX_PEOPLE: '1' });
		await expect
			.poll(
				async () => {
					const reports = [await report(a), await report(b)];
					return reports.map((one) => (one.connected ? 'in' : one.closed)).sort();
				},
				{ timeout: 15_000 }
			)
			.toEqual([4503, 'in']);

		// The service goes for good: whoever was in keeps trying for as long as
		// they were given, and then the room ends.
		await stopVoice(service);
		await expect
			.poll(async () => [(await report(a)).closed, (await report(b)).closed].sort(), {
				timeout: 15_000
			})
			.toEqual([1006, 4503]);
		for (const person of [a, b]) await person.page.context().close();
	} finally {
		await stopVoice(service);
	}
});

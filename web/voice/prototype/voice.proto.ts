// The voice prototype's checks in one engine at a time (P4C.1). Each person is
// a browser context of its own; docs/voice.md records what the results settled.
import { expect, test } from '@playwright/test';
import { AUDIO_LEVEL_URI } from './frame.ts';
import {
	everyoneHearsEveryone,
	expectHeard,
	expectSilence,
	join,
	leave,
	report,
	serviceStats,
	tapsOf
} from './room.ts';

const handlers = { chromium: 'Chrome111', firefox: 'Firefox120', webkit: 'Safari12' };

test('two people hear each other through the SFU, encrypted in a worker', async ({
	browser
}, info) => {
	const room = `${info.project.name}-two`;
	const people = [await join(browser, room, 0), await join(browser, room, 1)];
	const reports = await everyoneHearsEveryone(people);

	for (const one of reports) {
		expect(one.handler).toBe(handlers[info.project.name as keyof typeof handlers]);
		expect(one.support.scriptTransform).toBe(true);
		expect(one.audioLevelNegotiated).toBe(false);
		expect(one.senderExtensions.length).toBeGreaterThan(0);
	}
	// The service negotiated no audio levels, and a listener at the SFU saw none:
	// only prototype frames it holds no key for.
	const stats = await serviceStats();
	expect(stats.producerHeaderExtensions).not.toContain(AUDIO_LEVEL_URI);
	expect(stats.consumerHeaderExtensions).not.toContain(AUDIO_LEVEL_URI);
	for (const tap of await tapsOf(room, 2)) {
		expect(tap.prototypeFrames).toBe(tap.packets);
		expect(tap.headerExtensionIds).not.toContain(tap.audioLevelId);
	}
	console.log(`[voice-proto] ${JSON.stringify({ room, reports })}`);
	await leave(people);
});

test('the SFU would see audio levels if a client negotiated them', async ({ browser }, info) => {
	// The control for the check above: with the extension left in, the same
	// listener finds it on the wire.
	const room = `${info.project.name}-levels`;
	const people = [
		await join(browser, room, 0, { audioLevel: 1 }),
		await join(browser, room, 1, { audioLevel: 1 })
	];
	const reports = await everyoneHearsEveryone(people);
	for (const one of reports) expect(one.audioLevelNegotiated).toBe(true);
	for (const tap of await tapsOf(room, 2)) {
		expect(tap.audioLevelId).not.toBeNull();
		expect(tap.headerExtensionIds).toContain(tap.audioLevelId);
	}
	await leave(people);
});

test('someone with the wrong key hears nothing and is not heard', async ({ browser }, info) => {
	const room = `${info.project.name}-wrong-key`;
	const members = [await join(browser, room, 0), await join(browser, room, 1)];
	const outsider = await join(browser, room, 2, { secret: 'not the room secret' });

	await expect(async () => {
		const theirs = await report(outsider, 500);
		const received = theirs.transforms.filter((one) => one.direction === 'decrypt');
		expect(received).toHaveLength(2);
		for (const one of received) {
			expect(one.failed).toBeGreaterThan(50);
			expect(one.frames).toBe(0);
		}
		for (const one of theirs.heard) expectSilence(one, `key ${one.kid} at the outsider`);

		for (const member of members) {
			const mine = await report(member, 500);
			const other = members.find((one) => one !== member)!;
			expectHeard(
				mine.heard.find((one) => one.kid === other.kid)!,
				other,
				'the other member'
			);
			expectSilence(
				mine.heard.find((one) => one.kid === outsider.kid)!,
				'the outsider'
			);
			const refused = mine.transforms.find((one) => one.id === `recv-${theirs.peerId}`)!;
			expect(refused.failed).toBeGreaterThan(50);
			expect(refused.frames).toBe(0);
		}
	}).toPass({ timeout: 60_000 });
	await leave([...members, outsider]);
});

test('ts-mls agrees a group key in the browser', async ({ page }) => {
	await page.goto('/');
	const check = await page.evaluate(() => window.voice.mls());
	expect(check.epoch).toBe(2);
	expect(check.baseKeys).toHaveLength(3);
	expect(check.baseKeys[0]).toMatch(/^[0-9a-f]{32}$/);
	expect(new Set(check.baseKeys).size).toBe(1);
	console.log(`[voice-proto] ${JSON.stringify({ mls: check })}`);
});

test('two people hear each other over TCP on the same port', async ({ browser }, info) => {
	const room = `${info.project.name}-tcp`;
	const people = [
		await join(browser, room, 0, { tcp: 1 }),
		await join(browser, room, 1, { tcp: 1 })
	];
	const reports = await everyoneHearsEveryone(people);
	for (const one of reports) expect(one.protocol).toBe('tcp');
	await leave(people);
});

test('two people talk through fake capture devices', async ({ browser }, info) => {
	test.skip(
		info.project.name === 'chromium' && process.platform === 'darwin',
		"Chromium's fake microphone never answers on macOS here (browsers.ts)"
	);
	const room = `${info.project.name}-capture`;
	const people = [
		await join(browser, room, 0, { source: 'capture' }),
		await join(browser, room, 1, { source: 'capture' })
	];
	const reports = await everyoneHearsEveryone(people);
	for (const one of reports) expect(one.source).toBe('capture');
	await leave(people);
});

test('nine people hear each other, and the service is measured', async ({ browser }, info) => {
	test.setTimeout(300_000);
	const room = `${info.project.name}-nine`;
	const people = [];
	for (let kid = 0; kid < 9; kid++) people.push(await join(browser, room, kid));
	await everyoneHearsEveryone(people);
	expect((await serviceStats()).rooms.find((one) => one.room === room)).toEqual({
		room,
		peers: 9,
		producers: 9,
		consumers: 72
	});
	// The keyless listener is done with every producer before the clock starts.
	await tapsOf(room, 9);

	// Thirty seconds of nine people all sending at once: the worst a table can do.
	const seconds = 30;
	const before = await serviceStats();
	const started = performance.now();
	await people[0].page.waitForTimeout(seconds * 1000);
	const after = await serviceStats();
	const elapsed = (performance.now() - started) / 1000;
	const reports = await everyoneHearsEveryone(people);

	const percent = (micros: number) => Math.round(micros / elapsed / 100) / 100;
	const megabytes = (bytes: number) => Math.round(bytes / 1024 / 1024);
	const kbps = (bytes: number) => Math.round((bytes * 8) / elapsed / 1000);
	const heard = reports.flatMap((one) => one.heard);
	const sent = reports.map((one) => one.transforms.find((t) => t.direction === 'encrypt')!);
	const measured = {
		room,
		seconds: Math.round(elapsed),
		// CPU as a share of one core.
		workerCpuPercent: percent(after.worker.cpuMicros - before.worker.cpuMicros),
		nodeCpuPercent: percent(after.node.cpuMicros - before.node.cpuMicros),
		workerRssMb: megabytes(after.worker.rssBytes),
		nodeRssMb: megabytes(after.node.rssBytes),
		// What the service took in from all nine and sent out to all nine, on the wire.
		receivedKbps: kbps(after.bytesReceived - before.bytesReceived),
		sentKbps: kbps(after.bytesSent - before.bytesSent),
		sentKbpsPerListenerPerSpeaker: kbps((after.bytesSent - before.bytesSent) / 72),
		opusBytesPerFrame: Math.round(
			sent.reduce((sum, one) => sum + one.bytes, 0) / sent.reduce((sum, one) => sum + one.frames, 0)
		),
		concealedPercent:
			Math.round(
				(10000 * heard.reduce((sum, one) => sum + one.concealedSamples, 0)) /
					heard.reduce((sum, one) => sum + one.totalSamplesReceived, 0)
			) / 100,
		jitterBufferMs: Math.round(
			heard.reduce((sum, one) => sum + one.jitterBufferMs, 0) / heard.length
		),
		protocols: [...new Set(reports.map((one) => one.protocol))]
	};
	console.log(`[voice-proto] ${JSON.stringify(measured)}`);
	await info.attach('nine-person room', {
		body: JSON.stringify(measured, null, 2),
		contentType: 'application/json'
	});
	await leave(people);
});

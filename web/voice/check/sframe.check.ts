// SFrame and its worker in a real browser (P4C.2), one engine a project. The
// vectors Vitest holds sframe.ts to under Node are run on each engine's own
// WebCrypto, and a WebRTC call is sent through the worker, built and served as
// the site's client is, under the site's CSP (vite.config.ts beside this).
import { expect, test, type Page } from '@playwright/test';
import { canCapture, canTransform } from './browsers.ts';
import type { CallOptions, CallReport, Heard } from './page.ts';

const SENDER = 3;

async function ready(page: Page): Promise<void> {
	if (process.env.VOICE_DEBUG) {
		page.on('console', (message) => console.log(`[page] ${message.text()}`));
		page.on('pageerror', (error) => console.log(`[page] ${error}`));
	}
	await page.goto('/');
	await expect(page.locator('body')).toHaveAttribute('data-check', 'ready');
}

// A call on this page: a fake microphone where the engine's works here and a
// tone where it does not. Only Chromium is given Web Audio; the others are
// judged by WebRTC's statistics (browsers.ts).
async function call(page: Page, engine: string, extra: Partial<CallOptions> = {}): Promise<void> {
	test.skip(!canTransform(engine), 'this build of the engine has no RTCRtpScriptTransform');
	await ready(page);
	const options: CallOptions = {
		source: canCapture(engine) ? 'capture' : 'tone',
		webAudio: engine === 'chromium',
		from: SENDER,
		...extra
	};
	await page.evaluate((given) => window.check.call(given), options);
}

const key = (page: Page, who: 'speaker' | 'listener', epoch: number, secret: string) =>
	page.evaluate(([w, e, s]) => window.check.key(w, e, s), [who, epoch, secret] as const);
const sendAs = (page: Page, sender: number, epoch: number) =>
	page.evaluate(([s, e]) => window.check.sendAs(s, e), [sender, epoch] as const);
const retire = (page: Page, who: 'speaker' | 'listener', epoch: number) =>
	page.evaluate(([w, e]) => window.check.retire(w, e), [who, epoch] as const);
const report = (page: Page, listenMs = 0): Promise<CallReport> =>
	page.evaluate((ms) => window.check.report(ms), listenMs);

// The listener decoded real audio, with little of it concealed. With an
// analyser the page measures the sound itself; without, WebRTC's count of
// decoded energy stands in. (Chromium counts no energy for a track whose only
// output is a muted element.)
function expectHeard(heard: Heard): void {
	if (heard.rms !== null) expect(heard.rms, 'rms').toBeGreaterThan(0.005);
	else expect(heard.energy, 'energy').toBeGreaterThan(0.0001);
	expect(heard.totalSamplesReceived, 'samples').toBeGreaterThan(24_000);
	expect(heard.concealedSamples / heard.totalSamplesReceived, 'concealed').toBeLessThan(0.5);
}

// The listener decoded nothing.
function expectSilence(heard: Heard): void {
	if (heard.rms !== null) expect(heard.rms, 'rms').toBeLessThan(0.001);
	else expect(heard.energy, 'energy').toBe(0);
}

const refusals = (one: CallReport): Record<string, number> =>
	Object.fromEntries(Object.entries(one.received!.refused).filter(([, count]) => count > 0));

test("RFC 9605's vectors hold on this engine's WebCrypto", async ({ page }, info) => {
	await ready(page);
	// Where an engine cannot put a worker between the codec and the network,
	// the page says so, and voice does not start there (D-15).
	const transform = canTransform(info.project.name);
	expect(await page.evaluate(() => window.check.support())).toEqual({
		frames: transform,
		scriptTransform: transform,
		subtle: true
	});
	const check = await page.evaluate(() => window.check.vectors());
	expect(check.failures).toEqual([]);
	expect(check).toMatchObject({ headers: 289, frames: 1, otherSuites: 7 });
});

test('a base key cannot be read back out', async ({ page }) => {
	await ready(page);
	expect(await page.evaluate(() => window.check.keys())).toEqual({
		extractable: false,
		exported: false,
		usages: ['deriveBits', 'deriveKey']
	});
});

test('a call is sealed and opened in the worker, and heard', async ({ page }, info) => {
	await call(page, info.project.name);
	// The listener holds the key before the first frame is sealed under it.
	await key(page, 'listener', 1, 'the table');
	await key(page, 'speaker', 1, 'the table');
	await sendAs(page, SENDER, 1);

	let last!: CallReport;
	await expect(async () => {
		last = await report(page, 1200);
		expect(last.connection).toEqual({ speaker: 'connected', listener: 'connected' });
		expect(last.sent).toMatchObject({ id: 'send', direction: 'encrypt' });
		expect(last.sent!.frames).toBeGreaterThan(50);
		expect(last.received).toMatchObject({ id: 'recv', direction: 'decrypt' });
		expect(last.received!.frames).toBeGreaterThan(50);
		expectHeard(last.heard);
	}).toPass({ timeout: 45_000 });
	expect(refusals(last)).toEqual({});
	expect(last.refused).toEqual([]);
	expect(last.received!.frames).toBeLessThanOrEqual(last.sent!.frames);
	// What was opened is what was sealed: the same Opus bytes a frame.
	const opus = (tally: { bytes: number; frames: number }) => tally.bytes / tally.frames;
	expect(Math.abs(opus(last.received!) - opus(last.sent!))).toBeLessThan(8);
	console.log(
		`[voice-check] ${JSON.stringify({ engine: info.project.name, platform: process.platform, sent: last.sent, received: last.received })}`
	);
});

test('a listener with another secret opens nothing and hears nothing', async ({ page }, info) => {
	await call(page, info.project.name);
	await key(page, 'listener', 1, 'not the table');
	await key(page, 'speaker', 1, 'the table');
	await sendAs(page, SENDER, 1);
	await expect(async () => {
		const one = await report(page, 600);
		expect(one.sent!.frames).toBeGreaterThan(50);
		expect(one.received!.refused.tampered).toBeGreaterThan(50);
		expect(one.received!.frames).toBe(0);
		expect(refusals(one)).toEqual({ tampered: one.received!.refused.tampered });
		expectSilence(one.heard);
	}).toPass({ timeout: 45_000 });
});

test('a listener with no key opens nothing and hears nothing', async ({ page }, info) => {
	await call(page, info.project.name);
	await key(page, 'speaker', 1, 'the table');
	await sendAs(page, SENDER, 1);
	await expect(async () => {
		const one = await report(page, 600);
		expect(one.received!.refused['unknown-key']).toBeGreaterThan(50);
		expect(one.received!.frames).toBe(0);
		expectSilence(one.heard);
	}).toPass({ timeout: 45_000 });
});

test("frames on another person's stream are refused", async ({ page }, info) => {
	// The listener takes this stream to be leaf 4's; what arrives is sealed as leaf 3.
	await call(page, info.project.name, { from: SENDER + 1 });
	await key(page, 'listener', 1, 'the table');
	await key(page, 'speaker', 1, 'the table');
	await sendAs(page, SENDER, 1);
	await expect(async () => {
		const one = await report(page, 600);
		expect(one.received!.refused['wrong-sender']).toBeGreaterThan(50);
		expect(one.received!.frames).toBe(0);
		expectSilence(one.heard);
	}).toPass({ timeout: 45_000 });
});

test('a speaker with no key sends nothing', async ({ page }, info) => {
	await call(page, info.project.name);
	await key(page, 'listener', 1, 'the table');
	await expect(async () => {
		const one = await report(page, 600);
		expect(one.connection).toEqual({ speaker: 'connected', listener: 'connected' });
		expect(one.sent!.unsent).toBeGreaterThan(50);
		expect(one.sent!.frames).toBe(0);
		// Nothing was sealed, so nothing left the page: the listener was handed no frame at all.
		expect(one.received?.frames ?? 0).toBe(0);
		expect(one.received ? refusals(one) : {}).toEqual({});
		expect(one.heard.packetsReceived).toBe(0);
		expectSilence(one.heard);
	}).toPass({ timeout: 45_000 });
});

test('audio sent without the worker is never played', async ({ page }, info) => {
	// A sender with no transform sends plain Opus. The listener refuses every frame of it.
	await call(page, info.project.name, { unsealed: true });
	await key(page, 'listener', 1, 'the table');
	await expect(async () => {
		const one = await report(page, 600);
		expect(one.sent).toBeNull();
		const refused = Object.values(one.received!.refused).reduce((sum, count) => sum + count, 0);
		expect(refused).toBeGreaterThan(50);
		expect(one.received!.frames).toBe(0);
		expectSilence(one.heard);
	}).toPass({ timeout: 45_000 });
});

test('a new epoch takes over without a refused frame, and a retired one is refused', async ({
	page
}, info) => {
	await call(page, info.project.name);
	await key(page, 'listener', 1, 'the table');
	await key(page, 'speaker', 1, 'the table');
	await sendAs(page, SENDER, 1);
	await expect(async () => {
		expect((await report(page)).received!.frames).toBeGreaterThan(50);
	}).toPass({ timeout: 45_000 });

	// Someone joined: the listener gets the new epoch first and keeps the old one
	// for the frames still on their way, then the speaker moves to it.
	await key(page, 'listener', 2, 'the table, one more');
	await key(page, 'speaker', 2, 'the table, one more');
	await sendAs(page, SENDER, 2);
	const moved = (await report(page)).received!.frames;
	await expect(async () => {
		expect((await report(page)).received!.frames).toBeGreaterThan(moved + 50);
	}).toPass({ timeout: 45_000 });
	await retire(page, 'listener', 1);
	await retire(page, 'speaker', 1);
	const after = await report(page, 1200);
	expect(refusals(after)).toEqual({});
	expect(after.refused).toEqual([]);
	expectHeard(after.heard);

	// The listener's page retires epoch 2 while the speaker still sends under it.
	await retire(page, 'listener', 2);
	const retired = (await report(page)).received!;
	await expect(async () => {
		const one = (await report(page)).received!;
		expect(one.refused['stale-epoch']).toBeGreaterThan(50);
		expect(one.frames).toBe(retired.frames);
	}).toPass({ timeout: 45_000 });
});

test('the table voice code is the same words on this engine', async ({ page }) => {
	await ready(page);
	// The answer group-keys.spec.ts pins under Node.
	expect(await page.evaluate(() => window.check.code())).toBe('media casino old equip');
});

// One 20 ms frame of decoded audio at 48 kHz.
const ONE_FRAME = 960;

for (const skewMs of [0, 60]) {
	test(`a join and a leave cost a listener no frame, the listener ${skewMs} ms behind`, async ({
		page
	}, info) => {
		// The speaker makes the group, so its leaf is 0, and the listener's stream is that leaf's.
		await call(page, info.project.name, { from: 0 });
		const first = await page.evaluate(() => window.check.groupStart());
		expect(first).toMatchObject({
			epoch: 1,
			speaker: { leaf: 0, seatsOk: true },
			listener: { leaf: 1, seatsOk: true }
		});
		expect(first.listener.code).toBe(first.speaker.code);
		await expect(async () => {
			const one = await report(page, 600);
			expect(one.received!.frames).toBeGreaterThan(100);
			expectHeard(one.heard);
		}).toPass({ timeout: 45_000 });
		const before = await report(page);

		// Someone sits down and joins voice, then stands up again: two new epochs,
		// each with a code of its own that both screens share.
		const joined = await page.evaluate((ms) => window.check.groupJoin(ms), skewMs);
		expect(joined.epoch).toBe(2);
		expect(joined.listener.code).toBe(joined.speaker.code);
		await page.waitForTimeout(1500);
		const left = await page.evaluate((ms) => window.check.groupLeave(ms), skewMs);
		expect(left.epoch).toBe(3);
		expect(left.listener.code).toBe(left.speaker.code);
		expect(new Set([first.speaker.code, joined.speaker.code, left.speaker.code]).size).toBe(3);
		for (const one of [joined, left]) {
			expect(one.speaker.seatsOk).toBe(true);
			expect(one.listener.seatsOk).toBe(true);
		}
		await page.waitForTimeout(1500);

		const after = await report(page, 600);
		// Every frame sent was opened: none refused, none left unsent.
		expect(refusals(after)).toEqual({});
		expect(after.refused).toEqual([]);
		expect(after.sent!.unsent).toBe(before.sent!.unsent);
		expect(after.received!.frames).toBeGreaterThan(before.received!.frames + 100);
		expectHeard(after.heard);
		const concealed = after.heard.concealedSamples - before.heard.concealedSamples;
		console.log(
			`[voice-check] ${JSON.stringify({ engine: info.project.name, platform: process.platform, skewMs, concealedSamples: concealed, waited: after.received!.waited })}`
		);
		if (skewMs === 0) {
			// Both pages reach each epoch together, as two pages told by one server do.
			expect(concealed).toBeLessThanOrEqual(ONE_FRAME);
		} else {
			// The listener got frames before their key: it waited for it, and still dropped none.
			expect(after.received!.waited).toBeGreaterThan(0);
		}
	});
}

test('what SFrame costs a page in a full room', async ({ page }, info) => {
	await ready(page);
	// 161 bytes is a 20 ms Opus frame at 64 kbps (docs/voice.md).
	const result = await page.evaluate(() =>
		window.check.bench({ frames: 3000, bytes: 161, others: 8 })
	);
	console.log(
		`[voice-check] ${JSON.stringify({ engine: info.project.name, platform: process.platform, bench: result })}`
	);
	await info.attach('sframe cost', {
		body: JSON.stringify(result, null, 2),
		contentType: 'application/json'
	});
	// A frame lasts 20 ms; sealing or opening one must be a small part of that.
	expect(result.sealMicros).toBeLessThan(2000);
	expect(result.openMicros).toBeLessThan(2000);
});

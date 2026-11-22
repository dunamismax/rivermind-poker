// A listener at the SFU that holds no key (P4C.8): a test build of the voice
// service (tap-server.ts) keeps every packet it forwards, as its operator
// could, while three people in one engine talk through it, one arriving and
// one leaving. Then the check asks what that copy is worth: to the listener,
// which holds no key, nothing at all; to each person, exactly the epochs they
// were in. Someone who arrived opens nothing said before, and someone who
// left nothing said after.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { AUDIO_LEVEL_URI } from '../../src/lib/server/voice/media.ts';
import { LAYOUT, TAG_BYTES, decodeHeader, partsOf } from '../../src/lib/voice/sframe.ts';
import { fromBase64 } from '../../src/lib/voice/signalling.ts';
import { canTransform } from './browsers.ts';
import {
	everyoneHearsEveryone,
	identity,
	join,
	newTable,
	report,
	startVoice,
	stopVoice,
	type Person
} from './people.ts';
import type { Decoded } from './room.ts';
import type { TapCapture } from './tap-server.ts';
import { TAP_PORT, TAP_READ_PORT } from './vite.config.ts';

const TAP_URL = `ws://127.0.0.1:${TAP_PORT}/voice`;

const tapped = async (): Promise<TapCapture[]> =>
	(await fetch(`http://127.0.0.1:${TAP_READ_PORT}/tap`)).json();

// One frame the listener kept, with what its SFrame header says in the clear.
type Frame = { producer: string; sender: number; epoch: number; payload: string };

function framesOf(captures: TapCapture[]): Frame[] {
	return captures.flatMap(({ producer, packets }) =>
		packets.map(({ payload }) => {
			const bytes = fromBase64(payload)!;
			const header = decodeHeader(bytes);
			const parts = header && partsOf(LAYOUT, header.kid);
			return {
				producer,
				// -1 where the payload is not an SFrame frame at all.
				sender: parts?.sender ?? -1,
				epoch: header && bytes.length > header.length + TAG_BYTES ? (parts?.slot ?? -1) : -1,
				payload
			};
		})
	);
}

test.beforeEach(({ browserName }) => {
	test.skip(!canTransform(browserName), 'this build of the engine has no RTCRtpScriptTransform');
});

test('a listener at the SFU with no key gets every frame and hears none; who arrived or left opens nothing outside their epochs', async ({
	browser,
	playwright
}) => {
	const service = await startVoice(TAP_PORT, 'tap-server.ts', {
		TAP_PORT: String(TAP_READ_PORT)
	});
	try {
		const engine = browser.browserType().name();
		const table = newTable();
		const seated = [0, 1, 2];
		// Each stage of the conversation goes on a while: a fake microphone that
		// beeps sends little between beeps (DTX).
		const talk = (person: Person) => person.page.waitForTimeout(1500);
		// a is alone in voice under epoch 0: nobody but the listener hears it.
		const a = await join(browser, table, 0, seated, [], TAP_URL);
		await expect
			.poll(async () => framesOf(await tapped()).filter(({ epoch }) => epoch === 0).length, {
				timeout: 30_000
			})
			.toBeGreaterThan(25);
		// b arrives (epoch 1), then c (epoch 2).
		const b = await join(browser, table, 1, seated, [], TAP_URL);
		await everyoneHearsEveryone([a, b]);
		await talk(a);
		const c = await join(browser, table, 2, seated, [], TAP_URL);
		const three = await everyoneHearsEveryone([a, b, c]);
		await talk(a);
		expect(three.map(({ leaf, epoch }) => ({ leaf, epoch }))).toEqual([
			{ leaf: 0, epoch: 2 },
			{ leaf: 1, epoch: 2 },
			{ leaf: 2, epoch: 2 }
		]);
		// a stands up and leaves voice, keeping the page and the keys it was given.
		const heardByA = await report(a);
		for (const person of [b, c]) {
			await person.page.evaluate((now) => window.room.seats(now), [identity(1), identity(2)]);
		}
		await a.page.evaluate(() => window.room.leave());
		const two = await everyoneHearsEveryone([b, c]);
		expect(two.map(({ epoch }) => epoch)).toEqual([3, 3]);
		// b and c go on talking, under a key a never held.
		await talk(b);
		const heard = [heardByA, ...(await Promise.all([b, c].map((person) => report(person))))];
		const captures = await tapped();
		const frames = framesOf(captures);

		// Every packet the listener kept is an SFrame frame sealed as the person
		// whose producer sent it, under one of the room's four epochs, and none
		// carries an audio level.
		expect(captures).toHaveLength(3);
		expect(frames.filter(({ sender, epoch }) => sender < 0 || epoch < 0)).toEqual([]);
		const senderOf = new Map<string, number>();
		for (const capture of captures) {
			const senders = new Set(
				frames.filter((frame) => frame.producer === capture.producer).map((one) => one.sender)
			);
			expect(senders.size).toBe(1);
			senderOf.set(capture.producer, [...senders][0]);
			// It reads each packet's extensions: the stream's `mid` is there, levels are not.
			expect(capture.extensions).toContain('urn:ietf:params:rtp-hdrext:sdes:mid');
			expect(capture.extensions).not.toContain(AUDIO_LEVEL_URI);
		}
		expect([...senderOf.values()].sort()).toEqual([0, 1, 2]);
		// It was handed every frame that anyone was: it consumed each producer
		// from its start, before any listener could, and missed none.
		for (const capture of captures) {
			const leaf = senderOf.get(capture.producer)!;
			const most = Math.max(
				...heard
					.flatMap((one) => one.heard.filter((h) => h.leaf === leaf))
					.map((h) => h.packetsReceived)
			);
			expect(capture.packets.length, `leaf ${leaf}`).toBeGreaterThanOrEqual(most);
			expect(capture.gaps, `leaf ${leaf}: sequence numbers skipped`).toBe(0);
		}
		// How many frames each person sealed under each epoch.
		const count = (sender: number, epoch: number) =>
			frames.filter((one) => one.sender === sender && one.epoch === epoch).length;
		const counts = [0, 1, 2].map((sender) => [0, 1, 2, 3].map((epoch) => count(sender, epoch)));
		console.log(`[${engine}] frames by sender and epoch: ${JSON.stringify(counts)}`);
		for (const [sender, epoch] of [
			[0, 0],
			[0, 1],
			[1, 1],
			[0, 2],
			[1, 2],
			[2, 2],
			[1, 3],
			[2, 3]
		]) {
			expect(count(sender, epoch), `sender ${sender}, epoch ${epoch}`).toBeGreaterThan(10);
		}
		expect(count(0, 3), 'a sealed nothing after leaving').toBe(0);
		expect(count(2, 0) + count(2, 1), 'c sealed nothing before arriving').toBe(0);

		// Each person opens exactly the frames of the epochs they were in: a
		// those before it left, c those after it arrived, b all but a's first.
		const payloads = frames.map(({ payload }) => payload);
		const opened = new Map<Person, (string | null)[]>();
		for (const [person, epochs] of [
			[a, [0, 1, 2]],
			[b, [1, 2, 3]],
			[c, [2, 3]]
		] as [Person, number[]][]) {
			expect(await person.page.evaluate(() => window.room.epochs())).toEqual(epochs);
			const result = await person.page.evaluate((given) => window.room.open(given), payloads);
			opened.set(person, result);
			const wrong = frames.filter(
				(frame, index) => (result[index] !== null) !== epochs.includes(frame.epoch)
			);
			expect(
				wrong.length,
				`seat ${person.seat}: frames opened outside its epochs, or not within`
			).toBe(0);
		}
		// So every frame the listener holds is a ciphertext under a key of the
		// group, and nothing it holds is anything else.
		expect(
			frames.filter((_, index) => [a, b, c].every((p) => opened.get(p)![index] === null))
		).toEqual([]);

		// What the listener's copy sounds like through an Opus decoder, against
		// what the same frames, opened by someone in the room, sound like: three
		// seconds of each person's audio under epoch 2.
		let decoder: Page = b.page;
		let ownBrowser: Browser | null = null;
		if (!(await decoder.evaluate(() => window.room.decode([]))).decoder) {
			ownBrowser = await playwright.chromium.launch();
			decoder = await ownBrowser.newPage();
			await decoder.goto(new URL('/room.html', test.info().project.use.baseURL).href);
		}
		for (const sender of [0, 1, 2]) {
			const run = frames
				.map((frame, index) => ({ frame, index }))
				.filter(({ frame }) => frame.sender === sender && frame.epoch === 2);
			const middle = run.slice(Math.max(0, Math.floor(run.length / 2) - 75)).slice(0, 150);
			const raw = middle.map(({ frame }) => frame.payload);
			const plain = middle.map(({ index }) => opened.get(b)![index]!);
			const heardThem: Decoded = await decoder.evaluate(
				(given) => window.room.decode(given),
				plain
			);
			const tappedThem: Decoded = await decoder.evaluate(
				([given, at]) => window.room.decode(given, at),
				[raw, heardThem.peakHz ?? 0] as [string[], number]
			);
			console.log(
				`[${engine}] sender ${sender}: opened ${JSON.stringify(heardThem)}; as tapped ${JSON.stringify(tappedThem)}`
			);
			expect(heardThem.decoder).toBe(true);
			expect(heardThem.failed).toBe(0);
			expect(heardThem.prominence!, `sender ${sender}: a tone, opened`).toBeGreaterThan(20);
			// Whatever the decoder makes of the copy, there is no tone in it.
			if (tappedThem.failed < raw.length) expect(tappedThem.samples).toBeGreaterThan(4800);
			expect(tappedThem.prominenceAt ?? 0, `sender ${sender}: the tone, as tapped`).toBeLessThan(
				10
			);
		}
		await ownBrowser?.close();
		for (const person of [a, b, c]) await person.page.context().close();
	} finally {
		await stopVoice(service);
	}
});

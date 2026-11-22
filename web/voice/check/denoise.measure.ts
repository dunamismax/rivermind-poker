// RNNoise against the browser's own noise suppression, through a real capture
// path (P4C.6's last measurement, run with P4C.7's tools): Chromium on Linux
// takes a file as its microphone, so the same room and voice are played into
// `getUserMedia` four times, with neither kind of processing, with the
// browser's alone, with RNNoise alone, and with both, as a table sends by
// default. What comes out of each is compared with what went in.
//
//   scripts/voice-measure-linux.sh denoise
//
// The room is the check page's own (denoise.ts): a fan, a keyboard and
// chatter, with a voice over its middle half. The voice is the recording
// MEASURE_SPEECH names, or the page's voice-like signal.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch } from './browsers.ts';

const SECONDS = 8;
const RATE = 48000;
// A fiftieth of a second: the grain of the loudness the captures are lined up by.
const STEP = RATE / 50;

function speech(): string | undefined {
	const file = process.env.MEASURE_SPEECH;
	if (!file || !existsSync(file)) return undefined;
	const wave = readFileSync(file);
	let at = 12;
	while (at + 8 <= wave.length) {
		const size = wave.readUInt32LE(at + 4);
		if (wave.toString('latin1', at, at + 4) === 'data') {
			return wave.subarray(at + 8, at + 8 + size).toString('base64');
		}
		at += 8 + size + (size % 2);
	}
	return undefined;
}

function wave(pcm: Buffer): Buffer {
	const header = Buffer.alloc(44);
	header.write('RIFF', 0, 'latin1');
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write('WAVEfmt ', 8, 'latin1');
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(RATE, 24);
	header.writeUInt32LE(RATE * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write('data', 36, 'latin1');
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

const samplesOf = (text: string): Int16Array => {
	const bytes = Buffer.from(text, 'base64');
	return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
};

// The energy of each fiftieth of a second.
function loudness(samples: Int16Array): Float64Array {
	const steps = new Float64Array(Math.floor(samples.length / STEP));
	for (let at = 0; at < steps.length; at += 1) {
		let sum = 0;
		for (let i = at * STEP; i < (at + 1) * STEP; i += 1) sum += (samples[i] / 32768) ** 2;
		steps[at] = sum;
	}
	return steps;
}

// Where in the capture the played file begins: the shift at which the
// capture's loudness best follows the file's, the file going round and round.
function startOf(captured: Float64Array, played: Float64Array): number {
	let best = 0;
	let bestScore = -Infinity;
	for (let shift = 0; shift < played.length; shift += 1) {
		let score = 0;
		for (let at = 0; at < captured.length; at += 1) {
			score +=
				Math.log10(captured[at] + 1e-9) * Math.log10(played[(at + shift) % played.length] + 1e-9);
		}
		if (score > bestScore) {
			bestScore = score;
			best = shift;
		}
	}
	return best;
}

// The energy of the capture where the file has only the room, and where it
// has the voice too, leaving half a second at each change.
function parts(captured: Float64Array, shift: number, length: number) {
	let [room, voice, roomSteps, voiceSteps] = [0, 0, 0, 0];
	const margin = 25;
	for (let at = 0; at < captured.length; at += 1) {
		const place = (at + shift) % length;
		const [from, to] = [length / 4, (length * 3) / 4];
		if (place > from + margin && place < to - margin) {
			voice += captured[at];
			voiceSteps += 1;
		} else if (
			(place > margin && place < from - margin) ||
			(place > to + margin && place < length - margin)
		) {
			room += captured[at];
			roomSteps += 1;
		}
	}
	return { room: room / roomSteps, voice: voice / voiceSteps };
}

const db = (ratio: number) => Math.round(10 * Math.log10(ratio) * 10) / 10;

test('RNNoise takes more of a room out than the browser’s own noise suppression', async ({
	playwright,
	browserName,
	baseURL
}) => {
	test.skip(
		browserName !== 'chromium',
		'Chromium is the engine that takes a file as its microphone'
	);
	test.skip(process.platform !== 'linux', 'Chromium’s fake microphone does not work on macOS');
	// The sound to play, made by the page so it is the check's own room.
	const first = await playwright.chromium.launch(launch.chromium);
	const maker = await (await first.newContext({ baseURL })).newPage();
	await maker.goto('/denoise.html');
	await expect(maker.locator('body')).toHaveAttribute('data-denoise', 'ready');
	const mixed = await maker.evaluate(
		([seconds, voice]) => window.denoise.mix(seconds as number, voice as string | undefined),
		[SECONDS, speech()] as const
	);
	await first.close();
	const file = path.join(mkdtempSync(path.join(tmpdir(), 'rivermind-room-')), 'room.wav');
	writeFileSync(file, wave(Buffer.from(mixed, 'base64')));
	const played = loudness(samplesOf(mixed));

	const browser = await playwright.chromium.launch({
		args: [...(launch.chromium.args ?? []), `--use-file-for-fake-audio-capture=${file}`]
	});
	const capture = async (noiseSuppression: boolean, denoise: boolean) => {
		const context = await browser.newContext({ baseURL, permissions: ['microphone'] });
		const page = await context.newPage();
		page.on('console', (message) => {
			if (message.text().startsWith('[capture]')) console.log(message.text());
		});
		await page.goto('/denoise.html');
		await expect(page.locator('body')).toHaveAttribute('data-denoise', 'ready');
		// Two turns of the file, after one for the processing to settle.
		const text = await page.evaluate((options) => window.denoise.capture(options), {
			noiseSuppression,
			denoise,
			seconds: SECONDS * 3
		});
		await context.close();
		const captured = loudness(samplesOf(text)).subarray(SECONDS * 50);
		return parts(captured, startOf(captured, played), played.length);
	};
	const raw = await capture(false, false);
	const rows: [string, { room: number; voice: number }][] = [
		['the browser’s own', await capture(true, false)],
		['RNNoise alone', await capture(false, true)],
		['both, as a table sends', await capture(true, true)]
	];
	console.log(
		`[capture] ${JSON.stringify({ processing: 'none', roomToVoiceDb: db(raw.room / raw.voice) })}`
	);
	for (const [processing, got] of rows) {
		console.log(
			`[capture] ${JSON.stringify({
				processing,
				roomCutDb: db(raw.room / got.room),
				voiceDb: db(got.voice / raw.voice),
				roomToVoiceDb: db(got.room / got.voice)
			})}`
		);
	}
	await browser.close();
	const [own, , both] = rows.map(([, got]) => got);
	// The criterion: with RNNoise the room is quieter than with the browser's own alone.
	expect(raw.room / both.room).toBeGreaterThan(raw.room / own.room);
});

// What a room hears through a network that loses and delays packets (P4C.7):
// two people in each engine, one playing recorded speech to the other through
// a network that drops a share of the packets and holds the rest 30 ms, give
// or take 30. Run with `pnpm voice:measure loss`; the figures go in
// docs/voice.md, and what the listener heard under each condition is written
// to artifacts/voice-loss/ for someone to listen to.
//
// The network is the relay (relay.ts) by default, which works wherever the
// checks do. With IMPAIR=netem it is Linux's own `tc netem` on the loopback
// interface, for packets to and from the voice service's media port, which
// needs root (scripts/voice-measure-linux.sh runs it in a container).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { test } from '@playwright/test';
import { canTransform } from './browsers.ts';
import type { DelayStats } from './delay.ts';
import { hasWebAudio, measured, reportOf, settled, type Engine } from './measure.ts';
import { newTable, startVoice, stopVoice } from './people.ts';
import { CLEAR, Relay, type Impairment } from './relay.ts';
import { RELAYED_MEDIA_PORT, RELAYED_PORT } from './vite.config.ts';

const SECONDS = Number(process.env.MEASURE_SECONDS ?? 30);
const NETEM = process.env.IMPAIR === 'netem';
const JITTER = { delayMs: 30, jitterMs: 30 };

test.beforeEach(({ browserName }) => {
	test.skip(!canTransform(browserName), 'this build of the engine has no RTCRtpScriptTransform');
});

const lan = Object.values(networkInterfaces())
	.flat()
	.find((address) => address?.family === 'IPv4' && !address.internal)?.address;

// `tc netem` on loopback for the media port's packets: a band of their own,
// which a filter sends them to by the port they come from or go to.
const tc = (...args: string[]) => execFileSync('tc', args, { stdio: 'pipe' });
function netemStart(): void {
	try {
		tc('qdisc', 'del', 'dev', 'lo', 'root');
	} catch {
		// none yet
	}
	tc('qdisc', 'add', 'dev', 'lo', 'root', 'handle', '1:', 'prio', 'bands', '4');
	tc('qdisc', 'add', 'dev', 'lo', 'parent', '1:4', 'handle', '40:', 'netem', 'limit', '10000');
}
function netemSet({ loss, delayMs, jitterMs, legs }: Impairment): void {
	try {
		tc('filter', 'del', 'dev', 'lo', 'parent', '1:');
	} catch {
		// none yet
	}
	const idle = loss === 0 && delayMs === 0 && jitterMs === 0;
	tc(
		...['qdisc', 'change', 'dev', 'lo', 'parent', '1:4', 'handle', '40:', 'netem'],
		...['limit', '10000', 'loss', `${loss * 100}%`, 'delay', `${delayMs}ms`, `${jitterMs}ms`]
	);
	if (idle) return;
	const port = String(RELAYED_MEDIA_PORT);
	const match = (field: 'sport' | 'dport') =>
		tc(
			...['filter', 'add', 'dev', 'lo', 'parent', '1:', 'protocol', 'ip', 'u32'],
			...['match', 'ip', 'protocol', '17', '0xff', 'match', 'ip', field, port, '0xffff'],
			...['flowid', '1:4']
		);
	if (legs !== 'down') match('dport');
	if (legs !== 'up') match('sport');
}
function netemStop(): void {
	try {
		tc('qdisc', 'del', 'dev', 'lo', 'root');
	} catch {
		// already gone
	}
}

const CONDITIONS: [string, Impairment][] = [
	['clear', CLEAR],
	['jitter alone, both ways', { loss: 0, ...JITTER, legs: 'both' }],
	['2% lost to the listener', { loss: 0.02, ...JITTER, legs: 'down' }],
	['5% lost to the listener', { loss: 0.05, ...JITTER, legs: 'down' }],
	['10% lost to the listener', { loss: 0.1, ...JITTER, legs: 'down' }],
	['2% lost from the speaker', { loss: 0.02, ...JITTER, legs: 'up' }],
	['5% lost from the speaker', { loss: 0.05, ...JITTER, legs: 'up' }],
	['10% lost from the speaker', { loss: 0.1, ...JITTER, legs: 'up' }],
	['5% lost both ways', { loss: 0.05, ...JITTER, legs: 'both' }]
];

const percent = (part: number, whole: number) =>
	whole > 0 ? Math.round((part / whole) * 10000) / 100 : null;

// Speech for the speakers to play, as 16-bit mono PCM at 48 kHz: the file
// MEASURE_SPEECH names, or macOS's own voice reading a few sentences. Opus
// protects speech against loss in ways it does not protect a tone, so a tone
// would measure the wrong thing. Nothing of it is kept in the repository.
function speech(): Buffer | null {
	let file = process.env.MEASURE_SPEECH;
	if (!file && process.platform === 'darwin') {
		const spoken = path.join(tmpdir(), `rivermind-speech-${process.pid}.aiff`);
		file = path.join(tmpdir(), `rivermind-speech-${process.pid}.wav`);
		execFileSync('say', [
			'-o',
			spoken,
			'The river card is the last of the five. I will raise to four hundred, and we will see who was bluffing. Nine players at this table, and everyone has something to say about that hand. Deal the next one.'
		]);
		execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', spoken, file]);
	}
	if (!file || !existsSync(file)) return null;
	// The samples are the `data` chunk of the WAVE file.
	const wave = readFileSync(file);
	let at = 12;
	while (at + 8 <= wave.length) {
		const size = wave.readUInt32LE(at + 4);
		if (wave.toString('latin1', at, at + 4) === 'data') return wave.subarray(at + 8, at + 8 + size);
		at += 8 + size + (size % 2);
	}
	return null;
}

// A WAVE file of 16-bit mono PCM at 48 kHz.
function wave(pcm: Buffer): Buffer {
	const header = Buffer.alloc(44);
	header.write('RIFF', 0, 'latin1');
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write('WAVEfmt ', 8, 'latin1');
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(48000, 24);
	header.writeUInt32LE(96000, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write('data', 36, 'latin1');
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

test('two people through a network that loses packets and delays them', async ({
	playwright,
	browserName
}) => {
	test.skip(!lan, 'the measure needs an address beside loopback');
	const engine = browserName as Engine;
	const pcm = speech();
	test.skip(!pcm, 'no speech to play: set MEASURE_SPEECH to a WAVE file');
	// With the relay, the service's media port is on loopback and it announces
	// the relay; with netem it is on loopback and the LAN address itself, whose
	// packets from this machine also cross the loopback interface.
	const relay = NETEM
		? null
		: await Relay.start(
				{ address: lan!, port: RELAYED_MEDIA_PORT },
				{ address: '127.0.0.1', port: RELAYED_MEDIA_PORT }
			);
	if (NETEM) netemStart();
	const service = await startVoice(RELAYED_PORT, '../server.ts', {
		VOICE_MEDIA_PORT: String(RELAYED_MEDIA_PORT),
		...(NETEM ? {} : { VOICE_LISTEN_IPS: '127.0.0.1', VOICE_ANNOUNCED_ADDRESS: lan! })
	});
	const url = `ws://127.0.0.1:${RELAYED_PORT}/voice`;
	const out = path.resolve(import.meta.dirname, '../../../artifacts/voice-loss');
	try {
		const table = newTable();
		// The speaker plays speech; an engine with no Web Audio here listens to a
		// speaker in Chromium, which has it everywhere, and is read by its statistics.
		const speaker = hasWebAudio(engine) ? playwright[engine] : playwright.chromium;
		const talking = { source: 'speech', speech: pcm!.toString('base64') } as const;
		const people = [
			await measured(speaker, table, 0, [0, 1], talking, url),
			await measured(playwright[engine], table, 1, [0, 1], talking, url)
		];
		await settled(people);
		const listener = people[1];
		for (const [index, [label, impairment]] of CONDITIONS.entries()) {
			if (relay) relay.impairment = impairment;
			else netemSet(impairment);
			// Let the jitter buffer find its depth, and the speaker's encoder hear of
			// the loss, before anything counts.
			await listener.page.waitForTimeout(10_000);
			const before = (await reportOf(listener)).stats[0];
			// What the listener hears, for someone to listen to afterwards.
			const recording = listener.page.evaluate(() => window.delay.record(10_000));
			await listener.page.waitForTimeout(SECONDS * 1000);
			const after = (await reportOf(listener)).stats[0];
			const heard = await recording;
			if (heard) {
				mkdirSync(out, { recursive: true });
				const name = `${engine}-${index}-${label.replace(/[^a-z0-9]+/gi, '-')}.wav`;
				writeFileSync(path.join(out, name), wave(Buffer.from(heard, 'base64')));
			}
			const delta = (pick: (one: DelayStats) => number) => pick(after) - pick(before);
			const lost = delta((one) => one.packetsLost);
			const emitted = delta((one) => one.jitterBufferEmitted);
			console.log(
				`[loss] ${JSON.stringify({
					engine: browserName,
					speaker: speaker.name(),
					network: NETEM ? 'netem' : 'relay',
					condition: label,
					concealed: percent(
						delta((one) => one.concealedSamples),
						delta((one) => one.totalSamplesReceived)
					),
					lost: percent(lost, lost + delta((one) => one.packetsReceived)),
					fecPackets:
						after.fecPacketsReceived === null ? null : delta((one) => one.fecPacketsReceived ?? 0),
					jitterBufferMs: emitted
						? Math.round((delta((one) => one.jitterBufferDelay) / emitted) * 10000) / 10
						: null,
					recorded: heard !== null
				})}`
			);
		}
		for (const person of people) await person.close();
	} finally {
		if (NETEM) netemStop();
		await stopVoice(service);
		relay?.close();
	}
});

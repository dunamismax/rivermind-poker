// The voice checks' page (`pnpm voice:check`, P4C.2). It runs what Vitest runs
// under Node in a real browser, and what Node cannot run at all: a WebRTC call
// whose every Opus frame passes through the encoded-transform worker.
//
// The call is two peer connections on this one page, a speaker's and a
// listener's, each with a worker and key store of its own, as two people's
// pages have. No server is involved: what a forwarding server does to frames
// is P4C.4's to check. `window.check` is what the Playwright checks drive.
//
// A browser Playwright does not drive, such as Safari on a phone or in the iOS
// Simulator, runs the same checks by hand: `/?run` runs the vectors, the key
// check and the cost at once, and the buttons add a call through the
// microphone or with a Web Audio tone. Each result is shown on the page and posted to the server that
// serves it, which prints it (vite.config.ts beside this).
import { Delivery } from '../../src/lib/voice/delivery.ts';
import { EpochKeys, type Epoch } from '../../src/lib/voice/group-keys.ts';
import { Member, type Identity } from '../../src/lib/voice/group.ts';
import { FrameCrypto, canEncryptFrames } from '../../src/lib/voice/sframe-client.ts';
import type { Tally } from '../../src/lib/voice/sframe-transform.ts';
import { importBaseKey } from '../../src/lib/voice/sframe.ts';
import { checkVectors, type VectorCheck } from '../../src/lib/voice/sframe-vectors.ts';
import { voiceCode } from '../../src/lib/voice/voice-code.ts';
import type { BenchRequest, BenchResult } from './bench.worker.ts';

export type Who = 'speaker' | 'listener';

export type CallOptions = {
	// A Web Audio tone, or the engine's fake microphone.
	source: 'tone' | 'capture';
	// Off, the page makes no AudioContext and judges what it hears by WebRTC's statistics.
	webAudio: boolean;
	// The leaf the listener takes the stream to be from, or null to take anyone's.
	from: number | null;
	// Send without the worker: plain Opus, as a client with no encryption would.
	unsealed?: boolean;
};

export type Heard = {
	// From an analyser on the decoded track, where the page has Web Audio: the loudest moment's RMS.
	rms: number | null;
	// From WebRTC's statistics: the energy of everything decoded so far, and how much was concealed.
	energy: number;
	totalSamplesReceived: number;
	concealedSamples: number;
	packetsReceived: number;
};

export type CallReport = {
	connection: { speaker: string; listener: string };
	sent: Tally | null;
	received: Tally | null;
	// What each side's key store would not do, as `asked: error`.
	refused: string[];
	heard: Heard;
};

// Where the two pages of a call stand in the table's MLS group.
export type GroupReport = {
	epoch: number;
	speaker: { leaf: number; code: string; seatsOk: boolean };
	listener: { leaf: number; code: string; seatsOk: boolean };
};

export type Check = {
	support(): { frames: boolean; scriptTransform: boolean; subtle: boolean };
	vectors(): Promise<VectorCheck>;
	// Whether a base key made for the worker can be read back out of WebCrypto.
	keys(): Promise<{ extractable: boolean; exported: boolean; usages: string[] }>;
	call(options: CallOptions): Promise<void>;
	// Give one side an epoch's key, made from a secret. It resolves once that side's worker holds it.
	key(who: Who, epoch: number, secret: string): Promise<void>;
	sendAs(sender: number, epoch: number): Promise<void>;
	retire(who: Who, epoch: number): Promise<void>;
	report(listenMs?: number): Promise<CallReport>;
	bench(request: BenchRequest): Promise<BenchResult>;
	// The table voice code of thirty-two bytes of 7, on this engine's WebCrypto.
	code(): Promise<string>;
	// Key the call from an MLS group instead: the speaker makes it at seat 0 and
	// the listener joins at seat 1, with the service's delivery rules between them.
	groupStart(): Promise<GroupReport>;
	// Someone sits down at seat 2 and joins, or stands up again. The speaker's
	// page reaches the new epoch first; the listener's follows `skewMs` later.
	groupJoin(skewMs: number): Promise<GroupReport>;
	groupLeave(skewMs: number): Promise<GroupReport>;
};

declare global {
	interface Window {
		check: Check;
	}
}

const text = new TextEncoder();
const baseKey = (secret: string) => importBaseKey(text.encode(secret.padEnd(16, '.')));

type Call = {
	crypto: Record<Who, FrameCrypto>;
	speaker: RTCPeerConnection;
	listener: RTCPeerConnection;
	receiver: RTCRtpReceiver;
	context: AudioContext | null;
	analyser: AnalyserNode | null;
	refused: string[];
};
let current: Call | null = null;
const theCall = (): Call => {
	if (!current) throw new Error('no call yet');
	return current;
};

async function track(
	options: CallOptions,
	context: AudioContext | null
): Promise<MediaStreamTrack> {
	if (options.source === 'capture') {
		// The browser's own processing is off so a fake device's signal arrives as it was made.
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
		});
		return stream.getAudioTracks()[0];
	}
	if (!context) throw new Error('a tone needs Web Audio');
	const oscillator = new OscillatorNode(context, { frequency: 440 });
	const gain = new GainNode(context, { gain: 0.25 });
	const out = new MediaStreamAudioDestinationNode(context);
	oscillator.connect(gain).connect(out);
	oscillator.start();
	return out.stream.getAudioTracks()[0];
}

async function call(options: CallOptions): Promise<void> {
	if (current) throw new Error('one call a page');
	let context: AudioContext | null = null;
	if (options.webAudio) {
		context = new AudioContext();
		await context.resume();
	}
	const refused: string[] = [];
	const crypto: Record<Who, FrameCrypto> = {
		speaker: new FrameCrypto(),
		listener: new FrameCrypto()
	};
	for (const who of ['speaker', 'listener'] as const) {
		crypto[who].onrefused = (asked, error) => refused.push(`${who} ${asked}: ${error}`);
	}

	const speaker = new RTCPeerConnection();
	const listener = new RTCPeerConnection();
	speaker.onicecandidate = ({ candidate }) => void listener.addIceCandidate(candidate ?? undefined);
	listener.onicecandidate = ({ candidate }) => void speaker.addIceCandidate(candidate ?? undefined);

	// Each transform is set before its side negotiates, so no frame passes without it.
	const sending = speaker.addTransceiver(await track(options, context), { direction: 'sendonly' });
	if (!options.unsealed) crypto.speaker.encrypt(sending.sender);
	const arrived = new Promise<RTCTrackEvent>((resolve) => {
		listener.ontrack = (event) => {
			crypto.listener.decrypt(event.receiver, 'recv', options.from);
			resolve(event);
		};
	});

	await speaker.setLocalDescription(await speaker.createOffer());
	await listener.setRemoteDescription(speaker.localDescription!);
	await listener.setLocalDescription(await listener.createAnswer());
	await speaker.setRemoteDescription(listener.localDescription!);
	const { receiver, track: remote } = await arrived;

	const stream = new MediaStream([remote]);
	// The element keeps the track decoding. Chromium also feeds a remote track
	// to Web Audio only while a media element holds it.
	const element = new Audio();
	element.muted = true;
	element.srcObject = stream;
	void element.play().catch(() => {});
	let analyser: AnalyserNode | null = null;
	if (context) {
		analyser = new AnalyserNode(context, { fftSize: 2048, smoothingTimeConstant: 0 });
		const silent = new GainNode(context, { gain: 0 });
		context.createMediaStreamSource(stream).connect(analyser).connect(silent);
		silent.connect(context.destination);
	}
	current = { crypto, speaker, listener, receiver, context, analyser, refused };
}

function rmsOf(analyser: AnalyserNode): number {
	const wave = new Float32Array(analyser.fftSize);
	analyser.getFloatTimeDomainData(wave);
	return Math.sqrt(wave.reduce((sum, sample) => sum + sample * sample, 0) / wave.length);
}

async function report(listenMs = 0): Promise<CallReport> {
	const { crypto, speaker, listener, receiver, analyser, refused } = theCall();
	// The loudest of several looks: a fake capture device beeps rather than hums.
	let rms: number | null = analyser ? 0 : null;
	const until = performance.now() + listenMs;
	do {
		if (analyser) rms = Math.max(rms ?? 0, rmsOf(analyser));
		if (listenMs) await new Promise((resolve) => setTimeout(resolve, 50));
	} while (performance.now() < until);

	const inbound = [...(await receiver.getStats()).values()].find(
		(stat) => stat.type === 'inbound-rtp'
	);
	const [sent, received] = await Promise.all([crypto.speaker.tallies(), crypto.listener.tallies()]);
	return {
		connection: { speaker: speaker.connectionState, listener: listener.connectionState },
		sent: sent[0] ?? null,
		received: received[0] ?? null,
		refused,
		heard: {
			rms,
			energy: inbound?.totalAudioEnergy ?? 0,
			totalSamplesReceived: inbound?.totalSamplesReceived ?? 0,
			concealedSamples: inbound?.concealedSamples ?? 0,
			packetsReceived: inbound?.packetsReceived ?? 0
		}
	};
}

// The call's two pages as members of one table's group, and the voice service between them.
type Grouped = {
	delivery: Delivery;
	pages: Record<Who, { identity: Identity; member: Member; keys: EpochKeys; epoch: Epoch }>;
	third: Member | null;
};
let grouped: Grouped | null = null;
const seat = (n: number): Identity => ({ player: `player-${n}`, seat: n });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function groupReport(): GroupReport {
	const { speaker, listener } = grouped!.pages;
	const side = (page: typeof speaker) => ({
		leaf: page.epoch.leaf,
		code: page.epoch.code.join(' '),
		seatsOk: page.epoch.seats.ok
	});
	return { epoch: Number(speaker.epoch.epoch), speaker: side(speaker), listener: side(listener) };
}

async function groupStart(): Promise<GroupReport> {
	const { crypto } = theCall();
	const delivery = await Delivery.create(new TextEncoder().encode('check-table'));
	const key = delivery.servicePublicKey;
	const made = await Member.create(seat(0), delivery.groupId, key);
	if (!(await delivery.open(made.groupInfo, seat(0))).accepted) throw new Error('not opened');
	const joined = await Member.join(seat(1), delivery.groupInfo!, key);
	const outcome = await delivery.submit(joined.commit, joined.groupInfo, seat(1));
	if (!outcome.accepted) throw new Error(outcome.refusal);
	await made.member.receive(joined.commit);
	const page = async (who: Who, identity: Identity, member: Member) => {
		const keys = new EpochKeys(crypto[who]);
		keys.seats([seat(0), seat(1)]);
		return { identity, member, keys, epoch: await keys.advance(member) };
	};
	// The listener holds the first key before the speaker sends under it.
	const listener = await page('listener', seat(1), joined.member);
	await crypto.listener.tallies();
	const speaker = await page('speaker', seat(0), made.member);
	grouped = { delivery, pages: { speaker, listener }, third: null };
	return groupReport();
}

// Both pages take the group's new epoch, each at its own pace as two people's
// pages do: each applies what the service passed on to it, then takes the
// keys. The listener's page starts `skewMs` after the speaker's.
async function moved(
	seated: Identity[],
	skewMs: number,
	hears: Record<Who, Uint8Array[]>
): Promise<void> {
	const take = async (who: Who, afterMs: number) => {
		const page = grouped!.pages[who];
		if (afterMs) await pause(afterMs);
		for (const message of hears[who]) await page.member.receive(message);
		page.keys.seats(seated);
		page.epoch = await page.keys.advance(page.member);
	};
	await Promise.all([take('speaker', 0), take('listener', skewMs)]);
}

async function groupJoin(skewMs: number): Promise<GroupReport> {
	const { delivery } = grouped!;
	const candidate = await Member.join(seat(2), delivery.groupInfo!, delivery.servicePublicKey);
	const outcome = await delivery.submit(candidate.commit, candidate.groupInfo, seat(2));
	if (!outcome.accepted) throw new Error(outcome.refusal);
	grouped!.third = candidate.member;
	await moved([seat(0), seat(1), seat(2)], skewMs, {
		speaker: [candidate.commit],
		listener: [candidate.commit]
	});
	return groupReport();
}

async function groupLeave(skewMs: number): Promise<GroupReport> {
	const { delivery, pages, third } = grouped!;
	const proposal = await delivery.remove(third!.leaf);
	if (!proposal) throw new Error('nobody to remove');
	await pages.speaker.member.receive(proposal);
	// The speaker holds the lowest leaf: it commits the removal, and has the new epoch at once.
	const candidate = await pages.speaker.member.commit();
	const outcome = await delivery.submit(candidate.commit, candidate.groupInfo, seat(0));
	if (!outcome.accepted) throw new Error(outcome.refusal);
	pages.speaker.member = candidate.member;
	grouped!.third = null;
	// The committer is a step ahead of everyone it tells: it already holds the new epoch.
	await moved([seat(0), seat(1)], skewMs, { speaker: [], listener: [proposal, candidate.commit] });
	return groupReport();
}

window.check = {
	code: async () => (await voiceCode(new Uint8Array(32).fill(7))).join(' '),
	groupStart,
	groupJoin,
	groupLeave,
	support: () => ({
		frames: canEncryptFrames(),
		scriptTransform: typeof RTCRtpScriptTransform === 'function',
		subtle: typeof crypto?.subtle?.deriveKey === 'function'
	}),
	vectors: checkVectors,
	async keys() {
		const key = await baseKey('secret');
		const exported = await crypto.subtle.exportKey('raw', key).then(
			() => true,
			() => false
		);
		return { extractable: key.extractable, exported, usages: [...key.usages].sort() };
	},
	call,
	async key(who, epoch, secret) {
		const side = theCall().crypto[who];
		side.addEpoch(BigInt(epoch), await baseKey(secret));
		// The worker answers in the order it was asked: once it has, it holds the key.
		await side.tallies();
	},
	async sendAs(sender, epoch) {
		const side = theCall().crypto.speaker;
		side.sendAs(sender, BigInt(epoch));
		await side.tallies();
	},
	async retire(who, epoch) {
		const side = theCall().crypto[who];
		side.retire(BigInt(epoch));
		await side.tallies();
	},
	report,
	bench(request) {
		const worker = new Worker(new URL('./bench.worker.ts', import.meta.url), { type: 'module' });
		return new Promise((resolve, reject) => {
			worker.onmessage = ({ data }: MessageEvent<BenchResult>) => {
				worker.terminate();
				resolve(data);
			};
			worker.onerror = (event) => reject(new Error(event.message));
			worker.postMessage(request);
		});
	}
};

// By hand, with no Playwright: each step bounded, so a browser that hangs says where.
const within = <T>(what: string, promise: Promise<T>, ms: number): Promise<T> =>
	Promise.race([
		promise,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))
	]);

async function tell(result: Record<string, unknown>): Promise<void> {
	const body = JSON.stringify({ agent: navigator.userAgent, ...result });
	document.querySelector('#log')!.append(`${body}\n`);
	await fetch('/result', { method: 'POST', body }).catch(() => {});
}

const attempt = <T>(what: string, run: () => Promise<T>, ms: number): Promise<T | string> =>
	within(what, run(), ms).catch((error) => String(error));

async function runAlone(): Promise<void> {
	const vectors = await attempt('vectors', checkVectors, 20_000);
	await tell({
		support: window.check.support(),
		vectors:
			typeof vectors === 'string' ? vectors : { ...vectors, failures: vectors.failures.length },
		keys: await attempt('keys', window.check.keys, 10_000),
		bench: await attempt(
			'bench',
			() => window.check.bench({ frames: 3000, bytes: 161, others: 8 }),
			60_000
		)
	});
}

async function runCall(source: CallOptions['source']): Promise<void> {
	await tell({
		source,
		call: await attempt(
			'call',
			async () => {
				await within('starting the call', call({ source, webAudio: true, from: 3 }), 30_000);
				await window.check.key('listener', 1, 'the table');
				await window.check.key('speaker', 1, 'the table');
				await window.check.sendAs(3, 1);
				await new Promise((resolve) => setTimeout(resolve, 4000));
				return report(1500);
			},
			60_000
		)
	});
}

document.querySelector('#call')!.addEventListener('click', () => void runCall('capture'));
document.querySelector('#tone')!.addEventListener('click', () => void runCall('tone'));
if (new URLSearchParams(location.search).has('run')) void runAlone();
document.body.setAttribute('data-check', 'ready');

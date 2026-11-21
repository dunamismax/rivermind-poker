// The voice prototype's browser side (P4C.1): joins a room on the prototype
// service through mediasoup-client, sends one audio track and receives
// everyone else's, with every frame passing through the encoded-transform
// worker. `window.voice` is what the Playwright checks drive and read.
//
//   /?room=NAME&secret=TEXT&source=tone|capture&freq=HZ[&audioLevel=1][&tcp=1][&webaudio=0]
//
// With `webaudio=0` the page makes no AudioContext: it must capture, and what it
// hears is judged by WebRTC's own statistics alone. Playwright's WebKit needs
// that (see browsers.ts).
import { Device, type types as msc } from 'mediasoup-client';
import { AUDIO_LEVEL_URI } from './frame.ts';
import type { MlsCheck } from './mls-check.ts';
import type { ClientMessage, Method, PeerInfo, Requests, ServerMessage } from './signalling.ts';
import type { TransformCounts, TransformOptions } from './transform.worker.ts';

export type Heard = {
	peerId: string;
	kid: number;
	// From a Web Audio analyser on the decoded track, when the page has one: the
	// strongest frequency, its level, and the loudest moment's RMS.
	peakHz: number | null;
	peakDb: number | null;
	rms: number | null;
	// From WebRTC's statistics: the energy of everything decoded so far (0 for silence).
	energy: number;
	concealedSamples: number;
	totalSamplesReceived: number;
	jitterBufferMs: number;
};

export type Report = {
	peerId: string;
	kid: number;
	handler: string;
	source: 'tone' | 'capture';
	support: { scriptTransform: boolean; encodedStreams: boolean };
	connection: { send: string; recv: string };
	protocol: string | null;
	webAudio: string;
	senderExtensions: string[];
	receiverExtensions: string[];
	audioLevelNegotiated: boolean;
	transforms: TransformCounts[];
	heard: Heard[];
};

export type Voice = {
	join(): Promise<void>;
	report(listenMs?: number): Promise<Report>;
	// Every WebRTC statistic of both transports, for working out a failed connection.
	stats(): Promise<{ send: unknown[]; recv: unknown[] }>;
	leave(): void;
	// ts-mls on this page, apart from any room (mls-check.ts).
	mls(): Promise<MlsCheck>;
};

declare global {
	interface Window {
		voice: Voice;
	}
}

const query = new URLSearchParams(location.search);
const room = query.get('room') ?? 'room';
const secret = query.get('secret') ?? 'prototype';
const source = query.get('source') === 'capture' ? 'capture' : 'tone';
const freq = Number(query.get('freq') ?? 440);
const audioLevel = query.has('audioLevel');
const webAudio = query.get('webaudio') !== '0';

const log = (line: string) => {
	document.querySelector('#log')!.append(`${line}\n`);
};

// One worker holds every transform of this page: the sender's and each receiver's.
const worker = new Worker(new URL('./transform.worker.ts', import.meta.url), { type: 'module' });
let counts: TransformCounts[] = [];
worker.onmessage = ({ data }: MessageEvent<TransformCounts[]>) => {
	counts = data;
};

// A stand-in for the group key P4C.3 takes from MLS: every sender's key and
// salt come from the room secret and the sender's number. The key is made
// non-extractable here and handed to the worker in the transform's options.
const encoder = new TextEncoder();
const base = crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
	'deriveKey',
	'deriveBits'
]);
async function transformOptions(
	direction: TransformOptions['direction'],
	kid: number,
	id: string
): Promise<TransformOptions> {
	const hkdf = (label: string) => ({
		name: 'HKDF',
		hash: 'SHA-256',
		salt: new Uint8Array(32),
		info: encoder.encode(`rivermind voice prototype ${label} ${kid}`)
	});
	const key = await crypto.subtle.deriveKey(
		hkdf('key'),
		await base,
		{ name: 'AES-GCM', length: 128 },
		false,
		['encrypt', 'decrypt']
	);
	const salt = new Uint8Array(await crypto.subtle.deriveBits(hkdf('salt'), await base, 96));
	return { id, direction, kid, key, salt };
}

// What this person asks of the service: audio levels left in, or media over TCP alone.
const asks = new URLSearchParams();
if (audioLevel) asks.set('audioLevel', '1');
if (query.has('tcp')) asks.set('tcp', '1');
const socket = new WebSocket(`ws://${location.host}/voice?${asks}`);
const opened = new Promise<void>((resolve, reject) => {
	socket.onopen = () => resolve();
	socket.onerror = () => reject(new Error('signalling socket failed'));
});
const waiting = new Map<number, { resolve(data: unknown): void; reject(error: Error): void }>();
let nextId = 1;

function request<M extends Method>(
	method: M,
	data: Requests[M]['request']
): Promise<Requests[M]['response']> {
	const id = nextId++;
	socket.send(JSON.stringify({ id, method, data } as ClientMessage));
	return new Promise((resolve, reject) => {
		waiting.set(id, { resolve: resolve as (data: unknown) => void, reject });
	});
}

type Listening = {
	peer: PeerInfo;
	consumer: msc.Consumer;
	receiver: RTCRtpReceiver | null;
	analyser: AnalyserNode | null;
	element: HTMLAudioElement;
};

let context: AudioContext | null = null;
let device: Device;
let me: { peerId: string; kid: number };
let sendTransport: msc.Transport;
let recvTransport: msc.Transport;
let sender: RTCRtpSender | null = null;
const listening = new Map<string, Listening>();
// Consumers are added one at a time, in the order the room announced them.
let consuming = Promise.resolve();

async function track(): Promise<MediaStreamTrack> {
	if (source === 'capture') {
		// The browser's own processing is off so a fake device's signal arrives as it was made.
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
		});
		return stream.getAudioTracks()[0];
	}
	if (!context) throw new Error('a tone needs Web Audio');
	const oscillator = new OscillatorNode(context, { frequency: freq });
	const gain = new GainNode(context, { gain: 0.25 });
	const out = new MediaStreamAudioDestinationNode(context);
	oscillator.connect(gain).connect(out);
	oscillator.start();
	return out.stream.getAudioTracks()[0];
}

function transport(
	direction: 'send' | 'recv',
	info: Requests['createTransport']['response']
): msc.Transport {
	const made =
		direction === 'send' ? device.createSendTransport(info) : device.createRecvTransport(info);
	made.on('connect', ({ dtlsParameters }, done, failed) => {
		request('connectTransport', { transportId: made.id, dtlsParameters }).then(done, failed);
	});
	made.on('produce', ({ rtpParameters }, done, failed) => {
		request('produce', { transportId: made.id, rtpParameters }).then(done, failed);
	});
	return made;
}

function listen(peer: PeerInfo): void {
	const producerId = peer.producerId;
	if (!producerId) return;
	consuming = consuming.then(async () => {
		const options = await transformOptions('decrypt', peer.kid, `recv-${peer.peerId}`);
		const answer = await request('consume', {
			transportId: recvTransport.id,
			producerId,
			rtpCapabilities: device.rtpCapabilities
		});
		let receiver: RTCRtpReceiver | null = null;
		const consumer = await recvTransport.consume({
			id: answer.id,
			producerId,
			kind: 'audio',
			rtpParameters: answer.rtpParameters,
			onRtpReceiver: (made) => {
				receiver = made;
				made.transform = new RTCRtpScriptTransform(worker, options);
			}
		});
		const stream = new MediaStream([consumer.track]);
		// The element keeps the track decoding. Chromium also feeds a remote track
		// to Web Audio only while a media element holds it.
		const element = new Audio();
		element.muted = true;
		element.srcObject = stream;
		void element.play().catch(() => {});
		let analyser: AnalyserNode | null = null;
		if (context) {
			analyser = new AnalyserNode(context, { fftSize: 16384, smoothingTimeConstant: 0 });
			const silent = new GainNode(context, { gain: 0 });
			context.createMediaStreamSource(stream).connect(analyser).connect(silent);
			silent.connect(context.destination);
		}
		listening.set(peer.peerId, { peer, consumer, receiver, analyser, element });
		await request('resume', { consumerId: consumer.id });
		log(`hearing ${peer.peerId} (key ${peer.kid})`);
	});
}

socket.onmessage = ({ data }) => {
	const message = JSON.parse(String(data)) as ServerMessage;
	if ('notice' in message) {
		if (message.notice === 'producer') listen(message.peer);
		else {
			listening.get(message.peerId)?.consumer.close();
			listening.delete(message.peerId);
		}
		return;
	}
	const pending = waiting.get(message.id);
	waiting.delete(message.id);
	if (message.ok) pending?.resolve(message.data);
	else pending?.reject(new Error(message.error));
};

async function join(): Promise<void> {
	if (webAudio) {
		context = new AudioContext();
		await context.resume();
	}
	await opened;
	const joined = await request('join', { room });
	me = { peerId: joined.peerId, kid: joined.kid };
	device = await Device.factory();
	await device.load({ routerRtpCapabilities: joined.routerRtpCapabilities });
	sendTransport = transport('send', await request('createTransport', { direction: 'send' }));
	recvTransport = transport('recv', await request('createTransport', { direction: 'recv' }));

	const options = await transformOptions('encrypt', me.kid, 'send');
	await sendTransport.produce({
		track: await track(),
		// docs/voice.md: mono, in-band FEC, DTX, 64 kbps on average, 20 ms frames.
		codecOptions: {
			opusStereo: false,
			opusFec: true,
			opusDtx: true,
			opusMaxAverageBitrate: 64000,
			opusPtime: 20
		},
		onRtpSender: (made) => {
			sender = made;
			made.transform = new RTCRtpScriptTransform(worker, options);
		}
	});
	for (const peer of joined.peers) listen(peer);
	await consuming;
	log(`joined ${room} as ${me.peerId} (key ${me.kid}) with ${device.handlerName}`);
}

type Measure = { peakHz: number | null; peakDb: number | null; rms: number | null };

function measure(analyser: AnalyserNode | null): Measure {
	if (!analyser || !context) return { peakHz: null, peakDb: null, rms: null };
	const spectrum = new Float32Array(analyser.frequencyBinCount);
	analyser.getFloatFrequencyData(spectrum);
	const hzPerBin = context.sampleRate / analyser.fftSize;
	let peak = Math.ceil(100 / hzPerBin);
	for (let bin = peak; bin * hzPerBin < 4000; bin++) if (spectrum[bin] > spectrum[peak]) peak = bin;
	const wave = new Float32Array(analyser.fftSize);
	analyser.getFloatTimeDomainData(wave);
	const rms = Math.sqrt(wave.reduce((sum, sample) => sum + sample * sample, 0) / wave.length);
	return { peakHz: peak * hzPerBin, peakDb: spectrum[peak], rms };
}

async function report(listenMs = 0): Promise<Report> {
	await consuming;
	// The loudest of several looks: a fake capture device beeps rather than hums.
	const best = new Map<string, Measure>();
	const until = performance.now() + listenMs;
	do {
		for (const [peerId, { analyser }] of listening) {
			const now = measure(analyser);
			if (!best.has(peerId) || (now.rms ?? 0) > (best.get(peerId)!.rms ?? 0)) best.set(peerId, now);
		}
		if (listenMs) await new Promise((resolve) => setTimeout(resolve, 100));
	} while (performance.now() < until);

	const heard: Heard[] = [];
	for (const [peerId, { peer, consumer }] of listening) {
		const inbound = [...(await consumer.getStats()).values()].find(
			(stat) => stat.type === 'inbound-rtp'
		);
		heard.push({
			peerId,
			kid: peer.kid,
			...best.get(peerId)!,
			energy: inbound?.totalAudioEnergy ?? 0,
			concealedSamples: inbound?.concealedSamples ?? 0,
			totalSamplesReceived: inbound?.totalSamplesReceived ?? 0,
			jitterBufferMs: inbound?.jitterBufferEmittedCount
				? (1000 * inbound.jitterBufferDelay) / inbound.jitterBufferEmittedCount
				: 0
		});
	}
	const sent = [...(await sendTransport.getStats()).values()];
	const pair = sent.find((stat) => stat.type === 'candidate-pair' && stat.nominated);
	const local = sent.find((stat) => stat.id === pair?.localCandidateId);
	const uris = (parameters: RTCRtpParameters | undefined) =>
		parameters?.headerExtensions.map((extension) => extension.uri) ?? [];
	const senderExtensions = uris(sender?.getParameters());
	const receiverExtensions = [
		...new Set([...listening.values()].flatMap(({ receiver }) => uris(receiver?.getParameters())))
	];
	return {
		...me,
		handler: device.handlerName,
		source,
		support: {
			scriptTransform: typeof RTCRtpScriptTransform === 'function',
			encodedStreams: 'createEncodedStreams' in RTCRtpSender.prototype
		},
		connection: { send: sendTransport.connectionState, recv: recvTransport.connectionState },
		protocol: local?.protocol ?? null,
		webAudio: context ? `${context.state} at ${context.sampleRate} Hz` : 'off',
		senderExtensions,
		receiverExtensions,
		audioLevelNegotiated: [...senderExtensions, ...receiverExtensions].includes(AUDIO_LEVEL_URI),
		transforms: counts,
		heard
	};
}

window.voice = {
	join,
	report,
	async stats() {
		return {
			send: [...(await sendTransport.getStats()).values()],
			recv: [...(await recvTransport.getStats()).values()]
		};
	},
	leave() {
		socket.close();
		sendTransport?.close();
		recvTransport?.close();
	},
	// Loaded only when asked for, so the room's page does not carry ts-mls.
	mls: async () => (await import('./mls-check.ts')).mlsCheck()
};

document.querySelector('#join')!.addEventListener('click', () => {
	join().then(
		() => document.body.setAttribute('data-voice', 'joined'),
		(error) => {
			log(`failed: ${error}`);
			document.body.setAttribute('data-voice', `failed: ${error}`);
		}
	);
});

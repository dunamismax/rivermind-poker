// The voice service's check page (`pnpm voice:check`, P4C.4): one person in a
// table's voice room on the real service (voice/server.ts), through the
// site's VoiceRoom (src/lib/voice/room.ts): the MLS group over voice
// signalling v1, each epoch's keys in the worker, and audio through
// mediasoup. `window.room` is what room.check.ts drives.
import type { Identity } from '../../src/lib/voice/group.ts';
import { VoiceRoom, type Heard as Stream } from '../../src/lib/voice/room.ts';
import type { Tally } from '../../src/lib/voice/sframe-transform.ts';

export type JoinOptions = {
	url: string;
	table: string;
	token: string;
	seated: Identity[];
	// A Web Audio tone of this frequency, or the engine's fake microphone.
	source: 'tone' | 'capture';
	freq: number;
	// Off, the page makes no AudioContext and judges what it hears by WebRTC's statistics.
	webAudio: boolean;
	// Public references this person has muted.
	muted?: string[];
	// Ask the test for each token (`window.voiceToken`), so the room can come
	// back by itself after the service restarts.
	refresh?: boolean;
};

export type Heard = {
	leaf: number;
	player: string | null;
	muted: boolean;
	packetsReceived: number;
	rms: number | null;
	peakHz: number | null;
	energy: number;
	totalSamplesReceived: number;
	concealedSamples: number;
};

export type RoomReport = {
	connected: boolean;
	leaf: number | null;
	epoch: number | null;
	code: string[];
	seatsOk: boolean;
	handler: string;
	connection: { send: string | null; recv: string | null };
	// The ICE candidate pair each transport chose: the protocol, and the service's address and port.
	path: { send: string | null; recv: string | null };
	transforms: Tally[];
	refused: string[];
	heard: Heard[];
};

export type RoomCheck = {
	join(options: JoinOptions): Promise<void>;
	report(listenMs?: number): Promise<RoomReport>;
	seats(seated: Identity[]): void;
	mute(player: string, muted: boolean): Promise<void>;
	leave(): void;
};

declare global {
	interface Window {
		room: RoomCheck;
		voiceToken?: () => Promise<string>;
	}
}

const log = (line: string) => {
	document.querySelector('#log')!.append(`${line}\n`);
	console.log(line);
};

let room: VoiceRoom | null = null;
let context: AudioContext | null = null;
const analysers = new Map<string, AnalyserNode>();
// Elements keep each remote track decoding; Chromium also feeds a remote
// track to Web Audio only while a media element holds it.
const elements = new Map<string, HTMLAudioElement>();

async function track(options: JoinOptions): Promise<MediaStreamTrack> {
	if (options.source === 'capture') {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
		});
		return stream.getAudioTracks()[0];
	}
	const oscillator = new OscillatorNode(context!, { frequency: options.freq });
	const gain = new GainNode(context!, { gain: 0.25 });
	const out = new MediaStreamAudioDestinationNode(context!);
	oscillator.connect(gain).connect(out);
	oscillator.start();
	return out.stream.getAudioTracks()[0];
}

function heard(stream: Stream): void {
	const media = new MediaStream([stream.track]);
	const element = new Audio();
	element.muted = true;
	element.srcObject = media;
	void element.play().catch(() => {});
	elements.set(stream.peer, element);
	if (context) {
		const analyser = new AnalyserNode(context, { fftSize: 16384, smoothingTimeConstant: 0 });
		const silent = new GainNode(context, { gain: 0 });
		context.createMediaStreamSource(media).connect(analyser).connect(silent);
		silent.connect(context.destination);
		analysers.set(stream.peer, analyser);
	}
	log(`hearing leaf ${stream.leaf}`);
}

function measure(analyser: AnalyserNode | undefined): {
	rms: number | null;
	peakHz: number | null;
} {
	if (!analyser || !context) return { rms: null, peakHz: null };
	const spectrum = new Float32Array(analyser.frequencyBinCount);
	analyser.getFloatFrequencyData(spectrum);
	const hzPerBin = context.sampleRate / analyser.fftSize;
	let peak = Math.ceil(100 / hzPerBin);
	for (let bin = peak; bin * hzPerBin < 4000; bin++) if (spectrum[bin] > spectrum[peak]) peak = bin;
	const wave = new Float32Array(analyser.fftSize);
	analyser.getFloatTimeDomainData(wave);
	const rms = Math.sqrt(wave.reduce((sum, sample) => sum + sample * sample, 0) / wave.length);
	return { rms, peakHz: peak * hzPerBin };
}

window.room = {
	async join(options) {
		if (options.webAudio) {
			context = new AudioContext();
			await context.resume();
		}
		room = await VoiceRoom.join({
			url: options.url,
			table: options.table,
			token: options.refresh ? () => window.voiceToken!() : options.token,
			seated: options.seated,
			muted: options.muted,
			track: await track(options),
			onheard: heard,
			onended: (stream) => {
				analysers.delete(stream.peer);
				elements.get(stream.peer)?.pause();
				elements.delete(stream.peer);
			},
			onclose: (code) => document.body.setAttribute('data-closed', String(code)),
			onreconnecting: (code) => log(`lost the voice service (${code}); coming back`),
			onreconnected: () => log('back in voice'),
			log
		});
		log(`joined as leaf ${room.leaf} with ${room.handler}`);
	},
	async report(listenMs = 0) {
		const now = room!;
		// The loudest of several looks: a fake capture device beeps rather than hums.
		const best = new Map<string, { rms: number | null; peakHz: number | null }>();
		const until = performance.now() + listenMs;
		do {
			for (const [peer, analyser] of analysers) {
				const one = measure(analyser);
				if ((one.rms ?? 0) >= (best.get(peer)?.rms ?? -1)) best.set(peer, one);
			}
			if (listenMs) await new Promise((resolve) => setTimeout(resolve, 100));
		} while (performance.now() < until);
		const heard: Heard[] = [];
		for (const stream of now.heard) {
			const inbound = [...(await stream.consumer.getStats()).values()].find(
				(stat) => stat.type === 'inbound-rtp'
			);
			heard.push({
				leaf: stream.leaf,
				player: stream.player,
				muted: stream.muted,
				packetsReceived: inbound?.packetsReceived ?? 0,
				...(best.get(stream.peer) ?? { rms: null, peakHz: null }),
				energy: inbound?.totalAudioEnergy ?? 0,
				totalSamplesReceived: inbound?.totalSamplesReceived ?? 0,
				concealedSamples: inbound?.concealedSamples ?? 0
			});
		}
		const { send, recv } = now.transports;
		const pathOf = async (transport: typeof send) => {
			if (!transport) return null;
			const stats = [...(await transport.getStats()).values()];
			const pair = stats.find(
				(stat) => stat.type === 'candidate-pair' && (stat.nominated || stat.selected)
			);
			const remote = stats.find((stat) => stat.id === pair?.remoteCandidateId);
			return remote ? `${remote.protocol} ${remote.address ?? remote.ip}:${remote.port}` : null;
		};
		return {
			connected: now.connected,
			leaf: now.leaf,
			epoch: now.epoch ? Number(now.epoch.epoch) : null,
			code: now.epoch?.code ?? [],
			seatsOk: now.epoch?.seats.ok ?? false,
			handler: now.handler,
			connection: { send: send?.connectionState ?? null, recv: recv?.connectionState ?? null },
			path: { send: await pathOf(send), recv: await pathOf(recv) },
			transforms: await now.tallies(),
			refused: now.refused,
			heard: heard.sort((a, b) => a.leaf - b.leaf)
		};
	},
	seats(seated) {
		room?.seats(seated);
	},
	mute(player, muted) {
		return room!.mute(player, muted);
	},
	leave() {
		room?.close();
	}
};

document.body.setAttribute('data-room', 'ready');

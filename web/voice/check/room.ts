// The voice service's check page (`pnpm voice:check`, P4C.4): one person in a
// table's voice room on the real service (voice/server.ts), through the
// site's VoiceRoom (src/lib/voice/room.ts): the MLS group over voice
// signalling v1, each epoch's keys in the worker, and audio through
// mediasoup. `window.room` is what room.check.ts drives.
import type { Identity } from '../../src/lib/voice/group.ts';
import { VoiceRoom, type Heard as Stream } from '../../src/lib/voice/room.ts';
import { FrameCrypto } from '../../src/lib/voice/sframe-client.ts';
import type { Tally } from '../../src/lib/voice/sframe-transform.ts';
import {
	LAYOUT,
	decodeHeader,
	deriveFrameKey,
	open as openFrame,
	partsOf,
	type FrameKey
} from '../../src/lib/voice/sframe.ts';
import { fromBase64, toBase64 } from '../../src/lib/voice/signalling.ts';

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
	// What the person has done with their own audio before joining (P4C.6):
	// muted themself, or deafened.
	selfMuted?: boolean;
	deafened?: boolean;
	// How long the room keeps trying to come back before it ends, and how long
	// a transport has to connect, and to connect again (room.ts).
	giveUpMs?: number;
	connectMs?: number;
	iceGiveUpMs?: number;
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
	// Until when the service refuses this person's audio (P4C.8), or null.
	silencedUntil: number | null;
	// Whether the page has a producer: it sends audio.
	producing: boolean;
	// How many times this connection started ICE again, and how many times the
	// room lost the service and came back (P4C.7).
	iceRestarts: number;
	reconnects: number;
	// The code the room ended with, or null while it stands.
	closed: number | null;
	// The track this page sends and its AudioContext, as the page sees them
	// (the app's voice check, P5D.9, reads them in the background).
	local: { readyState: string; muted: boolean; enabled: boolean; context: string | null } | null;
	// Everyone else, as this page's own copy of the group and the service's
	// notices have them (P4C.6).
	people: { seat: number | null; sending: boolean; muted: boolean; deafened: boolean }[];
};

// What a run of Opus frames decodes to (`decode`): how many the decoder
// refused, the decoded sound's level, its loudest frequency, and how far a tone
// at that frequency, or at `atHz` when given, stands above the sound around it
// (`prominence`, in dB).
export type Decoded = {
	decoder: boolean;
	failed: number;
	samples: number;
	rms: number;
	peakHz: number | null;
	prominence: number | null;
	prominenceAt: number | null;
};

export type RoomCheck = {
	join(options: JoinOptions): Promise<void>;
	report(listenMs?: number): Promise<RoomReport>;
	seats(seated: Identity[]): void;
	mute(player: string, muted: boolean): Promise<void>;
	leave(): void;
	// The epochs this page was given a key for.
	epochs(): number[];
	// Each SFrame frame opened with the keys this page was given, or null where
	// none of them opens it (P4C.8).
	open(frames: string[]): Promise<(string | null)[]>;
	// Decode Opus frames with the browser's own decoder (WebCodecs), whatever
	// they hold, and say what came out (P4C.8).
	decode(frames: string[], atHz?: number): Promise<Decoded>;
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

// Every epoch's base key this page's room was given, for the keyless
// listener's check (tap.check.ts): the same non-extractable CryptoKeys the
// worker holds, usable only on this page, so the check can try them on frames
// captured at the voice service. The site's pages keep nothing of the kind.
const held = new Map<bigint, CryptoKey>();
const addEpoch = FrameCrypto.prototype.addEpoch;
FrameCrypto.prototype.addEpoch = function (epoch: bigint, baseKey: CryptoKey) {
	held.set(epoch, baseKey);
	addEpoch.call(this, epoch, baseKey);
};

// A radix-2 FFT in place, for `analyse`.
function fft(re: Float64Array, im: Float64Array): void {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let size = 2; size <= n; size <<= 1) {
		const angle = (-2 * Math.PI) / size;
		for (let start = 0; start < n; start += size) {
			for (let k = 0; k < size / 2; k++) {
				const [cos, sin] = [Math.cos(angle * k), Math.sin(angle * k)];
				const a = start + k;
				const b = a + size / 2;
				const tr = re[b] * cos - im[b] * sin;
				const ti = re[b] * sin + im[b] * cos;
				re[b] = re[a] - tr;
				im[b] = im[a] - ti;
				re[a] += tr;
				im[a] += ti;
			}
		}
	}
}

// The loudest frequency between 100 Hz and 4 kHz of 48 kHz audio, and how far
// it stands out: the mean power within 10 Hz of it over the mean power from 30
// to 300 Hz to either side, in dB. A tone stands tens of dB above its
// surroundings; noise, however it is shaped, does not.
//
// The loudest frequency is looked for in the middle of the audio. How far a
// tone at `atHz` stands out is the median over every stretch of the audio in
// turn: a tone is in all of them, and whatever a decoder makes of frames that
// are not audio, which can ring at any frequency for a moment, is not.
function analyse(
	pcm: Float32Array,
	atHz?: number
): Pick<Decoded, 'rms' | 'peakHz' | 'prominence' | 'prominenceAt'> {
	const rms = Math.sqrt(pcm.reduce((sum, x) => sum + x * x, 0) / Math.max(1, pcm.length));
	// A tenth of a second at least; less than the transform is padded with silence.
	const n = 1 << 15;
	if (pcm.length < 4800) return { rms, peakHz: null, prominence: null, prominenceAt: null };
	const hzPerBin = 48000 / n;
	const spectrum = (start: number) => {
		const re = new Float64Array(n);
		const im = new Float64Array(n);
		const length = Math.min(n, pcm.length - start);
		for (let i = 0; i < length; i++) {
			re[i] = pcm[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1)));
		}
		fft(re, im);
		const power = (bin: number) => re[bin] ** 2 + im[bin] ** 2;
		const mean = (lo: number, hi: number) => {
			let sum = 0;
			let bins = 0;
			for (let bin = Math.ceil(Math.max(50, lo) / hzPerBin); bin * hzPerBin <= hi; bin++) {
				sum += power(bin);
				bins += 1;
			}
			return bins ? sum / bins : 0;
		};
		const prominence = (hz: number) => {
			const tone = mean(hz - 10, hz + 10);
			const around = (mean(hz - 300, hz - 30) + mean(hz + 30, hz + 300)) / 2;
			return 10 * Math.log10(Math.max(tone, 1e-30) / Math.max(around, 1e-30));
		};
		return { power, prominence };
	};
	const middle = spectrum(Math.max(0, Math.floor((pcm.length - n) / 2)));
	let peak = Math.ceil(100 / hzPerBin);
	for (let bin = peak; bin * hzPerBin < 4000; bin++) {
		if (middle.power(bin) > middle.power(peak)) peak = bin;
	}
	let prominenceAt: number | null = null;
	if (atHz) {
		const each: number[] = [];
		for (let start = 0; start === 0 || start + n <= pcm.length; start += n) {
			each.push(spectrum(start).prominence(atHz));
		}
		each.sort((a, b) => a - b);
		prominenceAt = each[Math.floor((each.length - 1) / 2)];
	}
	return {
		rms,
		peakHz: peak * hzPerBin,
		prominence: middle.prominence(peak * hzPerBin),
		prominenceAt
	};
}

// Opus frames through WebCodecs' decoder, as one stream. A frame it refuses
// closes the decoder, so a run with any refused is decoded again a frame at a
// time, each refusal counted and the next frame given a new decoder.
async function decodeOpus(frames: Uint8Array[]): Promise<{ failed: number; pcm: Float32Array }> {
	const run = async (batches: Uint8Array[][]) => {
		const chunks: Float32Array[] = [];
		let failed = 0;
		let index = 0;
		for (const batch of batches) {
			const decoder = new AudioDecoder({
				output: (data) => {
					const samples = new Float32Array(data.numberOfFrames);
					data.copyTo(samples, { planeIndex: 0, format: 'f32-planar' });
					chunks.push(samples);
					data.close();
				},
				error: () => {}
			});
			decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
			try {
				for (const frame of batch) {
					decoder.decode(
						new EncodedAudioChunk({ type: 'key', timestamp: index++ * 20_000, data: frame })
					);
				}
				await decoder.flush();
			} catch {
				failed += 1;
			}
			if (decoder.state !== 'closed') decoder.close();
		}
		const pcm = new Float32Array(chunks.reduce((sum, one) => sum + one.length, 0));
		let at = 0;
		for (const one of chunks) {
			pcm.set(one, at);
			at += one.length;
		}
		return { failed, pcm };
	};
	const whole = await run([frames]);
	return whole.failed ? run(frames.map((frame) => [frame])) : whole;
}

let room: VoiceRoom | null = null;
let sending: MediaStreamTrack | null = null;
let reconnects = 0;
let closed: number | null = null;
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
			sending: !options.selfMuted && !options.deafened,
			status: { muted: options.selfMuted ?? false, deafened: options.deafened ?? false },
			deafened: options.deafened ?? false,
			giveUpMs: options.giveUpMs,
			connectMs: options.connectMs,
			iceGiveUpMs: options.iceGiveUpMs,
			track: (sending = await track(options)),
			onheard: heard,
			onended: (stream) => {
				analysers.delete(stream.peer);
				elements.get(stream.peer)?.pause();
				elements.delete(stream.peer);
			},
			onclose: (code) => {
				closed = code;
				document.body.setAttribute('data-closed', String(code));
			},
			onreconnecting: (code) => log(`lost the voice service (${code}); coming back`),
			onreconnected: () => {
				reconnects += 1;
				log('back in voice');
			},
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
			heard: heard.sort((a, b) => a.leaf - b.leaf),
			silencedUntil: now.silencedUntil,
			producing: now.producer !== null && !now.producer.closed,
			iceRestarts: now.iceRestarts,
			reconnects,
			closed,
			local: sending && {
				readyState: sending.readyState,
				muted: sending.muted,
				enabled: sending.enabled,
				context: context?.state ?? null
			},
			people: now.people
				.map(({ seat, sending, muted, deafened }) => ({ seat, sending, muted, deafened }))
				.sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0))
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
	},
	epochs() {
		return [...held.keys()].map(Number).sort((a, b) => a - b);
	},
	async open(frames) {
		const slots = 1n << BigInt(LAYOUT.epochBits);
		const keys = new Map<string, Promise<FrameKey>>();
		return Promise.all(
			frames.map(async (text) => {
				const frame = fromBase64(text);
				const header = frame && decodeHeader(frame);
				const parts = header && partsOf(LAYOUT, header.kid);
				if (!frame || !header || !parts) return null;
				for (const [epoch, baseKey] of held) {
					if (Number(epoch % slots) !== parts.slot) continue;
					const id = `${epoch}:${header.kid}`;
					let key = keys.get(id);
					if (!key) keys.set(id, (key = deriveFrameKey(baseKey, header.kid, 'decrypt')));
					try {
						return toBase64(new Uint8Array(await openFrame(await key, header, frame)));
					} catch {
						// Not this epoch's: try the next that shares its low bits.
					}
				}
				return null;
			})
		);
	},
	async decode(frames, atHz) {
		const none = { failed: frames.length, samples: 0, rms: 0, peakHz: null, prominence: null };
		if (typeof AudioDecoder !== 'function') return { decoder: false, ...none, prominenceAt: null };
		const config = { codec: 'opus', sampleRate: 48000, numberOfChannels: 1 };
		if (!(await AudioDecoder.isConfigSupported(config)).supported) {
			return { decoder: false, ...none, prominenceAt: null };
		}
		const { failed, pcm } = await decodeOpus(frames.map((text) => fromBase64(text)!));
		return { decoder: true, failed, samples: pcm.length, ...analyse(pcm, atHz) };
	}
};

// A page nobody drives, such as the app's web view (P5D.9), joins from its
// address: `#join=` and the JoinOptions as JSON, with `report`, a name for it,
// added. It then posts its report to the page's server every two seconds.
async function joinFromAddress(): Promise<void> {
	const options = JSON.parse(
		decodeURIComponent(location.hash.slice('#join='.length))
	) as JoinOptions & { report: string };
	const post = (body: Record<string, unknown>) =>
		fetch('/result', {
			method: 'POST',
			body: JSON.stringify({
				room: options.report,
				agent: navigator.userAgent,
				at: Date.now(),
				...body
			})
		}).catch(() => {});
	try {
		await window.room.join(options);
	} catch (error) {
		await post({ error: String(error) });
		return;
	}
	for (;;) {
		await post({ report: await window.room.report(1000) }).catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}
if (location.hash.startsWith('#join=')) void joinFromAddress();

document.body.setAttribute('data-room', 'ready');

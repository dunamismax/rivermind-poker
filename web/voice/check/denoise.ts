// Table voice's stronger noise suppression (P4C.6, Q-11) on the voice checks'
// page, which carries the site's CSP: the worklet and the WebAssembly load as
// the site loads them, and RNNoise runs on a 48 kHz OfflineAudioContext over a
// room's noise, with and without a voice on top. `window.denoise` is what
// denoise.check.ts drives.
//
// The room is made here, seeded, so every engine hears the same: a fan (pink
// noise), a keyboard (short clicks) and chatter (other voices, low and
// muffled). The voice is a voice-like signal (a gliding pitch through three
// formants, in syllables) unless the caller gives a recording.
//
// For the comparison with the browser's own noise suppression (P4C.6's last
// measurement, denoise.measure.ts), the page also hands the test the same
// room and voice as sound to play into a real capture path (`mix`), and
// records what a microphone captured with each kind of processing (`capture`).
import { Denoiser, RNNOISE_RATE, rnnoiseNode } from '../../src/lib/voice/denoise.ts';
import marksUrl from './marks.worklet.js?url';

export type Measure = {
	// How much quieter RNNoise leaves the room where nobody speaks, in dB.
	noiseCutDb: number;
	// How much of the speech it keeps where someone does: the output's energy against the input's.
	speechKeptDb: number;
	// How far behind the input RNNoise's output is, by cross-correlation over the voice.
	delayMs: number;
	// Rendering time against the audio's length: a share of one core.
	cpu: number;
	seconds: number;
	// The unmeasured room before it, long enough for RNNoise to have started.
	leadSeconds: number;
};

export type CaptureOptions = {
	// The browser's own noise suppression (`noiseSuppression` on the microphone).
	noiseSuppression: boolean;
	// RNNoise after it, as the site sends by default.
	denoise: boolean;
	seconds: number;
};

declare global {
	interface Window {
		denoise: {
			measure(options?: { voice?: number[]; seconds?: number }): Promise<Measure>;
			// The room for `seconds`, with a voice over its middle half: 16-bit mono
			// PCM at 48 kHz, as base64. `voice` is a recording in the same form.
			mix(seconds: number, voice?: string): string;
			// What the microphone gives the page for `seconds`, in the same form.
			capture(options: CaptureOptions): Promise<string>;
		};
	}
}

const bytesOf = (text: string): Uint8Array => {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
	return bytes;
};
const pcmOf = (samples: Float32Array): string => {
	const pcm = new Int16Array(samples.length);
	for (let at = 0; at < samples.length; at += 1) {
		pcm[at] = Math.max(-32768, Math.min(32767, Math.round(samples[at] * 32767)));
	}
	const bytes = new Uint8Array(pcm.buffer);
	let text = '';
	for (let at = 0; at < bytes.length; at += 0x8000) {
		text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	}
	return btoa(text);
};

const RATE = RNNOISE_RATE;

// A small seeded generator, so the room is the same in every engine.
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// A voice-like signal: a pitch gliding between 110 and 190 Hz, its harmonics
// shaped by three formants, in syllables of about a quarter second.
function voiceLike(samples: number, seed: number): Float32Array<ArrayBuffer> {
	const next = random(seed);
	const out = new Float32Array(samples);
	const formants = [
		[700, 1],
		[1200, 0.5],
		[2600, 0.25]
	];
	let phase = 0;
	for (let i = 0; i < samples; i++) {
		const t = i / RATE;
		const pitch = 150 + 40 * Math.sin(2 * Math.PI * 0.7 * t + seed);
		phase += pitch / RATE;
		let sample = 0;
		for (let h = 1; h * pitch < 4000; h++) {
			let weight = 0;
			for (const [centre, gain] of formants) {
				weight += gain / (1 + ((h * pitch - centre) / 150) ** 2);
			}
			sample += (weight / h) * Math.sin(2 * Math.PI * h * phase);
		}
		const syllable = Math.max(0, Math.sin(2 * Math.PI * 4 * t)) ** 2;
		out[i] = sample * syllable * 0.08 * (0.8 + 0.4 * next());
	}
	return out;
}

// The room: a fan, a keyboard and chatter.
function room(samples: number): Float32Array<ArrayBuffer> {
	const next = random(7);
	const out = new Float32Array(samples);
	// Pink noise (Paul Kellet's filter).
	let [b0, b1, b2, b3, b4, b5, b6] = [0, 0, 0, 0, 0, 0, 0];
	for (let i = 0; i < samples; i++) {
		const white = next() * 2 - 1;
		b0 = 0.99886 * b0 + white * 0.0555179;
		b1 = 0.99332 * b1 + white * 0.0750759;
		b2 = 0.969 * b2 + white * 0.153852;
		b3 = 0.8665 * b3 + white * 0.3104856;
		b4 = 0.55 * b4 + white * 0.5329522;
		b5 = -0.7616 * b5 - white * 0.016898;
		out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.006;
		b6 = white * 0.115926;
	}
	// Keys: a click every 120 to 300 ms.
	for (let at = 0; at < samples; at += Math.floor((0.12 + next() * 0.18) * RATE)) {
		for (let i = 0; i < 240 && at + i < samples; i++) {
			out[at + i] += (next() * 2 - 1) * 0.05 * Math.exp(-i / 40);
		}
	}
	// Chatter: three other voices, quiet and muffled.
	for (const seed of [11, 23, 37]) {
		const other = voiceLike(samples, seed);
		let low = 0;
		for (let i = 0; i < samples; i++) {
			low += 0.15 * (other[i] - low);
			out[i] += low * 0.25;
		}
	}
	return out;
}

const energy = (data: Float32Array, from: number, to: number) => {
	let sum = 0;
	for (let i = Math.floor(from * RATE); i < Math.floor(to * RATE); i++) sum += data[i] * data[i];
	return sum;
};
const db = (ratio: number) => Math.round(10 * Math.log10(ratio) * 10) / 10;

// The lag, in samples, at which `out` best matches `input`, up to 50 ms.
function lag(input: Float32Array, out: Float32Array, from: number, to: number): number {
	let best = 0;
	let bestScore = -Infinity;
	for (let shift = 0; shift <= 0.05 * RATE; shift++) {
		let score = 0;
		for (let i = Math.floor(from * RATE); i < Math.floor(to * RATE); i += 2) {
			score += input[i] * out[i + shift];
		}
		if (score > bestScore) {
			bestScore = score;
			best = shift;
		}
	}
	return best;
}

window.denoise = {
	mix(seconds, voice) {
		const samples = seconds * RATE;
		const source = voice
			? Float32Array.from(new Int16Array(bytesOf(voice).buffer), (sample) => sample / 32768)
			: voiceLike(samples, 3);
		const [from, to] = [Math.floor((samples * 1) / 4), Math.floor((samples * 3) / 4)];
		const mix = room(samples);
		for (let i = from; i < to; i++) mix[i] += source[(i - from) % source.length];
		return pcmOf(mix);
	},
	async capture({ noiseSuppression, denoise, seconds }) {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount: { ideal: 1 },
				echoCancellation: false,
				autoGainControl: false,
				noiseSuppression
			}
		});
		const microphone = stream.getAudioTracks()[0];
		console.log(`[capture] the microphone has ${microphone.getSettings().channelCount} channels`);
		const denoiser = denoise ? await Denoiser.start(microphone) : null;
		const context = new AudioContext({ sampleRate: RATE });
		await context.resume();
		await context.audioWorklet.addModule(marksUrl);
		const blocks: Float32Array[] = [];
		const recorder = new AudioWorkletNode(context, 'marks-recorder', { numberOfOutputs: 0 });
		recorder.port.onmessage = ({ data }: MessageEvent<Float32Array>) => blocks.push(data);
		const source = context.createMediaStreamSource(
			new MediaStream([denoiser?.track ?? microphone])
		);
		source.connect(recorder);
		await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
		source.disconnect();
		denoiser?.close();
		microphone.stop();
		await context.close();
		const captured = new Float32Array(blocks.reduce((sum, one) => sum + one.length, 0));
		let at = 0;
		for (const block of blocks) {
			captured.set(block, at);
			at += block.length;
		}
		return pcmOf(captured);
	},
	async measure({ voice, seconds = 8 } = {}) {
		const samples = seconds * RATE;
		// Noise alone for the first and last quarter, a voice over it in between.
		const speech = new Float32Array(samples);
		const source = voice ? Float32Array.from(voice) : voiceLike(samples, 3);
		const [from, to] = [seconds / 4, (seconds * 3) / 4];
		for (let i = Math.floor(from * RATE); i < Math.floor(to * RATE); i++) {
			speech[i] = source[(i - Math.floor(from * RATE)) % source.length];
		}
		const noise = room(samples);
		const mix = new Float32Array(samples);
		for (let i = 0; i < samples; i++) mix[i] = speech[i] + noise[i];

		// The room first, which is not measured: the processor starts RNNoise's WebAssembly
		// asynchronously in the worklet and plays silence until it has. Where the engine
		// can, the render waits at its first block; elsewhere (Firefox, which renders
		// nine seconds in a few tens of milliseconds) the lead grows until RNNoise had
		// been running for three seconds before the measured part began. With less it is
		// still learning the room when the measure starts: a tenth of a second, which
		// this once allowed, read 9.6 dB, and one second 12.6 dB, where 20 is the rule.
		const settle = 3 * RATE;
		let lead = 4 * RATE;
		let rendered: AudioBuffer;
		let renderMs: number;
		for (;;) {
			const context = new OfflineAudioContext(1, lead + samples, RATE);
			const buffer = new AudioBuffer({
				length: lead + samples,
				sampleRate: RATE,
				numberOfChannels: 1
			});
			buffer.copyToChannel(room(lead), 0);
			buffer.copyToChannel(mix, 0, lead);
			const player = new AudioBufferSourceNode(context, { buffer });
			const node = await rnnoiseNode(context);
			player.connect(node).connect(context.destination);
			player.start();
			let held = 0;
			if ('suspend' in context) {
				held = 500;
				void context.suspend(128 / RATE).then(async () => {
					await new Promise((resolve) => setTimeout(resolve, held));
					await context.resume();
				});
			}
			const started = performance.now();
			rendered = await context.startRendering();
			renderMs = performance.now() - started - held;
			node.destroy();
			const first = rendered.getChannelData(0).findIndex((sample) => sample !== 0);
			if ((first >= 0 && first < lead - settle) || lead >= 64 * RATE) break;
			lead *= 4;
		}
		const out = rendered.getChannelData(0).subarray(lead);
		const shift = lag(mix, out, 0.5, seconds - 0.5);
		const shifted = (a: number, b: number) => energy(out.subarray(shift), a, b);
		const quiet =
			(energy(mix, 0.5, from) + energy(mix, to + 0.5, seconds - 0.5)) /
			(shifted(0.5, from) + shifted(to + 0.5, seconds - 0.5));
		return {
			noiseCutDb: db(quiet),
			speechKeptDb: db(shifted(from + 0.5, to - 0.5) / energy(mix, from + 0.5, to - 0.5)),
			delayMs: Math.round((shift / RATE) * 1000 * 10) / 10,
			cpu: Math.round((renderMs / 1000 / (seconds + lead / RATE)) * 1000) / 1000,
			leadSeconds: lead / RATE,
			seconds
		};
	}
};
document.body.setAttribute('data-denoise', 'ready');

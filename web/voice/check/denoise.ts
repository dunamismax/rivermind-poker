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
import { RNNOISE_RATE, rnnoiseNode } from '../../src/lib/voice/denoise.ts';

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

declare global {
	interface Window {
		denoise: {
			measure(options?: { voice?: number[]; seconds?: number }): Promise<Measure>;
		};
	}
}

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
		// nine seconds in a few tens of milliseconds) the lead grows until RNNoise was
		// running before the measured part began.
		let lead = RATE;
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
			if ((first >= 0 && first < lead - 0.1 * RATE) || lead >= 64 * RATE) break;
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

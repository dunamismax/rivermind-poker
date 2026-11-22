// Stronger noise suppression for table voice (P4C.6, Q-11): RNNoise, built to
// WebAssembly, in an AudioWorklet between the microphone and what the page
// encodes and seals. It runs in the speaker's browser before encryption, so it
// costs no privacy. `@sapphi-red/web-noise-suppressor` (MIT) provides the
// node and the processor; RNNoise itself is BSD-3-Clause and its WebAssembly
// build Apache-2.0 (licenses/web-noise-suppressor.txt).
//
// The worklet and the WebAssembly are bundled same-origin files, and running
// WebAssembly needs `'wasm-unsafe-eval'` in the page's `script-src`, the one
// loosening of the CSP voice makes (Q-11).
//
// RNNoise works on 48 kHz audio in 10 ms frames, so it gets an AudioContext of
// its own at 48 kHz. A browser that cannot run it (no AudioWorklet, no
// WebAssembly, or a microphone it will not resample) keeps its own processing.
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import simdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

export const RNNOISE_RATE = 48000;

let binary: Promise<ArrayBuffer> | null = null;

// The WebAssembly, fetched once a page (the SIMD build where the browser has SIMD).
export function rnnoiseBinary(): Promise<ArrayBuffer> {
	binary ??= loadRnnoise({ url: wasmUrl, simdUrl }).catch((error: unknown) => {
		binary = null;
		throw error;
	});
	return binary;
}

// Add the processor to a context, and make the node.
export async function rnnoiseNode(
	context: BaseAudioContext & { audioWorklet: AudioWorklet }
): Promise<RnnoiseWorkletNode> {
	const [wasmBinary] = await Promise.all([
		rnnoiseBinary(),
		context.audioWorklet.addModule(workletUrl)
	]);
	return new RnnoiseWorkletNode(context as AudioContext, { maxChannels: 1, wasmBinary });
}

export class Denoiser {
	readonly context: AudioContext;
	// What the page sends: the microphone after RNNoise.
	readonly track: MediaStreamTrack;
	// Its output, for the meter.
	readonly output: AudioNode;
	#nodes: { source: MediaStreamAudioSourceNode; node: RnnoiseWorkletNode };

	private constructor(
		context: AudioContext,
		track: MediaStreamTrack,
		source: MediaStreamAudioSourceNode,
		node: RnnoiseWorkletNode
	) {
		this.context = context;
		this.track = track;
		this.output = node;
		this.#nodes = { source, node };
	}

	// Put RNNoise after `input`. Throws where the browser cannot run it.
	static async start(input: MediaStreamTrack): Promise<Denoiser> {
		if (typeof AudioWorkletNode === 'undefined' || typeof WebAssembly === 'undefined') {
			throw new Error('no AudioWorklet or WebAssembly');
		}
		const context = new AudioContext({ sampleRate: RNNOISE_RATE, latencyHint: 'interactive' });
		try {
			const node = await rnnoiseNode(context);
			const source = context.createMediaStreamSource(new MediaStream([input]));
			const out = new MediaStreamAudioDestinationNode(context, {
				channelCount: 1,
				channelCountMode: 'explicit'
			});
			source.connect(node).connect(out);
			void context.resume().catch(() => {});
			return new Denoiser(context, out.stream.getAudioTracks()[0], source, node);
		} catch (error) {
			void context.close().catch(() => {});
			throw error;
		}
	}

	close(): void {
		this.#nodes.source.disconnect();
		this.#nodes.node.disconnect();
		this.#nodes.node.destroy();
		this.track.stop();
		void this.context.close().catch(() => {});
	}
}

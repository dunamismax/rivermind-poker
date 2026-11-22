// AudioWorklet processors for the voice measurements (P4C.7, delay.ts).
// `marks-source` plays marks at set intervals and says when each one started;
// `marks-ear` says when it hears one start. Both read the wall clock on the
// audio thread, in the block the sample is in, so the two ends of a call on
// one machine can be compared to within a block or two. `marks-recorder`
// hands the page every block it is given, for a recording of what a listener
// hears.
//
// A mark is either a 10 ms burst of a 2 kHz tone over a quiet 220 Hz carrier
// (`tone`: the carrier keeps the encoder sending between marks), or 80 ms of
// a voiced sound, a 140 Hz pulse train shaped like a vowel, over silence
// (`voice`: what noise suppression lets through, starting as an utterance
// does). Plain JavaScript: a worklet module is served as it is, and runs in
// the audio thread's own scope, whose globals neither checker knows.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
/* global AudioWorkletProcessor, sampleRate, registerProcessor */

const TWO_PI = 2 * Math.PI;

class MarksSource extends AudioWorkletProcessor {
	constructor(options) {
		super();
		const { everyMs, mark } = options.processorOptions;
		this.every = Math.round((everyMs * sampleRate) / 1000);
		this.mark = mark;
		this.length = Math.round(((mark === 'voice' ? 80 : 10) * sampleRate) / 1000);
		this.at = 0;
		this.next = this.every;
		this.left = 0;
		this.index = 0;
	}

	voiced(n) {
		// Harmonics of 140 Hz under two formants, about 700 and 1200 Hz.
		const t = n / sampleRate;
		let sum = 0;
		for (let harmonic = 1; harmonic <= 20; harmonic += 1) {
			const hz = 140 * harmonic;
			const weight =
				1 / (1 + ((hz - 700) / 180) ** 2) + 0.6 / (1 + ((hz - 1200) / 220) ** 2) + 0.05;
			sum += weight * Math.sin(TWO_PI * hz * t);
		}
		return 0.28 * sum;
	}

	process(_inputs, outputs) {
		const out = outputs[0][0];
		const now = Date.now();
		for (let i = 0; i < out.length; i += 1) {
			if (this.at === this.next) {
				this.next += this.every;
				this.left = this.length;
				this.port.postMessage({ index: this.index, at: now + (i / sampleRate) * 1000 });
				this.index += 1;
			}
			let sample =
				this.mark === 'tone' ? 0.03 * Math.sin((TWO_PI * 220 * this.at) / sampleRate) : 0;
			if (this.left > 0) {
				const n = this.length - this.left;
				sample +=
					this.mark === 'voice' ? this.voiced(n) : 0.7 * Math.sin((TWO_PI * 2000 * n) / sampleRate);
				this.left -= 1;
			}
			out[i] = sample;
			this.at += 1;
		}
		return true;
	}
}

class MarksEar extends AudioWorkletProcessor {
	constructor(options) {
		super();
		const { threshold, quietMs } = options.processorOptions;
		this.threshold = threshold;
		this.quiet = Math.round((quietMs * sampleRate) / 1000);
		this.at = 0;
		this.lastLoud = -Infinity;
		this.blocks = 0;
	}

	process(inputs) {
		const input = inputs[0];
		const now = Date.now();
		this.blocks += 1;
		// Proof that the graph renders: a context can say it runs and not.
		if (this.blocks % 400 === 0) this.port.postMessage({ blocks: this.blocks });
		const length = input[0]?.length ?? 128;
		for (let i = 0; i < length; i += 1) {
			let loudest = 0;
			for (const channel of input) loudest = Math.max(loudest, Math.abs(channel[i]));
			if (loudest > this.threshold) {
				if (this.at - this.lastLoud > this.quiet) {
					this.port.postMessage({ at: now + (i / sampleRate) * 1000 });
				}
				this.lastLoud = this.at;
			}
			this.at += 1;
		}
		return true;
	}
}

class MarksRecorder extends AudioWorkletProcessor {
	process(inputs) {
		const channel = inputs[0][0];
		if (channel) this.port.postMessage(channel.slice());
		return true;
	}
}

registerProcessor('marks-recorder', MarksRecorder);
registerProcessor('marks-source', MarksSource);
registerProcessor('marks-ear', MarksEar);

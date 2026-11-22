// The microphone for table voice (P4C.6): asked for only once the person has
// chosen to join (D-15), with the device and the browser's processing they
// chose, and a level for the meter. A refusal is explained in plain words, and
// the person stays in voice to listen. With `denoise`, what the page sends is
// the microphone after RNNoise (denoise.ts), and the raw microphone if RNNoise
// cannot run or stops.
import type { Denoiser } from './denoise.ts';
import type { VoiceSettings } from './settings.ts';

export type MicSettings = Pick<
	VoiceSettings,
	'input' | 'echoCancellation' | 'noiseSuppression' | 'autoGainControl' | 'denoise'
>;

// Why there is no microphone.
export type MicProblem = 'denied' | 'no-device' | 'busy' | 'insecure' | 'unsupported' | 'failed';

export class MicError extends Error {
	readonly problem: MicProblem;

	constructor(problem: MicProblem, cause?: unknown) {
		super(problem, { cause });
		this.problem = problem;
	}
}

// What went wrong and what to do about it, in a sentence or two.
export function explainMic(problem: MicProblem): string {
	switch (problem) {
		case 'denied':
			return 'Your browser did not let the page use the microphone. To talk, allow the microphone for this site in the browser’s site settings (often the icon beside the address), then press Join voice again. You can listen meanwhile.';
		case 'no-device':
			return 'No microphone was found. Plug one in or choose another in the voice settings, then press Join voice again. You can listen meanwhile.';
		case 'busy':
			return 'The microphone is in use by another program or could not be started. Close the other program, then press Join voice again. You can listen meanwhile.';
		case 'insecure':
			return 'The microphone works only on a secure (https) page.';
		case 'unsupported':
			return 'This browser cannot give the page a microphone. You can listen.';
		case 'failed':
			return 'The microphone could not be started. Press Join voice to try again. You can listen meanwhile.';
	}
}

export function problemOf(error: unknown): MicProblem {
	const name = (error as { name?: string } | null)?.name;
	switch (name) {
		case 'NotAllowedError':
		case 'PermissionDeniedError':
			return 'denied';
		case 'NotFoundError':
		case 'DevicesNotFoundError':
		case 'OverconstrainedError':
			return 'no-device';
		case 'NotReadableError':
		case 'TrackStartError':
		case 'AbortError':
			return 'busy';
		case 'SecurityError':
			return 'insecure';
		case 'NotSupportedError':
		case 'TypeError':
			return 'unsupported';
		default:
			return 'failed';
	}
}

// The constraints for `getUserMedia`: the chosen device if there is one, mono,
// and the browser's processing as chosen.
export function constraintsFor(settings: Omit<MicSettings, 'denoise'>): MediaTrackConstraints {
	return {
		...(settings.input ? { deviceId: { ideal: settings.input } } : {}),
		channelCount: { ideal: 1 },
		echoCancellation: settings.echoCancellation,
		noiseSuppression: settings.noiseSuppression,
		autoGainControl: settings.autoGainControl
	};
}

// How long a page waits for `getUserMedia` before giving up on it: some
// browsers never settle when no prompt can be shown.
const ASK_MS = 30_000;
// RNNoise's context has stopped when its clock has not moved for this long while
// it says it runs, or when it has not run at all for twice as long.
const STALLED_MS = 1500;

export const DENOISE_UNAVAILABLE =
	'This browser cannot run the stronger noise suppression, so it uses its own.';
export const DENOISE_STOPPED =
	'The stronger noise suppression stopped, so the browser’s own is used.';

export class Microphone {
	readonly stream: MediaStream;
	// Why RNNoise is not running though it was asked for; null when it runs or was not asked for.
	denoiseProblem: string | null = null;
	// The track to send changed: RNNoise stopped, and the raw microphone took its place.
	ontrack: ((track: MediaStreamTrack) => void) | null = null;
	#denoiser: Denoiser | null = null;
	#analyser: AnalyserNode | null = null;
	#source: AudioNode | null = null;
	#samples = new Float32Array(1024);
	#watch: ReturnType<typeof setInterval> | null = null;

	private constructor(stream: MediaStream) {
		this.stream = stream;
	}

	// Ask the browser for the microphone. Throws a MicError.
	static async open(settings: MicSettings): Promise<Microphone> {
		if (typeof window !== 'undefined' && !window.isSecureContext) throw new MicError('insecure');
		if (!navigator.mediaDevices?.getUserMedia) throw new MicError('unsupported');
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const stream = await Promise.race([
				navigator.mediaDevices.getUserMedia({ audio: constraintsFor(settings), video: false }),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new MicError('failed')), ASK_MS);
				})
			]);
			if (!stream.getAudioTracks().length) throw new MicError('no-device');
			const mic = new Microphone(stream);
			if (settings.denoise) await mic.#denoise();
			return mic;
		} catch (error) {
			throw error instanceof MicError ? error : new MicError(problemOf(error), error);
		} finally {
			clearTimeout(timer);
		}
	}

	// The microphones and speakers the browser will name. Their labels appear
	// only once the page has been given a microphone.
	static async devices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
		try {
			const all = await navigator.mediaDevices.enumerateDevices();
			const named = (kind: MediaDeviceKind) =>
				all.filter((one) => one.kind === kind && one.deviceId && one.label);
			return { inputs: named('audioinput'), outputs: named('audiooutput') };
		} catch {
			return { inputs: [], outputs: [] };
		}
	}

	// The microphone as the browser gives it.
	get raw(): MediaStreamTrack {
		return this.stream.getAudioTracks()[0];
	}

	// What the page sends: after RNNoise while it runs.
	get track(): MediaStreamTrack {
		return this.#denoiser?.track ?? this.raw;
	}

	get denoising(): boolean {
		return this.#denoiser !== null;
	}

	// The device the browser gave, for the settings' list.
	get device(): string | null {
		return this.raw.getSettings().deviceId ?? null;
	}

	get live(): boolean {
		return this.raw.readyState === 'live';
	}

	// Measure what is sent, for the meter and this person's own ring: on RNNoise's
	// own context while it runs, else on `context`.
	meter(context: AudioContext | null): void {
		// Only the tap to the old analyser goes: RNNoise's output also feeds what is sent.
		if (this.#source && this.#analyser) {
			try {
				this.#source.disconnect(this.#analyser);
			} catch {
				// Already apart.
			}
		}
		this.#source = null;
		this.#analyser = null;
		const on = this.#denoiser?.context ?? context;
		if (!on) return;
		try {
			this.#source = this.#denoiser?.output ?? on.createMediaStreamSource(this.stream);
			this.#analyser = new AnalyserNode(on, { fftSize: 1024, smoothingTimeConstant: 0 });
			this.#source.connect(this.#analyser);
		} catch {
			this.#source = null;
			this.#analyser = null;
		}
	}

	async #denoise(): Promise<void> {
		try {
			// Loaded only when asked for: the library defines its node on import.
			const { Denoiser } = await import('./denoise.ts');
			this.#denoiser = await Denoiser.start(this.raw);
		} catch {
			this.denoiseProblem = DENOISE_UNAVAILABLE;
			return;
		}
		const context = this.#denoiser.context;
		let clock = { time: context.currentTime, at: performance.now() };
		const started = performance.now();
		this.#watch = setInterval(() => {
			const now = performance.now();
			if (context.currentTime !== clock.time) {
				clock = { time: context.currentTime, at: now };
				return;
			}
			if (document.hidden) {
				clock.at = now;
				return;
			}
			const stalled =
				context.state === 'running'
					? now - clock.at > STALLED_MS
					: now - Math.max(started, clock.at) > STALLED_MS * 2;
			if (stalled) this.#stopDenoise(DENOISE_STOPPED);
		}, 250);
	}

	#stopDenoise(why: string): void {
		if (this.#watch) clearInterval(this.#watch);
		this.#watch = null;
		const denoiser = this.#denoiser;
		if (!denoiser) return;
		this.#denoiser = null;
		this.#source = null;
		this.#analyser = null;
		denoiser.close();
		this.denoiseProblem = why;
		this.ontrack?.(this.raw);
	}

	// The input's level now, 0 to 1; null with nothing to measure it on.
	level(): number | null {
		if (!this.#analyser) return null;
		this.#analyser.getFloatTimeDomainData(this.#samples);
		let sum = 0;
		for (const sample of this.#samples) sum += sample * sample;
		return Math.sqrt(sum / this.#samples.length);
	}

	close(): void {
		if (this.#watch) clearInterval(this.#watch);
		this.#watch = null;
		if (this.#source && this.#analyser) this.#source.disconnect(this.#analyser);
		this.#denoiser?.close();
		this.#denoiser = null;
		for (const track of this.stream.getTracks()) track.stop();
	}
}

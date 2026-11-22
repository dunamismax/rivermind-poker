// The microphone for table voice (P4C.6): asked for only once the person has
// chosen to join (D-15), with the device and the browser's processing they
// chose, and a level for the meter. A refusal is explained in plain words, and
// the person stays in voice to listen.
import type { VoiceSettings } from './settings.ts';

export type MicSettings = Pick<
	VoiceSettings,
	'input' | 'echoCancellation' | 'noiseSuppression' | 'autoGainControl'
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
export function constraintsFor(settings: MicSettings): MediaTrackConstraints {
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

export class Microphone {
	readonly stream: MediaStream;
	#analyser: AnalyserNode | null = null;
	#source: MediaStreamAudioSourceNode | null = null;
	#samples = new Float32Array(1024);

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
			return new Microphone(stream);
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

	get track(): MediaStreamTrack {
		return this.stream.getAudioTracks()[0];
	}

	// The device the browser gave, for the settings' list.
	get device(): string | null {
		return this.track.getSettings().deviceId ?? null;
	}

	get live(): boolean {
		return this.track.readyState === 'live';
	}

	// Measure the input on this context, for the meter and this person's own ring.
	meter(context: AudioContext | null): void {
		this.#source?.disconnect();
		this.#source = null;
		this.#analyser = null;
		if (!context) return;
		try {
			this.#source = context.createMediaStreamSource(this.stream);
			this.#analyser = new AnalyserNode(context, { fftSize: 1024, smoothingTimeConstant: 0 });
			this.#source.connect(this.#analyser);
		} catch {
			this.#source = null;
			this.#analyser = null;
		}
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
		this.#source?.disconnect();
		for (const track of this.stream.getTracks()) track.stop();
	}
}

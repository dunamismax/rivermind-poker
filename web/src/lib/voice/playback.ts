// How a page plays the people it hears in table voice (P4C.6, docs/voice.md):
// a Web Audio graph for each of them, with a gain for the volume this person
// gave them (0 to 200%), a stereo panner that puts the voice on its seat's
// side of the table, and an analyser for the speaking ring, read here after
// decryption, since audio levels never travel on the wire.
//
// Where the mix goes depends on the engine.
//
//   - Firefox and Safari play it to the AudioContext's destination: their echo
//     cancellers hear everything the page plays.
//   - Chromium cancels echo only on audio it plays from a peer connection, so
//     a mix played straight from Web Audio would come back through a laptop's
//     microphone to everyone else. There it goes through a pair of local peer
//     connections on this page (`loopback`), and an audio element plays what
//     arrives, the way Mozilla Hubs does it. That element also takes the
//     chosen speakers (`setSinkId`). Nothing on that pair leaves the machine.
//   - With no Web Audio, or a context that stops rendering while it says it
//     runs (as Playwright's WebKit does once the microphone is live), each
//     voice plays from its own audio element (`elements`): volume up to 100%,
//     no panning, and the speaking ring from WebRTC's statistics.
//
// Every voice also has an audio element of its own holding its track, muted
// while the graph plays it: Chromium feeds a remote track to Web Audio only
// while a media element holds it.

export type Output = 'direct' | 'loopback' | 'elements';

// Whether someone is speaking, from the level of what this page hears of
// them: on as soon as it passes the threshold, off once it has stayed under
// it for `holdMs`, so the ring does not flicker between words.
export class SpeakingGate {
	readonly threshold: number;
	readonly holdMs: number;
	#last = -Infinity;

	constructor(threshold = 0.012, holdMs = 400) {
		this.threshold = threshold;
		this.holdMs = holdMs;
	}

	update(level: number, now: number): boolean {
		if (level >= this.threshold) this.#last = now;
		return now - this.#last < this.holdMs;
	}
}

// The root mean square of a block of samples.
export function rms(samples: Float32Array): number {
	let sum = 0;
	for (const sample of samples) sum += sample * sample;
	return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

// How far left (-1) or right (1) a voice comes from, by the left edge of its
// seat on the table as a percentage of the width: never all the way to one
// ear, which is tiring to listen to.
export function panFor(left: number, spread = 0.7): number {
	const pan = ((left - 50) / 50) * spread;
	return Math.max(-spread, Math.min(spread, Math.round(pan * 100) / 100));
}

// Chromium, the one engine that needs the loopback (see above), by a feature
// only it has: the user agent string can claim to be anything.
export function isChromium(): boolean {
	const data = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } })
		.userAgentData;
	return data?.brands?.some(({ brand }) => brand === 'Chromium') ?? false;
}

type Stream = {
	key: string;
	track: MediaStreamTrack;
	element: HTMLAudioElement;
	volume: number;
	pan: number;
	gate: SpeakingGate;
	speaking: boolean;
	nodes: {
		source: AudioNode;
		gain: GainNode;
		panner: StereoPannerNode;
		analyser: AnalyserNode;
	} | null;
	// For the statistics in `elements`: the total energy and duration last read.
	energy: { energy: number; duration: number } | null;
};

export type PlaybackOptions = {
	// Someone started or stopped speaking.
	onspeaking?: (key: string, speaking: boolean) => void;
	// WebRTC's inbound statistics of a voice, for its speaking ring when there
	// is no graph to measure it with.
	stats?: (
		key: string
	) => Promise<{ totalAudioEnergy?: number; totalSamplesDuration?: number } | null>;
	// Whether to send the mix through the loopback: by default, in Chromium.
	loopback?: boolean;
	log?: (line: string) => void;
};

const POLL_MS = 100;
const STATS_MS = 300;
// A context that says it runs but whose clock has not moved in this long has stopped.
const STALLED_MS = 1500;

export class Playback {
	#options: PlaybackOptions;
	#context: AudioContext | null = null;
	#master: GainNode | null = null;
	#out: HTMLAudioElement | null = null;
	#loop: RTCPeerConnection[] = [];
	#mode: Output = 'elements';
	#streams = new Map<string, Stream>();
	#timer: ReturnType<typeof setInterval> | null = null;
	#stats: ReturnType<typeof setInterval> | null = null;
	#deafened = false;
	#spatial = true;
	#clock = { time: 0, at: 0 };
	// When a click last asked the context to run: one that still does not, well
	// after, never will (Firefox with no sound device, as on a CI runner).
	#asked: number | null = null;
	#blocked = false;
	#closed = false;
	onchange: (() => void) | null = null;

	constructor(options: PlaybackOptions = {}) {
		this.#options = options;
	}

	get mode(): Output {
		return this.#mode;
	}

	// Whether the browser held playback back for want of a click, so the page
	// must ask for one (`resume`).
	get blocked(): boolean {
		return this.#blocked;
	}

	get context(): AudioContext | null {
		return this.#context;
	}

	// Where the mix can be listened in on, for measuring how late it is
	// (P4C.7): the node every voice ends in, and, through the loopback, the
	// stream the audio element plays.
	get mix(): AudioNode | null {
		return this.#master;
	}

	get played(): MediaStream | null {
		const stream = this.#mode === 'loopback' ? this.#out?.srcObject : null;
		return stream instanceof MediaStream ? stream : null;
	}

	// Whether this page can choose the speakers.
	get canChooseOutput(): boolean {
		const element = this.#mode === 'loopback' ? this.#out : null;
		if (element) return 'setSinkId' in element;
		if (this.#mode === 'direct' && this.#context) return 'setSinkId' in this.#context;
		return 'setSinkId' in HTMLMediaElement.prototype && this.#mode === 'elements';
	}

	// Make the graph. Call it from the click that joins voice, so the context
	// starts running there and autoplay rules never silence the room.
	start(): void {
		if (this.#context || this.#closed || typeof AudioContext === 'undefined') {
			this.#poll();
			return;
		}
		try {
			const context = new AudioContext({ latencyHint: 'interactive' });
			this.#context = context;
			this.#master = new GainNode(context, { gain: this.#deafened ? 0 : 1 });
			const loopback = this.#options.loopback ?? isChromium();
			this.#mode = loopback ? 'loopback' : 'direct';
			if (loopback) void this.#startLoopback(context, this.#master);
			else this.#master.connect(context.destination);
			void context.resume().then(
				() => this.#checkBlocked(),
				() => this.#checkBlocked()
			);
			context.onstatechange = () => this.#checkBlocked();
			this.#clock = { time: context.currentTime, at: performance.now() };
			this.#noteGesture();
		} catch (error) {
			this.#options.log?.(`voice: no Web Audio (${error})`);
			this.#context = null;
			this.#mode = 'elements';
		}
		this.#poll();
	}

	// Try to start playback again, from a click.
	async resume(): Promise<void> {
		this.#noteGesture();
		await this.#context?.resume().catch(() => {});
		for (const stream of this.#streams.values()) await this.#play(stream.element);
		if (this.#out) await this.#play(this.#out);
		this.#checkBlocked();
	}

	add(key: string, track: MediaStreamTrack, volume = 1, pan = 0): void {
		this.remove(key);
		const element = new Audio();
		element.autoplay = true;
		element.srcObject = new MediaStream([track]);
		const stream: Stream = {
			key,
			track,
			element,
			volume,
			pan,
			gate: new SpeakingGate(),
			speaking: false,
			nodes: null,
			energy: null
		};
		this.#streams.set(key, stream);
		this.#wire(stream);
		void this.#play(element);
	}

	remove(key: string): void {
		const stream = this.#streams.get(key);
		if (!stream) return;
		this.#streams.delete(key);
		this.#unwire(stream);
		stream.element.pause();
		stream.element.srcObject = null;
		if (stream.speaking) this.#options.onspeaking?.(key, false);
	}

	has(key: string): boolean {
		return this.#streams.has(key);
	}

	speaking(key: string): boolean {
		return this.#streams.get(key)?.speaking ?? false;
	}

	// What a voice's gain is set to, for checks: null with no graph.
	gainOf(key: string): number | null {
		return this.#streams.get(key)?.nodes?.gain.gain.value ?? null;
	}

	panOf(key: string): number | null {
		return this.#streams.get(key)?.nodes?.panner.pan.value ?? null;
	}

	setVolume(key: string, volume: number): void {
		const stream = this.#streams.get(key);
		if (!stream) return;
		stream.volume = volume;
		this.#level(stream);
	}

	setPan(key: string, pan: number): void {
		const stream = this.#streams.get(key);
		if (!stream) return;
		stream.pan = pan;
		if (stream.nodes) stream.nodes.panner.pan.value = this.#spatial ? pan : 0;
	}

	setSpatial(spatial: boolean): void {
		this.#spatial = spatial;
		for (const stream of this.#streams.values()) this.setPan(stream.key, stream.pan);
	}

	// Hear nobody. The service has stopped sending too (VoiceRoom.deafen); this
	// silences whatever is already on its way.
	setDeafened(deafened: boolean): void {
		this.#deafened = deafened;
		if (this.#master) this.#master.gain.value = deafened ? 0 : 1;
		for (const stream of this.#streams.values()) this.#level(stream);
	}

	// Play to the chosen speakers, or the default (''). False where the browser cannot.
	async setOutput(device: string | null): Promise<boolean> {
		const id = device ?? '';
		type Sinkable = { setSinkId(id: string): Promise<void> };
		const targets: Sinkable[] = [];
		if (this.#mode === 'loopback' && this.#out) targets.push(this.#out as unknown as Sinkable);
		else if (this.#mode === 'direct' && this.#context && 'setSinkId' in this.#context) {
			targets.push(this.#context as unknown as Sinkable);
		} else if (this.#mode === 'elements') {
			for (const stream of this.#streams.values()) {
				targets.push(stream.element as unknown as Sinkable);
			}
		}
		if (!targets.length || !targets.every((one) => 'setSinkId' in one)) return false;
		try {
			for (const target of targets) await target.setSinkId(id);
			return true;
		} catch (error) {
			this.#options.log?.(`voice: could not change the speakers (${error})`);
			return false;
		}
	}

	close(): void {
		this.#closed = true;
		if (this.#timer) clearInterval(this.#timer);
		if (this.#stats) clearInterval(this.#stats);
		this.#timer = this.#stats = null;
		for (const key of [...this.#streams.keys()]) this.remove(key);
		for (const connection of this.#loop) connection.close();
		this.#loop = [];
		if (this.#out) {
			this.#out.pause();
			this.#out.srcObject = null;
		}
		void this.#context?.close().catch(() => {});
		this.#context = null;
	}

	#noteGesture(): void {
		const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } })
			.userActivation;
		if (activation?.isActive !== false) this.#asked = performance.now();
	}

	async #play(element: HTMLAudioElement): Promise<void> {
		try {
			await element.play();
		} catch (error) {
			if ((error as Error).name === 'NotAllowedError') this.#blocked = true;
		}
		this.#checkBlocked();
	}

	#checkBlocked(): void {
		const contextHeld = this.#context !== null && this.#context.state === 'suspended';
		const elementHeld = [...this.#streams.values()].some(
			(stream) => this.#mode === 'elements' && stream.element.paused
		);
		const before = this.#blocked;
		this.#blocked = contextHeld || elementHeld || (this.#out?.paused ?? false);
		if (before !== this.#blocked) this.onchange?.();
	}

	#wire(stream: Stream): void {
		const context = this.#context;
		if (!context || !this.#master || this.#mode === 'elements') {
			stream.element.muted = false;
			this.#level(stream);
			return;
		}
		stream.element.muted = true;
		const source = context.createMediaStreamSource(stream.element.srcObject as MediaStream);
		const gain = new GainNode(context);
		const panner = new StereoPannerNode(context, { pan: this.#spatial ? stream.pan : 0 });
		const analyser = new AnalyserNode(context, { fftSize: 1024, smoothingTimeConstant: 0 });
		source.connect(gain).connect(panner).connect(this.#master);
		source.connect(analyser);
		stream.nodes = { source, gain, panner, analyser };
		this.#level(stream);
	}

	#unwire(stream: Stream): void {
		const nodes = stream.nodes;
		stream.nodes = null;
		if (!nodes) return;
		for (const node of Object.values(nodes)) node.disconnect();
	}

	#level(stream: Stream): void {
		if (stream.nodes) {
			stream.nodes.gain.gain.value = stream.volume;
			return;
		}
		stream.element.volume = Math.min(1, stream.volume);
		stream.element.muted = this.#deafened || stream.volume === 0;
	}

	async #startLoopback(context: AudioContext, master: GainNode): Promise<void> {
		const out = new Audio();
		out.autoplay = true;
		this.#out = out;
		try {
			const destination = context.createMediaStreamDestination();
			master.connect(destination);
			const [a, b] = [new RTCPeerConnection(), new RTCPeerConnection()];
			this.#loop = [a, b];
			a.onicecandidate = ({ candidate }) => candidate && void b.addIceCandidate(candidate);
			b.onicecandidate = ({ candidate }) => candidate && void a.addIceCandidate(candidate);
			b.ontrack = ({ track, receiver }) => {
				// Nothing on this pair crosses a network, so its jitter buffer is asked
				// to hold as little as it can (P4C.7): the default kept 30 ms more.
				for (const [name, value] of [
					['jitterBufferTarget', 0],
					['playoutDelayHint', 0]
				] as const) {
					try {
						if (name in receiver) (receiver as unknown as Record<string, number>)[name] = value;
					} catch {
						// An engine that will not take it keeps its own depth.
					}
				}
				out.srcObject = new MediaStream([track]);
				void this.#play(out);
			};
			for (const track of destination.stream.getAudioTracks())
				a.addTrack(track, destination.stream);
			const offer = await a.createOffer();
			await a.setLocalDescription({ type: 'offer', sdp: forLoopback(offer.sdp ?? '') });
			await b.setRemoteDescription({ type: 'offer', sdp: forLoopback(offer.sdp ?? '') });
			const answer = await b.createAnswer();
			await b.setLocalDescription({ type: 'answer', sdp: forLoopback(answer.sdp ?? '') });
			await a.setRemoteDescription({ type: 'answer', sdp: forLoopback(answer.sdp ?? '') });
			const connected = await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), 4000);
				b.onconnectionstatechange = () => {
					if (b.connectionState === 'connected') {
						clearTimeout(timer);
						resolve(true);
					} else if (b.connectionState === 'failed') {
						clearTimeout(timer);
						resolve(false);
					}
				};
			});
			if (!connected) throw new Error('the loopback did not connect');
		} catch (error) {
			if (this.#closed) return;
			// Play straight from the graph: no echo cancellation in Chromium, but sound.
			this.#options.log?.(`voice: playing without the loopback (${error})`);
			for (const connection of this.#loop) connection.close();
			this.#loop = [];
			this.#out = null;
			out.srcObject = null;
			if (this.#context === context) {
				master.connect(context.destination);
				this.#mode = 'direct';
				this.onchange?.();
			}
		}
	}

	// Measure everyone's level, and give up on a graph that has stopped.
	#poll(): void {
		if (this.#timer || this.#closed) return;
		const samples = new Float32Array(1024);
		this.#timer = setInterval(() => {
			const now = performance.now();
			const context = this.#context;
			if (context && this.#mode !== 'elements' && context.state === 'running') {
				if (context.currentTime !== this.#clock.time) {
					this.#clock = { time: context.currentTime, at: now };
				} else if (now - this.#clock.at > STALLED_MS && !document.hidden) {
					this.#fallBack();
					return;
				}
			} else if (
				context &&
				this.#mode !== 'elements' &&
				this.#asked !== null &&
				now - this.#asked > STALLED_MS * 2 &&
				!document.hidden
			) {
				this.#fallBack();
				return;
			}
			for (const stream of this.#streams.values()) {
				if (!stream.nodes) continue;
				stream.nodes.analyser.getFloatTimeDomainData(samples);
				this.#speak(stream, stream.gate.update(rms(samples), now));
			}
		}, POLL_MS);
		this.#stats = setInterval(() => void this.#measureStats(), STATS_MS);
	}

	async #measureStats(): Promise<void> {
		const read = this.#options.stats;
		if (!read) return;
		const now = performance.now();
		for (const stream of this.#streams.values()) {
			if (stream.nodes) continue;
			const stats = await read(stream.key).catch(() => null);
			const energy = stats?.totalAudioEnergy;
			const duration = stats?.totalSamplesDuration;
			if (energy === undefined || duration === undefined) continue;
			const before = stream.energy;
			stream.energy = { energy, duration };
			if (!before || duration <= before.duration) continue;
			const level = Math.sqrt((energy - before.energy) / (duration - before.duration));
			this.#speak(stream, stream.gate.update(level, now));
		}
	}

	#speak(stream: Stream, speaking: boolean): void {
		if (speaking === stream.speaking) return;
		stream.speaking = speaking;
		this.#options.onspeaking?.(stream.key, speaking);
	}

	// The graph stopped rendering: play each voice from its own element.
	#fallBack(): void {
		this.#options.log?.('voice: Web Audio stopped; playing each voice on its own');
		this.#mode = 'elements';
		for (const stream of this.#streams.values()) {
			this.#unwire(stream);
			stream.element.muted = false;
			this.#level(stream);
			void this.#play(stream.element);
		}
		for (const connection of this.#loop) connection.close();
		this.#loop = [];
		this.#out?.pause();
		this.#out = null;
		void this.#context?.close().catch(() => {});
		this.#context = null;
		this.#master = null;
		this.onchange?.();
	}
}

// What the loopback asks of Opus: stereo, so the panning survives it, and
// 10 ms frames in place of 20, since every millisecond a frame waits to be
// filled is added to what the listener hears (P4C.7). Nothing here leaves the
// machine, so the bitrate and the smaller frames cost no one's network.
export function forLoopback(sdp: string): string {
	const opus = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp)?.[1];
	if (!opus) return sdp;
	return sdp
		.replace(/a=(max)?ptime:\d+\r?\n/g, '')
		.replace(
			new RegExp(`a=fmtp:${opus} ([^\\r\\n]*)(\\r?\\n)`),
			(line, params: string, end: string) => {
				const kept = params
					.split(';')
					.filter((one) => !/^(stereo|sprop-stereo|maxaveragebitrate)=/.test(one.trim()));
				const fmtp = [...kept, 'stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=256000'].join(';');
				return `a=fmtp:${opus} ${fmtp}${end}a=ptime:10${end}`;
			}
		);
}

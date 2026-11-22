// The delay measure's page (`pnpm voice:measure`, P4C.7): one person in a
// table's voice room on the real service, through the site's VoiceRoom, who
// plays marks into the call and times the marks they hear from everyone else
// (marks.worklet.js), both on the audio thread against the wall clock. Two
// such pages on one machine give mouth-to-ear delay: from the block a mark is
// made in to the block it arrives in at the listener's playback graph.
//
// A page can send as the site does, through RNNoise (`denoise`), and play as
// the site does, through Playback (`site`): Chromium's loopback pair is then
// in the path, as it is at a table. `raw` sends the marks' track as it is and
// listens to each person's track as it comes out of the peer connection.
import { Denoiser } from '../../src/lib/voice/denoise.ts';
import type { Identity } from '../../src/lib/voice/group.ts';
import { Playback } from '../../src/lib/voice/playback.ts';
import { VoiceRoom, type Heard } from '../../src/lib/voice/room.ts';
import marksUrl from './marks.worklet.js?url';

export type DelayOptions = {
	url: string;
	table: string;
	token: string;
	seated: Identity[];
	// What this person sends: marks every `everyMs`, a quiet steady tone, the
	// engine's fake microphone (an engine with no Web Audio here), or recorded
	// speech played round and round (`speech`).
	source: 'marks' | 'quiet' | 'capture' | 'speech';
	// The speech: 16-bit mono PCM at 48 kHz, as base64.
	speech?: string;
	mark: 'tone' | 'voice';
	everyMs: number;
	// Send through RNNoise, as the site does by default.
	denoise: boolean;
	// Listen through the site's Playback, or to each track as it arrives.
	playback: 'raw' | 'site';
	// Make no AudioContext at all: only the statistics are read.
	webAudio: boolean;
};

export type Sent = { index: number; at: number };
export type Arrival = { leaf: number | null; at: number };

export type DelayStats = {
	leaf: number;
	packetsReceived: number;
	packetsLost: number;
	totalSamplesReceived: number;
	concealedSamples: number;
	// WebRTC's own count of how long samples waited in the jitter buffer, in
	// milliseconds a sample, and what it aims at.
	jitterBufferMs: number | null;
	jitterBufferTargetMs: number | null;
	jitterMs: number | null;
	// The counts behind it, for a figure over part of a call: seconds waited in
	// all, and samples played out.
	jitterBufferDelay: number;
	jitterBufferEmitted: number;
	// Packets whose audio came from Opus's in-band error correction, where the engine counts them.
	fecPacketsReceived: number | null;
};

export type DelayReport = {
	leaf: number | null;
	epoch: number | null;
	output: string;
	denoising: boolean;
	sent: Sent[];
	heard: Arrival[];
	// Blocks the ear has rendered: a context that stopped stops counting.
	blocks: number;
	stats: DelayStats[];
	// The round trip to the media server, from the candidate pair in use.
	roundTripMs: number | null;
	// What the browser says its own output adds after the graph.
	baseLatencyMs: number | null;
	outputLatencyMs: number | null;
};

export type DelayCheck = {
	join(options: DelayOptions): Promise<void>;
	report(): Promise<DelayReport>;
	// Forget the marks so far.
	clear(): void;
	// What this page hears of the first person it heard, for `ms`: 16-bit mono
	// PCM at 48 kHz, as base64. Null with no Web Audio.
	record(ms: number): Promise<string | null>;
	leave(): void;
};

declare global {
	interface Window {
		delay: DelayCheck;
	}
}

const log = (line: string) => {
	document.querySelector('#log')!.append(`${line}\n`);
	console.log(line);
};

let room: VoiceRoom | null = null;
let context: AudioContext | null = null;
let playback: Playback | null = null;
let denoiser: Denoiser | null = null;
let sent: Sent[] = [];
let heard: Arrival[] = [];
let blocks = 0;
const elements = new Map<string, HTMLAudioElement>();
const ears = new Map<string, AudioNode[]>();
// Each person's track in the graph, for a recording.
const sources = new Map<string, AudioNode>();

const bytesOf = (text: string): Uint8Array => {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
	return bytes;
};
const textOf = (bytes: Uint8Array): string => {
	let text = '';
	for (let at = 0; at < bytes.length; at += 0x8000) {
		text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	}
	return btoa(text);
};

// An ear on `source`: it hears, and plays nothing.
function ear(source: AudioNode, leaf: number | null): AudioNode[] {
	const node = new AudioWorkletNode(context!, 'marks-ear', {
		numberOfOutputs: 1,
		processorOptions: { threshold: 0.12, quietMs: 250 }
	});
	node.port.onmessage = ({ data }: MessageEvent<{ at?: number; blocks?: number }>) => {
		if (data.blocks !== undefined) blocks = data.blocks;
		else heard.push({ leaf, at: data.at! });
	};
	const silent = new GainNode(context!, { gain: 0 });
	source.connect(node).connect(silent).connect(context!.destination);
	return [source, node, silent];
}

async function track(options: DelayOptions): Promise<MediaStreamTrack> {
	if (options.source === 'capture') {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
		});
		return stream.getAudioTracks()[0];
	}
	const out = new MediaStreamAudioDestinationNode(context!, {
		channelCount: 1,
		channelCountMode: 'explicit'
	});
	if (options.source === 'speech') {
		const pcm = new Int16Array(bytesOf(options.speech!).buffer);
		const buffer = new AudioBuffer({ length: pcm.length, sampleRate: 48000 });
		const samples = buffer.getChannelData(0);
		for (let at = 0; at < pcm.length; at += 1) samples[at] = pcm[at] / 32768;
		const speech = new AudioBufferSourceNode(context!, { buffer, loop: true });
		speech.connect(out);
		speech.start();
	} else if (options.source === 'quiet') {
		const tone = new OscillatorNode(context!, { frequency: 330 });
		tone.connect(new GainNode(context!, { gain: 0.03 })).connect(out);
		tone.start();
	} else {
		const marks = new AudioWorkletNode(context!, 'marks-source', {
			numberOfInputs: 0,
			outputChannelCount: [1],
			processorOptions: { everyMs: options.everyMs, mark: options.mark }
		});
		marks.port.onmessage = ({ data }: MessageEvent<Sent>) => sent.push(data);
		marks.connect(out);
	}
	return out.stream.getAudioTracks()[0];
}

function hear(stream: Heard, options: DelayOptions): void {
	if (options.playback === 'site') {
		playback!.add(stream.peer, stream.track);
		return;
	}
	// Chromium feeds a remote track to Web Audio only while an element holds it.
	const media = new MediaStream([stream.track]);
	const element = new Audio();
	element.muted = true;
	element.srcObject = media;
	void element.play().catch(() => {});
	elements.set(stream.peer, element);
	if (!context) return;
	const source = context.createMediaStreamSource(media);
	sources.set(stream.peer, source);
	ears.set(stream.peer, ear(source, stream.leaf));
}

window.delay = {
	async join(options) {
		if (options.webAudio) {
			context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
			await context.resume();
			await context.audioWorklet.addModule(marksUrl);
		}
		let microphone = await track(options);
		if (options.denoise) {
			denoiser = await Denoiser.start(microphone);
			microphone = denoiser.track;
		}
		if (options.playback === 'site') {
			playback = new Playback({ log });
			playback.start();
		}
		room = await VoiceRoom.join({
			url: options.url,
			table: options.table,
			token: options.token,
			seated: options.seated,
			track: microphone,
			onheard: (stream) => hear(stream, options),
			onended: (stream) => {
				playback?.remove(stream.peer);
				elements.get(stream.peer)?.pause();
				elements.delete(stream.peer);
				for (const node of ears.get(stream.peer) ?? []) node.disconnect();
				ears.delete(stream.peer);
				sources.delete(stream.peer);
			},
			log
		});
		// The site's mix, heard where it leaves the graph: straight from the node
		// every voice ends in, or, through Chromium's loopback, from the stream
		// its audio element plays.
		if (playback && context) {
			const direct = playback.mode === 'direct' ? playback.mix : null;
			if (direct) {
				// The mix is in Playback's own context: the ear goes there too.
				await playback.context!.audioWorklet.addModule(marksUrl);
				const node = new AudioWorkletNode(playback.context!, 'marks-ear', {
					processorOptions: { threshold: 0.12, quietMs: 250 }
				});
				node.port.onmessage = ({ data }: MessageEvent<{ at?: number; blocks?: number }>) => {
					if (data.blocks !== undefined) blocks = data.blocks;
					else heard.push({ leaf: null, at: data.at! });
				};
				const silent = new GainNode(playback.context!, { gain: 0 });
				direct.connect(node).connect(silent).connect(playback.context!.destination);
			} else {
				const wait = performance.now() + 10_000;
				while (!playback.played && performance.now() < wait) {
					await new Promise((resolve) => setTimeout(resolve, 50));
				}
				if (playback.played) ear(context.createMediaStreamSource(playback.played), null);
			}
		}
		log(`joined as leaf ${room.leaf}, playing ${playback?.mode ?? 'raw'}`);
	},
	async report() {
		const now = room!;
		const stats: DelayStats[] = [];
		for (const stream of now.heard) {
			const inbound = [...(await stream.consumer.getStats()).values()].find(
				(stat) => stat.type === 'inbound-rtp'
			);
			const emitted = inbound?.jitterBufferEmittedCount ?? 0;
			stats.push({
				leaf: stream.leaf,
				packetsReceived: inbound?.packetsReceived ?? 0,
				packetsLost: inbound?.packetsLost ?? 0,
				totalSamplesReceived: inbound?.totalSamplesReceived ?? 0,
				concealedSamples: inbound?.concealedSamples ?? 0,
				jitterBufferMs: emitted ? ((inbound.jitterBufferDelay ?? 0) / emitted) * 1000 : null,
				jitterBufferTargetMs:
					emitted && typeof inbound.jitterBufferTargetDelay === 'number'
						? (inbound.jitterBufferTargetDelay / emitted) * 1000
						: null,
				jitterMs: typeof inbound?.jitter === 'number' ? inbound.jitter * 1000 : null,
				jitterBufferDelay: inbound?.jitterBufferDelay ?? 0,
				jitterBufferEmitted: emitted,
				fecPacketsReceived:
					typeof inbound?.fecPacketsReceived === 'number' ? inbound.fecPacketsReceived : null
			});
		}
		let roundTripMs: number | null = null;
		for (const transport of [now.transports.recv, now.transports.send]) {
			for (const stat of (await transport?.getStats())?.values() ?? []) {
				if (stat.type !== 'candidate-pair' || !(stat.nominated || stat.selected)) continue;
				if (typeof stat.currentRoundTripTime === 'number') {
					roundTripMs = Math.max(roundTripMs ?? 0, stat.currentRoundTripTime * 1000);
				}
			}
		}
		const output = playback?.context ?? context;
		const latency = (value: number | undefined) =>
			typeof value === 'number' ? value * 1000 : null;
		return {
			leaf: now.leaf,
			epoch: now.epoch ? Number(now.epoch.epoch) : null,
			output: playback?.mode ?? 'raw',
			denoising: denoiser !== null,
			sent: [...sent],
			heard: [...heard],
			blocks,
			stats: stats.sort((a, b) => a.leaf - b.leaf),
			roundTripMs,
			baseLatencyMs: latency(output?.baseLatency),
			outputLatencyMs: latency(output?.outputLatency)
		};
	},
	clear() {
		sent = [];
		heard = [];
	},
	async record(ms) {
		const source = [...sources.values()][0];
		if (!context || !source) return null;
		const blocks: Float32Array[] = [];
		const recorder = new AudioWorkletNode(context, 'marks-recorder', { numberOfOutputs: 0 });
		recorder.port.onmessage = ({ data }: MessageEvent<Float32Array>) => blocks.push(data);
		source.connect(recorder);
		await new Promise((resolve) => setTimeout(resolve, ms));
		source.disconnect(recorder);
		const pcm = new Int16Array(blocks.reduce((sum, one) => sum + one.length, 0));
		let at = 0;
		for (const block of blocks) {
			for (const sample of block) {
				pcm[at] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
				at += 1;
			}
		}
		return textOf(new Uint8Array(pcm.buffer));
	},
	leave() {
		room?.close();
		denoiser?.close();
		playback?.close();
	}
};

document.body.setAttribute('data-delay', 'ready');

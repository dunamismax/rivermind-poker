// The parts of voice playback and capture that need no browser (P4C.6).
import { describe, expect, it } from 'vitest';
import { constraintsFor, explainMic, problemOf } from './microphone.ts';
import { SpeakingGate, panFor, rms, stereo } from './playback.ts';
import { DEFAULTS } from './settings.ts';
import { socketUrl } from '../nl/voice.svelte.ts';

describe('the speaking ring', () => {
	it('lights as soon as a voice passes the threshold and holds between words', () => {
		const gate = new SpeakingGate(0.02, 400);
		expect(gate.update(0.001, 0)).toBe(false);
		expect(gate.update(0.05, 100)).toBe(true);
		expect(gate.update(0.001, 300)).toBe(true);
		expect(gate.update(0.001, 499)).toBe(true);
		expect(gate.update(0.001, 500)).toBe(false);
	});

	it('measures a block of samples', () => {
		expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
		expect(rms(new Float32Array(0))).toBe(0);
	});
});

describe('spatial audio', () => {
	it('puts a voice on its seat’s side, never all the way into one ear', () => {
		expect(panFor(50)).toBe(0);
		expect(panFor(0)).toBe(-0.7);
		expect(panFor(100)).toBe(0.7);
		expect(panFor(75)).toBe(0.35);
		expect(panFor(-20)).toBe(-0.7);
	});

	it('asks the loopback for stereo Opus', () => {
		const sdp = [
			'v=0',
			'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
			'a=rtpmap:111 opus/48000/2',
			'a=fmtp:111 minptime=10;useinbandfec=1;stereo=0',
			'a=rtpmap:63 red/48000/2',
			''
		].join('\r\n');
		const out = stereo(sdp);
		expect(out).toContain(
			'a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=256000\r\n'
		);
		expect(stereo('v=0\r\n')).toBe('v=0\r\n');
	});
});

describe('the microphone', () => {
	it('asks for the chosen device and processing, in mono', () => {
		expect(constraintsFor(DEFAULTS)).toEqual({
			channelCount: { ideal: 1 },
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: true
		});
		expect(constraintsFor({ ...DEFAULTS, input: 'usb', echoCancellation: false })).toMatchObject({
			deviceId: { ideal: 'usb' },
			echoCancellation: false
		});
	});

	it('explains each refusal in plain words, leaving the person listening', () => {
		const named = (name: string) => Object.assign(new Error(name), { name });
		expect(problemOf(named('NotAllowedError'))).toBe('denied');
		expect(problemOf(named('NotFoundError'))).toBe('no-device');
		expect(problemOf(named('NotReadableError'))).toBe('busy');
		expect(problemOf(named('SecurityError'))).toBe('insecure');
		expect(problemOf(named('NotSupportedError'))).toBe('unsupported');
		expect(problemOf(null)).toBe('failed');
		expect(explainMic('denied')).toMatch(/allow the microphone/);
		for (const problem of ['denied', 'no-device', 'busy', 'failed'] as const) {
			expect(explainMic(problem)).toMatch(/listen/);
		}
	});
});

describe('the voice service’s address', () => {
	it('is the page’s own origin, over wss for an https page', () => {
		expect(
			socketUrl('/voice', { protocol: 'https:', host: 'rivermindpoker.com' } as Location)
		).toBe('wss://rivermindpoker.com/voice');
		expect(socketUrl('/voice', { protocol: 'http:', host: '127.0.0.1:8800' } as Location)).toBe(
			'ws://127.0.0.1:8800/voice'
		);
	});
});

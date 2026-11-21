// What the encoded-transform worker does to each frame (sframe.worker.ts), kept
// apart from the worker so Vitest can run it: a frame leaving is sealed or
// dropped, a frame arriving is opened or dropped, and every one is counted.
// Nothing here passes a frame on as it came: the only way through is the key
// store (sframe.ts).
import type { KeyStore, Refusal } from './sframe.ts';

// What the page tells the worker. An epoch number crosses as a bigint and its
// base key as a non-extractable CryptoKey; both survive a structured clone.
export type KeyMessage =
	| { type: 'epoch'; epoch: bigint; baseKey: CryptoKey }
	| { type: 'send'; sender: number; epoch: bigint }
	| { type: 'retire'; epoch: bigint }
	| { type: 'hold'; held: boolean }
	| { type: 'tallies'; id: number };

// What the worker tells the page: the tallies it asked for, or that the key
// store would not do what a message asked (an epoch older than the last, say).
export type WorkerMessage =
	| { type: 'tallies'; id: number; tallies: Tally[] }
	| { type: 'refused'; asked: KeyMessage['type']; error: string };

// The options a page gives `RTCRtpScriptTransform`. `id` names the transform in
// the tallies; `from` is the leaf a receiver's stream belongs to.
export type TransformOptions =
	{ id: string; direction: 'encrypt' } | { id: string; direction: 'decrypt'; from: number | null };

export type Tally = {
	id: string;
	direction: 'encrypt' | 'decrypt';
	// Frames sealed or opened and passed on, and the bytes they held before that.
	frames: number;
	bytes: number;
	// Frames dropped: `unsent` on the way out, for want of a key to send under.
	unsent: number;
	refused: Record<Refusal, number>;
	// Frames opened only after waiting for their epoch's key to arrive.
	waited: number;
	// Frames that arrived with no bytes at all, dropped unread. Firefox hands a
	// receiver the padding packets its peer probes the connection with as a
	// direct call starts; they hold nothing to open and nothing to play.
	empty: number;
	// Time spent sealing or opening, in milliseconds: all of it, and the slowest frame.
	ms: number;
	slowestMs: number;
};

export function newTally(id: string, direction: Tally['direction']): Tally {
	return {
		id,
		direction,
		frames: 0,
		bytes: 0,
		unsent: 0,
		refused: {
			malformed: 0,
			'unknown-key': 0,
			'stale-epoch': 0,
			'wrong-sender': 0,
			tampered: 0,
			replayed: 0
		},
		waited: 0,
		empty: 0,
		ms: 0,
		slowestMs: 0
	};
}

// An RTCEncodedAudioFrame, as far as this file touches it.
export type EncodedFrame = { data: ArrayBuffer };

function timed(tally: Tally, started: number): void {
	const took = performance.now() - started;
	tally.ms += took;
	if (took > tally.slowestMs) tally.slowestMs = took;
}

// Seals each frame a sender encodes. Without a key to send under the frame is
// dropped: no frame leaves this page unencrypted.
export function encryptor(store: KeyStore, tally: Tally): Transformer<EncodedFrame, EncodedFrame> {
	return {
		async transform(frame, controller) {
			const started = performance.now();
			const size = frame.data.byteLength;
			const sealed = await store.seal(frame.data);
			timed(tally, started);
			if (!sealed) {
				tally.unsent += 1;
				return;
			}
			tally.frames += 1;
			tally.bytes += size;
			frame.data = sealed.buffer;
			controller.enqueue(frame);
		}
	};
}

// How long a receiver waits for the key of a frame from an epoch it has not
// been given. When someone joins or leaves, every page moves to the new epoch
// within a few milliseconds of the others but not at the same instant, and a
// speaker who got there first is, for that moment, ahead of its listeners.
export const KEY_WAIT_MS = 250;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Opens each frame a receiver is handed. One that does not open is dropped
// and never reaches the decoder, which then conceals it as it would a lost packet.
//
// A frame under a key id this page does not hold waits up to `waitMs` for the
// next epoch to arrive and is then tried once more. The stream's later frames
// queue behind it in order, so a late key costs a pause the jitter buffer
// absorbs and no frame. A stream waits once for each epoch the page is given:
// frames nobody will ever send a key for are not waited on twice.
export function decryptor(
	store: KeyStore,
	tally: Tally,
	from: number | null,
	waitMs: number = KEY_WAIT_MS
): Transformer<EncodedFrame, EncodedFrame> {
	// The count of epochs at which this stream last waited in vain, or tried again in vain.
	let gaveUpAt = -1;
	return {
		async transform(frame, controller) {
			if (frame.data.byteLength === 0) {
				tally.empty += 1;
				return;
			}
			const started = performance.now();
			const bytes = new Uint8Array(frame.data);
			let opened = await store.open(bytes, from ?? undefined);
			if (!opened.ok && opened.refusal === 'unknown-key' && gaveUpAt !== store.added) {
				const arrived = await Promise.race([
					store.nextAdded().then(() => true),
					sleep(waitMs).then(() => false)
				]);
				if (arrived) opened = await store.open(bytes, from ?? undefined);
				if (!opened.ok) gaveUpAt = store.added;
				else tally.waited += 1;
			}
			timed(tally, started);
			if (!opened.ok) {
				tally.refused[opened.refusal] += 1;
				return;
			}
			tally.frames += 1;
			tally.bytes += opened.data.byteLength;
			frame.data = opened.data;
			controller.enqueue(frame);
		}
	};
}

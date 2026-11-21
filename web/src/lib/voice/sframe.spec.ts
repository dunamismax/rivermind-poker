// SFrame against RFC 9605 (P4C.2): appendix C's vectors byte for byte, then
// what the key store must refuse: a tampered header or frame, a replayed
// counter, an unknown key id and a retired epoch. Each is refused, counted and
// never passed on to the decoder. voice/check runs the vectors and the worker
// in each browser.
import { describe, expect, it } from 'vitest';
import {
	KeyStore,
	LAYOUT,
	REPLAY_WINDOW,
	TAG_BYTES,
	decodeHeader,
	deriveFrameKey,
	encodeHeader,
	importBaseKey,
	kidOf,
	partsOf,
	type Bytes,
	type Refusal
} from './sframe.ts';
import {
	decryptor,
	encryptor,
	newTally,
	type EncodedFrame,
	type Tally
} from './sframe-transform.ts';
import { checkVectors, hex, unhex } from './sframe-vectors.ts';

const text = new TextEncoder();
const baseKey = (secret: string) => importBaseKey(text.encode(secret.padEnd(16, '.')));
const frame = (words: string) => text.encode(words);
const said = (data: ArrayBuffer) => new TextDecoder().decode(data);

// Two members of one group: a sender at a leaf, and a listener.
async function pair(sender = 3, epoch = 5n) {
	const key = await baseKey('epoch five');
	const speaker = new KeyStore();
	speaker.add(epoch, key);
	speaker.sendAs(sender, epoch);
	const listener = new KeyStore();
	listener.add(epoch, key);
	return { speaker, listener, key };
}

const sealed = async (store: KeyStore, words: string): Promise<Bytes> =>
	(await store.seal(frame(words)))!;

const refusal = async (store: KeyStore, data: Uint8Array, from?: number) => {
	const opened = await store.open(data, from);
	return opened.ok ? 'opened' : opened.refusal;
};

describe("RFC 9605's test vectors", () => {
	it('reproduces every header vector and the 0x0004 SFrame vector', async () => {
		const check = await checkVectors();
		expect(check.failures).toEqual([]);
		expect(check).toMatchObject({ headers: 289, frames: 1, otherSuites: 7 });
	});

	it('notices a vector that does not hold', async () => {
		// The check itself is checked: a header it did not write is not the vector's.
		expect(hex(encodeHeader(0x123n, 0x4567n))).toBe('9901234567');
		expect(hex(encodeHeader(0x123n, 0x4568n))).not.toBe('9901234567');
	});
});

describe('the header', () => {
	it('carries small values in the config byte and larger ones after it', () => {
		expect(hex(encodeHeader(0n, 0n))).toBe('00');
		expect(hex(encodeHeader(7n, 7n))).toBe('77');
		expect(hex(encodeHeader(8n, 7n))).toBe('8708');
		expect(hex(encodeHeader(7n, 8n))).toBe('7808');
		expect(hex(encodeHeader(0xffffn, 0x100n))).toBe('99ffff0100');
		expect(decodeHeader(unhex('99ffff0100aabb'))).toEqual({ kid: 0xffffn, ctr: 0x100n, length: 5 });
	});

	it('refuses values that are not 64-bit unsigned integers', () => {
		expect(() => encodeHeader(-1n, 0n)).toThrow(RangeError);
		expect(() => encodeHeader(0n, 1n << 64n)).toThrow(RangeError);
	});

	it('reads no header from too few bytes or a value written longer than it needs', () => {
		expect(decodeHeader(new Uint8Array())).toBeNull();
		// A two-byte key id announced, one byte there.
		expect(decodeHeader(unhex('9001'))).toBeNull();
		// 5 and 0x09 each fit in fewer bytes than they were given.
		expect(decodeHeader(unhex('8005'))).toBeNull();
		expect(decodeHeader(unhex('900009'))).toBeNull();
		expect(decodeHeader(unhex('0805'))).toBeNull();
		expect(decodeHeader(unhex('090009'))).toBeNull();
	});
});

describe('key ids from an MLS sender and epoch', () => {
	it("gives the RFC's figure 9 key ids (E=4, S=6)", () => {
		expect(LAYOUT).toEqual({ epochBits: 4, senderBits: 6 });
		expect(kidOf(LAYOUT, 3, 14n)).toBe(0x3en);
		expect(kidOf(LAYOUT, 7, 14n)).toBe(0x7en);
		expect(kidOf(LAYOUT, 20, 14n)).toBe(0x14en);
		expect(kidOf(LAYOUT, 3, 15n)).toBe(0x3fn);
		expect(kidOf(LAYOUT, 5, 15n)).toBe(0x5fn);
		expect(kidOf(LAYOUT, 33, 17n)).toBe(0x211n);
		expect(kidOf(LAYOUT, 51, 17n)).toBe(0x331n);
		expect(partsOf(LAYOUT, 0x331n)).toEqual({ sender: 51, slot: 1 });
		// The figure's key ids with a context: nobody here sends one.
		expect(partsOf(LAYOUT, 0x820n)).toBeNull();
		expect(partsOf(LAYOUT, 0xc20n)).toBeNull();
	});

	it('has no key id for a leaf beyond the layout', () => {
		expect(() => kidOf(LAYOUT, 64, 0n)).toThrow(RangeError);
		expect(() => kidOf(LAYOUT, -1, 0n)).toThrow(RangeError);
		expect(() => kidOf(LAYOUT, 1.5, 0n)).toThrow(RangeError);
	});
});

describe('keys', () => {
	it('cannot be read back out of WebCrypto, and seal or open but never both', async () => {
		const key = await baseKey('secret');
		expect(key.extractable).toBe(false);
		await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();

		const sealing = await deriveFrameKey(key, 0x35n, 'encrypt');
		const opening = await deriveFrameKey(key, 0x35n, 'decrypt');
		expect(sealing.key.extractable).toBe(false);
		expect(opening.key.extractable).toBe(false);
		expect(sealing.key.usages).toEqual(['encrypt']);
		expect(opening.key.usages).toEqual(['decrypt']);
		await expect(crypto.subtle.exportKey('raw', sealing.key)).rejects.toThrow();
		const iv = new Uint8Array(12);
		await expect(
			crypto.subtle.encrypt({ name: 'AES-GCM', iv }, opening.key, new Uint8Array(4))
		).rejects.toThrow();
	});

	it('are refused by a key store when they could be read back out', async () => {
		const readable = await crypto.subtle.importKey('raw', new Uint8Array(16), 'HKDF', false, [
			'deriveBits'
		]);
		// WebCrypto never lets an HKDF key be extractable, so the guard is shown on a stand-in.
		const store = new KeyStore();
		expect(() => store.add(1n, { ...readable, extractable: true } as CryptoKey)).toThrow(TypeError);
		expect(store.epochs).toEqual([]);
	});
});

describe('a frame between two members', () => {
	it('is sealed by one and opened by the other, under the sender and epoch it names', async () => {
		const { speaker, listener } = await pair(3, 5n);
		const first = await sealed(speaker, 'first frame');
		const second = await sealed(speaker, 'second frame');

		// Key id 0x35 (leaf 3, epoch 5) and counters 0 and 1, then the frame and a 16-byte tag.
		expect(decodeHeader(first)).toEqual({ kid: 0x35n, ctr: 0n, length: 2 });
		expect(decodeHeader(second)).toEqual({ kid: 0x35n, ctr: 1n, length: 2 });
		expect(first.length).toBe(2 + 'first frame'.length + TAG_BYTES);
		expect(hex(first)).not.toContain(hex(frame('first frame')));

		const opened = await listener.open(first, 3);
		expect(opened).toMatchObject({ ok: true, sender: 3, epoch: 5n });
		expect(opened.ok && said(opened.data)).toBe('first frame');
		const next = await listener.open(second);
		expect(next.ok && said(next.data)).toBe('second frame');
	});

	it('seals an empty frame, and opens it', async () => {
		const { speaker, listener } = await pair();
		const empty = (await speaker.seal(new Uint8Array()))!;
		expect(empty.length).toBe(2 + TAG_BYTES);
		const opened = await listener.open(empty);
		expect(opened.ok && opened.data.byteLength).toBe(0);
	});

	it('never repeats a counter, however the frames overlap', async () => {
		const { speaker } = await pair();
		const frames = await Promise.all(
			Array.from({ length: 300 }, (_, n) => sealed(speaker, `frame ${n}`))
		);
		const counters = frames.map((one) => decodeHeader(one)!.ctr);
		expect(new Set(counters).size).toBe(300);
		expect(counters).toEqual(Array.from({ length: 300 }, (_, n) => BigInt(n)));
	});
});

describe('a frame that is refused', () => {
	it('with a tampered header', async () => {
		const { speaker, listener } = await pair();
		for (let n = 0; n < 9; n++) await sealed(speaker, 'earlier');
		const good = await sealed(speaker, 'hello');
		expect(decodeHeader(good)).toEqual({ kid: 0x35n, ctr: 9n, length: 3 });

		// Another counter: the nonce and the authenticated header both change.
		const counter = new Uint8Array(good);
		counter[2] ^= 0x01;
		expect(await refusal(listener, counter)).toBe('tampered');
		// Another member's key id in the same epoch: a different key.
		const sender = new Uint8Array(good);
		sender[1] = 0x45;
		expect(await refusal(listener, sender)).toBe('tampered');
		// The same key id and counter written another way are not the header that was sealed.
		const padded = new Uint8Array([0x99, 0x00, 0x35, 0x00, 0x09, ...good.subarray(3)]);
		expect(await refusal(listener, padded)).toBe('malformed');

		expect(await refusal(listener, good)).toBe('opened');
	});

	it('with a tampered frame or tag, or cut short', async () => {
		const { speaker, listener } = await pair();
		const good = await sealed(speaker, 'hello');
		for (const at of [2, 4, good.length - TAG_BYTES, good.length - 1]) {
			const bad = new Uint8Array(good);
			bad[at] ^= 0x80;
			expect(await refusal(listener, bad), `byte ${at}`).toBe('tampered');
		}
		expect(await refusal(listener, good.subarray(0, good.length - 1))).toBe('tampered');
		// Shorter than a header and a tag: not an SFrame ciphertext at all.
		expect(await refusal(listener, good.subarray(0, TAG_BYTES + 1))).toBe('malformed');
		expect(await refusal(listener, new Uint8Array())).toBe('malformed');
		// A plain Opus frame, as a sender with no transform would send it.
		expect(await refusal(listener, new Uint8Array(160).fill(0xfc))).not.toBe('opened');

		expect(await refusal(listener, good)).toBe('opened');
	});

	it('sealed under another secret', async () => {
		const { speaker } = await pair();
		const outsider = new KeyStore();
		outsider.add(5n, await baseKey('not the group'));
		expect(await refusal(outsider, await sealed(speaker, 'hello'))).toBe('tampered');
	});

	it('with a replayed counter', async () => {
		const { speaker, listener } = await pair();
		const frames: Bytes[] = [];
		for (let n = 0; n < REPLAY_WINDOW + 40; n++) frames.push(await sealed(speaker, `frame ${n}`));

		expect(await refusal(listener, frames[0])).toBe('opened');
		expect(await refusal(listener, frames[0])).toBe('replayed');
		// Late but inside the window: opened once, in any order.
		expect(await refusal(listener, frames[10])).toBe('opened');
		expect(await refusal(listener, frames[7])).toBe('opened');
		expect(await refusal(listener, frames[7])).toBe('replayed');
		expect(await refusal(listener, frames[10])).toBe('replayed');
		// A jump ahead leaves the window behind: what fell out of it is refused unseen.
		expect(await refusal(listener, frames[REPLAY_WINDOW + 20])).toBe('opened');
		expect(await refusal(listener, frames[5])).toBe('replayed');
		expect(await refusal(listener, frames[20])).toBe('replayed');
		expect(await refusal(listener, frames[21])).toBe('opened');
		expect(await refusal(listener, frames[REPLAY_WINDOW + 20])).toBe('replayed');
		expect(await refusal(listener, frames[REPLAY_WINDOW + 39])).toBe('opened');
	});

	it('when two copies arrive at once: one is opened', async () => {
		const { speaker, listener } = await pair();
		const good = await sealed(speaker, 'hello');
		const both = await Promise.all([refusal(listener, good), refusal(listener, good)]);
		expect(both.sort()).toEqual(['opened', 'replayed']);
	});

	it('does not count a counter it could not authenticate', async () => {
		const { speaker, listener } = await pair();
		const good = await sealed(speaker, 'hello');
		const bad = new Uint8Array(good);
		bad[bad.length - 1] ^= 1;
		expect(await refusal(listener, bad)).toBe('tampered');
		expect(await refusal(listener, good)).toBe('opened');
	});

	it('with an unknown key id', async () => {
		const { speaker, listener, key } = await pair(3, 5n);
		// An epoch this page was never given.
		const ahead = new KeyStore();
		ahead.add(6n, key);
		ahead.sendAs(3, 6n);
		expect(await refusal(listener, await sealed(ahead, 'from epoch six'))).toBe('unknown-key');
		// A key id with a context above the sender's bits.
		const withContext = new Uint8Array([0x90, 0x08, 0x35, ...new Uint8Array(20)]);
		expect(decodeHeader(withContext)?.kid).toBe(0x835n);
		expect(await refusal(listener, withContext)).toBe('unknown-key');
		// A page with no key at all.
		expect(await refusal(new KeyStore(), await sealed(speaker, 'hello'))).toBe('unknown-key');
	});

	it('from a stale epoch', async () => {
		const { speaker, listener } = await pair(3, 5n);
		const before = await sealed(speaker, 'before');
		const late = await sealed(speaker, 'late');
		expect(await refusal(listener, before)).toBe('opened');

		const next = await baseKey('epoch six');
		listener.add(6n, next);
		// The grace window: the old epoch still opens while both are held.
		expect(listener.epochs).toEqual([5n, 6n]);
		listener.retire(5n);
		expect(listener.epochs).toEqual([6n]);
		expect(await refusal(listener, late)).toBe('stale-epoch');

		// A sender whose epoch was retired sends nothing until it is given another.
		speaker.add(6n, next);
		speaker.retire(5n);
		expect(speaker.sending).toBeNull();
		expect(await speaker.seal(frame('unsent'))).toBeNull();
		speaker.sendAs(3, 6n);
		expect(await refusal(listener, await sealed(speaker, 'after'))).toBe('opened');
	});

	it('from an epoch whose low bits a newer one has taken (RFC 9605, 5.2)', async () => {
		const { speaker, listener } = await pair(3, 5n);
		const old = await sealed(speaker, 'old');
		// Epoch 21 has epoch 5's low four bits: 5 is removed when 21 arrives.
		listener.add(21n, await baseKey('epoch twenty-one'));
		expect(listener.epochs).toEqual([21n]);
		expect(await refusal(listener, old)).toBe('tampered');
		// The sender too stops using a key its group has moved past.
		speaker.add(21n, await baseKey('epoch twenty-one'));
		expect(await speaker.seal(frame('unsent'))).toBeNull();
	});

	it('from the wrong sender', async () => {
		const { speaker, listener } = await pair(3, 5n);
		// It arrived on leaf 4's stream: the server routed it there.
		expect(await refusal(listener, await sealed(speaker, 'hello'), 4)).toBe('wrong-sender');
		// A frame sealed as this page's own leaf is nobody else's to send.
		listener.sendAs(4, 5n);
		const impostor = new KeyStore();
		impostor.add(5n, await baseKey('epoch five'));
		impostor.sendAs(4, 5n);
		expect(await refusal(listener, await sealed(impostor, 'as you'))).toBe('wrong-sender');
		expect(await refusal(listener, await sealed(speaker, 'hello'), 3)).toBe('opened');
	});
});

describe('the key store', () => {
	it('sends nothing without an epoch to send under', async () => {
		const store = new KeyStore();
		expect(await store.seal(frame('hello'))).toBeNull();
		store.add(1n, await baseKey('one'));
		expect(await store.seal(frame('hello'))).toBeNull();
		expect(() => store.sendAs(0, 2n)).toThrow(RangeError);
		expect(store.sending).toBeNull();
	});

	it('takes each epoch once, in order', async () => {
		const store = new KeyStore();
		const again = await baseKey('again');
		store.add(4n, await baseKey('four'));
		expect(() => store.add(4n, again)).toThrow(RangeError);
		expect(() => store.add(3n, again)).toThrow(RangeError);
		store.add(9n, await baseKey('nine'));
		expect(store.epochs).toEqual([4n, 9n]);
		// Retiring an epoch it does not hold changes nothing.
		store.retire(7n);
		expect(store.epochs).toEqual([4n, 9n]);
	});

	it('never restarts a counter or goes back an epoch', async () => {
		const { speaker, key } = await pair(3, 5n);
		await sealed(speaker, 'zero');
		speaker.sendAs(3, 5n);
		expect(decodeHeader(await sealed(speaker, 'one'))?.ctr).toBe(1n);

		speaker.add(6n, key);
		speaker.sendAs(3, 6n);
		expect(decodeHeader(await sealed(speaker, 'new epoch'))).toMatchObject({ kid: 0x36n, ctr: 0n });
		expect(() => speaker.sendAs(3, 5n)).toThrow(RangeError);
		expect(speaker.sending).toEqual({ sender: 3, epoch: 6n });

		// With the newer epoch retired and nothing to send under, the older one,
		// still held and already sent under from counter 0, is not taken up again.
		speaker.retire(6n);
		expect(speaker.sending).toBeNull();
		expect(speaker.epochs).toEqual([5n]);
		expect(() => speaker.sendAs(3, 5n)).toThrow(RangeError);
		expect(() => speaker.sendAs(4, 5n)).toThrow(RangeError);
		expect(await speaker.seal(frame('unsent'))).toBeNull();
	});

	it('will not send as a leaf it has opened frames from', async () => {
		const { speaker, listener } = await pair(3, 5n);
		expect(await refusal(listener, await sealed(speaker, 'hello'))).toBe('opened');
		expect(() => listener.sendAs(3, 5n)).toThrow(RangeError);
	});
});

describe('the transform a worker runs', () => {
	// Frames through real streams, as `RTCRtpScriptTransform` hands them over.
	async function through(
		step: Transformer<EncodedFrame, EncodedFrame>,
		frames: Uint8Array[]
	): Promise<Bytes[]> {
		const stream = new TransformStream(step);
		const out: Bytes[] = [];
		const reading = stream.readable.pipeTo(
			new WritableStream({ write: (one) => void out.push(new Uint8Array(one.data)) })
		);
		const writer = stream.writable.getWriter();
		for (const one of frames) await writer.write({ data: new Uint8Array(one).buffer });
		await writer.close();
		await reading;
		return out;
	}

	const refused = (tally: Tally) =>
		Object.fromEntries(Object.entries(tally.refused).filter(([, count]) => count > 0));

	it('seals what leaves and opens what arrives, counting both', async () => {
		const { speaker, listener } = await pair(3, 5n);
		const sent = newTally('send', 'encrypt');
		const heard = newTally('recv', 'decrypt');
		const words = ['one', 'two', 'three'].map(frame);
		const wire = await through(encryptor(speaker, sent), words);
		expect(wire.map((one) => decodeHeader(one)?.ctr)).toEqual([0n, 1n, 2n]);
		const played = await through(decryptor(listener, heard, 3), wire);

		expect(played.map((one) => said(one.buffer))).toEqual(['one', 'two', 'three']);
		expect(sent).toMatchObject({ frames: 3, bytes: 11, unsent: 0 });
		expect(heard).toMatchObject({ frames: 3, bytes: 11 });
		expect(refused(heard)).toEqual({});
		expect(sent.ms).toBeGreaterThan(0);
		expect(heard.slowestMs).toBeGreaterThan(0);
	});

	it('drops a frame it has no key to send under', async () => {
		const store = new KeyStore();
		const sent = newTally('send', 'encrypt');
		expect(await through(encryptor(store, sent), [frame('in the clear?')])).toEqual([]);
		expect(sent).toMatchObject({ frames: 0, bytes: 0, unsent: 1 });
	});

	it('plays none of the frames it refuses, and counts each kind', async () => {
		const { speaker, key } = await pair(3, 5n);
		const good = await sealed(speaker, 'good');
		const replayed = good;
		const tampered = new Uint8Array(await sealed(speaker, 'tampered'));
		tampered[tampered.length - 1] ^= 1;
		const other = new KeyStore();
		other.add(6n, key);
		other.sendAs(3, 6n);
		const unknown = await sealed(other, 'unknown epoch');
		const elsewhere = new KeyStore();
		elsewhere.add(5n, key);
		elsewhere.sendAs(4, 5n);
		const wrongSender = await sealed(elsewhere, 'another leaf');
		const stale = new KeyStore();
		stale.add(4n, key);
		stale.sendAs(3, 4n);
		const old = await sealed(stale, 'retired epoch');

		// A listener that held epochs 4 and 5 and has retired 4.
		const listener = new KeyStore();
		listener.add(4n, key);
		listener.add(5n, key);
		listener.retire(4n);
		const heard = newTally('recv', 'decrypt');
		const played = await through(decryptor(listener, heard, 3), [
			good,
			replayed,
			tampered,
			unknown,
			wrongSender,
			old,
			new Uint8Array(3),
			// Padding, as Firefox hands it to a receiver: no bytes, so not a frame at all.
			new Uint8Array(),
			new Uint8Array()
		]);

		expect(played.map((one) => said(one.buffer))).toEqual(['good']);
		expect(heard.frames).toBe(1);
		expect(heard.empty).toBe(2);
		const expected: Record<Refusal, number> = {
			malformed: 1,
			'unknown-key': 1,
			'stale-epoch': 1,
			'wrong-sender': 1,
			tampered: 1,
			replayed: 1
		};
		expect(heard.refused).toEqual(expected);
	});
});

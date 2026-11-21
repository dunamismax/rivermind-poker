// SFrame (RFC 9605) for table voice: every Opus frame is encrypted in the
// sender's browser and opened only in a listener's, under keys the voice
// server never holds (docs/voice.md, D-15).
//
// The cipher suite is AES_128_GCM_SHA256_128 (0x0004), over WebCrypto. The
// first half of this file is the RFC itself: the header (4.3), the key and salt
// (4.4.2), the nonce and the sealed frame (4.4.3, 4.4.4), and a key id made of
// an MLS sender and epoch (5.2). sframe.spec.ts holds it to appendix C's
// vectors byte for byte. The second half, `KeyStore`, is what the RFC leaves
// to the application (section 9): which key ids a page may send and open
// with, counters that never repeat, and refusing replays and retired epochs.
//
// No `$lib` imports and nothing but erasable TypeScript: the worker, the pages
// and Node's own test runs all load this file as it is.

export const CIPHER_SUITE = 0x0004;
// AEAD.Nk, AEAD.Nn and AEAD.Nt of RFC 9605's table 1, in bytes.
export const KEY_BYTES = 16;
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

const MAX_U64 = (1n << 64n) - 1n;
const text = new TextEncoder();

export type Bytes = Uint8Array<ArrayBuffer>;
export type Header = { kid: bigint; ctr: bigint; length: number };

// How many bytes a value of 8 or more takes, written with no leading zero.
function sizeOf(value: bigint): number {
	let bytes = 1;
	while (value >> BigInt(8 * bytes)) bytes += 1;
	return bytes;
}

function write(out: Uint8Array, at: number, bytes: number, value: bigint): void {
	for (let n = bytes - 1; n >= 0; n--) {
		out[at + n] = Number(value & 0xffn);
		value >>= 8n;
	}
}

function read(data: Uint8Array, at: number, bytes: number): bigint {
	let value = 0n;
	for (let n = 0; n < bytes; n++) value = (value << 8n) | BigInt(data[at + n]);
	return value;
}

// Section 4.3: a config byte, then the key id and the counter. A value under 8
// sits in the config byte itself; a larger one follows it in as few bytes as
// hold it, and the config byte carries that length less one.
export function encodeHeader(kid: bigint, ctr: bigint): Bytes {
	if (kid < 0n || kid > MAX_U64 || ctr < 0n || ctr > MAX_U64) {
		throw new RangeError('an SFrame key id and counter are 64-bit unsigned integers');
	}
	const kidBytes = kid < 8n ? 0 : sizeOf(kid);
	const ctrBytes = ctr < 8n ? 0 : sizeOf(ctr);
	const header = new Uint8Array(1 + kidBytes + ctrBytes);
	const k = kidBytes ? 0x80 | ((kidBytes - 1) << 4) : Number(kid) << 4;
	const c = ctrBytes ? 0x08 | (ctrBytes - 1) : Number(ctr);
	header[0] = k | c;
	write(header, 1, kidBytes, kid);
	write(header, 1 + kidBytes, ctrBytes, ctr);
	return header;
}

// The header at the start of `data`, or null where there is none: too few
// bytes, or a value written in more bytes than it needs, which the RFC forbids
// and no sender here produces.
export function decodeHeader(data: Uint8Array): Header | null {
	if (data.length < 1) return null;
	const config = data[0];
	const kidBytes = config & 0x80 ? ((config >> 4) & 7) + 1 : 0;
	const ctrBytes = config & 0x08 ? (config & 7) + 1 : 0;
	const length = 1 + kidBytes + ctrBytes;
	if (data.length < length) return null;
	const kid = kidBytes ? read(data, 1, kidBytes) : BigInt((config >> 4) & 7);
	const ctr = ctrBytes ? read(data, 1 + kidBytes, ctrBytes) : BigInt(config & 7);
	if (kidBytes && (kid < 8n || data[1] === 0)) return null;
	if (ctrBytes && (ctr < 8n || data[1 + kidBytes] === 0)) return null;
	return { kid, ctr, length };
}

// Section 4.4.2's labels: the text, the key id as eight bytes and the cipher
// suite as two, all big endian.
export function label(what: 'key' | 'salt', kid: bigint): Bytes {
	const prefix = text.encode(`SFrame 1.0 Secret ${what} `);
	const out = new Uint8Array(prefix.length + 10);
	out.set(prefix);
	write(out, prefix.length, 8, kid);
	write(out, prefix.length + 8, 2, BigInt(CIPHER_SUITE));
	return out;
}

// A base key as WebCrypto holds it for HKDF. It cannot be read back out: a
// page turns each epoch's secret into one of these and forgets the bytes.
export function importBaseKey(baseKey: BufferSource): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', baseKey, 'HKDF', false, ['deriveKey', 'deriveBits']);
}

// HKDF-Expand(HKDF-Extract("", base_key), info, …) in one WebCrypto step. An
// empty salt and a hash-length run of zeros are the same HMAC key (RFC 5869
// section 2.2); the zeros are written out because not every engine has always
// taken an empty one.
export function hkdf(info: Bytes): HkdfParams {
	return { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info };
}

// One key id's key and salt (section 4.4.2). The AES key is made inside
// WebCrypto, never as bytes, and for one direction only: the RFC requires a key
// to be marked for sealing or for opening, never both, and WebCrypto then
// enforces it.
export type FrameKey = { kid: bigint; key: CryptoKey; salt: Bytes };

export async function deriveFrameKey(
	baseKey: CryptoKey,
	kid: bigint,
	use: 'encrypt' | 'decrypt'
): Promise<FrameKey> {
	const [key, salt] = await Promise.all([
		crypto.subtle.deriveKey(
			hkdf(label('key', kid)),
			baseKey,
			{ name: 'AES-GCM', length: 8 * KEY_BYTES },
			false,
			[use]
		),
		crypto.subtle.deriveBits(hkdf(label('salt', kid)), baseKey, 8 * NONCE_BYTES)
	]);
	return { kid, key, salt: new Uint8Array(salt) };
}

// Section 4.4.3: the salt with the counter, as a big-endian integer of the
// nonce's length, XORed into it. A counter is 64 bits, so only the last eight
// bytes change.
export function nonceFor(salt: Bytes, ctr: bigint): Bytes {
	const nonce = new Uint8Array(salt);
	const view = new DataView(nonce.buffer);
	view.setBigUint64(NONCE_BYTES - 8, view.getBigUint64(NONCE_BYTES - 8) ^ ctr);
	return nonce;
}

// What the AEAD authenticates beside the frame: the header, then whatever
// metadata the application adds. Table voice adds none.
function aadOf(header: Uint8Array, metadata: Uint8Array | undefined): Bytes {
	if (!metadata?.length) return new Uint8Array(header);
	const aad = new Uint8Array(header.length + metadata.length);
	aad.set(header);
	aad.set(metadata, header.length);
	return aad;
}

// An SFrame ciphertext: the header, the encrypted frame and the tag.
export async function seal(
	key: FrameKey,
	ctr: bigint,
	plaintext: BufferSource,
	metadata?: Uint8Array
): Promise<Bytes> {
	const header = encodeHeader(key.kid, ctr);
	const sealed = await crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv: nonceFor(key.salt, ctr),
			additionalData: aadOf(header, metadata),
			tagLength: 8 * TAG_BYTES
		},
		key.key,
		plaintext
	);
	const out = new Uint8Array(header.length + sealed.byteLength);
	out.set(header);
	out.set(new Uint8Array(sealed), header.length);
	return out;
}

// The frame inside an SFrame ciphertext whose header has been read. It rejects
// when the key, the header, the frame or the tag is not what was sealed.
export function open(
	key: FrameKey,
	header: Header,
	ciphertext: Uint8Array,
	metadata?: Uint8Array
): Promise<ArrayBuffer> {
	return crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv: nonceFor(key.salt, header.ctr),
			additionalData: aadOf(ciphertext.subarray(0, header.length), metadata),
			tagLength: 8 * TAG_BYTES
		},
		key.key,
		ciphertext.subarray(header.length) as Bytes
	);
}

// Section 5.2: a key id names its sender and epoch. The low `epochBits` bits
// (the RFC's E) are the low bits of the MLS epoch, the next `senderBits` (S)
// are the sender's leaf index in the group, and the bits above them, the
// sender's context, are zero here: one stream a person.
export type Layout = { epochBits: number; senderBits: number };

// The RFC's own example: sixteen epochs in flight and sixty-four leaves, for
// a table of nine. P4C.3 fixes these once the group's timing is measured.
export const LAYOUT: Layout = { epochBits: 4, senderBits: 6 };

export function kidOf(layout: Layout, sender: number, epoch: bigint): bigint {
	if (!Number.isInteger(sender) || sender < 0 || sender >= 1 << layout.senderBits) {
		throw new RangeError(`no room in a key id for sender ${sender}`);
	}
	const bits = BigInt(layout.epochBits);
	return (BigInt(sender) << bits) | (epoch & ((1n << bits) - 1n));
}

// The sender and the epoch's low bits a key id names, or null if it has a
// context, which nobody here sends.
export function partsOf(layout: Layout, kid: bigint): { sender: number; slot: number } | null {
	const bits = BigInt(layout.epochBits);
	const sender = kid >> bits;
	if (sender >> BigInt(layout.senderBits)) return null;
	return { sender: Number(sender), slot: Number(kid & ((1n << bits) - 1n)) };
}

// Why a frame was not opened. None of these is ever passed on to the decoder.
export type Refusal =
	// No SFrame header, or too short to hold a tag.
	| 'malformed'
	// A key id this page has no key for: an epoch it has not been given, or a context.
	| 'unknown-key'
	// An epoch this page has retired.
	| 'stale-epoch'
	// Not the sender this stream belongs to, or this page's own key id.
	| 'wrong-sender'
	// The key, the header, the frame or the tag is not what a member sealed.
	| 'tampered'
	// A counter already opened under this key, or too far behind to tell.
	| 'replayed';

export type Opened =
	{ ok: true; data: ArrayBuffer; sender: number; epoch: bigint } | { ok: false; refusal: Refusal };

// How far behind the newest counter a frame may arrive and still be opened:
// two and a half seconds of 20 ms frames. An older one cannot be told from a
// replay and is refused as one.
export const REPLAY_WINDOW = 128;
const WINDOW = BigInt(REPLAY_WINDOW);
const WINDOW_MASK = (1n << WINDOW) - 1n;

// One sender's frames in one epoch, as a receiver tracks them: its key, the
// newest counter opened and which of the counters just before it were.
type Receiving = { key: Promise<FrameKey>; newest: bigint; seen: bigint };

type Epoch = {
	epoch: bigint;
	baseKey: CryptoKey;
	// The leaf this page sends as under this epoch, once it has: that key id
	// seals here and so never opens.
	sender: number | null;
	receiving: Map<number, Receiving>;
};

type Sending = { epoch: bigint; sender: number; key: Promise<FrameKey>; next: number };

// The keys one page holds: the epochs it can open frames from and the one it
// sends under. It keeps the promises the RFC asks of the application:
//
//   - a (key, key id, counter) is used to seal once: counters only go up, an
//     epoch is added once and never an older one after a newer, and a key id
//     is for sealing or for opening, never both (4.4.1, 9.1);
//   - an epoch is forgotten when a new one takes its low bits (5.2), or when
//     the page retires it;
//   - a frame is opened once, and only from a counter the window can vouch
//     for (9.3).
export class KeyStore {
	readonly layout: Layout;
	// Epochs by their low bits. `null` marks one this page retired.
	#slots = new Map<number, Epoch | null>();
	#newest = -1n;
	// The newest epoch this page has ever sent under, whether or not it still does.
	#lastSent = -1n;
	#sending: Sending | null = null;
	#held = false;
	#added = 0;
	#waiting: (() => void)[] = [];

	constructor(layout: Layout = LAYOUT) {
		this.layout = layout;
	}

	#slot(epoch: bigint): number {
		return Number(epoch & ((1n << BigInt(this.layout.epochBits)) - 1n));
	}

	// A new epoch's base key, from which every member's keys are derived on
	// demand. Frames sealed under it can be opened at once; this page goes on
	// sending under the epoch it was until `sendAs` moves it.
	add(epoch: bigint, baseKey: CryptoKey): void {
		if (baseKey.extractable) throw new TypeError('an SFrame base key must not be extractable');
		if (epoch <= this.#newest) throw new RangeError(`epoch ${epoch} is not newer than the last`);
		this.#newest = epoch;
		const slot = this.#slot(epoch);
		if (this.#sending && this.#slot(this.#sending.epoch) === slot) this.#sending = null;
		this.#slots.set(slot, { epoch, baseKey, sender: null, receiving: new Map() });
		this.#added += 1;
		for (const wake of this.#waiting.splice(0)) wake();
	}

	// How many epochs this page has been given, and a promise for the next one:
	// a receiver handed a frame from an epoch it does not hold yet can wait a
	// moment for the key instead of dropping the frame (sframe-transform.ts).
	get added(): number {
		return this.#added;
	}

	nextAdded(): Promise<void> {
		return new Promise((resolve) => this.#waiting.push(resolve));
	}

	// Stop sending, or start again, without touching a key or a counter. While
	// it is held a page seals nothing, so nothing leaves it: the group holds
	// someone who is not at the table, and the page will not speak to them.
	hold(held: boolean): void {
		this.#held = held;
	}

	get held(): boolean {
		return this.#held;
	}

	// Forget an epoch: its frames are refused from now on, and if this page was
	// sending under it, it sends nothing until `sendAs` names another.
	retire(epoch: bigint): void {
		const slot = this.#slot(epoch);
		if (this.#slots.get(slot)?.epoch !== epoch) return;
		this.#slots.set(slot, null);
		if (this.#sending?.epoch === epoch) this.#sending = null;
	}

	// Send as this leaf of the group under this epoch, from counter 0. Asking
	// again for what is already so changes nothing, and an epoch this page has
	// sent under before, or an older one, is refused: a counter never restarts.
	sendAs(sender: number, epoch: bigint): void {
		if (this.#sending?.epoch === epoch && this.#sending.sender === sender) return;
		const held = this.#slots.get(this.#slot(epoch));
		if (held?.epoch !== epoch) throw new RangeError(`no key for epoch ${epoch}`);
		if (epoch <= this.#lastSent) {
			throw new RangeError(`already sent under epoch ${this.#lastSent}`);
		}
		if (held.receiving.has(sender)) {
			throw new RangeError(`sender ${sender} is someone this page has opened frames from`);
		}
		const kid = kidOf(this.layout, sender, epoch);
		held.sender = sender;
		this.#lastSent = epoch;
		this.#sending = {
			epoch,
			sender,
			key: deriveFrameKey(held.baseKey, kid, 'encrypt'),
			next: 0
		};
	}

	get sending(): { sender: number; epoch: bigint } | null {
		return this.#sending && { sender: this.#sending.sender, epoch: this.#sending.epoch };
	}

	// The epochs this page can open frames from, oldest first.
	get epochs(): bigint[] {
		return [...this.#slots.values()]
			.flatMap((held) => (held ? [held.epoch] : []))
			.sort((a, b) => (a < b ? -1 : 1));
	}

	// The next frame, sealed, or null when this page has nothing to send under.
	// A frame that cannot be sealed is never sent as it is.
	async seal(frame: BufferSource): Promise<Bytes | null> {
		const sending = this.#sending;
		if (!sending || this.#held || sending.next >= Number.MAX_SAFE_INTEGER) return null;
		// Taken before anything is awaited: two frames in flight never share a counter.
		const ctr = BigInt(sending.next++);
		return seal(await sending.key, ctr, frame);
	}

	// Open a frame. `from` is the leaf whose stream it arrived on, when the page
	// knows it: the server can route one person's frames into another's stream,
	// and this is what stops them being played as that person's.
	async open(frame: Uint8Array, from?: number): Promise<Opened> {
		const header = decodeHeader(frame);
		if (!header || frame.length < header.length + TAG_BYTES) {
			return { ok: false, refusal: 'malformed' };
		}
		const parts = partsOf(this.layout, header.kid);
		if (!parts) return { ok: false, refusal: 'unknown-key' };
		const held = this.#slots.get(parts.slot);
		if (held === null) return { ok: false, refusal: 'stale-epoch' };
		if (!held) return { ok: false, refusal: 'unknown-key' };
		if (held.sender === parts.sender || (from !== undefined && from !== parts.sender)) {
			return { ok: false, refusal: 'wrong-sender' };
		}
		let receiving = held.receiving.get(parts.sender);
		if (!receiving) {
			receiving = {
				key: deriveFrameKey(held.baseKey, header.kid, 'decrypt'),
				newest: -1n,
				seen: 0n
			};
			held.receiving.set(parts.sender, receiving);
		}
		let data: ArrayBuffer;
		try {
			data = await open(await receiving.key, header, frame);
		} catch {
			return { ok: false, refusal: 'tampered' };
		}
		// Only now, with the frame known to be a member's, does its counter count.
		// Nothing is awaited between the look and the mark, so of two copies in
		// flight at once only one gets through.
		if (header.ctr > receiving.newest) {
			const ahead = header.ctr - receiving.newest;
			receiving.seen = ahead >= WINDOW ? 1n : ((receiving.seen << ahead) | 1n) & WINDOW_MASK;
			receiving.newest = header.ctr;
		} else {
			const behind = receiving.newest - header.ctr;
			if (behind >= WINDOW || receiving.seen & (1n << behind)) {
				return { ok: false, refusal: 'replayed' };
			}
			receiving.seen |= 1n << behind;
		}
		return { ok: true, data, sender: parts.sender, epoch: held.epoch };
	}
}

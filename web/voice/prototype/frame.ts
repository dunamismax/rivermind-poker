// The prototype's frame format (P4C.1). It is SFrame in shape, not RFC 9605:
// a clear header the receiver needs to pick a key and build the nonce, then the
// Opus frame under AES-128-GCM with the header as additional data. P4C.2
// replaces it with real SFrame (`src/lib/voice/sframe.ts`); nothing here ships.
//
//   byte 0      MAGIC
//   byte 1      key id: the sender's number in the room
//   bytes 2-5   frame counter, big endian
//   bytes 6-    ciphertext, then the 16-byte tag

export const MAGIC = 0xa5;
export const HEADER_BYTES = 6;
export const TAG_BYTES = 16;

export function writeHeader(kid: number, counter: number): Uint8Array<ArrayBuffer> {
	const header = new Uint8Array(HEADER_BYTES);
	header[0] = MAGIC;
	header[1] = kid;
	new DataView(header.buffer).setUint32(2, counter);
	return header;
}

export function readHeader(frame: Uint8Array): { kid: number; counter: number } | null {
	if (frame.length < HEADER_BYTES + TAG_BYTES || frame[0] !== MAGIC) return null;
	const counter = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2);
	return { kid: frame[1], counter };
}

// The per-frame nonce: the sender's salt with the counter folded into its last four bytes.
export function nonceFor(salt: Uint8Array, counter: number): Uint8Array<ArrayBuffer> {
	const nonce = new Uint8Array(salt);
	const view = new DataView(nonce.buffer);
	view.setUint32(8, view.getUint32(8) ^ counter);
	return nonce;
}

export const AUDIO_LEVEL_URI = 'urn:ietf:params:rtp-hdrext:ssrc-audio-level';

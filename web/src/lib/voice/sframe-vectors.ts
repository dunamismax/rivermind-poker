// RFC 9605's appendix C, run against sframe.ts: every header vector (C.1) and
// the SFrame vector of cipher suite 0x0004 (C.3), byte for byte. Vitest runs it
// under Node (sframe.spec.ts) and Playwright in each browser (voice/check), so
// one engine's WebCrypto cannot disagree with another's unnoticed. C.2 and the
// other four vectors of C.3 are for cipher suites this site does not use.
import vectors from './sframe-vectors.json' with { type: 'json' };
import {
	CIPHER_SUITE,
	KEY_BYTES,
	decodeHeader,
	deriveFrameKey,
	encodeHeader,
	hkdf,
	importBaseKey,
	label,
	nonceFor,
	open,
	seal,
	type Bytes
} from './sframe.ts';

export const hex = (bytes: Uint8Array | ArrayBuffer): string =>
	[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export function unhex(text: string): Bytes {
	const bytes = new Uint8Array(text.length / 2);
	for (let n = 0; n < bytes.length; n++) bytes[n] = parseInt(text.slice(2 * n, 2 * n + 2), 16);
	return bytes;
}

export type VectorCheck = {
	// Vectors checked, and those left out as another cipher suite's.
	headers: number;
	frames: number;
	otherSuites: number;
	// One line for each value that did not match; empty when every vector holds.
	failures: string[];
};

export async function checkVectors(): Promise<VectorCheck> {
	const failures: string[] = [];
	const same = (what: string, got: string, want: string) => {
		if (got !== want) failures.push(`${what}: got ${got}, want ${want}`);
	};

	for (const vector of vectors.header) {
		const kid = BigInt(`0x${vector.kid}`);
		const ctr = BigInt(`0x${vector.ctr}`);
		const name = `header kid ${vector.kid} ctr ${vector.ctr}`;
		same(`${name} encoded`, hex(encodeHeader(kid, ctr)), vector.header);
		const decoded = decodeHeader(unhex(vector.header));
		same(
			`${name} decoded`,
			decoded ? `${decoded.kid} ${decoded.ctr} ${decoded.length}` : 'null',
			`${kid} ${ctr} ${vector.header.length / 2}`
		);
	}

	const suite = CIPHER_SUITE.toString(16).padStart(4, '0');
	const frames = vectors.sframe.filter((vector) => vector.cipher_suite === suite);
	for (const vector of frames) {
		const kid = BigInt(`0x${vector.kid}`);
		const ctr = BigInt(`0x${vector.ctr}`);
		const metadata = unhex(vector.metadata);
		const plaintext = unhex(vector.pt);
		const ciphertext = unhex(vector.ct);
		const baseKey = await importBaseKey(unhex(vector.base_key));

		same('sframe_key_label', hex(label('key', kid)), vector.sframe_key_label);
		same('sframe_salt_label', hex(label('salt', kid)), vector.sframe_salt_label);
		// HKDF-Extract("", base_key) is HMAC under a hash-length run of zeros: the
		// step WebCrypto's HKDF takes inside, shown to give the RFC's secret.
		const zeros = await crypto.subtle.importKey(
			'raw',
			new Uint8Array(32),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		same(
			'sframe_secret',
			hex(await crypto.subtle.sign('HMAC', zeros, unhex(vector.base_key))),
			vector.sframe_secret
		);
		// The key as bytes, for this comparison alone: deriveFrameKey makes the
		// same key inside WebCrypto, where it cannot be read.
		same(
			'sframe_key',
			hex(await crypto.subtle.deriveBits(hkdf(label('key', kid)), baseKey, 8 * KEY_BYTES)),
			vector.sframe_key
		);
		const sealing = await deriveFrameKey(baseKey, kid, 'encrypt');
		const opening = await deriveFrameKey(baseKey, kid, 'decrypt');
		same('sframe_salt', hex(sealing.salt), vector.sframe_salt);
		same('nonce', hex(nonceFor(sealing.salt, ctr)), vector.nonce);
		same('aad', hex(encodeHeader(kid, ctr)) + vector.metadata, vector.aad);
		same('ct', hex(await seal(sealing, ctr, plaintext, metadata)), vector.ct);
		const header = decodeHeader(ciphertext);
		if (!header) failures.push('ct: no header');
		else same('pt', hex(await open(opening, header, ciphertext, metadata)), vector.pt);
	}

	return {
		headers: vectors.header.length,
		frames: frames.length,
		otherSuites: vectors.aead.length + vectors.sframe.length - frames.length,
		failures
	};
}

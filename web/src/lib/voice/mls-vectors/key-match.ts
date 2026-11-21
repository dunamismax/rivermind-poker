// Whether a public and a private key belong together, by using them.
// Adapted from ts-mls 1.6.4, test/crypto/keyMatch.ts (MIT, licenses/ts-mls.txt).
import type { Hpke } from 'ts-mls/crypto/hpke.js';
import type { Signature } from 'ts-mls/crypto/signature.js';

export async function hpkeKeysMatch(
	publicKey: Uint8Array,
	privateKey: Uint8Array,
	hpke: Hpke
): Promise<boolean> {
	const encoder = new TextEncoder();
	const plaintext = encoder.encode('test');
	const info = encoder.encode('key check');
	const { ct, enc } = await hpke.seal(await hpke.importPublicKey(publicKey), plaintext, info);
	const decrypted = await hpke.open(await hpke.importPrivateKey(privateKey), enc, ct, info);
	return new TextDecoder().decode(decrypted) === 'test';
}

export async function signatureKeysMatch(
	publicKey: Uint8Array,
	privateKey: Uint8Array,
	s: Signature
): Promise<boolean> {
	const testMessage = new TextEncoder().encode('test');
	const signature = await s.sign(privateKey, testMessage);
	return s.verify(publicKey, testMessage, signature);
}

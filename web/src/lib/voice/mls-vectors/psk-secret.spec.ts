// The MLS working group's psk_secret test vectors against the pinned ts-mls (P4C.3).
// Adapted from ts-mls 1.6.4, test/test-vectors/pskSecret.test.ts (MIT, licenses/ts-mls.txt):
// it imports the installed package by subpath and reads the working group's own files,
// the cases for ciphersuite 0x0001, which load.ts fetches at a pinned commit and checks.
import { expect, test, vi } from 'vitest';
import { vectors } from './load.ts';
import source from './source.json' with { type: 'json' };
import {
	type CiphersuiteId,
	type CiphersuiteImpl,
	getCiphersuiteFromId
} from 'ts-mls/crypto/ciphersuite.js';
import { getCiphersuiteImpl } from 'ts-mls/crypto/getCiphersuiteImpl.js';
import { computePskSecret, type PreSharedKeyIdExternal } from 'ts-mls/presharedkey.js';
import { bytesToHex, hexToBytes } from './hex.ts';

vi.setConfig({ testTimeout: 120_000 });

const json = await vectors('psk_secret');

test.concurrent.each(json.map((x, index) => [index, x]))(
	`psk_secret test vectors %i`,
	async (_index, x) => {
		const impl = await getCiphersuiteImpl(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId));
		await testPskSecret(x.psk_secret, x.psks, impl);
	}
);

type Psk = {
	psk_id: string;
	psk: string;
	psk_nonce: string;
};

function toExternalPsk(p: Psk): [PreSharedKeyIdExternal, Uint8Array] {
	return [
		{ psktype: 'external', pskId: hexToBytes(p.psk_id), pskNonce: hexToBytes(p.psk_nonce) },
		hexToBytes(p.psk)
	];
}

async function testPskSecret(secret: string, psks: Psk[], impl: CiphersuiteImpl) {
	const computedSecret = await computePskSecret(psks.map(toExternalPsk), impl);
	expect(bytesToHex(computedSecret)).toBe(secret);
}

// Without the working group's files (load.ts) this file has nothing to run, and says so.
test.skipIf(json.length === 0)('the psk_secret vectors for ciphersuite 0x0001 are all here', () => {
	expect(json).toHaveLength(source.files['psk_secret'].cases);
});

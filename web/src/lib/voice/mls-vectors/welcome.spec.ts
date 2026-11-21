// The MLS working group's welcome test vectors against the pinned ts-mls (P4C.3).
// Adapted from ts-mls 1.6.4, test/test-vectors/welcome.test.ts (MIT, licenses/ts-mls.txt):
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
import { hexToBytes } from './hex.ts';
import { decodeMlsMessage } from 'ts-mls/message.js';
import { makeKeyPackageRef } from 'ts-mls/keyPackage.js';
import { constantTimeEqual } from 'ts-mls/util/constantTimeCompare.js';
import { verifyGroupInfoConfirmationTag, verifyGroupInfoSignature } from 'ts-mls/groupInfo.js';
import { decryptGroupInfo, decryptGroupSecrets } from 'ts-mls/welcome.js';
import { type PrivateKey } from 'ts-mls/crypto/hpke.js';

vi.setConfig({ testTimeout: 120_000 });

const json = await vectors('welcome');

test.concurrent.each(json.map((x, index) => [index, x]))(
	`welcome test vectors %i`,
	async (_index, x) => {
		const impl = await getCiphersuiteImpl(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId));
		await testWelcome(x.init_priv, x.key_package, x.signer_pub, x.welcome, impl);
	}
);

async function testWelcome(
	init_priv: string,
	key_package: string,
	signer_pub: string,
	welcome: string,
	impl: CiphersuiteImpl
) {
	const x = decodeMlsMessage(hexToBytes(welcome), 0);
	if (x === undefined || x[0].wireformat !== 'mls_welcome')
		throw new Error("Couldn't decode to welcome");

	const w = x[0].welcome;

	const y = decodeMlsMessage(hexToBytes(key_package), 0);
	if (y === undefined || y[0].wireformat !== 'mls_key_package')
		throw new Error("Couldn't decode to key package");

	const keyPackageRef = await makeKeyPackageRef(y[0].keyPackage, impl.hash);

	const secret = w.secrets.find((s) => constantTimeEqual(s.newMember, keyPackageRef));

	if (secret === undefined) throw new Error('No matching secret found');

	const privKey: PrivateKey = await impl.hpke.importPrivateKey(hexToBytes(init_priv));
	const groupSecrets = await decryptGroupSecrets(privKey, keyPackageRef, w, impl.hpke);

	if (groupSecrets === undefined) throw new Error('Could not decrypt group secrets');

	const pskSecret = new Uint8Array(impl.kdf.size);

	const gi = await decryptGroupInfo(w, groupSecrets.joinerSecret, pskSecret, impl);
	if (gi === undefined) throw new Error('Could not decrypt group info');

	const tagOk = await verifyGroupInfoConfirmationTag(
		gi,
		groupSecrets.joinerSecret,
		pskSecret,
		impl
	);
	expect(tagOk).toBe(true);

	const signatureOk = await verifyGroupInfoSignature(gi, hexToBytes(signer_pub), impl.signature);
	expect(signatureOk).toBe(true);
}

// Without the working group's files (load.ts) this file has nothing to run, and says so.
test.skipIf(json.length === 0)('the welcome vectors for ciphersuite 0x0001 are all here', () => {
	expect(json).toHaveLength(source.files['welcome'].cases);
});

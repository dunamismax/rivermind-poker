// The MLS working group's passive-client-handling-commit, passive-client-random, passive-client-welcome test vectors against the pinned ts-mls (P4C.3).
// Adapted from ts-mls 1.6.4, test/test-vectors/passiveClientScenarios.test.ts (MIT, licenses/ts-mls.txt):
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
import { type KeyPackage, type PrivateKeyPackage } from 'ts-mls/keyPackage.js';
import { hexToBytes } from './hex.ts';
import { hpkeKeysMatch, signatureKeysMatch } from './key-match.ts';
import { decodeMlsMessage } from 'ts-mls/message.js';
import { decodeRatchetTree } from 'ts-mls/ratchetTree.js';

import { joinGroup, makePskIndex } from 'ts-mls/clientState.js';
import { processPrivateMessage, processPublicMessage } from 'ts-mls/processMessages.js';
import { bytesToBase64 } from 'ts-mls/util/byteArray.js';

vi.setConfig({ testTimeout: 120_000 });

const jsonCommit = await vectors('passive-client-handling-commit');
const jsonRandom = await vectors('passive-client-random');
const jsonWelcome = await vectors('passive-client-welcome');

test.concurrent.each(jsonCommit.map((x, index) => [index, x]))(
	`passive-client-handling-commit test vectors %i`,
	async (_index, x) => {
		const impl = await getCiphersuiteImpl(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId));
		await testPassiveClientScenario(x, impl);
	}
);

test.concurrent.each(jsonRandom.map((x, index) => [index, x]))(
	`passive-client-random test vectors %i`,
	async (_index, x) => {
		const impl = await getCiphersuiteImpl(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId));
		await testPassiveClientScenario(x, impl);
	},
	60000
);

test.concurrent.each(jsonWelcome.map((x, index) => [index, x]))(
	`passive-client-welcome test vectors %i`,
	async (_index, x) => {
		const impl = await getCiphersuiteImpl(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId));
		await testPassiveClientScenario(x, impl);
	}
);

async function testPassiveClientScenario(data: MlsGroupState, impl: CiphersuiteImpl) {
	const kp = decodeMlsMessage(hexToBytes(data.key_package), 0);

	if (kp === undefined || kp[0].wireformat !== 'mls_key_package')
		throw new Error('Could not decode KeyPackage');
	await verifyKeys(data, kp[0].keyPackage, impl);

	const welcome = decodeMlsMessage(hexToBytes(data.welcome), 0);

	if (welcome === undefined || welcome[0].wireformat !== 'mls_welcome')
		throw new Error('Could not decode Welcome');

	const pks: PrivateKeyPackage = {
		hpkePrivateKey: hexToBytes(data.encryption_priv),
		initPrivateKey: hexToBytes(data.init_priv),
		signaturePrivateKey: hexToBytes(data.signature_priv)
	};

	const tree =
		data.ratchet_tree !== null
			? decodeRatchetTree(hexToBytes(data.ratchet_tree), 0)?.[0]
			: undefined;

	const psks: Record<string, Uint8Array> = data.external_psks.reduce(
		(acc, psk) => ({ ...acc, [bytesToBase64(hexToBytes(psk.psk_id))]: hexToBytes(psk.psk) }),
		{}
	);
	let state = await joinGroup(
		welcome[0].welcome,
		kp[0].keyPackage,
		pks,
		makePskIndex(undefined, psks),
		impl,
		tree
	);

	expect(state.keySchedule.epochAuthenticator).toStrictEqual(
		hexToBytes(data.initial_epoch_authenticator)
	);

	for (const epoch of data.epochs) {
		for (const proposal of epoch.proposals) {
			const mlsProposal = decodeMlsMessage(hexToBytes(proposal), 0);
			if (
				mlsProposal === undefined ||
				(mlsProposal[0].wireformat !== 'mls_private_message' &&
					mlsProposal[0].wireformat !== 'mls_public_message')
			)
				throw new Error('Could not decode proposal message');

			if (mlsProposal[0].wireformat === 'mls_private_message') {
				const res = await processPrivateMessage(
					state,
					mlsProposal[0].privateMessage,
					makePskIndex(state, psks),
					impl
				);

				state = res.newState;
			} else {
				const res = await processPublicMessage(
					state,
					mlsProposal[0].publicMessage,
					makePskIndex(state, psks),
					impl
				);

				state = res.newState;
			}
		}

		const mlsCommit = decodeMlsMessage(hexToBytes(epoch.commit), 0);
		if (
			mlsCommit === undefined ||
			(mlsCommit[0].wireformat !== 'mls_private_message' &&
				mlsCommit[0].wireformat !== 'mls_public_message')
		)
			throw new Error('Could not decode commit message');

		if (mlsCommit[0].wireformat === 'mls_private_message') {
			const res = await processPrivateMessage(
				state,
				mlsCommit[0].privateMessage,
				makePskIndex(state, psks),
				impl
			);

			state = res.newState;
		} else {
			const res = await processPublicMessage(
				state,
				mlsCommit[0].publicMessage,
				makePskIndex(state, psks),
				impl
			);
			state = res.newState;
		}

		expect(state.keySchedule.epochAuthenticator).toStrictEqual(
			hexToBytes(epoch.epoch_authenticator)
		);
	}
}

async function verifyKeys(data: MlsGroupState, kp: KeyPackage, impl: CiphersuiteImpl) {
	const hpke = await hpkeKeysMatch(
		kp.leafNode.hpkePublicKey,
		hexToBytes(data.encryption_priv),
		impl.hpke
	);
	expect(hpke).toBe(true);

	const hpkeInit = await hpkeKeysMatch(kp.initKey, hexToBytes(data.init_priv), impl.hpke);
	expect(hpkeInit).toBe(true);

	const sig = await signatureKeysMatch(
		kp.leafNode.signaturePublicKey,
		hexToBytes(data.signature_priv),
		impl.signature
	);
	expect(sig).toBe(true);
	hexToBytes(data.init_priv);
}

type MlsGroupState = {
	cipher_suite: number;
	external_psks: ExternalPsk[];
	key_package: string;
	signature_priv: string;
	encryption_priv: string;
	init_priv: string;
	welcome: string;
	ratchet_tree: string | null;
	initial_epoch_authenticator: string;
	epochs: Epoch[];
};

type ExternalPsk = {
	psk_id: string;
	psk: string;
};

type Epoch = {
	proposals: string[];
	commit: string;
	epoch_authenticator: string;
};

// Without the working group's files (load.ts) this file has nothing to run, and says so.
test.skipIf(jsonCommit.length === 0)(
	'the passive-client-handling-commit vectors for ciphersuite 0x0001 are all here',
	() => {
		expect(jsonCommit).toHaveLength(source.files['passive-client-handling-commit'].cases);
	}
);

// Without the working group's files (load.ts) this file has nothing to run, and says so.
test.skipIf(jsonRandom.length === 0)(
	'the passive-client-random vectors for ciphersuite 0x0001 are all here',
	() => {
		expect(jsonRandom).toHaveLength(source.files['passive-client-random'].cases);
	}
);

// Without the working group's files (load.ts) this file has nothing to run, and says so.
test.skipIf(jsonWelcome.length === 0)(
	'the passive-client-welcome vectors for ciphersuite 0x0001 are all here',
	() => {
		expect(jsonWelcome).toHaveLength(source.files['passive-client-welcome'].cases);
	}
);

// The MLS working group's transcript-hashes test vectors against the pinned ts-mls (P4C.3).
// Adapted from ts-mls 1.6.4, test/test-vectors/transcriptHashes.test.ts (MIT, licenses/ts-mls.txt):
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
import { decodeAuthenticatedContent } from 'ts-mls/authenticatedContent.js';
import { createConfirmedHash, createInterimHash } from 'ts-mls/transcriptHash.js';

vi.setConfig({ testTimeout: 120_000 });

const json = await vectors('transcript-hashes');

test.concurrent.each(json.map((x, index) => [index, x]))(
	`transcript-hashes test vectors %i`,
	async (_index, x) => {
		const impl = await getCiphersuiteImpl(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId));
		await testTranscriptHash(
			x.authenticated_content,
			x.confirmation_key,
			x.confirmed_transcript_hash_after,
			x.interim_transcript_hash_after,
			x.interim_transcript_hash_before,
			impl
		);
	}
);

async function testTranscriptHash(
	authenticatedContent: string,
	confirmationKey: string,
	confirmedHashAfter: string,
	interimHashAfter: string,
	interimHashBefore: string,
	impl: CiphersuiteImpl
) {
	const auth = decodeAuthenticatedContent(hexToBytes(authenticatedContent), 0);
	if (
		auth === undefined ||
		auth[0].content.contentType !== 'commit' ||
		auth[0].auth.contentType !== 'commit'
	) {
		throw new Error('Could not decode authenticated content');
	}

	const confirmationTag = auth[0].auth.confirmationTag;

	const verified = await impl.hash.verifyMac(
		hexToBytes(confirmationKey),
		confirmationTag,
		hexToBytes(confirmedHashAfter)
	);
	expect(verified).toBe(true);

	const input = {
		wireformat: auth[0].wireformat,
		content: auth[0].content,
		signature: auth[0].auth.signature
	};

	const computedConfirmedHash = await createConfirmedHash(
		hexToBytes(interimHashBefore),
		input,
		impl.hash
	);

	expect(computedConfirmedHash).toStrictEqual(hexToBytes(confirmedHashAfter));

	const computedInterimHash = await createInterimHash(
		hexToBytes(confirmedHashAfter),
		confirmationTag,
		impl.hash
	);
	expect(computedInterimHash).toStrictEqual(hexToBytes(interimHashAfter));
}

// Without the working group's files (load.ts) this file has nothing to run, and says so.
test.skipIf(json.length === 0)(
	'the transcript-hashes vectors for ciphersuite 0x0001 are all here',
	() => {
		expect(json).toHaveLength(source.files['transcript-hashes'].cases);
	}
);

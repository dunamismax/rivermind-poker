// The MLS working group's tree-validation test vectors against the pinned ts-mls (P4C.3).
// Adapted from ts-mls 1.6.4, test/test-vectors/treeValidation.test.ts (MIT, licenses/ts-mls.txt):
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
import { decodeRatchetTree, resolution } from 'ts-mls/ratchetTree.js';
import { hexToBytes } from './hex.ts';
import { treeHash } from 'ts-mls/treeHash.js';
import { verifyLeafNodeSignature } from 'ts-mls/leafNode.js';
import { nodeToLeafIndex, toNodeIndex } from 'ts-mls/treemath.js';
import { verifyParentHashes } from 'ts-mls/parentHash.js';

vi.setConfig({ testTimeout: 120_000 });

const json = await vectors('tree-validation');

test.concurrent.each(json.map((x, index) => [index, x]))(
	`tree-validation test vectors %i`,
	async (_index, x) => {
		const impl = await getCiphersuiteImpl(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId));
		await treeOperationsTest(x, impl);
	}
);

type TreeValidationData = {
	tree: string;
	group_id: string;
	tree_hashes: string[];
	resolutions: number[][];
};

async function treeOperationsTest(data: TreeValidationData, impl: CiphersuiteImpl) {
	const tree = decodeRatchetTree(hexToBytes(data.tree), 0);

	if (tree === undefined) throw new Error('could not decode tree');

	for (const [i, h] of data.tree_hashes.entries()) {
		const hash = await treeHash(tree[0], toNodeIndex(i), impl.hash);
		expect(hash).toStrictEqual(hexToBytes(h));
	}

	for (const [i, r] of data.resolutions.entries()) {
		const reso = resolution(tree[0], toNodeIndex(i));
		expect(reso).toStrictEqual(r);
	}

	expect(await verifyParentHashes(tree[0], impl.hash)).toBe(true);

	for (const [i, n] of tree[0].entries()) {
		if (n !== undefined) {
			if (n.nodeType === 'leaf') {
				expect(
					await verifyLeafNodeSignature(
						n.leaf,
						hexToBytes(data.group_id),
						nodeToLeafIndex(toNodeIndex(i)),
						impl.signature
					)
				).toBe(true);
			}
		}
	}
}

// Without the working group's files (load.ts) this file has nothing to run, and says so.
test.skipIf(json.length === 0)(
	'the tree-validation vectors for ciphersuite 0x0001 are all here',
	() => {
		expect(json).toHaveLength(source.files['tree-validation'].cases);
	}
);

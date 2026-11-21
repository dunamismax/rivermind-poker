// The MLS working group's tree-operations test vectors against the pinned ts-mls (P4C.3).
// Adapted from ts-mls 1.6.4, test/test-vectors/treeOperations.test.ts (MIT, licenses/ts-mls.txt):
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
import {
	addLeafNode,
	decodeRatchetTree,
	encodeRatchetTree,
	type RatchetTree,
	removeLeafNode,
	updateLeafNode
} from 'ts-mls/ratchetTree.js';
import { hexToBytes } from './hex.ts';
import { decodeProposal, type Proposal } from 'ts-mls/proposal.js';
import { treeHashRoot } from 'ts-mls/treeHash.js';
import { toLeafIndex } from 'ts-mls/treemath.js';

vi.setConfig({ testTimeout: 120_000 });

const json = await vectors('tree-operations');

test.concurrent.each(json.map((x, index) => [index, x]))(
	`tree-operations test vectors %i`,
	async (_index, x) => {
		const impl = await getCiphersuiteImpl(getCiphersuiteFromId(x.cipher_suite as CiphersuiteId));
		await treeOperationsTest(x, impl);
	}
);

type TreeOperationData = {
	proposal: string;
	proposal_sender: number;
	tree_after: string;
	tree_before: string;
	tree_hash_after: string;
	tree_hash_before: string;
};

async function treeOperationsTest(data: TreeOperationData, impl: CiphersuiteImpl) {
	const tree = decodeRatchetTree(hexToBytes(data.tree_before), 0);

	if (tree === undefined) throw new Error('could not decode tree');

	const hash = await treeHashRoot(tree[0], impl.hash);
	expect(hash).toStrictEqual(hexToBytes(data.tree_hash_before));

	const proposal = decodeProposal(hexToBytes(data.proposal), 0);
	if (proposal === undefined) throw new Error('could not decode proposal');

	const treeAfter = applyProposal(proposal[0], tree[0], data);

	if (treeAfter === undefined)
		throw new Error('Could not apply proposal: ' + proposal[0].proposalType);

	expect(encodeRatchetTree(treeAfter)).toStrictEqual(hexToBytes(data.tree_after));

	const hashAfter = await treeHashRoot(treeAfter, impl.hash);
	expect(hashAfter).toStrictEqual(hexToBytes(data.tree_hash_after));
}

function applyProposal(proposal: Proposal, tree: RatchetTree, data: TreeOperationData) {
	switch (proposal.proposalType) {
		case 'add':
			return addLeafNode(tree, proposal.add.keyPackage.leafNode)[0];
		case 'update':
			return updateLeafNode(tree, proposal.update.leafNode, toLeafIndex(data.proposal_sender));
		case 'remove':
			return removeLeafNode(tree, toLeafIndex(proposal.remove.removed));
		case 'psk':
		case 'reinit':
		case 'external_init':
		case 'group_context_extensions':
	}
}

// Without the working group's files (load.ts) this file has nothing to run, and says so.
test.skipIf(json.length === 0)(
	'the tree-operations vectors for ciphersuite 0x0001 are all here',
	() => {
		expect(json).toHaveLength(source.files['tree-operations'].cases);
	}
);

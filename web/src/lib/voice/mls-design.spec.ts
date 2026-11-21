// The design check for the group key (P4C.1): what docs/voice.md asks of
// ts-mls, shown to work for ciphersuite 0x0001 before P4C.3 builds on it. It
// stays as a guard for upgrades of the pinned package.
//
// ts-mls is imported by subpath throughout. Its package root also loads a
// provider that needs `@noble/hashes`, which the package does not declare, so
// `import … from 'ts-mls'` fails under pnpm. The default provider, which these
// paths use, runs on WebCrypto (Ed25519 and X25519) and `@hpke/core` alone.
import { describe, expect, it } from 'vitest';
import { createGroup, type ClientState } from 'ts-mls/clientState.js';
import {
	createCommit,
	createGroupInfoWithExternalPubAndRatchetTree,
	joinGroupExternal
} from 'ts-mls/createCommit.js';
import { ciphersuites, getCiphersuiteFromName } from 'ts-mls/crypto/ciphersuite.js';
import { getCiphersuiteImpl } from 'ts-mls/crypto/getCiphersuiteImpl.js';
import { defaultCapabilities } from 'ts-mls/defaultCapabilities.js';
import type { Extension } from 'ts-mls/extension.js';
import { proposeExternal } from 'ts-mls/externalProposal.js';
import { encodeExternalSender } from 'ts-mls/externalSender.js';
import type { GroupInfo } from 'ts-mls/groupInfo.js';
import { generateKeyPackage, generateKeyPackageWithKey } from 'ts-mls/keyPackage.js';
import { mlsExporter } from 'ts-mls/keySchedule.js';
import { defaultLifetime } from 'ts-mls/lifetime.js';
import { decodeMlsMessage, encodeMlsMessage, type MLSMessage } from 'ts-mls/message.js';
import { processPublicMessage } from 'ts-mls/processMessages.js';
import { emptyPskIndex } from 'ts-mls/pskIndex.js';
import type { PublicMessage } from 'ts-mls/publicMessage.js';

const SUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';
const impl = await getCiphersuiteImpl(getCiphersuiteFromName(SUITE));
const text = new TextEncoder();
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

type Signer = { publicKey: Uint8Array; signKey: Uint8Array };

// The group's only external sender: the voice service, which may propose removals.
function externalSenders(service: Signer): Extension {
	return {
		extensionType: 'external_senders',
		extensionData: encodeExternalSender({
			signaturePublicKey: service.publicKey,
			credential: { credentialType: 'basic', identity: text.encode('rivermind-poker-voice') }
		})
	};
}

// A member's key package, under a signature key of their own making or a given one.
function keyPackage(name: string, signer?: Signer) {
	const credential = { credentialType: 'basic', identity: text.encode(name) } as const;
	return signer
		? generateKeyPackageWithKey(
				credential,
				defaultCapabilities(),
				defaultLifetime,
				[],
				signer,
				impl
			)
		: generateKeyPackage(credential, defaultCapabilities(), defaultLifetime, [], impl);
}

// What the voice service holds for newcomers, as it travels: a GroupInfo with
// the ratchet tree and the external public key, published by whoever committed last.
async function published(state: ClientState): Promise<GroupInfo> {
	const info = await createGroupInfoWithExternalPubAndRatchetTree(state, [], impl);
	const wire = encodeMlsMessage({
		version: 'mls10',
		wireformat: 'mls_group_info',
		groupInfo: info
	});
	const [message] = decodeMlsMessage(wire, 0)!;
	if (message.wireformat !== 'mls_group_info') throw new Error('not a group info');
	return message.groupInfo;
}

function publicMessage(message: MLSMessage): PublicMessage {
	if (message.wireformat !== 'mls_public_message') throw new Error('not a public message');
	return message.publicMessage;
}

const apply = async (state: ClientState, message: PublicMessage) =>
	(await processPublicMessage(state, message, emptyPskIndex, impl)).newState;

// RFC 9605 section 5.2: the SFrame base key of an epoch, 16 bytes for AES-128-GCM.
const baseKey = async (state: ClientState) =>
	hex(
		await mlsExporter(
			state.keySchedule.exporterSecret,
			'SFrame 1.0 Base Key',
			new Uint8Array(),
			16,
			impl
		)
	);

const authenticator = (state: ClientState) => hex(state.keySchedule.epochAuthenticator);

// A room of `size` people: the first creates the group, the rest join by
// external commit from the published GroupInfo, and everyone already in the
// room applies each commit.
async function room(size: number, service: Signer, signers: Record<number, Signer> = {}) {
	const first = await keyPackage('player-0', signers[0]);
	const states = [
		await createGroup(
			text.encode('table-1'),
			first.publicPackage,
			first.privatePackage,
			[externalSenders(service)],
			impl
		)
	];
	let info = await published(states[0]);
	for (let n = 1; n < size; n++) {
		const next = await keyPackage(`player-${n}`, signers[n]);
		const joined = await joinGroupExternal(
			info,
			next.publicPackage,
			next.privatePackage,
			false,
			impl
		);
		for (let m = 0; m < states.length; m++)
			states[m] = await apply(states[m], joined.publicMessage);
		states.push(joined.newState);
		info = await published(joined.newState);
	}
	return { states, info };
}

async function expectAgreement(states: ClientState[], epoch: bigint): Promise<void> {
	for (const state of states) {
		expect(state.groupContext.epoch).toBe(epoch);
		expect(state.groupActiveState.kind).toBe('active');
		expect(await baseKey(state)).toBe(await baseKey(states[0]));
		expect(authenticator(state)).toBe(authenticator(states[0]));
	}
}

describe('ts-mls for table voice (P4C.1)', () => {
	it('offers ciphersuite 0x0001', () => {
		expect(ciphersuites[SUITE]).toBe(1);
	});

	it('grows a group to nine by external commits, with one key and one authenticator an epoch', async () => {
		const service = await impl.signature.keygen();
		const keys = new Set<string>();
		const codes = new Set<string>();
		for (const size of [1, 2, 3, 9]) {
			const { states } = await room(size, service);
			await expectAgreement(states, BigInt(size - 1));
			expect(states.map((state) => state.privatePath.leafIndex)).toEqual(
				Array.from({ length: size }, (_, n) => n)
			);
			keys.add(await baseKey(states[0]));
			codes.add(authenticator(states[0]));
		}
		// Every epoch has a key and an authenticator of its own.
		expect(keys.size).toBe(4);
		expect(codes.size).toBe(4);
	});

	it("applies the service's removal once the lowest leaf commits it, and locks the removed member out", async () => {
		const service = await impl.signature.keygen();
		const { states, info } = await room(3, service);
		const [alice, bob, carol] = states;
		const before = await baseKey(alice);

		const removal = publicMessage(
			await proposeExternal(
				info,
				{ proposalType: 'remove', remove: { removed: bob.privatePath.leafIndex } },
				service.publicKey,
				service.signKey,
				impl
			)
		);
		const aliceHeard = await apply(alice, removal);
		const bobHeard = await apply(bob, removal);
		const carolHeard = await apply(carol, removal);
		expect(Object.keys(aliceHeard.unappliedProposals)).toHaveLength(1);

		const commit = await createCommit(
			{ state: aliceHeard, cipherSuite: impl },
			{ wireAsPublicMessage: true }
		);
		const carolAfter = await apply(carolHeard, publicMessage(commit.commit));
		await expectAgreement([commit.newState, carolAfter], 3n);
		expect(await baseKey(carolAfter)).not.toBe(before);

		// Bob reads the commit that removes him and is left at the old epoch, with the old key.
		const bobAfter = await apply(bobHeard, publicMessage(commit.commit));
		expect(bobAfter.groupActiveState.kind).toBe('removedFromGroup');
		expect(bobAfter.groupContext.epoch).toBe(2n);
		expect(await baseKey(bobAfter)).toBe(before);
	});

	it('refuses a second commit for an epoch, and its author follows the first', async () => {
		const service = await impl.signature.keygen();
		const { states, info } = await room(3, service);
		const [alice, bob, carol] = states;
		const removal = publicMessage(
			await proposeExternal(
				info,
				{ proposalType: 'remove', remove: { removed: bob.privatePath.leafIndex } },
				service.publicKey,
				service.signKey,
				impl
			)
		);
		const aliceHeard = await apply(alice, removal);
		const carolHeard = await apply(carol, removal);

		// Both commit at once. The service passes on the first; a commit never changes
		// the state it was made from, so Carol drops hers and applies Alice's.
		const first = await createCommit(
			{ state: aliceHeard, cipherSuite: impl },
			{ wireAsPublicMessage: true }
		);
		const second = await createCommit(
			{ state: carolHeard, cipherSuite: impl },
			{ wireAsPublicMessage: true }
		);
		const carolAfter = await apply(carolHeard, publicMessage(first.commit));
		await expectAgreement([first.newState, carolAfter], 3n);
		await expect(apply(first.newState, publicMessage(second.commit))).rejects.toThrow(
			/epoch too old/
		);
	});

	it('refuses a removal the service did not sign', async () => {
		const service = await impl.signature.keygen();
		const forger = await impl.signature.keygen();
		const { states, info } = await room(2, service);

		// ts-mls will not even build a proposal for a signer the group does not name.
		const proposal = { proposalType: 'remove', remove: { removed: 1 } } as const;
		await expect(
			proposeExternal(info, proposal, forger.publicKey, forger.signKey, impl)
		).rejects.toThrow(/external_sender/);

		// So forge one against a copy of the group that names the forger, and send it to a member.
		const forged = publicMessage(
			await proposeExternal(
				{ ...info, groupContext: { ...info.groupContext, extensions: [externalSenders(forger)] } },
				proposal,
				forger.publicKey,
				forger.signKey,
				impl
			)
		);
		await expect(apply(states[0], forged)).rejects.toThrow();
	});

	it('lets a member who missed commits rejoin under the same signature key, replacing their old leaf', async () => {
		const service = await impl.signature.keygen();
		const bob = await impl.signature.keygen();
		const { states, info } = await room(3, service, { 1: bob });
		// A resync: the external commit also removes the leaf that carries the same signature key.
		const again = await keyPackage('player-1', bob);
		const back = await joinGroupExternal(
			info,
			again.publicPackage,
			again.privatePackage,
			true,
			impl
		);
		const alice = await apply(states[0], back.publicMessage);
		const carol = await apply(states[2], back.publicMessage);
		await expectAgreement([alice, back.newState, carol], 3n);
		expect(back.newState.privatePath.leafIndex).toBe(1);
		// The state they held before stays at the old epoch.
		expect(states[1].groupContext.epoch).toBe(2n);
	});

	it('lets a member who reloaded join as a new leaf, and the service then removes the old one', async () => {
		// A reloaded page has a new signature key, so it cannot resync: ts-mls 1.6.4
		// finds the old leaf by signature key alone, and with no match
		// `joinGroupExternal(…, resync = true)` never returns. The page joins as a
		// newcomer instead, and the service proposes the stale leaf's removal.
		const service = await impl.signature.keygen();
		const { states, info } = await room(3, service);
		const again = await keyPackage('player-1');
		const back = await joinGroupExternal(
			info,
			again.publicPackage,
			again.privatePackage,
			false,
			impl
		);
		let alice = await apply(states[0], back.publicMessage);
		let carol = await apply(states[2], back.publicMessage);
		let bob = back.newState;
		await expectAgreement([alice, bob, carol], 3n);
		expect(bob.privatePath.leafIndex).toBe(3);

		const removal = publicMessage(
			await proposeExternal(
				await published(bob),
				{ proposalType: 'remove', remove: { removed: 1 } },
				service.publicKey,
				service.signKey,
				impl
			)
		);
		alice = await apply(alice, removal);
		bob = await apply(bob, removal);
		carol = await apply(carol, removal);
		const commit = await createCommit(
			{ state: alice, cipherSuite: impl },
			{ wireAsPublicMessage: true }
		);
		bob = await apply(bob, publicMessage(commit.commit));
		carol = await apply(carol, publicMessage(commit.commit));
		await expectAgreement([commit.newState, bob, carol], 4n);
		// The reloaded page's old state reads neither epoch.
		await expect(apply(states[1], publicMessage(commit.commit))).rejects.toThrow();
	});
});

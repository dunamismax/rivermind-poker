// The MLS group behind a table's voice (RFC 9420, docs/voice.md): the people in
// voice agree a key for each epoch that the voice service never holds, and a
// new one whenever someone joins or leaves. This file is one member's side.
// delivery.ts is the service's: it orders commits and proposes removals, and
// can read neither a key nor a frame.
//
//   - The first person creates the group, naming the service as its one
//     external sender. Everyone after joins by an external commit from the
//     GroupInfo the service holds, so nobody already in the room has to act.
//   - The service proposes the removal of whoever left. The remaining member
//     with the lowest leaf commits it; if they do not, the next one does.
//   - A member applies only what this design sends: a removal the service
//     signed, a commit of such removals, and a newcomer's external commit.
//
// ts-mls is imported by subpath: its package root loads a provider that needs
// a package it does not declare. Nothing here imports `#lib`, so Node, the
// page and the voice service all load this file as it is.
import { createGroup, type ClientState } from 'ts-mls/clientState.js';
import {
	createCommit,
	createGroupInfoWithExternalPubAndRatchetTree,
	joinGroupExternal
} from 'ts-mls/createCommit.js';
import { getCiphersuiteFromName, type CiphersuiteImpl } from 'ts-mls/crypto/ciphersuite.js';
import { getCiphersuiteImpl } from 'ts-mls/crypto/getCiphersuiteImpl.js';
import { defaultCapabilities } from 'ts-mls/defaultCapabilities.js';
import type { Extension } from 'ts-mls/extension.js';
import { decodeExternalSender, encodeExternalSender } from 'ts-mls/externalSender.js';
import type { GroupInfo } from 'ts-mls/groupInfo.js';
import type { IncomingMessageCallback } from 'ts-mls/incomingMessageAction.js';
import { generateKeyPackage } from 'ts-mls/keyPackage.js';
import { mlsExporter } from 'ts-mls/keySchedule.js';
import { defaultLifetime } from 'ts-mls/lifetime.js';
import { decodeMlsMessage, encodeMlsMessage, type MLSMessage } from 'ts-mls/message.js';
import { processPublicMessage } from 'ts-mls/processMessages.js';
import { emptyPskIndex } from 'ts-mls/pskIndex.js';
import type { PublicMessage } from 'ts-mls/publicMessage.js';
import type { RatchetTree } from 'ts-mls/ratchetTree.js';
import { KEY_BYTES } from './sframe.ts';

export const CIPHERSUITE = 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519';
// The credential the voice service signs its removals under.
export const SERVICE_NAME = 'rivermind-poker-voice';
// RFC 9605 section 5.2: the label an epoch's SFrame base key is exported under.
export const BASE_KEY_LABEL = 'SFrame 1.0 Base Key';

const text = new TextEncoder();

let implementation: Promise<CiphersuiteImpl> | null = null;
export function suite(): Promise<CiphersuiteImpl> {
	return (implementation ??= getCiphersuiteImpl(getCiphersuiteFromName(CIPHERSUITE)));
}

// Who a leaf says it is: a player's public reference and the seat they hold.
// It is a claim, signed only by a key made for the session. What makes it
// worth anything is that every client checks the group's members against the
// table's seats, and that the people at the table can compare the voice code.
export type Identity = { player: string; seat: number };

export const encodeIdentity = ({ player, seat }: Identity): Uint8Array<ArrayBuffer> =>
	text.encode(`${seat}:${player}`);

export function decodeIdentity(bytes: Uint8Array): Identity | null {
	let value: string;
	try {
		value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
	const parts = /^(0|[1-9]\d{0,2}):(.{1,128})$/su.exec(value);
	return parts && { seat: Number(parts[1]), player: parts[2] };
}

export const sameIdentity = (a: Identity | null, b: Identity | null): boolean =>
	a !== null && b !== null && a.player === b.player && a.seat === b.seat;

// A leaf of the group and who it says it is; null where it does not say so in this design's form.
export type Leaf = { leaf: number; identity: Identity | null };

export function rosterOf(tree: RatchetTree): Leaf[] {
	const leaves: Leaf[] = [];
	for (let node = 0; node < tree.length; node += 2) {
		const one = tree[node];
		if (one?.nodeType !== 'leaf') continue;
		const credential = one.leaf.credential;
		leaves.push({
			leaf: node / 2,
			identity: credential.credentialType === 'basic' ? decodeIdentity(credential.identity) : null
		});
	}
	return leaves;
}

// The extension that names the voice service as the group's only external sender.
export function serviceExtension(servicePublicKey: Uint8Array): Extension {
	return {
		extensionType: 'external_senders',
		extensionData: encodeExternalSender({
			signaturePublicKey: servicePublicKey,
			credential: { credentialType: 'basic', identity: text.encode(SERVICE_NAME) }
		})
	};
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((byte, at) => byte === b[at]);

// The keys of the external senders a group names. The design has exactly one.
export function externalSenders(extensions: Extension[]): Uint8Array[] {
	return extensions
		.filter((one) => one.extensionType === 'external_senders')
		.map((one) => {
			const decoded = decodeExternalSender(one.extensionData, 0);
			if (!decoded) throw new Error('an external sender that does not decode');
			return decoded[0].signaturePublicKey;
		});
}

export const namesOnlyService = (
	extensions: Extension[],
	servicePublicKey: Uint8Array
): boolean => {
	const named = externalSenders(extensions);
	return named.length === 1 && sameBytes(named[0], servicePublicKey);
};

// MLS messages as they cross the signalling socket.
export function decodeMessage(bytes: Uint8Array): MLSMessage {
	const decoded = decodeMlsMessage(bytes, 0);
	if (!decoded || decoded[1] !== bytes.length) throw new Error('not one MLS message');
	return decoded[0];
}

export function decodePublicMessage(bytes: Uint8Array): PublicMessage {
	const message = decodeMessage(bytes);
	if (message.wireformat !== 'mls_public_message') throw new Error('not an MLS public message');
	return message.publicMessage;
}

export function decodeGroupInfo(bytes: Uint8Array): GroupInfo {
	const message = decodeMessage(bytes);
	if (message.wireformat !== 'mls_group_info') throw new Error('not an MLS GroupInfo');
	return message.groupInfo;
}

const encodePublicMessage = (publicMessage: PublicMessage): Uint8Array =>
	encodeMlsMessage({ version: 'mls10', wireformat: 'mls_public_message', publicMessage });

async function groupInfoOf(state: ClientState, impl: CiphersuiteImpl): Promise<Uint8Array> {
	const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(state, [], impl);
	return encodeMlsMessage({ version: 'mls10', wireformat: 'mls_group_info', groupInfo });
}

async function keyPackage(identity: Identity, impl: CiphersuiteImpl) {
	return generateKeyPackage(
		{ credentialType: 'basic', identity: encodeIdentity(identity) },
		defaultCapabilities(),
		defaultLifetime,
		[],
		impl
	);
}

// What this design lets a member apply. ts-mls has already checked signatures
// and the membership tag by the time it asks.
//
//   - A proposal on its own: a removal from the external sender, the service.
//   - A member's commit: of such removals, at least one, and nothing else. A
//     member has no business adding anyone, removing anyone the service did
//     not name, or changing who the external sender is.
//   - A newcomer's external commit: its external init and nothing else.
const policy: IncomingMessageCallback = (incoming) => {
	if (incoming.kind === 'proposal') {
		const { proposal, senderLeafIndex } = incoming.proposal;
		return proposal.proposalType === 'remove' && senderLeafIndex === undefined
			? 'accept'
			: 'reject';
	}
	if (incoming.senderLeafIndex === undefined) {
		return incoming.proposals.length === 1 &&
			incoming.proposals[0].proposal.proposalType === 'external_init'
			? 'accept'
			: 'reject';
	}
	return incoming.proposals.length > 0 &&
		incoming.proposals.every(
			({ proposal, senderLeafIndex }) =>
				proposal.proposalType === 'remove' && senderLeafIndex === undefined
		)
		? 'accept'
		: 'reject';
};

export type Received =
	// The service proposed removals; `removes` is every leaf now waiting to go.
	| { kind: 'proposal'; removes: number[] }
	// The group moved to a new epoch.
	| { kind: 'commit'; epoch: bigint }
	// The commit removed this member: its state stays at the old epoch for good.
	| { kind: 'removed' }
	// Not something this design sends. Nothing changed.
	| { kind: 'rejected' };

// A candidate for the next epoch that this member made: the commit to send,
// the GroupInfo that follows it, and the member as it will be if the service
// accepts the commit. Until it does, the member it was made from stands, and
// applies whichever commit won instead.
export type Candidate = { commit: Uint8Array; groupInfo: Uint8Array; member: Member };

export class Member {
	#state: ClientState;
	#impl: CiphersuiteImpl;
	#servicePublicKey: Uint8Array;

	private constructor(state: ClientState, impl: CiphersuiteImpl, servicePublicKey: Uint8Array) {
		this.#state = state;
		this.#impl = impl;
		this.#servicePublicKey = servicePublicKey;
	}

	// The first person in voice makes the group and the GroupInfo the next will join from.
	static async create(
		identity: Identity,
		groupId: Uint8Array,
		servicePublicKey: Uint8Array
	): Promise<{ member: Member; groupInfo: Uint8Array }> {
		const impl = await suite();
		const mine = await keyPackage(identity, impl);
		const state = await createGroup(
			groupId,
			mine.publicPackage,
			mine.privatePackage,
			[serviceExtension(servicePublicKey)],
			impl
		);
		return {
			member: new Member(state, impl, servicePublicKey),
			groupInfo: await groupInfoOf(state, impl)
		};
	}

	// Join by external commit from the GroupInfo the service holds. The group must
	// name the service this client is talking to as its only external sender,
	// or someone else could remove its members.
	static async join(
		identity: Identity,
		groupInfo: Uint8Array,
		servicePublicKey: Uint8Array
	): Promise<Candidate> {
		const impl = await suite();
		const info = decodeGroupInfo(groupInfo);
		if (!namesOnlyService(info.groupContext.extensions, servicePublicKey)) {
			throw new Error('the group does not name the voice service as its only external sender');
		}
		const mine = await keyPackage(identity, impl);
		// Never a resync: ts-mls 1.6.4 does not return from one whose signature key
		// is not in the group. A page that comes back joins as a newcomer, and the
		// service proposes its old leaf's removal.
		const joined = await joinGroupExternal(
			info,
			mine.publicPackage,
			mine.privatePackage,
			false,
			impl
		);
		return {
			commit: encodePublicMessage(joined.publicMessage),
			groupInfo: await groupInfoOf(joined.newState, impl),
			member: new Member(joined.newState, impl, servicePublicKey)
		};
	}

	get epoch(): bigint {
		return this.#state.groupContext.epoch;
	}

	get groupId(): Uint8Array {
		return this.#state.groupContext.groupId;
	}

	// This member's leaf: the sender in its SFrame key ids.
	get leaf(): number {
		return this.#state.privatePath.leafIndex;
	}

	get active(): boolean {
		return this.#state.groupActiveState.kind === 'active';
	}

	// Everyone in the group, from this member's own copy of the tree, never from
	// what the service says.
	roster(): Leaf[] {
		return rosterOf(this.#state.ratchetTree);
	}

	// The leaves the service has proposed to remove and nobody has committed yet.
	pendingRemovals(): number[] {
		return Object.values(this.#state.unappliedProposals)
			.flatMap(({ proposal }) =>
				proposal.proposalType === 'remove' ? [proposal.remove.removed] : []
			)
			.sort((a, b) => a - b);
	}

	// How many members stand ahead of this one to commit the pending removals: 0
	// means this member commits now, n that it waits n turns for those ahead of
	// it. Null when there is nothing to commit or this member is the one going.
	commitRank(): number | null {
		const going = new Set(this.pendingRemovals());
		if (going.size === 0 || going.has(this.leaf) || !this.active) return null;
		return this.roster().filter(({ leaf }) => !going.has(leaf) && leaf < this.leaf).length;
	}

	// Apply a message the service passed on. A message this design does not
	// send, or one that fails ts-mls's checks, changes nothing.
	async receive(message: Uint8Array): Promise<Received> {
		let incoming: PublicMessage;
		try {
			incoming = decodePublicMessage(message);
		} catch {
			return { kind: 'rejected' };
		}
		let result;
		try {
			result = await processPublicMessage(this.#state, incoming, emptyPskIndex, this.#impl, policy);
		} catch {
			return { kind: 'rejected' };
		}
		if (result.actionTaken === 'reject') return { kind: 'rejected' };
		const next = result.newState;
		// A commit that leaves the group naming another external sender would hand
		// removals to someone else. The policy above already refuses the proposal
		// that could do it; this is the same rule, checked on the result.
		if (!namesOnlyService(next.groupContext.extensions, this.#servicePublicKey)) {
			return { kind: 'rejected' };
		}
		this.#state = next;
		if (next.groupActiveState.kind === 'removedFromGroup') return { kind: 'removed' };
		if (incoming.content.contentType === 'commit') return { kind: 'commit', epoch: this.epoch };
		return { kind: 'proposal', removes: this.pendingRemovals() };
	}

	// Commit the removals the service proposed. This member is unchanged: it
	// moves to `candidate.member` only once the service has accepted the commit.
	async commit(): Promise<Candidate> {
		if (this.commitRank() === null) throw new Error('nothing for this member to commit');
		const made = await createCommit(
			{ state: this.#state, cipherSuite: this.#impl },
			{ wireAsPublicMessage: true }
		);
		if (made.commit.wireformat !== 'mls_public_message') throw new Error('not a public commit');
		return {
			commit: encodeMlsMessage(made.commit),
			groupInfo: await groupInfoOf(made.newState, this.#impl),
			member: new Member(made.newState, this.#impl, this.#servicePublicKey)
		};
	}

	// This epoch's SFrame base key (RFC 9605 section 5.2). The caller imports it
	// into WebCrypto at once (`importBaseKey`) and lets the bytes go.
	baseKey(): Promise<Uint8Array> {
		return mlsExporter(
			this.#state.keySchedule.exporterSecret,
			BASE_KEY_LABEL,
			new Uint8Array(),
			KEY_BYTES,
			this.#impl
		);
	}

	// What every member of this epoch holds and nobody outside it does: the
	// table voice code is made from it (voice-code.ts).
	get authenticator(): Uint8Array {
		return new Uint8Array(this.#state.keySchedule.epochAuthenticator);
	}
}

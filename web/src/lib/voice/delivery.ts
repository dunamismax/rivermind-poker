// The voice service's part in a table's MLS group (docs/voice.md): the
// delivery service of RFC 9420, and the group's one external sender. It holds
// no secret of the group. What it holds is the latest GroupInfo a member
// published, which is public, and a signature key of its own, made for the
// room and kept in memory, under which it proposes removals.
//
// Its rules:
//
//   - one commit an epoch: the first that fits is accepted and passed on, and
//     any other made from the same epoch is refused (group.ts: its author
//     drops it and applies the winner);
//   - a commit changes the group only as its sender may: a newcomer adds one
//     leaf, their own; a member removes leaves the service proposed, and
//     nothing else;
//   - a removal the service proposed stays wanted until a commit carries it
//     out. Proposals die with their epoch, so after every commit the service
//     proposes again whatever is still to go.
//
// The service cannot check a commit as a member does: the membership tag is
// keyed with a group secret. It checks what is public, and a member who lies
// to it in a GroupInfo can break the room for newcomers but learn nothing;
// the room then starts a new group (P4C.7).
import { proposeExternal } from 'ts-mls/externalProposal.js';
import type { CiphersuiteImpl } from 'ts-mls/crypto/ciphersuite.js';
import {
	ratchetTreeFromExtension,
	verifyGroupInfoSignature,
	type GroupInfo
} from 'ts-mls/groupInfo.js';
import { encodeMlsMessage } from 'ts-mls/message.js';
import { getSignaturePublicKeyFromLeafIndex } from 'ts-mls/ratchetTree.js';
import { toLeafIndex } from 'ts-mls/treemath.js';
import {
	decodeGroupInfo,
	decodePublicMessage,
	namesOnlyService,
	rosterOf,
	sameIdentity,
	suite,
	type Identity,
	type Leaf
} from './group.ts';

export type Refusal =
	// Not an MLS message of the kind expected, or not for this room's group.
	| 'malformed'
	// There is a group already, or there is none yet.
	| 'no-group'
	| 'group-exists'
	// Another commit was accepted for this epoch first.
	| 'epoch-taken'
	// The GroupInfo is not signed by a member in its own tree, is for the wrong
	// epoch, or names another external sender.
	| 'bad-group-info'
	// The commit does something its sender may not.
	| 'not-allowed';

export type Outcome =
	| {
			accepted: true;
			epoch: bigint;
			// The leaf an external commit added, and the leaves a member's commit removed.
			joined: Leaf | null;
			removed: number[];
			// Removals still wanted, proposed again for the new epoch, to send to
			// everyone, a newcomer included: nobody can apply the commit that carries
			// them out without having seen them.
			proposals: Uint8Array[];
	  }
	| { accepted: false; refusal: Refusal };

type Held = { bytes: Uint8Array; info: GroupInfo; roster: Leaf[] };

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
	a.length === b.length && a.every((byte, at) => byte === b[at]);

export class Delivery {
	#impl: CiphersuiteImpl;
	#signer: { publicKey: Uint8Array; signKey: Uint8Array };
	#held: Held | null = null;
	// Leaves the service wants gone that no commit has removed yet.
	#leaving = new Set<number>();
	readonly groupId: Uint8Array;

	private constructor(
		impl: CiphersuiteImpl,
		signer: { publicKey: Uint8Array; signKey: Uint8Array },
		groupId: Uint8Array
	) {
		this.#impl = impl;
		this.#signer = signer;
		this.groupId = groupId;
	}

	// A room's delivery service, with a signature key made for it now.
	static async create(groupId: Uint8Array): Promise<Delivery> {
		const impl = await suite();
		return new Delivery(impl, await impl.signature.keygen(), groupId);
	}

	// What a client needs before it creates or joins the group.
	get servicePublicKey(): Uint8Array {
		return this.#signer.publicKey;
	}

	get epoch(): bigint | null {
		return this.#held ? this.#held.info.groupContext.epoch : null;
	}

	// What a newcomer joins from.
	get groupInfo(): Uint8Array | null {
		return this.#held?.bytes ?? null;
	}

	// Who is in the group, by the latest GroupInfo.
	roster(): Leaf[] {
		return this.#held?.roster ?? [];
	}

	// The leaves one person holds: one, or two for a moment after their page reloaded.
	leavesOf(player: string): number[] {
		return this.roster()
			.filter(({ identity }) => identity?.player === player)
			.map(({ leaf }) => leaf);
	}

	// Forget the group: the room emptied, or the group broke and starts again.
	close(): void {
		this.#held = null;
		this.#leaving.clear();
	}

	// A GroupInfo for the epoch expected, signed by a member in its own tree,
	// in which every leaf says who it is and the service is the one external sender.
	async #read(bytes: Uint8Array, epoch: bigint): Promise<Held | null> {
		let info: GroupInfo;
		try {
			info = decodeGroupInfo(bytes);
		} catch {
			return null;
		}
		const context = info.groupContext;
		if (!sameBytes(context.groupId, this.groupId) || context.epoch !== epoch) return null;
		try {
			if (!namesOnlyService(context.extensions, this.#signer.publicKey)) return null;
			const tree = ratchetTreeFromExtension(info);
			if (!tree) return null;
			const signedBy = getSignaturePublicKeyFromLeafIndex(tree, toLeafIndex(info.signer));
			if (!(await verifyGroupInfoSignature(info, signedBy, this.#impl.signature))) return null;
			const roster = rosterOf(tree);
			if (roster.some(({ identity }) => identity === null)) return null;
			return { bytes, info, roster };
		} catch {
			return null;
		}
	}

	// The first person's GroupInfo: epoch 0, and nobody in the group but them.
	async open(groupInfo: Uint8Array, from: Identity): Promise<Outcome> {
		if (this.#held) return { accepted: false, refusal: 'group-exists' };
		const held = await this.#read(groupInfo, 0n);
		if (!held) return { accepted: false, refusal: 'bad-group-info' };
		if (held.roster.length !== 1 || !sameIdentity(held.roster[0].identity, from)) {
			return { accepted: false, refusal: 'not-allowed' };
		}
		this.#held = held;
		return { accepted: true, epoch: 0n, joined: held.roster[0], removed: [], proposals: [] };
	}

	// A commit and the GroupInfo that follows it, from the person the signalling
	// socket belongs to. Accepted, it is the caller's to pass on to everyone else.
	async submit(commit: Uint8Array, groupInfo: Uint8Array, from: Identity): Promise<Outcome> {
		const now = this.#held;
		if (!now) return { accepted: false, refusal: 'no-group' };
		const epoch = now.info.groupContext.epoch;
		let content;
		try {
			content = decodePublicMessage(commit).content;
		} catch {
			return { accepted: false, refusal: 'malformed' };
		}
		if (content.contentType !== 'commit' || !sameBytes(content.groupId, this.groupId)) {
			return { accepted: false, refusal: 'malformed' };
		}
		if (content.epoch !== epoch) {
			return { accepted: false, refusal: content.epoch < epoch ? 'epoch-taken' : 'malformed' };
		}
		const next = await this.#read(groupInfo, epoch + 1n);
		if (!next) return { accepted: false, refusal: 'bad-group-info' };

		// What the commit did, by the trees before and after it.
		const before = new Map(now.roster.map((one) => [one.leaf, one.identity]));
		const after = new Map(next.roster.map((one) => [one.leaf, one.identity]));
		const added = next.roster.filter(({ leaf }) => !before.has(leaf));
		const removed = now.roster.filter(({ leaf }) => !after.has(leaf)).map(({ leaf }) => leaf);
		const changed = next.roster.some(
			({ leaf, identity }) => before.has(leaf) && !sameIdentity(before.get(leaf)!, identity)
		);
		let allowed: boolean;
		if (content.sender.senderType === 'new_member_commit') {
			// A newcomer: one new leaf, theirs, and nobody gone.
			allowed =
				added.length === 1 &&
				sameIdentity(added[0].identity, from) &&
				removed.length === 0 &&
				!changed;
		} else if (content.sender.senderType === 'member') {
			// A member: their own commit, of removals the service asked for and nothing more.
			allowed =
				sameIdentity(before.get(content.sender.leafIndex) ?? null, from) &&
				added.length === 0 &&
				removed.length > 0 &&
				removed.every((leaf) => this.#leaving.has(leaf)) &&
				!changed;
		} else {
			allowed = false;
		}
		if (!allowed) return { accepted: false, refusal: 'not-allowed' };

		this.#held = next;
		for (const leaf of removed) this.#leaving.delete(leaf);
		// A leaf that was to go may have gone already; what is left is asked for again.
		for (const leaf of this.#leaving) if (!after.has(leaf)) this.#leaving.delete(leaf);
		const proposals: Uint8Array[] = [];
		for (const leaf of [...this.#leaving].sort((a, b) => a - b)) {
			proposals.push(await this.#propose(next, leaf));
		}
		return {
			accepted: true,
			epoch: epoch + 1n,
			joined: added[0] ?? null,
			removed,
			proposals
		};
	}

	async #propose(held: Held, leaf: number): Promise<Uint8Array> {
		return encodeMlsMessage(
			await proposeExternal(
				held.info,
				{ proposalType: 'remove', remove: { removed: leaf } },
				this.#signer.publicKey,
				this.#signer.signKey,
				this.#impl
			)
		);
	}

	// Ask the group to remove a leaf: whoever held it left the seat, or their
	// page reloaded and joined again. The proposal is for everyone in the room.
	// Null when the leaf is not in the group, or is already asked for.
	async remove(leaf: number): Promise<Uint8Array | null> {
		const held = this.#held;
		if (!held || this.#leaving.has(leaf) || !held.roster.some((one) => one.leaf === leaf)) {
			return null;
		}
		this.#leaving.add(leaf);
		return this.#propose(held, leaf);
	}

	// The leaves waiting to be removed.
	get leaving(): number[] {
		return [...this.#leaving].sort((a, b) => a - b);
	}
}

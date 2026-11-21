// The table's MLS group (P4C.3): members (group.ts) and the voice service's
// delivery rules (delivery.ts) driven together, as the signalling socket will
// drive them. After every join, leave, reload and collision, everyone in voice
// holds the same epoch, the same SFrame base key and the same authenticator,
// and nobody who left can follow.
import { describe, expect, it } from 'vitest';
import type { ClientState } from 'ts-mls/clientState.js';
import { createCommit, joinGroupExternal } from 'ts-mls/createCommit.js';
import { defaultCapabilities } from 'ts-mls/defaultCapabilities.js';
import { proposeExternal } from 'ts-mls/externalProposal.js';
import { generateKeyPackage } from 'ts-mls/keyPackage.js';
import { defaultLifetime } from 'ts-mls/lifetime.js';
import { encodeMlsMessage } from 'ts-mls/message.js';
import type { Proposal } from 'ts-mls/proposal.js';
import { Delivery, type Outcome } from './delivery.ts';
import {
	Member,
	decodeGroupInfo,
	decodeIdentity,
	decodePublicMessage,
	encodeIdentity,
	serviceExtension,
	suite,
	type Identity
} from './group.ts';

const impl = await suite();
const text = new TextEncoder();
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const who = (seat: number): Identity => ({ player: `player-${seat}`, seat });

// One person's page in voice.
type Client = { identity: Identity; member: Member };

// A table's voice room: the service's delivery rules and the pages connected
// to it. Each method is what the signalling socket will carry (P4C.4, P4C.5).
class Room {
	delivery!: Delivery;
	clients: Client[] = [];
	// The last state of every page that left or reloaded.
	gone: Member[] = [];
	// Every base key so far and the epoch it belonged to, to show none comes round again.
	keys = new Map<string, bigint>();
	// The commit that made the current epoch, and the last removal proposed, as they were passed on.
	lastCommit: Uint8Array | null = null;
	lastProposal: Uint8Array | null = null;

	static async open(name = 'table-1'): Promise<Room> {
		const room = new Room();
		room.delivery = await Delivery.create(text.encode(name));
		return room;
	}

	get serviceKey(): Uint8Array {
		return this.delivery.servicePublicKey;
	}

	// The service passes a message on to every page but its author's.
	async broadcast(message: Uint8Array, except?: Client): Promise<void> {
		for (const client of this.clients) {
			if (client !== except) await client.member.receive(message);
		}
	}

	// An accepted commit goes to everyone but its author. The removals the service
	// asks for again go to everyone, a newcomer included: the commit that carries
	// them out refers to them, and nobody can apply it without having seen them.
	async accepted(outcome: Outcome, commit: Uint8Array, author: Client): Promise<void> {
		if (!outcome.accepted) throw new Error(`refused: ${outcome.refusal}`);
		this.lastCommit = commit;
		await this.broadcast(commit, author);
		for (const proposal of outcome.proposals) await this.broadcast(proposal);
	}

	// A person joins voice: they make the group, or join it by external commit.
	// A join that loses its epoch to another commit starts again from the new GroupInfo.
	async join(identity: Identity): Promise<Client> {
		for (;;) {
			const groupInfo = this.delivery.groupInfo;
			if (!groupInfo) {
				const made = await Member.create(identity, this.delivery.groupId, this.serviceKey);
				const outcome = await this.delivery.open(made.groupInfo, identity);
				if (!outcome.accepted) throw new Error(`refused: ${outcome.refusal}`);
				const client = { identity, member: made.member };
				this.clients.push(client);
				return client;
			}
			const candidate = await Member.join(identity, groupInfo, this.serviceKey);
			const outcome = await this.delivery.submit(candidate.commit, candidate.groupInfo, identity);
			if (!outcome.accepted) {
				expect(outcome.refusal).toBe('epoch-taken');
				continue;
			}
			const client = { identity, member: candidate.member };
			this.clients.push(client);
			await this.accepted(outcome, candidate.commit, client);
			return client;
		}
	}

	// A page's socket closed: the service asks for its leaf to be removed.
	async drop(client: Client): Promise<void> {
		this.clients = this.clients.filter((one) => one !== client);
		this.gone.push(client.member);
		if (this.clients.length === 0) {
			this.delivery.close();
			return;
		}
		const proposal = await this.delivery.remove(client.member.leaf);
		if (proposal) await this.broadcast(proposal);
		this.lastProposal = proposal;
	}

	// The member whose turn it is commits the pending removals. `skip` members
	// ahead of it have gone quiet, so the next in line steps in.
	async commit(skip = 0): Promise<Client> {
		const author = this.clients.find((client) => client.member.commitRank() === skip);
		if (!author) throw new Error(`nobody at rank ${skip}`);
		const candidate = await author.member.commit();
		const outcome = await this.delivery.submit(
			candidate.commit,
			candidate.groupInfo,
			author.identity
		);
		author.member = candidate.member;
		await this.accepted(outcome, candidate.commit, author);
		return author;
	}

	// Commit until nothing is waiting to be removed.
	async settle(): Promise<void> {
		while (this.delivery.leaving.length > 0) await this.commit();
	}

	async leave(client: Client): Promise<void> {
		await this.drop(client);
		await this.settle();
	}

	// A page reloads: it joins as a newcomer under a new key, and the service
	// asks for the leaf its old page held to be removed.
	async reload(client: Client): Promise<Client> {
		this.clients = this.clients.filter((one) => one !== client);
		this.gone.push(client.member);
		const stale = client.member.leaf;
		if (this.clients.length === 0) this.delivery.close();
		const back = await this.join(client.identity);
		expect(back.member.leaf).not.toBe(this.clients.length > 1 ? stale : -1);
		const proposal = await this.delivery.remove(stale);
		if (proposal) await this.broadcast(proposal);
		await this.settle();
		return back;
	}

	// Everyone in voice agrees, on everything, and those who left are locked out.
	async expectAgreement(): Promise<void> {
		expect(this.clients.length).toBeGreaterThan(0);
		const first = this.clients[0].member;
		const key = hex(await first.baseKey());
		const seated = this.clients.map(({ identity }) => identity).sort((a, b) => a.seat - b.seat);
		for (const { identity, member } of this.clients) {
			expect(member.active).toBe(true);
			expect(member.epoch).toBe(this.delivery.epoch);
			expect(hex(await member.baseKey())).toBe(key);
			expect(hex(member.authenticator)).toBe(hex(first.authenticator));
			expect(member.pendingRemovals()).toEqual([]);
			// The group is the people in voice, one leaf each, and each knows its own.
			const roster = member.roster();
			expect(roster.map((one) => one.identity).sort((a, b) => a!.seat - b!.seat)).toEqual(seated);
			expect(roster.find((one) => one.leaf === member.leaf)?.identity).toEqual(identity);
			// The service's view, from the GroupInfo it holds, is the members' own.
			expect(this.delivery.roster()).toEqual(roster);
		}
		expect(key).toHaveLength(32);
		expect(this.keys.get(key) ?? first.epoch).toBe(first.epoch);
		this.keys.set(key, first.epoch);
		for (const left of this.gone) {
			expect(left.epoch).toBeLessThan(first.epoch);
			expect(hex(await left.baseKey())).not.toBe(key);
			// Nothing the room sends from here on moves them.
			if (this.lastCommit) {
				const result = await left.receive(this.lastCommit);
				expect(['rejected', 'removed']).toContain(result.kind);
				expect(hex(await left.baseKey())).not.toBe(key);
			}
		}
	}
}

// A small seeded generator, so a failing walk can be run again.
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe('who a leaf says it is', () => {
	it('is a seat and a player, and survives the round trip', () => {
		const identity = { player: 'p_3f9a-K', seat: 8 };
		expect(decodeIdentity(encodeIdentity(identity))).toEqual(identity);
		expect(new TextDecoder().decode(encodeIdentity(identity))).toBe('8:p_3f9a-K');
	});

	it('is nobody when it is not in that form', () => {
		for (const claim of ['', 'player', ':p', '01:p', '-1:p', '1.5:p', '1234:p', '3:']) {
			expect(decodeIdentity(text.encode(claim)), claim).toBeNull();
		}
		expect(decodeIdentity(new Uint8Array([0x33, 0x3a, 0xff]))).toBeNull();
	});
});

describe('a table of people joining and leaving', () => {
	it('grows from one to nine by external commits, a new key every epoch', async () => {
		const room = await Room.open();
		for (let seat = 0; seat < 9; seat++) {
			const client = await room.join(who(seat));
			expect(client.member.leaf).toBe(seat);
			expect(client.member.epoch).toBe(BigInt(seat));
			await room.expectAgreement();
		}
		expect(room.keys.size).toBe(9);
	});

	it('removes someone who left, by the lowest leaf, and locks them out', async () => {
		const room = await Room.open();
		const [alice, bob, carol] = [
			await room.join(who(0)),
			await room.join(who(1)),
			await room.join(who(2))
		];
		const before = hex(await alice.member.baseKey());

		await room.drop(bob);
		expect(alice.member.pendingRemovals()).toEqual([1]);
		expect(alice.member.commitRank()).toBe(0);
		expect(carol.member.commitRank()).toBe(1);
		// Bob's own page, had it heard the proposal, would have no turn to commit it.
		expect(bob.member.commitRank()).toBeNull();
		expect(await room.commit()).toBe(alice);

		expect(alice.member.epoch).toBe(3n);
		expect(hex(await alice.member.baseKey())).not.toBe(before);
		// Bob's page, had it gone on listening, reads its own removal and is left where it was.
		expect(await bob.member.receive(room.lastProposal!)).toEqual({
			kind: 'proposal',
			removes: [1]
		});
		expect(await bob.member.receive(room.lastCommit!)).toEqual({ kind: 'removed' });
		expect(bob.member.active).toBe(false);
		expect(bob.member.epoch).toBe(2n);
		expect(hex(await bob.member.baseKey())).toBe(before);
		await room.expectAgreement();
	});

	it('lets the next in line commit when the lowest leaf stays quiet', async () => {
		const room = await Room.open();
		const [, bob, carol, dave] = [
			await room.join(who(0)),
			await room.join(who(1)),
			await room.join(who(2)),
			await room.join(who(3))
		];
		await room.drop(dave);
		// Alice does nothing. Bob is one turn behind her, Carol two.
		expect(bob.member.commitRank()).toBe(1);
		expect(carol.member.commitRank()).toBe(2);
		expect(await room.commit(1)).toBe(bob);
		await room.expectAgreement();
	});

	it('skips a committer who is leaving too', async () => {
		const room = await Room.open();
		const [alice, bob, carol] = [
			await room.join(who(0)),
			await room.join(who(1)),
			await room.join(who(2))
		];
		// Alice and Bob go at once: Carol, the last leaf, is first in line.
		await room.drop(alice);
		await room.drop(bob);
		expect(carol.member.pendingRemovals()).toEqual([0, 1]);
		expect(carol.member.commitRank()).toBe(0);
		expect(await room.commit()).toBe(carol);
		await room.expectAgreement();
		expect(carol.member.roster()).toEqual([{ leaf: 2, identity: who(2) }]);
	});

	it('gives a freed leaf to the next person, under a new key', async () => {
		const room = await Room.open();
		const [, bob] = [await room.join(who(0)), await room.join(who(1)), await room.join(who(2))];
		await room.leave(bob);
		const erin = await room.join(who(4));
		expect(erin.member.leaf).toBe(1);
		await room.expectAgreement();
	});

	it('starts a new group when the room empties', async () => {
		const room = await Room.open();
		const alice = await room.join(who(0));
		const first = hex(await alice.member.baseKey());
		await room.leave(alice);
		expect(room.delivery.epoch).toBeNull();
		expect(room.delivery.groupInfo).toBeNull();
		const bob = await room.join(who(1));
		expect(bob.member.epoch).toBe(0n);
		expect(hex(await bob.member.baseKey())).not.toBe(first);
	});
});

describe('two things at once', () => {
	it('accepts the first of two joins and sends the second round again', async () => {
		const room = await Room.open();
		await room.join(who(0));
		const groupInfo = room.delivery.groupInfo!;
		const bob = await Member.join(who(1), groupInfo, room.serviceKey);
		const carol = await Member.join(who(2), groupInfo, room.serviceKey);

		const first = await room.delivery.submit(bob.commit, bob.groupInfo, who(1));
		const joined = { identity: who(1), member: bob.member };
		room.clients.push(joined);
		await room.accepted(first, bob.commit, joined);
		// Carol's commit was made from the epoch Bob's has just ended.
		expect(await room.delivery.submit(carol.commit, carol.groupInfo, who(2))).toEqual({
			accepted: false,
			refusal: 'epoch-taken'
		});
		// And no member takes it either, had it reached them.
		for (const client of room.clients) {
			expect(await client.member.receive(carol.commit)).toEqual({ kind: 'rejected' });
		}
		await room.join(who(2));
		await room.expectAgreement();
		expect(room.delivery.epoch).toBe(2n);
	});

	it('accepts the first of two commits of one removal, and its loser follows', async () => {
		const room = await Room.open();
		const [alice, bob, carol] = [
			await room.join(who(0)),
			await room.join(who(1)),
			await room.join(who(2))
		];
		await room.drop(carol);
		// Bob does not wait his turn: both commit.
		const hers = await alice.member.commit();
		const his = await bob.member.commit();
		const first = await room.delivery.submit(hers.commit, hers.groupInfo, alice.identity);
		expect(await room.delivery.submit(his.commit, his.groupInfo, bob.identity)).toEqual({
			accepted: false,
			refusal: 'epoch-taken'
		});
		// A commit never changes the member it was made from: Bob drops his and applies hers.
		alice.member = hers.member;
		await room.accepted(first, hers.commit, alice);
		expect(bob.member.epoch).toBe(alice.member.epoch);
		await room.expectAgreement();
	});

	it('asks again for a removal that a join overtook', async () => {
		const room = await Room.open();
		const [alice, bob, carol] = [
			await room.join(who(0)),
			await room.join(who(1)),
			await room.join(who(2))
		];
		await room.drop(carol);
		expect(alice.member.pendingRemovals()).toEqual([2]);
		// Before anyone commits it, Dave's join takes the epoch. The proposal died with it.
		const dave = await room.join(who(3));
		expect(room.delivery.leaving).toEqual([2]);
		// The service has proposed it again in the new epoch, to everyone, Dave included.
		for (const client of [alice, bob, dave]) {
			expect(client.member.pendingRemovals()).toEqual([2]);
		}
		await room.settle();
		await room.expectAgreement();
		expect(alice.member.roster().map((one) => one.identity!.seat)).toEqual([0, 1, 3]);
	});

	it('removes a reloaded page’s old leaf, leaving one leaf a person', async () => {
		const room = await Room.open();
		const [, bob] = [await room.join(who(0)), await room.join(who(1)), await room.join(who(2))];
		const old = bob.member;
		const back = await room.reload(bob);
		// For a moment the group held two leaves for seat 1; now it holds the new one.
		expect(back.member.leaf).toBe(3);
		await room.expectAgreement();
		expect(room.delivery.leavesOf('player-1')).toEqual([3]);
		expect(old.epoch).toBeLessThan(back.member.epoch);
	});

	it('holds together through a random walk of joins, leaves, reloads and collisions', async () => {
		let largest = 0;
		for (const seed of [1, 2, 3]) {
			const next = random(seed);
			const pick = <T>(from: T[]): T => from[Math.floor(next() * from.length)];
			const room = await Room.open(`walk-${seed}`);
			await room.join(who(0));
			await room.join(who(1));
			for (let step = 0; step < 40; step++) {
				const taken = new Set(room.clients.map(({ identity }) => identity.seat));
				const free = Array.from({ length: 9 }, (_, seat) => seat).filter(
					(seat) => !taken.has(seat)
				);
				const roll = next();
				if (room.clients.length <= 2 || (roll < 0.5 && free.length > 0)) {
					if (free.length > 1 && next() < 0.3) {
						// Two people join from the same GroupInfo; one goes round again.
						const [a, b] = [pick(free), pick(free)];
						if (a !== b) {
							const groupInfo = room.delivery.groupInfo!;
							const loser = await Member.join(who(b), groupInfo, room.serviceKey);
							await room.join(who(a));
							const refused = await room.delivery.submit(loser.commit, loser.groupInfo, who(b));
							expect(refused).toEqual({ accepted: false, refusal: 'epoch-taken' });
							await room.join(who(b));
						} else await room.join(who(a));
					} else await room.join(who(pick(free)));
				} else if (roll < 0.6) {
					await room.reload(pick(room.clients));
				} else if (roll < 0.8 && room.clients.length > 3) {
					// Two leave at once, and the first in line stays quiet.
					await room.drop(pick(room.clients));
					await room.drop(pick(room.clients));
					if (room.clients.some((client) => client.member.commitRank() === 1)) {
						await room.commit(1);
					}
					await room.settle();
				} else {
					await room.leave(pick(room.clients));
				}
				await room.expectAgreement();
				largest = Math.max(largest, room.clients.length);
			}
			// The walk went through many epochs, each with a key of its own.
			expect(Number(room.delivery.epoch), `seed ${seed}`).toBeGreaterThan(40);
			expect(room.keys.size, `seed ${seed}`).toBe(40);
		}
		// And somewhere along it the table was full, or nearly.
		expect(largest).toBeGreaterThanOrEqual(8);
	}, 120_000);
});

describe('what a member will not apply', () => {
	// Someone at the table whose page is not ours: a member in good standing,
	// built on ts-mls directly, who then sends what this design never does.
	async function rogueAt(room: Room, seat: number) {
		const mine = await generateKeyPackage(
			{ credentialType: 'basic', identity: encodeIdentity(who(seat)) },
			defaultCapabilities(),
			defaultLifetime,
			[],
			impl
		);
		const joined = await joinGroupExternal(
			decodeGroupInfo(room.delivery.groupInfo!),
			mine.publicPackage,
			mine.privatePackage,
			false,
			impl
		);
		const commit = encodeMlsMessage({
			version: 'mls10',
			wireformat: 'mls_public_message',
			publicMessage: joined.publicMessage
		});
		return { state: joined.newState, commit };
	}

	async function commitOf(state: ClientState, extraProposals: Proposal[]): Promise<Uint8Array> {
		const made = await createCommit(
			{ state, cipherSuite: impl },
			{ wireAsPublicMessage: true, extraProposals }
		);
		return encodeMlsMessage(made.commit);
	}

	// A room of three honest pages and one rogue member who has heard everything they have.
	async function roomWithRogue() {
		const room = await Room.open();
		const [alice, bob] = [await room.join(who(0)), await room.join(who(1))];
		const rogue = await rogueAt(room, 2);
		for (const client of room.clients) {
			expect((await client.member.receive(rogue.commit)).kind).toBe('commit');
		}
		return { room, alice, bob, rogue };
	}

	it('a member’s commit that removes someone the service did not name', async () => {
		const { alice, bob, rogue } = await roomWithRogue();
		const before = alice.member.epoch;
		const commit = await commitOf(rogue.state, [
			{ proposalType: 'remove', remove: { removed: bob.member.leaf } }
		]);
		expect(await alice.member.receive(commit)).toEqual({ kind: 'rejected' });
		expect(await bob.member.receive(commit)).toEqual({ kind: 'rejected' });
		expect(alice.member.epoch).toBe(before);
		expect(bob.member.active).toBe(true);
	});

	it('a member’s commit that adds someone', async () => {
		const { alice, rogue } = await roomWithRogue();
		const hidden = await generateKeyPackage(
			{ credentialType: 'basic', identity: encodeIdentity(who(7)) },
			defaultCapabilities(),
			defaultLifetime,
			[],
			impl
		);
		const commit = await commitOf(rogue.state, [
			{ proposalType: 'add', add: { keyPackage: hidden.publicPackage } }
		]);
		expect(await alice.member.receive(commit)).toEqual({ kind: 'rejected' });
		expect(alice.member.roster()).toHaveLength(3);
	});

	it('a member’s commit that changes who may propose removals', async () => {
		const { alice, rogue } = await roomWithRogue();
		const theirs = await impl.signature.keygen();
		const commit = await commitOf(rogue.state, [
			{
				proposalType: 'group_context_extensions',
				groupContextExtensions: { extensions: [serviceExtension(theirs.publicKey)] }
			}
		]);
		expect(await alice.member.receive(commit)).toEqual({ kind: 'rejected' });
	});

	it('a member’s commit of nothing at all', async () => {
		const { alice, rogue } = await roomWithRogue();
		expect(await alice.member.receive(await commitOf(rogue.state, []))).toEqual({
			kind: 'rejected'
		});
	});

	it('a removal the service did not sign', async () => {
		const room = await Room.open();
		const [alice] = [await room.join(who(0)), await room.join(who(1))];
		const forger = await impl.signature.keygen();
		const info = decodeGroupInfo(room.delivery.groupInfo!);
		// Forged against a copy of the group that names the forger, since ts-mls
		// will not build a proposal for a signer the group does not name.
		const forged = encodeMlsMessage(
			await proposeExternal(
				{
					...info,
					groupContext: {
						...info.groupContext,
						extensions: [serviceExtension(forger.publicKey)]
					}
				},
				{ proposalType: 'remove', remove: { removed: 1 } },
				forger.publicKey,
				forger.signKey,
				impl
			)
		);
		expect(await alice.member.receive(forged)).toEqual({ kind: 'rejected' });
		expect(alice.member.pendingRemovals()).toEqual([]);
	});

	it('bytes that are not an MLS public message', async () => {
		const room = await Room.open();
		const alice = await room.join(who(0));
		expect(await alice.member.receive(new Uint8Array(40))).toEqual({ kind: 'rejected' });
		expect(await alice.member.receive(room.delivery.groupInfo!)).toEqual({ kind: 'rejected' });
	});

	it('a group that names another service', async () => {
		const room = await Room.open();
		await room.join(who(0));
		const other = await impl.signature.keygen();
		await expect(Member.join(who(1), room.delivery.groupInfo!, other.publicKey)).rejects.toThrow(
			/external sender/
		);
	});
});

describe('what the service will not pass on', () => {
	async function three() {
		const room = await Room.open();
		const clients = [await room.join(who(0)), await room.join(who(1)), await room.join(who(2))];
		return { room, clients };
	}

	it('a first GroupInfo that holds anyone but its sender, or a second group', async () => {
		const room = await Room.open();
		const made = await Member.create(who(0), room.delivery.groupId, room.serviceKey);
		expect(await room.delivery.open(made.groupInfo, who(1))).toEqual({
			accepted: false,
			refusal: 'not-allowed'
		});
		expect((await room.delivery.open(made.groupInfo, who(0))).accepted).toBe(true);
		const again = await Member.create(who(1), room.delivery.groupId, room.serviceKey);
		expect(await room.delivery.open(again.groupInfo, who(1))).toEqual({
			accepted: false,
			refusal: 'group-exists'
		});
	});

	it('a group for another room, or one that names another external sender', async () => {
		const room = await Room.open('table-1');
		const elsewhere = await Member.create(who(0), text.encode('table-2'), room.serviceKey);
		expect(await room.delivery.open(elsewhere.groupInfo, who(0))).toEqual({
			accepted: false,
			refusal: 'bad-group-info'
		});
		const other = await impl.signature.keygen();
		const theirs = await Member.create(who(0), room.delivery.groupId, other.publicKey);
		expect(await room.delivery.open(theirs.groupInfo, who(0))).toEqual({
			accepted: false,
			refusal: 'bad-group-info'
		});
	});

	it('a join under someone else’s name', async () => {
		const { room } = await three();
		// The socket is seat 4's; the leaf says seat 5.
		const candidate = await Member.join(who(5), room.delivery.groupInfo!, room.serviceKey);
		expect(await room.delivery.submit(candidate.commit, candidate.groupInfo, who(4))).toEqual({
			accepted: false,
			refusal: 'not-allowed'
		});
		expect(room.delivery.epoch).toBe(2n);
	});

	it('a removal nobody asked for, or a commit from another person’s socket', async () => {
		const { room, clients } = await three();
		const [alice, bob, carol] = clients;
		await room.drop(carol);
		const candidate = await alice.member.commit();
		// Sent from Bob's socket: the commit's sender is Alice's leaf.
		expect(await room.delivery.submit(candidate.commit, candidate.groupInfo, bob.identity)).toEqual(
			{ accepted: false, refusal: 'not-allowed' }
		);
		// Alice's identity, from a socket that holds another of her leaves (a page
		// that reloaded holds its new leaf, not the old one).
		expect(
			await room.delivery.submit(candidate.commit, candidate.groupInfo, alice.identity, 5)
		).toEqual({ accepted: false, refusal: 'not-allowed' });
		const outcome = await room.delivery.submit(
			candidate.commit,
			candidate.groupInfo,
			alice.identity,
			alice.member.leaf
		);
		expect(outcome).toMatchObject({ accepted: true, epoch: 3n, removed: [2], joined: null });
	});

	it('a commit with the wrong GroupInfo, or none', async () => {
		const { room, clients } = await three();
		const [alice, , carol] = clients;
		const stale = room.delivery.groupInfo!;
		await room.drop(carol);
		const candidate = await alice.member.commit();
		for (const groupInfo of [stale, new Uint8Array(12), candidate.commit]) {
			expect(await room.delivery.submit(candidate.commit, groupInfo, alice.identity)).toEqual({
				accepted: false,
				refusal: 'bad-group-info'
			});
		}
		for (const commit of [new Uint8Array(12), candidate.groupInfo]) {
			expect(await room.delivery.submit(commit, candidate.groupInfo, alice.identity)).toEqual({
				accepted: false,
				refusal: 'malformed'
			});
		}
		expect(room.delivery.epoch).toBe(2n);
	});

	it('a proposal sent as a commit', async () => {
		const { room, clients } = await three();
		const proposal = (await room.delivery.remove(2))!;
		expect(decodePublicMessage(proposal).content.contentType).toBe('proposal');
		expect(
			await room.delivery.submit(proposal, room.delivery.groupInfo!, clients[0].identity)
		).toEqual({
			accepted: false,
			refusal: 'malformed'
		});
		// Asking twice for one leaf, or for a leaf nobody holds, proposes nothing.
		expect(await room.delivery.remove(2)).toBeNull();
		expect(await room.delivery.remove(6)).toBeNull();
	});

	it('anything before there is a group', async () => {
		const room = await Room.open();
		expect(await room.delivery.submit(new Uint8Array(4), new Uint8Array(4), who(0))).toEqual({
			accepted: false,
			refusal: 'no-group'
		});
		expect(await room.delivery.remove(0)).toBeNull();
		expect(room.delivery.roster()).toEqual([]);
	});
});

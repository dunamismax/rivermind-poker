// From the group to the audio (P4C.3): each epoch's SFrame keys taken from the
// MLS group as RFC 9605 section 5.2 says, with real key stores sealing and
// opening frames across joins and leaves; the grace window; the table voice
// code; and a page that stops sending when its group holds a stranger.
import { describe, expect, it } from 'vitest';
import { Delivery } from './delivery.ts';
import {
	DEPARTURE_GRACE_MS,
	EpochKeys,
	GRACE_MS,
	checkSeats,
	type Epoch,
	type FrameKeys
} from './group-keys.ts';
import { Member, type Identity } from './group.ts';
import {
	KeyStore,
	LAYOUT,
	decodeHeader,
	deriveFrameKey,
	importBaseKey,
	kidOf,
	open
} from './sframe.ts';
import { decryptor, newTally, type EncodedFrame } from './sframe-transform.ts';
import { CODE_WORDS, voiceCode } from './voice-code.ts';
import words from './voice-words.json' with { type: 'json' };

const text = new TextEncoder();
// The code of thirty-two bytes of 7, worked out once (sixty chained rounds of PBKDF2-HMAC-SHA-256, 10,000 iterations each).
const PINNED = 'media casino old equip';
const who = (seat: number): Identity => ({ player: `player-${seat}`, seat });
const said = (data: ArrayBuffer) => new TextDecoder().decode(data);

// Timers the test moves by hand.
class Clock {
	time = 0;
	#timers: { at: number; run: () => void }[] = [];
	now = () => this.time;
	set = (run: () => void, ms: number) => {
		const timer = { at: this.time + ms, run };
		this.#timers.push(timer);
		return timer;
	};
	clear = (timer: unknown) => {
		this.#timers = this.#timers.filter((one) => one !== timer);
	};
	advance(ms: number): void {
		this.time += ms;
		const due = this.#timers.filter((one) => one.at <= this.time);
		this.#timers = this.#timers.filter((one) => one.at > this.time);
		for (const one of due) one.run();
	}
}

// A page in voice: its place in the group, and the key store its worker would hold.
class Page {
	store = new KeyStore();
	keys: EpochKeys;
	epoch!: Epoch;
	constructor(
		readonly identity: Identity,
		public member: Member,
		clock: Clock
	) {
		const frames: FrameKeys = {
			addEpoch: (epoch, baseKey) => this.store.add(epoch, baseKey),
			sendAs: (sender, epoch) => this.store.sendAs(sender, epoch),
			retire: (epoch) => this.store.retire(epoch),
			hold: (held) => this.store.hold(held)
		};
		this.keys = new EpochKeys(frames, clock);
	}
	async advance(): Promise<Epoch> {
		return (this.epoch = await this.keys.advance(this.member));
	}
	async says(words: string): Promise<Uint8Array | null> {
		return this.store.seal(text.encode(words));
	}
	async hears(frame: Uint8Array, from: Page): Promise<string> {
		const opened = await this.store.open(frame, from.member.leaf);
		return opened.ok ? said(opened.data) : opened.refusal;
	}
}

// A table's voice: the service's delivery rules and the pages, each told who is seated.
class Table {
	clock = new Clock();
	delivery!: Delivery;
	pages: Page[] = [];

	static async open(): Promise<Table> {
		const table = new Table();
		table.delivery = await Delivery.create(text.encode('table-1'));
		return table;
	}

	seated(extra: Identity[] = []): Identity[] {
		return [...this.pages.map((page) => page.identity), ...extra];
	}

	// Everyone applies what the service passed on, then takes the new epoch's keys.
	async #moved(commit: Uint8Array, author: Page, proposals: Uint8Array[]): Promise<void> {
		for (const page of this.pages) {
			if (page !== author) await page.member.receive(commit);
			for (const proposal of proposals) await page.member.receive(proposal);
		}
		for (const page of this.pages) {
			page.keys.seats(this.seated());
			await page.advance();
		}
	}

	async sit(seat: number): Promise<Page> {
		const identity = who(seat);
		const key = this.delivery.servicePublicKey;
		if (!this.delivery.groupInfo) {
			const made = await Member.create(identity, this.delivery.groupId, key);
			await this.delivery.open(made.groupInfo, identity);
			const page = new Page(identity, made.member, this.clock);
			this.pages.push(page);
			page.keys.seats(this.seated());
			await page.advance();
			return page;
		}
		const candidate = await Member.join(identity, this.delivery.groupInfo, key);
		const outcome = await this.delivery.submit(candidate.commit, candidate.groupInfo, identity);
		if (!outcome.accepted) throw new Error(outcome.refusal);
		const page = new Page(identity, candidate.member, this.clock);
		this.pages.push(page);
		await this.#moved(candidate.commit, page, outcome.proposals);
		return page;
	}

	async stand(page: Page): Promise<void> {
		this.pages = this.pages.filter((one) => one !== page);
		const proposal = (await this.delivery.remove(page.member.leaf))!;
		for (const one of this.pages) {
			// The table says the seat is empty before the group has caught up.
			one.keys.seats(this.seated());
			await one.member.receive(proposal);
		}
		const author = this.pages.find((one) => one.member.commitRank() === 0)!;
		const candidate = await author.member.commit();
		const outcome = await this.delivery.submit(
			candidate.commit,
			candidate.groupInfo,
			author.identity
		);
		if (!outcome.accepted) throw new Error(outcome.refusal);
		author.member = candidate.member;
		await this.#moved(candidate.commit, author, outcome.proposals);
	}
}

describe('SFrame keys from the group (RFC 9605, 5.2)', () => {
	it('uses E = 4 and S = 6: sixteen epochs in flight, sixty-four leaves', () => {
		expect(LAYOUT).toEqual({ epochBits: 4, senderBits: 6 });
	});

	it('seals under the exporter’s base key, with the leaf and the epoch in the key id', async () => {
		const table = await Table.open();
		const alice = await table.sit(0);
		const bob = await table.sit(1);
		expect(alice.epoch).toMatchObject({ epoch: 1n, leaf: 0 });
		expect(bob.epoch).toMatchObject({ epoch: 1n, leaf: 1 });

		const frame = (await bob.says('raise'))!;
		// KID = (sender_index << E) + (epoch % (1 << E)): leaf 1, epoch 1.
		const header = decodeHeader(frame)!;
		expect(header).toMatchObject({ kid: kidOf(LAYOUT, 1, 1n), ctr: 0n });
		expect(header.kid).toBe(0x11n);
		expect(await alice.hears(frame, bob)).toBe('raise');

		// The same frame opens under a key derived by hand from
		// MLS-Exporter("SFrame 1.0 Base Key", "", 16), with no key store in between.
		const again = (await bob.says('call'))!;
		const baseKey = await importBaseKey((await alice.member.baseKey()) as Uint8Array<ArrayBuffer>);
		expect((await alice.member.baseKey()).length).toBe(16);
		const key = await deriveFrameKey(baseKey, 0x11n, 'decrypt');
		expect(said(await open(key, decodeHeader(again)!, again))).toBe('call');
	});

	it('gives every epoch a new key: a newcomer cannot open what came before', async () => {
		const table = await Table.open();
		const alice = await table.sit(0);
		const bob = await table.sit(1);
		const before = (await alice.says('before carol'))!;
		const carol = await table.sit(2);

		expect(carol.epoch.epoch).toBe(2n);
		expect(await carol.hears(before, alice)).toBe('unknown-key');
		// Even told the epoch's number, her group's key for it is not the old group's.
		expect(await bob.hears(before, alice)).toBe('before carol');
		const after = (await alice.says('after carol'))!;
		expect(decodeHeader(after)!.kid).toBe(kidOf(LAYOUT, 0, 2n));
		expect(await carol.hears(after, alice)).toBe('after carol');
		expect(await bob.hears(after, alice)).toBe('after carol');
	});

	it('locks out someone who left: nothing sealed after opens for them', async () => {
		const table = await Table.open();
		const alice = await table.sit(0);
		const bob = await table.sit(1);
		const carol = await table.sit(2);
		const heard = (await alice.says('while bob is here'))!;
		expect(await bob.hears(heard, alice)).toBe('while bob is here');

		await table.stand(bob);
		expect(alice.epoch.epoch).toBe(3n);
		const after = (await alice.says('after bob left'))!;
		expect(await carol.hears(after, alice)).toBe('after bob left');
		// Bob's page holds epochs 1 and 2 and nothing later.
		expect(await bob.hears(after, alice)).toBe('unknown-key');
		expect(bob.store.epochs).toEqual([1n, 2n]);
		// His group state cannot produce the key either.
		const stale = await importBaseKey((await bob.member.baseKey()) as Uint8Array<ArrayBuffer>);
		const guess = await deriveFrameKey(stale, decodeHeader(after)!.kid, 'decrypt');
		await expect(open(guess, decodeHeader(after)!, after)).rejects.toThrow();
	});

	it('keeps the epoch before for the grace window, then retires it', async () => {
		const table = await Table.open();
		const alice = await table.sit(0);
		const bob = await table.sit(1);
		const late = (await alice.says('on its way'))!;
		const later = (await alice.says('too late'))!;
		await table.sit(2);

		// Sealed under epoch 1, arriving after epoch 2 began.
		expect(bob.store.epochs).toEqual([1n, 2n]);
		expect(await bob.hears(late, alice)).toBe('on its way');
		table.clock.advance(GRACE_MS - 1);
		expect(bob.store.epochs).toEqual([1n, 2n]);
		table.clock.advance(1);
		expect(bob.store.epochs).toEqual([2n]);
		expect(await bob.hears(later, alice)).toBe('stale-epoch');
		// The sender moved on at once: nothing of hers is sealed under the old epoch.
		expect(decodeHeader((await alice.says('now'))!)!.kid).toBe(kidOf(LAYOUT, 0, 2n));
	});

	it('takes epochs in order when they come quickly', async () => {
		const table = await Table.open();
		const alice = await table.sit(0);
		// Two joins before Alice's page has dealt with the first.
		const key = table.delivery.servicePublicKey;
		const states = [];
		for (const seat of [1, 2]) {
			const candidate = await Member.join(who(seat), table.delivery.groupInfo!, key);
			await table.delivery.submit(candidate.commit, candidate.groupInfo, who(seat));
			await alice.member.receive(candidate.commit);
			states.push(candidate.member);
		}
		alice.keys.seats([who(0), who(1), who(2)]);
		// Her member is at epoch 2 by now. Asked once for each commit, her page takes
		// the epoch it is at, once.
		const [first, second] = await Promise.all([alice.advance(), alice.advance()]);
		expect(first).toMatchObject({ epoch: 2n, leaf: 0 });
		expect(second).toEqual(first);
		expect(alice.store.epochs).toEqual([0n, 2n]);
		expect(alice.store.sending).toEqual({ sender: 0, epoch: 2n });
	});
});

describe('a listener that gets a frame before its key', () => {
	async function through(
		step: Transformer<EncodedFrame, EncodedFrame>,
		frames: Uint8Array[],
		between?: () => Promise<void>
	): Promise<string[]> {
		const stream = new TransformStream(step);
		const out: string[] = [];
		const reading = stream.readable.pipeTo(
			new WritableStream({ write: (one) => void out.push(said(one.data)) })
		);
		const writer = stream.writable.getWriter();
		const writes = frames.map((one) => writer.write({ data: new Uint8Array(one).buffer }));
		await between?.();
		await Promise.all(writes);
		await writer.close();
		await reading;
		return out;
	}

	it('waits for the key and loses nothing, in order', async () => {
		const table = await Table.open();
		const alice = await table.sit(0);
		const bob = await table.sit(1);
		const last = (await alice.says('old epoch'))!;

		// Carol joins. Alice's page reaches the new epoch first and speaks under it.
		const candidate = await Member.join(
			who(2),
			table.delivery.groupInfo!,
			table.delivery.servicePublicKey
		);
		await table.delivery.submit(candidate.commit, candidate.groupInfo, who(2));
		await alice.member.receive(candidate.commit);
		alice.keys.seats([who(0), who(1), who(2)]);
		await alice.advance();
		const ahead = [
			(await alice.says('one'))!,
			(await alice.says('two'))!,
			(await alice.says('three'))!
		];

		const tally = newTally('recv', 'decrypt');
		const played = await through(
			decryptor(bob.store, tally, alice.member.leaf, 2000),
			[last, ...ahead],
			async () => {
				// Bob's page gets there a moment later.
				await new Promise((resolve) => setTimeout(resolve, 30));
				await bob.member.receive(candidate.commit);
				bob.keys.seats([who(0), who(1), who(2)]);
				await bob.advance();
			}
		);
		expect(played).toEqual(['old epoch', 'one', 'two', 'three']);
		expect(tally).toMatchObject({ frames: 4, waited: 1 });
		expect(Object.values(tally.refused).every((count) => count === 0)).toBe(true);
	});

	it('gives up after the wait, once, and drops what never gets a key', async () => {
		const table = await Table.open();
		const alice = await table.sit(0);
		const bob = await table.sit(1);
		const stranger = new KeyStore();
		stranger.add(9n, await importBaseKey(new Uint8Array(16)));
		stranger.sendAs(0, 9n);
		const junk = [];
		for (let n = 0; n < 5; n++) junk.push((await stranger.seal(text.encode('junk')))!);
		const real = (await alice.says('real'))!;

		const tally = newTally('recv', 'decrypt');
		const started = performance.now();
		const played = await through(decryptor(bob.store, tally, alice.member.leaf, 40), [
			...junk,
			real
		]);
		const took = performance.now() - started;
		expect(played).toEqual(['real']);
		expect(tally.refused['unknown-key']).toBe(5);
		// One wait of 40 ms for the five of them, not five.
		expect(took).toBeGreaterThanOrEqual(35);
		expect(took).toBeLessThan(160);
	});
});

describe('the table voice code', () => {
	it('is four words of the list, the same for a given authenticator', async () => {
		const code = await voiceCode(new Uint8Array(32).fill(7));
		expect(code).toHaveLength(CODE_WORDS);
		for (const word of code) expect(words).toContain(word);
		expect(await voiceCode(new Uint8Array(32).fill(7))).toEqual(code);
		expect(await voiceCode(new Uint8Array(32).fill(8))).not.toEqual(code);
		// Pinned, so every engine and every release makes the same words of the same epoch.
		expect(code.join(' ')).toBe(PINNED);
	});

	it('is the list python-mnemonic publishes: 2,048 words, none twice', () => {
		expect(words).toHaveLength(2048);
		expect(new Set(words).size).toBe(2048);
		expect([words[0], words[2047]]).toEqual(['abandon', 'zoo']);
	});

	it('is the same on every screen in an epoch and changes with every epoch', async () => {
		const table = await Table.open();
		const alice = await table.sit(0);
		const seen = new Set([alice.epoch.code.join(' ')]);
		const bob = await table.sit(1);
		expect(bob.epoch.code).toEqual(alice.epoch.code);
		seen.add(alice.epoch.code.join(' '));
		const carol = await table.sit(2);
		expect(carol.epoch.code).toEqual(alice.epoch.code);
		expect(bob.epoch.code).toEqual(alice.epoch.code);
		seen.add(alice.epoch.code.join(' '));
		await table.stand(bob);
		expect(carol.epoch.code).toEqual(alice.epoch.code);
		seen.add(alice.epoch.code.join(' '));
		expect(seen.size).toBe(4);
	});
});

describe('a group that holds someone who is not seated', () => {
	it('is told from the seats by player and seat together', () => {
		const roster = [
			{ leaf: 0, identity: who(0) },
			{ leaf: 1, identity: who(1) },
			// A reloaded page's old leaf beside its new one: one seat, two leaves.
			{ leaf: 2, identity: who(1) }
		];
		expect(checkSeats(roster, [who(0), who(1)])).toEqual({ ok: true, strangers: [] });
		expect(checkSeats(roster, [who(0), who(1), who(5)]).ok).toBe(true);
		expect(checkSeats(roster, [who(0)])).toEqual({ ok: false, strangers: roster.slice(1) });
		// The right player in the wrong seat, and a leaf that does not say who it is.
		expect(checkSeats([{ leaf: 0, identity: { player: 'player-1', seat: 4 } }], [who(1)]).ok).toBe(
			false
		);
		expect(checkSeats([{ leaf: 3, identity: null }], [who(3)]).ok).toBe(false);
		// Someone who has just left their seat, for as long as their grace lasts.
		expect(checkSeats(roster, [who(0)], [who(1)]).ok).toBe(true);
	});

	it('stops a page sending until the group matches the seats', async () => {
		const table = await Table.open();
		const alice = await table.sit(0);
		const bob = await table.sit(1);
		expect(alice.epoch.seats.ok).toBe(true);
		expect(await alice.says('hello')).not.toBeNull();

		// Someone joins the group whom the table does not seat: the service, or
		// anyone it let in. Alice's page sees them in its own copy of the tree.
		const key = table.delivery.servicePublicKey;
		const hidden = await Member.join(
			{ player: 'listener', seat: 7 },
			table.delivery.groupInfo!,
			key
		);
		await table.delivery.submit(hidden.commit, hidden.groupInfo, { player: 'listener', seat: 7 });
		for (const page of [alice, bob]) {
			await page.member.receive(hidden.commit);
			await page.advance();
		}
		expect(alice.epoch.seats).toEqual({
			ok: false,
			strangers: [{ leaf: 2, identity: { player: 'listener', seat: 7 } }]
		});
		// Nothing is sealed under the epoch the stranger shares.
		expect(alice.store.held).toBe(true);
		expect(await alice.says('can you hear me?')).toBeNull();
		expect(await bob.says('no')).toBeNull();

		// No grace for someone who was never seated, however long the page waits.
		table.clock.advance(DEPARTURE_GRACE_MS * 2);
		expect(await alice.says('still there?')).toBeNull();

		// The table seats them after all: the page speaks again.
		expect(alice.keys.seats([who(0), who(1), { player: 'listener', seat: 7 }]).ok).toBe(true);
		expect(await alice.says('now?')).not.toBeNull();
	});

	it('speaks on while someone who stood up is removed, and no longer than the grace', async () => {
		const table = await Table.open();
		const alice = await table.sit(0);
		const bob = await table.sit(1);
		await table.sit(2);
		// The table says Bob stood up. His leaf is in the group until a commit removes it,
		// which takes a moment: Alice is not cut off mid-word for it.
		expect(alice.keys.seats([who(0), who(2)]).ok).toBe(true);
		expect(await alice.says('one moment')).not.toBeNull();
		table.clock.advance(DEPARTURE_GRACE_MS - 1);
		expect(await alice.says('still within it')).not.toBeNull();

		// The removal never comes: a service that keeps him in the group gets nothing more,
		// and the page is told, so the table can say why its microphone is off.
		const told: boolean[] = [];
		alice.keys.onseats = (seats) => told.push(seats.ok);
		table.clock.advance(1);
		expect(alice.store.held).toBe(true);
		expect(told).toEqual([false]);
		expect(await alice.says('he should not hear this')).toBeNull();

		// Then it does, and the group matches the seats again.
		await table.stand(bob);
		expect(alice.epoch.seats.ok).toBe(true);
		const after = (await alice.says('gone'))!;
		expect(await bob.hears(after, alice)).toBe('unknown-key');
	});

	it('does not hold at all when the removal comes within the grace', async () => {
		const table = await Table.open();
		const alice = await table.sit(0);
		const bob = await table.sit(1);
		await table.sit(2);
		await table.stand(bob);
		expect(alice.epoch.seats.ok).toBe(true);
		table.clock.advance(DEPARTURE_GRACE_MS * 2);
		expect(alice.store.held).toBe(false);
		expect(await alice.says('carry on')).not.toBeNull();
	});

	it('sends nothing before its first epoch is checked, or after it closes', async () => {
		const store = new KeyStore();
		const keys = new EpochKeys({
			addEpoch: (epoch, baseKey) => store.add(epoch, baseKey),
			sendAs: (sender, epoch) => store.sendAs(sender, epoch),
			retire: (epoch) => store.retire(epoch),
			hold: (held) => store.hold(held)
		});
		expect(store.held).toBe(true);
		const delivery = await Delivery.create(text.encode('t'));
		const made = await Member.create(who(0), delivery.groupId, delivery.servicePublicKey);
		// The page has not been told who is seated: its own leaf is a stranger to it.
		expect((await keys.advance(made.member)).seats.ok).toBe(false);
		expect(await store.seal(text.encode('x'))).toBeNull();
		expect(keys.seats([who(0)]).ok).toBe(true);
		expect(await store.seal(text.encode('x'))).not.toBeNull();
		keys.close();
		expect(await store.seal(text.encode('x'))).toBeNull();
	});
});

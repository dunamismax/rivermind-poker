// From the table's MLS group to the keys its audio is sealed under (P4C.3):
// each epoch's SFrame base key (RFC 9605 section 5.2), handed to the worker
// that seals and opens frames, the voice code for the epoch, and the check of
// the group's members against the table's seats.
//
// When the group moves to a new epoch a page takes the new key at once and
// sends under it at once, so that nothing said after someone left is sealed
// under a key they hold. It keeps the epoch before for a grace window, for
// frames still on their way. A listener that gets a frame before its key
// waits for the key (sframe-transform.ts).
import type { Identity, Leaf, Member } from './group.ts';
import { importBaseKey } from './sframe.ts';
import { voiceCode } from './voice-code.ts';

// What an epoch's keys are given to: `FrameCrypto` on a page (sframe-client.ts).
export type FrameKeys = {
	addEpoch(epoch: bigint, baseKey: CryptoKey): void;
	sendAs(sender: number, epoch: bigint): void;
	retire(epoch: bigint): void;
	hold(held: boolean): void;
};

// How long the epoch before stays open for the frames sealed under it: long
// enough for anything a jitter buffer would still play, short next to a hand.
export const GRACE_MS = 2000;

// How long someone who has just left their seat may stay in the group before
// they count as a stranger. Their removal takes a commit, which follows the
// empty seat by a moment; without this every speaker would fall silent for
// that moment each time anyone stood up. It is only for people this page saw
// seated: someone who never held a seat is a stranger at once.
export const DEPARTURE_GRACE_MS = 3000;

// The group's members against the people seated at the table, as the table
// itself reports them. A leaf is a stranger when it does not say who it is,
// or says it is someone who holds no seat and has not just left one. Seats
// are counted, not leaves: a reloaded page's old leaf stays for a moment
// beside its new one.
export type Seats = { ok: boolean; strangers: Leaf[] };

const same = (a: Identity, b: Identity) => a.player === b.player && a.seat === b.seat;

export function checkSeats(roster: Leaf[], seated: Identity[], leaving: Identity[] = []): Seats {
	const strangers = roster.filter(
		({ identity }) =>
			!identity ||
			!(seated.some((one) => same(one, identity)) || leaving.some((one) => same(one, identity)))
	);
	return { ok: strangers.length === 0, strangers };
}

export type Epoch = {
	epoch: bigint;
	// This page's leaf: the sender in its frames' key ids.
	leaf: number;
	// The table voice code, the same on every screen in this epoch.
	code: string[];
	seats: Seats;
};

type Timers = {
	now(): number;
	set(run: () => void, ms: number): unknown;
	clear(timer: unknown): void;
};
const realTimers: Timers = {
	now: () => performance.now(),
	set: (run, ms) => setTimeout(run, ms),
	clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)
};

export class EpochKeys {
	#frames: FrameKeys;
	#timers: Timers;
	#graceMs: number;
	#seated: Identity[] = [];
	// People this page saw leave a seat, and when their grace runs out.
	#leaving: { identity: Identity; until: number; timer: unknown }[] = [];
	#roster: Leaf[] = [];
	#current: bigint | null = null;
	#latest: Epoch | null = null;
	#retiring = new Map<bigint, unknown>();
	// Epochs are taken one at a time, in the order the group reached them.
	#queue: Promise<unknown> = Promise.resolve();
	// Told when the check of members against seats changes by itself: the grace
	// of someone who left their seat ran out and they are in the group still.
	// The page shows what it is told here; the hold is already in place.
	onseats: ((seats: Seats) => void) | null = null;

	constructor(frames: FrameKeys, timers: Timers = realTimers, graceMs: number = GRACE_MS) {
		this.#frames = frames;
		this.#timers = timers;
		this.#graceMs = graceMs;
		// Nothing is sent before the first epoch's members have been checked.
		frames.hold(true);
	}

	// The group this page is in reached a new epoch, or the page has just
	// joined: take its key, check who is in it, and send under it.
	advance(member: Member): Promise<Epoch> {
		const taken = this.#queue.then(() => this.#take(member));
		this.#queue = taken.catch(() => {});
		return taken;
	}

	async #take(member: Member): Promise<Epoch> {
		const epoch = member.epoch;
		// Asked twice for one epoch, as when two commits arrive together and the
		// member has already applied both: the second asking changes nothing.
		if (this.#latest?.epoch === epoch) return this.#latest;
		const bytes = await member.baseKey();
		const key = await importBaseKey(bytes as Uint8Array<ArrayBuffer>);
		// The key lives in WebCrypto from here on; these bytes are done with.
		bytes.fill(0);
		this.#frames.addEpoch(epoch, key);
		this.#roster = member.roster();
		const seats = this.#check();
		// Held before the page sends under the new epoch, never after.
		this.#frames.hold(!seats.ok);
		this.#frames.sendAs(member.leaf, epoch);
		const before = this.#current;
		this.#current = epoch;
		if (before !== null && before !== epoch) {
			this.#retiring.set(
				before,
				this.#timers.set(() => {
					this.#retiring.delete(before);
					this.#frames.retire(before);
				}, this.#graceMs)
			);
		}
		this.#latest = {
			epoch,
			leaf: member.leaf,
			code: await voiceCode(member.authenticator),
			seats
		};
		return this.#latest;
	}

	#check(): Seats {
		const now = this.#timers.now();
		return checkSeats(
			this.#roster,
			this.#seated,
			this.#leaving.filter((one) => one.until > now).map((one) => one.identity)
		);
	}

	// Look again, and hold or release the page's sending by what is found.
	#recheck(): Seats {
		const seats = this.#check();
		if (this.#current !== null) this.#frames.hold(!seats.ok);
		if (this.#latest) this.#latest = { ...this.#latest, seats };
		return seats;
	}

	// The table's seats changed: someone sat down, stood up or was moved. A page
	// stops sending the moment its group holds someone who was never seated,
	// and, once their grace has run out, someone who left their seat and is in
	// the group still. It starts again when the group matches the seats.
	seats(seated: Identity[]): Seats {
		const now = this.#timers.now();
		for (const identity of this.#seated) {
			if (seated.some((one) => same(one, identity))) continue;
			if (this.#leaving.some((one) => same(one.identity, identity))) continue;
			const timer = this.#timers.set(() => {
				this.#leaving = this.#leaving.filter((one) => one.timer !== timer);
				const before = this.#latest?.seats.ok;
				const seats = this.#recheck();
				if (seats.ok !== before) this.onseats?.(seats);
			}, DEPARTURE_GRACE_MS);
			this.#leaving.push({ identity, until: now + DEPARTURE_GRACE_MS, timer });
		}
		this.#seated = seated;
		return this.#recheck();
	}

	// This page left voice, or was removed from the group: send nothing more.
	close(): void {
		this.#frames.hold(true);
		for (const timer of this.#retiring.values()) this.#timers.clear(timer);
		this.#retiring.clear();
		for (const { timer } of this.#leaving) this.#timers.clear(timer);
		this.#leaving = [];
	}
}

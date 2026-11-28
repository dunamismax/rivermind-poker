/**
 * Anonymous players and their display handles (P4.1), ported from
 * `rivermind/server/players.py` (P4B.5a).
 *
 * A first visit makes a player with a random handle such as `Quiet Heron 42`.
 * {@link MemoryPlayers} keeps them for a server without a database, and
 * {@link DatabasePlayers} stores them in the `players` table.
 */
import { randomInt } from 'node:crypto';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/index.ts';
import { players } from '../db/schema.ts';
import { guestName, newPlayerId } from './auth.ts';
import { handleAllowed } from './safety.ts';

export const ADJECTIVES = [
	'Amber', 'Arctic', 'Bold', 'Brave', 'Bright', 'Calm', 'Clever', 'Cosmic', 'Crimson', 'Daring',
	'Dusky', 'Eager', 'Fabled', 'Fierce', 'Gentle', 'Gilded', 'Golden', 'Grand', 'Happy', 'Hidden',
	'Humble', 'Iron', 'Jade', 'Jolly', 'Keen', 'Lucky', 'Lunar', 'Mellow', 'Merry', 'Misty',
	'Noble', 'Nimble', 'Patient', 'Plucky', 'Proud', 'Quick', 'Quiet', 'Rapid', 'Royal', 'Rustic',
	'Sharp', 'Silent', 'Silver', 'Sly', 'Solar', 'Steady', 'Stormy', 'Sunny', 'Swift', 'Tidy',
	'Valiant', 'Velvet', 'Vivid', 'Wandering', 'Wild', 'Wily', 'Wise', 'Witty', 'Young', 'Zesty'
] as const; // prettier-ignore
export const ANIMALS = [
	'Badger', 'Bear', 'Bison', 'Cobra', 'Condor', 'Coyote', 'Crane', 'Dolphin', 'Eagle', 'Falcon',
	'Ferret', 'Finch', 'Fox', 'Gecko', 'Gull', 'Hare', 'Hawk', 'Heron', 'Ibis', 'Jackal',
	'Jaguar', 'Kestrel', 'Koala', 'Lark', 'Lemur', 'Leopard', 'Lion', 'Lynx', 'Magpie', 'Marten',
	'Mink', 'Moose', 'Newt', 'Ocelot', 'Orca', 'Osprey', 'Otter', 'Owl', 'Panda', 'Panther',
	'Pelican', 'Puffin', 'Puma', 'Raven', 'Robin', 'Salmon', 'Seal', 'Shark', 'Sparrow', 'Stag',
	'Stoat', 'Swan', 'Tiger', 'Toucan', 'Trout', 'Turtle', 'Viper', 'Walrus', 'Wolf', 'Wren'
] as const; // prettier-ignore
const HANDLE_ATTEMPTS = 8;

/** A handle like `Quiet Heron 42`: one of 360,000, chosen with `node:crypto`, never a blocked word (P4.5). */
export function randomHandle(): string {
	for (;;) {
		const handle = `${ADJECTIVES[randomInt(ADJECTIVES.length)]} ${ANIMALS[randomInt(ANIMALS.length)]} ${randomInt(100)}`;
		if (handleAllowed(handle)) return handle;
	}
}

export interface PlayerRecord {
	readonly playerId: string;
	readonly handle: string;
}

export interface PlayerStore {
	/** A new player with a handle no one else has. */
	create(): Promise<PlayerRecord>;
	/** The player with this id, made with their Phase 3 guest handle if missing. */
	claim(playerId: string): Promise<PlayerRecord>;
	get(playerId: string): Promise<PlayerRecord | null>;
	/** Record a visit. */
	seen(playerId: string): Promise<void>;
	/** Give a player a new random handle, as moderation does for a reported one (P4.5). */
	rename(playerId: string): Promise<PlayerRecord>;
	/**
	 * Mark a guest as asking to be deleted (P5D.11): from now on `get` does not find
	 * them, so no session opens as them, until `erase` removes them.
	 */
	markDeleted(playerId: string): Promise<void>;
	/** The guests marked deleted and not yet erased, as at start-up after a restart. */
	pendingDeletions(): Promise<string[]>;
	/**
	 * Remove a guest marked deleted. Their ledger goes with them, so every wallet left
	 * still adds up; their mutes, blocks, reports and suspension go too. Does nothing
	 * for a guest already erased.
	 */
	erase(playerId: string): Promise<void>;
}

/** Players for a server without a database: they last as long as the process. */
export class MemoryPlayers implements PlayerStore {
	private readonly byId = new Map<string, PlayerRecord>();
	private readonly handles = new Set<string>();
	private readonly deleted = new Set<string>();

	private add(playerId: string, handle: string): PlayerRecord | null {
		if (this.handles.has(handle)) return null;
		const record = { playerId, handle };
		this.byId.set(playerId, record);
		this.handles.add(handle);
		return record;
	}

	async create(): Promise<PlayerRecord> {
		for (let i = 0; i < HANDLE_ATTEMPTS; i++) {
			const record = this.add(newPlayerId(), randomHandle());
			if (record) return record;
		}
		throw new Error('could not find a free handle');
	}

	async claim(playerId: string): Promise<PlayerRecord> {
		// A legacy guest who has since deleted themself starts again as someone new.
		if (this.deleted.has(playerId)) return this.create();
		const existing = this.byId.get(playerId);
		if (existing) return existing;
		let handle = guestName(playerId);
		if (this.handles.has(handle)) handle = `${handle} ${playerId.slice(2, 6)}`;
		const record = this.add(playerId, handle);
		if (!record) throw new Error(`handle ${handle} is taken`);
		return record;
	}

	async get(playerId: string): Promise<PlayerRecord | null> {
		return this.deleted.has(playerId) ? null : (this.byId.get(playerId) ?? null);
	}

	/** The handle of a known player, without waiting: for {@link MemorySafety}. */
	handleOf(playerId: string): string | null {
		return this.byId.get(playerId)?.handle ?? null;
	}

	async markDeleted(playerId: string): Promise<void> {
		if (this.byId.has(playerId)) this.deleted.add(playerId);
	}

	async pendingDeletions(): Promise<string[]> {
		return [...this.deleted].filter((id) => this.byId.has(id));
	}

	async erase(playerId: string): Promise<void> {
		const record = this.byId.get(playerId);
		if (!record || !this.deleted.has(playerId)) return;
		this.byId.delete(playerId);
		this.handles.delete(record.handle);
	}

	async seen(): Promise<void> {}

	async rename(playerId: string): Promise<PlayerRecord> {
		const old = this.byId.get(playerId);
		if (!old) throw new Error(`unknown player ${playerId}`);
		for (let i = 0; i < HANDLE_ATTEMPTS; i++) {
			const handle = randomHandle();
			if (this.handles.has(handle)) continue;
			this.handles.delete(old.handle);
			this.handles.add(handle);
			const record = { playerId, handle };
			this.byId.set(playerId, record);
			return record;
		}
		throw new Error('could not find a free handle');
	}
}

/** Players in the `players` table. */
export class DatabasePlayers implements PlayerStore {
	readonly db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	private async insert(playerId: string, handle: string): Promise<boolean> {
		const inserted = await this.db
			.insert(players)
			.values({ id: playerId, handle })
			.onConflictDoNothing()
			.returning({ id: players.id });
		return inserted.length > 0;
	}

	async create(): Promise<PlayerRecord> {
		for (let i = 0; i < HANDLE_ATTEMPTS; i++) {
			const playerId = newPlayerId();
			const handle = randomHandle();
			if (await this.insert(playerId, handle)) return { playerId, handle };
		}
		throw new Error('could not find a free handle');
	}

	async claim(playerId: string): Promise<PlayerRecord> {
		const existing = await this.get(playerId);
		if (existing) return existing;
		// A legacy guest who has since deleted themself starts again as someone new.
		const gone = await this.db
			.select({ id: players.id })
			.from(players)
			.where(and(eq(players.id, playerId), isNotNull(players.deletedAt)));
		if (gone.length) return this.create();
		const handle = guestName(playerId);
		if (!(await this.insert(playerId, handle))) {
			await this.insert(playerId, `${handle} ${playerId.slice(2, 6)}`);
		}
		const record = await this.get(playerId);
		if (!record) throw new Error(`could not store player ${playerId}`);
		return record;
	}

	async get(playerId: string): Promise<PlayerRecord | null> {
		const rows = await this.db
			.select({ handle: players.handle })
			.from(players)
			.where(and(eq(players.id, playerId), isNull(players.deletedAt)));
		return rows.length ? { playerId, handle: rows[0].handle } : null;
	}

	async markDeleted(playerId: string): Promise<void> {
		await this.db
			.update(players)
			.set({ deletedAt: sql`now()` })
			.where(and(eq(players.id, playerId), isNull(players.deletedAt)));
	}

	async pendingDeletions(): Promise<string[]> {
		const rows = await this.db
			.select({ id: players.id })
			.from(players)
			.where(isNotNull(players.deletedAt))
			.orderBy(players.deletedAt);
		return rows.map((r) => r.id);
	}

	async erase(playerId: string): Promise<void> {
		// ON DELETE CASCADE takes the ledger, reports, mutes, blocks and suspension in the
		// same statement, so a wallet and its entries go together.
		await this.db
			.delete(players)
			.where(and(eq(players.id, playerId), isNotNull(players.deletedAt)));
	}

	async seen(playerId: string): Promise<void> {
		await this.db
			.update(players)
			.set({ lastSeenAt: sql`now()` })
			.where(eq(players.id, playerId));
	}

	async rename(playerId: string): Promise<PlayerRecord> {
		if (!(await this.get(playerId))) throw new Error(`unknown player ${playerId}`);
		for (let i = 0; i < HANDLE_ATTEMPTS; i++) {
			const handle = randomHandle();
			const renamed = await this.db.transaction(async (tx) => {
				const taken = await tx
					.select({ id: players.id })
					.from(players)
					.where(eq(players.handle, handle));
				if (taken.length) return false;
				await tx.update(players).set({ handle }).where(eq(players.id, playerId));
				return true;
			});
			if (renamed) return { playerId, handle };
		}
		throw new Error('could not find a free handle');
	}
}

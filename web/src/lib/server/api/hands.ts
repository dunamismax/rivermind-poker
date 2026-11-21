/**
 * The hands each player played, for their hand history (P4.6), ported from
 * `rivermind/server/hands.py` (P4B.5a).
 *
 * When a hand ends the table records who was dealt into each seat. With a
 * database the table store writes those seats to `hand_players` beside the
 * hand's replayable history (P4B.5b), and {@link DatabaseHands} reads them
 * back. Without one, {@link MemoryHands} keeps the newest hands in memory.
 * Either way a player is shown only hands they were dealt into, and
 * `views.handDetail` leaves out every card they may not see. Hands from a
 * practice table (P6.0b) are marked `practice`.
 */
import { desc, eq, inArray, lt, and, asc } from 'drizzle-orm';
import type { Database } from '../db/index.ts';
import { handHistories, handPlayers, hands, pokerTables } from '../db/schema.ts';
import { handRecord, type JsonObject } from '../engine/history.ts';
import type { HandState } from '../engine/state.ts';
import { epochOf, wallClock } from './time.ts';

/** Hands a server without a database keeps, newest first. */
export const MEMORY_HANDS = 5_000;
export const MEMORY_PER_PLAYER = 200;

/** A seat dealt into a finished hand. `playerId` is null for a bot. */
export interface HandSeatRecord {
	seat: number;
	playerId: string | null;
	name: string;
	bot: string | null;
	/** Chips won (positive) or lost in the hand. */
	net: number;
}

export interface PlayedHand {
	handId: string;
	tableId: string;
	tableName: string;
	handNo: number;
	/** When the hand ended, in seconds since the epoch. */
	at: number;
	/** The `history.handRecord` document. */
	record: JsonObject;
	seats: readonly HandSeatRecord[];
	/** Played at a practice table (P6.0b), so not counted in competitive stats. */
	practice: boolean;
}

export function seatOf(hand: PlayedHand, playerId: string): number | null {
	return hand.seats.find((s) => s.playerId === playerId)?.seat ?? null;
}

/** Who sat in a seat dealt into a hand. */
export interface SeatedPlayer {
	playerId: string;
	name: string;
	bot: string | null;
}

/** A hand as the table finished it: its number, final state and who sat in each seat. */
export interface FinishedHand {
	handNo: number;
	state: HandState;
	seats: readonly (SeatedPlayer | null)[];
}

/** Who played each seat dealt into the hand, and what they won or lost. */
export function seatRecords(finished: FinishedHand): HandSeatRecord[] {
	const { state } = finished;
	const records: HandSeatRecord[] = [];
	finished.seats.forEach((who, seat) => {
		if (who === null) return;
		records.push({
			seat,
			playerId: who.bot ? null : who.playerId,
			name: who.name,
			bot: who.bot,
			net: state.stacks[seat] - (state.startingStacks[seat] ?? 0)
		});
	});
	return records;
}

export interface HandArchive {
	/** The player's hands, newest first, older than `before` if given. */
	played(playerId: string, limit: number, before?: string | null): Promise<PlayedHand[]>;
	get(handId: string): Promise<PlayedHand | null>;
}

/** A hand id as a number, or null if it is not one. */
function number(value: string | null | undefined): number | null {
	if (value === null || value === undefined || !/^[0-9]{1,18}$/.test(value)) return null;
	const n = Number(value);
	return Number.isSafeInteger(n) ? n : null;
}

/** The newest finished hands, for a server without a database. */
export class MemoryHands implements HandArchive {
	private readonly kept = new Map<number, PlayedHand>();
	private readonly byPlayer = new Map<string, number[]>();
	private readonly limit: number;
	private readonly perPlayer: number;
	private next = 1;

	constructor(limit = MEMORY_HANDS, perPlayer = MEMORY_PER_PLAYER) {
		this.limit = limit;
		this.perPlayer = perPlayer;
	}

	add(
		tableId: string,
		tableName: string,
		finished: FinishedHand,
		practice = false,
		at = wallClock()
	): PlayedHand {
		const seats = seatRecords(finished);
		const handId = this.next++;
		const hand: PlayedHand = {
			handId: String(handId),
			tableId,
			tableName,
			handNo: finished.handNo,
			at,
			record: handRecord(finished.state),
			seats,
			practice
		};
		this.kept.set(handId, hand);
		for (const seat of seats) {
			if (seat.playerId === null) continue;
			let mine = this.byPlayer.get(seat.playerId);
			if (!mine) this.byPlayer.set(seat.playerId, (mine = []));
			mine.push(handId);
			if (mine.length > this.perPlayer) mine.shift();
		}
		while (this.kept.size > this.limit) {
			this.kept.delete(this.kept.keys().next().value as number);
		}
		return hand;
	}

	async played(playerId: string, limit: number, before?: string | null): Promise<PlayedHand[]> {
		const cutoff = number(before);
		const ids = this.byPlayer.get(playerId) ?? [];
		const found: PlayedHand[] = [];
		for (let i = ids.length - 1; i >= 0 && found.length < limit; i--) {
			const hand = this.kept.get(ids[i]);
			if (hand && (cutoff === null || ids[i] < cutoff)) found.push(hand);
		}
		return found;
	}

	async get(handId: string): Promise<PlayedHand | null> {
		const n = number(handId);
		return n === null ? null : (this.kept.get(n) ?? null);
	}
}

/** Finished hands in PostgreSQL (`hands`, `hand_histories` and `hand_players`). */
export class DatabaseHands implements HandArchive {
	readonly db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	private async load(handIds: number[]): Promise<PlayedHand[]> {
		if (!handIds.length) return [];
		const rows = await this.db
			.select({
				id: hands.id,
				tableId: hands.tableId,
				name: pokerTables.name,
				handNo: hands.handNo,
				endedAt: epochOf(hands.endedAt),
				record: handHistories.record,
				practice: pokerTables.practice
			})
			.from(hands)
			.innerJoin(handHistories, eq(handHistories.handId, hands.id))
			.innerJoin(pokerTables, eq(pokerTables.id, hands.tableId))
			.where(inArray(hands.id, handIds));
		const seatRows = await this.db
			.select({
				handId: handPlayers.handId,
				seat: handPlayers.seatNo,
				playerId: handPlayers.playerId,
				name: handPlayers.displayName,
				bot: handPlayers.botKind,
				net: handPlayers.net
			})
			.from(handPlayers)
			.where(inArray(handPlayers.handId, handIds))
			.orderBy(asc(handPlayers.seatNo));
		const seats = new Map<number, HandSeatRecord[]>();
		for (const { handId, ...seat } of seatRows) {
			let mine = seats.get(handId);
			if (!mine) seats.set(handId, (mine = []));
			mine.push(seat);
		}
		const found = new Map<number, PlayedHand>();
		for (const row of rows) {
			found.set(row.id, {
				handId: String(row.id),
				tableId: row.tableId,
				tableName: row.name,
				handNo: row.handNo,
				at: row.endedAt ?? 0,
				record: row.record as JsonObject,
				seats: seats.get(row.id) ?? [],
				practice: row.practice
			});
		}
		return handIds.flatMap((id) => found.get(id) ?? []);
	}

	async played(playerId: string, limit: number, before?: string | null): Promise<PlayedHand[]> {
		const cutoff = number(before);
		const mine = eq(handPlayers.playerId, playerId);
		const rows = await this.db
			.select({ id: handPlayers.handId })
			.from(handPlayers)
			.where(cutoff === null ? mine : and(mine, lt(handPlayers.handId, cutoff)))
			.orderBy(desc(handPlayers.handId))
			.limit(limit);
		return this.load(rows.map((r) => r.id));
	}

	async get(handId: string): Promise<PlayedHand | null> {
		const n = number(handId);
		if (n === null) return null;
		const [found] = await this.load([n]);
		return found ?? null;
	}
}

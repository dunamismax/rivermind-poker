// Durable tables in PostgreSQL: a port of rivermind/server/store.py (P4B.5b),
// writing the same rows, so either server restores the other's tables.
//
// `TableStore` keeps each open table's snapshot (`tableToDict`) in
// `poker_tables.state`, mirrors its occupied seats into `seats`, records every
// hand dealt in `hands` and stores each finished hand's replayable history in
// `hand_histories`, with who played each seat in `hand_players` (P4.6).
// `TableSaver` is the runner hook that saves a table after every change and
// before anyone hears of it, so a player never sees a state the server could
// lose. At start-up `loadOpen` returns the tables to restore. A closed table
// keeps its row and hands but drops its state.
//
// If a save fails the table keeps playing from memory, the failure is logged
// and the next save catches up, finished hands included.
//
// Chips that leave a table for a wallet (P4.2) are paid in the same
// transaction as the save that took them off the table, so a crash can never
// pay them twice or lose them. A practice table (P6.0b) pays nothing: its
// chips never came from a wallet. Its row is marked `practice`, so its hands
// stay out of competitive stats.

import { and, asc, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import { seatRecords, type HandSeatRecord } from '../api/hands.ts';
import {
	applyEntry,
	creditsFor,
	UnknownPlayer,
	type Credit,
	type Executor
} from '../api/wallet.ts';
import type { Database } from '../db/index.ts';
import { handHistories, handPlayers, hands, pokerTables, seats } from '../db/schema.ts';
import { FORMAT as HISTORY_FORMAT, handRecord, type JsonObject } from '../engine/history.ts';
import type { Log, TableRunner } from './runner.ts';
import { consoleLog } from './runner.ts';
import { FORMAT as SNAPSHOT_FORMAT, READABLE, tableToDict } from './snapshot.ts';
import type { Table } from './table.ts';

export interface FinishedHand {
	handNo: number;
	button: number;
	/** A `history.handRecord` document. */
	record: JsonObject;
	/** Who played each seat dealt in (P4.6). */
	seats: readonly HandSeatRecord[];
}

export interface SavedTable {
	tableId: string;
	name: string;
	state: Record<string, unknown>;
}

export interface SeatRow {
	seatNo: number;
	displayName: string;
	botKind: string | null;
	stack: number;
	sittingOut: boolean;
}

export function seatRows(table: Table): SeatRow[] {
	return table.players().map(([seat, player]) => ({
		seatNo: seat,
		displayName: player.name,
		botKind: player.bot,
		stack: table.stackOf(seat),
		sittingOut: player.sittingOut
	}));
}

export interface Save {
	tableId: string;
	name: string;
	/** The snapshot, with the lobby settings under `lobby`. */
	state: Record<string, unknown>;
	seats: readonly SeatRow[];
	/** The hand in the snapshot, if any. */
	current: { handNo: number; button: number } | null;
	/** Hands that ended since the last save. */
	finished?: readonly FinishedHand[];
	/** Chips people took away since the last save. */
	credits?: readonly Credit[];
}

/** What a runner's saver needs from a store; tests substitute their own. */
export interface TableStorage {
	save(save: Save): Promise<void>;
	close(tableId: string, credits?: readonly Credit[]): Promise<void>;
	loadOpen(): Promise<SavedTable[]>;
}

export class TableStore implements TableStorage {
	readonly db: Database;
	private readonly log: Log;

	constructor(db: Database, log: Log = consoleLog) {
		this.db = db;
		this.log = log;
	}

	/** Save a table's snapshot, its seats, its hands and its wallet credits in one transaction. */
	async save(save: Save): Promise<void> {
		const { tableId, name, state } = save;
		const config = state.config as Record<string, number>;
		const lobby = (state.lobby ?? {}) as Record<string, unknown>;
		await this.db.transaction(async (tx) => {
			await this.pay(tx, save.credits ?? []);
			await tx
				.insert(pokerTables)
				.values({
					id: tableId,
					name,
					seatCount: config.seat_count,
					smallBlind: config.small_blind,
					bigBlind: config.big_blind,
					ante: config.ante,
					minBuyIn: config.min_buy_in,
					maxBuyIn: config.max_buy_in,
					status: 'open',
					state,
					stateFormat: SNAPSHOT_FORMAT,
					practice: typeof lobby.practice === 'string'
				})
				.onConflictDoUpdate({
					target: pokerTables.id,
					set: { name, state, stateFormat: SNAPSHOT_FORMAT, updatedAt: sql`now()` },
					setWhere: eq(pokerTables.status, 'open')
				});
			const occupied = save.seats.map((row) => row.seatNo);
			await tx
				.delete(seats)
				.where(
					occupied.length
						? and(eq(seats.tableId, tableId), notInArray(seats.seatNo, occupied))
						: eq(seats.tableId, tableId)
				);
			for (const row of save.seats) {
				await tx
					.insert(seats)
					.values({
						tableId,
						seatNo: row.seatNo,
						displayName: row.displayName,
						isBot: row.botKind !== null,
						botKind: row.botKind,
						stack: row.stack,
						sittingOut: row.sittingOut
					})
					.onConflictDoUpdate({
						target: [seats.tableId, seats.seatNo],
						set: {
							// A different occupant is a new arrival. SET sees the old row.
							joinedAt: sql`CASE WHEN ${seats.displayName} = excluded.display_name THEN ${seats.joinedAt} ELSE now() END`,
							displayName: sql`excluded.display_name`,
							isBot: sql`excluded.is_bot`,
							botKind: sql`excluded.bot_kind`,
							stack: sql`excluded.stack`,
							sittingOut: sql`excluded.sitting_out`
						}
					});
			}
			for (const hand of save.finished ?? []) {
				const [{ id: handId }] = await tx
					.insert(hands)
					.values({ tableId, handNo: hand.handNo, button: hand.button, endedAt: sql`now()` })
					.onConflictDoUpdate({
						target: [hands.tableId, hands.handNo],
						set: { endedAt: sql`coalesce(${hands.endedAt}, now())` }
					})
					.returning({ id: hands.id });
				await tx
					.insert(handHistories)
					.values({ handId, format: HISTORY_FORMAT, record: hand.record })
					.onConflictDoNothing({ target: handHistories.handId });
				if (hand.seats.length) {
					await tx
						.insert(handPlayers)
						.values(
							hand.seats.map((seat) => ({
								handId,
								seatNo: seat.seat,
								playerId: seat.playerId,
								displayName: seat.name,
								botKind: seat.bot,
								net: seat.net
							}))
						)
						.onConflictDoNothing({ target: [handPlayers.handId, handPlayers.seatNo] });
				}
			}
			if (save.current !== null) {
				await tx
					.insert(hands)
					.values({ tableId, handNo: save.current.handNo, button: save.current.button })
					.onConflictDoNothing({ target: [hands.tableId, hands.handNo] });
			}
		});
	}

	/**
	 * Mark a table closed: it is not restored again, and its state is dropped.
	 * `credits` pay back the chips of anyone still seated, in the same transaction.
	 */
	async close(tableId: string, credits: readonly Credit[] = []): Promise<void> {
		await this.db.transaction(async (tx) => {
			await this.pay(tx, credits);
			await tx
				.update(pokerTables)
				.set({ status: 'closed', state: null, stateFormat: null, updatedAt: sql`now()` })
				.where(eq(pokerTables.id, tableId));
			await tx.delete(seats).where(eq(seats.tableId, tableId));
		});
	}

	/** Every open table with a saved state, oldest first. */
	async loadOpen(): Promise<SavedTable[]> {
		const rows = await this.db
			.select({
				id: pokerTables.id,
				name: pokerTables.name,
				state: pokerTables.state,
				stateFormat: pokerTables.stateFormat
			})
			.from(pokerTables)
			.where(and(eq(pokerTables.status, 'open'), isNotNull(pokerTables.state)))
			.orderBy(asc(pokerTables.createdAt), asc(pokerTables.id));
		const saved: SavedTable[] = [];
		for (const row of rows) {
			if (row.stateFormat === null || !READABLE.has(row.stateFormat) || row.state === null) {
				this.log.warn(
					`Table ${row.id} has snapshot format ${row.stateFormat}, which this server cannot restore`
				);
				continue;
			}
			saved.push({ tableId: row.id, name: row.name, state: row.state });
		}
		return saved;
	}

	/** The stored history document of a finished hand. */
	async history(tableId: string, handNo: number): Promise<Record<string, unknown> | null> {
		const rows = await this.db
			.select({ record: handHistories.record })
			.from(handHistories)
			.innerJoin(hands, eq(hands.id, handHistories.handId))
			.where(and(eq(hands.tableId, tableId), eq(hands.handNo, handNo)));
		return rows[0]?.record ?? null;
	}

	private async pay(tx: Executor, credits: readonly Credit[]): Promise<void> {
		for (const credit of credits) {
			try {
				await tx.transaction((nested) =>
					applyEntry(nested, credit.playerId, credit.amount, credit.kind, credit.tableId)
				);
			} catch (error) {
				if (!(error instanceof UnknownPlayer)) throw error;
				// Seated before wallets existed (P4.2) and never back since: nobody to pay.
				this.log.warn(
					`No wallet for ${credit.playerId}; ${credit.amount} chips from table ${credit.tableId} dropped`
				);
			}
		}
	}
}

/** A `beforePublish` hook that saves its table before each change is published. */
export class TableSaver {
	readonly store: TableStorage;
	/** Finished hands not yet stored, kept until a save succeeds. */
	pending: FinishedHand[] = [];
	/** Chips owed to wallets, kept until a save succeeds. */
	credits: Credit[] = [];
	failures = 0;
	private readonly log: Log;

	constructor(store: TableStorage, log: Log = consoleLog) {
		this.store = store;
		this.log = log;
	}

	readonly hook = async (runner: TableRunner): Promise<void> => {
		const table = runner.table;
		for (const finished of table.drainFinished()) {
			this.pending.push({
				handNo: finished.handNo,
				button: finished.state.button,
				record: handRecord(finished.state),
				seats: seatRecords(finished)
			});
		}
		const departures = table.drainDepartures();
		if (runner.practice === null) this.credits.push(...creditsFor(runner.tableId, departures));
		const state: Record<string, unknown> = tableToDict(table);
		state.lobby = runner.lobbyState();
		const finished = [...this.pending];
		const credits = [...this.credits];
		try {
			await this.store.save({
				tableId: runner.tableId,
				name: runner.name,
				state,
				seats: seatRows(table),
				current: table.hand === null ? null : { handNo: table.handNo, button: table.hand.button },
				finished,
				credits
			});
		} catch (error) {
			this.failures += 1;
			this.log.error(`Could not save table ${runner.tableId}; it plays on from memory`, error);
			return;
		}
		this.pending.splice(0, finished.length);
		this.credits.splice(0, credits.length);
	};
}

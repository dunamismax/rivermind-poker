/**
 * Play-chip wallets and their ledger (P4.2), ported from
 * `rivermind/server/wallet.py` (P4B.5a).
 *
 * Chips are play money only, forever (D-1): they can never be bought, sold,
 * cashed out or transferred for value. Each player's balance changes only
 * together with a ledger entry, so the entries always add up to it, and a
 * balance can never go negative.
 *
 * - A player's first visit pays a starting grant. Later visits top a balance
 *   below {@link TOP_UP_FLOOR} back up to it, at most once a day.
 * - Sitting down and rebuying are paid from the wallet before the chips reach
 *   the table, and refunded if the table refuses them.
 * - Chips come back when the player leaves (`cash_out`) and when a waiting
 *   rebuy no longer fits (`refund`). With a database, the table store writes
 *   those in the same transaction as the table save that removed the chips
 *   (P4B.5b), through {@link applyEntry}.
 *
 * {@link MemoryWallet} keeps balances for a server without a database and
 * {@link DatabaseWallet} keeps them in `players.balance` and `ledger_entries`.
 */
import { desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/index.ts';
import { ledgerEntries, players, type LedgerKind } from '../db/schema.ts';
import { commas, epochOf, wallClock } from './time.ts';

/** Chips a new player starts with: 100 big blinds at 100/200. */
export const STARTING_GRANT = 20_000;
/** A visit tops a balance below this back up to it, once a day. */
export const TOP_UP_FLOOR = 10_000;
export const TOP_UP_SECONDS = 24 * 3600;
export const CREDIT_KINDS: ReadonlySet<LedgerKind> = new Set([
	'grant',
	'top_up',
	'cash_out',
	'refund'
]);
export const DEBIT_KINDS: ReadonlySet<LedgerKind> = new Set(['buy_in', 'rebuy']);
export const PLAY_MONEY_NOTICE =
	'Play money only: chips can never be bought, sold or cashed out, and have no value.';

export class InsufficientChips extends Error {
	readonly balance: number;
	readonly amount: number;

	constructor(balance: number, amount: number) {
		super(`You have ${commas(balance)} chips; that needs ${commas(amount)}.`);
		this.balance = balance;
		this.amount = amount;
	}
}

export class UnknownPlayer extends Error {}

export interface Entry {
	kind: LedgerKind;
	/** Positive for chips paid in, negative for chips paid out. */
	amount: number;
	balanceAfter: number;
	tableId: string | null;
	/** Seconds since the epoch. */
	at: number;
}

/** Chips going back from a table to a person's wallet. */
export interface Credit {
	playerId: string;
	amount: number;
	kind: 'cash_out' | 'refund';
	tableId: string;
}

/** Chips a table hands back: a player who left, or a waiting rebuy that no longer fit. */
export interface Departure {
	playerId: string;
	chips: number;
	bot: boolean;
	/** True when the player left; false for a dropped rebuy. */
	left: boolean;
}

/** What a table owes people for its departures. Bots have no wallet. */
export function creditsFor(tableId: string, departures: Iterable<Departure>): Credit[] {
	const credits: Credit[] = [];
	for (const d of departures) {
		if (d.bot || d.chips <= 0) continue;
		credits.push({
			playerId: d.playerId,
			amount: d.chips,
			kind: d.left ? 'cash_out' : 'refund',
			tableId
		});
	}
	return credits;
}

function check(amount: number, kind: string): void {
	if (!Number.isSafeInteger(amount) || amount <= 0) {
		throw new RangeError(`an amount is a positive whole number of chips, not ${amount}`);
	}
	if (!CREDIT_KINDS.has(kind as LedgerKind) && !DEBIT_KINDS.has(kind as LedgerKind)) {
		throw new RangeError(`unknown ledger entry kind ${JSON.stringify(kind)}`);
	}
}

export interface Wallet {
	/** Pay the starting grant or a due top-up. Returns the balance. */
	visit(playerId: string, now: number): Promise<number>;
	balance(playerId: string): Promise<number>;
	/** Take chips, or throw {@link InsufficientChips}. Returns the balance. */
	debit(
		playerId: string,
		amount: number,
		kind: LedgerKind,
		tableId?: string | null
	): Promise<number>;
	credit(
		playerId: string,
		amount: number,
		kind: LedgerKind,
		tableId?: string | null
	): Promise<number>;
	/** The newest entries first. */
	entries(playerId: string, limit?: number): Promise<Entry[]>;
	/**
	 * Forget a deleted guest's wallet and its entries together (P5D.11). In the
	 * database they go with the guest's row, by ON DELETE CASCADE.
	 */
	erase(playerId: string): Promise<void>;
}

/** Wallets for a server without a database: they last as long as the process. */
export class MemoryWallet implements Wallet {
	private readonly balances = new Map<string, number>();
	private readonly granted = new Map<string, number>();
	private readonly kept = new Map<string, Entry[]>();
	private readonly clock: () => number;

	constructor(clock: () => number = wallClock) {
		this.clock = clock;
	}

	private apply(
		playerId: string,
		amount: number,
		kind: LedgerKind,
		tableId: string | null,
		now: number
	): number {
		const before = this.balances.get(playerId) ?? 0;
		const balance = before + amount;
		if (balance < 0) throw new InsufficientChips(before, -amount);
		this.balances.set(playerId, balance);
		let mine = this.kept.get(playerId);
		if (!mine) this.kept.set(playerId, (mine = []));
		mine.push({ kind, amount, balanceAfter: balance, tableId, at: now });
		return balance;
	}

	async visit(playerId: string, now: number): Promise<number> {
		const granted = this.granted.get(playerId);
		const balance = this.balances.get(playerId) ?? 0;
		if (granted === undefined) {
			this.granted.set(playerId, now);
			return this.apply(playerId, STARTING_GRANT, 'grant', null, now);
		}
		if (balance < TOP_UP_FLOOR && now - granted >= TOP_UP_SECONDS) {
			this.granted.set(playerId, now);
			return this.apply(playerId, TOP_UP_FLOOR - balance, 'top_up', null, now);
		}
		return balance;
	}

	async balance(playerId: string): Promise<number> {
		return this.balances.get(playerId) ?? 0;
	}

	async debit(playerId: string, amount: number, kind: LedgerKind, tableId: string | null = null) {
		check(amount, kind);
		return this.apply(playerId, -amount, kind, tableId, this.clock());
	}

	async credit(playerId: string, amount: number, kind: LedgerKind, tableId: string | null = null) {
		check(amount, kind);
		return this.apply(playerId, amount, kind, tableId, this.clock());
	}

	async entries(playerId: string, limit = 50): Promise<Entry[]> {
		return [...(this.kept.get(playerId) ?? [])].reverse().slice(0, limit);
	}

	async erase(playerId: string): Promise<void> {
		this.balances.delete(playerId);
		this.granted.delete(playerId);
		this.kept.delete(playerId);
	}
}

/** A database or an open transaction on it. */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Change a stored balance and record the entry, inside the caller's
 * transaction. The balance changes only if it stays at or above zero, in one
 * statement, so concurrent debits can never overdraw it.
 */
export async function applyEntry(
	tx: Executor,
	playerId: string,
	amount: number,
	kind: LedgerKind,
	tableId: string | null
): Promise<number> {
	const updated = await tx
		.update(players)
		.set({ balance: sql`${players.balance} + ${amount}` })
		.where(sql`${players.id} = ${playerId} AND ${players.balance} + ${amount} >= 0`)
		.returning({ balance: players.balance });
	if (!updated.length) {
		const current = await tx
			.select({ balance: players.balance })
			.from(players)
			.where(eq(players.id, playerId));
		if (!current.length) throw new UnknownPlayer(playerId);
		throw new InsufficientChips(current[0].balance, -amount);
	}
	const balance = updated[0].balance;
	await tx.insert(ledgerEntries).values({ playerId, kind, amount, balanceAfter: balance, tableId });
	return balance;
}

/** Wallets in `players.balance` with every change in `ledger_entries`. */
export class DatabaseWallet implements Wallet {
	readonly db: Database;

	constructor(db: Database) {
		this.db = db;
	}

	async visit(playerId: string, now: number): Promise<number> {
		return this.db.transaction(async (tx) => {
			const rows = await tx
				.select({ balance: players.balance, granted: epochOf(players.grantedAt) })
				.from(players)
				.where(eq(players.id, playerId))
				.for('update');
			if (!rows.length) throw new UnknownPlayer(playerId);
			const { balance, granted } = rows[0];
			let kind: LedgerKind;
			let amount: number;
			if (granted === null) {
				[kind, amount] = ['grant', STARTING_GRANT];
			} else if (balance < TOP_UP_FLOOR && now - granted >= TOP_UP_SECONDS) {
				[kind, amount] = ['top_up', TOP_UP_FLOOR - balance];
			} else {
				return balance;
			}
			await tx
				.update(players)
				.set({ grantedAt: sql`to_timestamp(${now})` })
				.where(eq(players.id, playerId));
			return applyEntry(tx, playerId, amount, kind, null);
		});
	}

	async balance(playerId: string): Promise<number> {
		const rows = await this.db
			.select({ balance: players.balance })
			.from(players)
			.where(eq(players.id, playerId));
		if (!rows.length) throw new UnknownPlayer(playerId);
		return rows[0].balance;
	}

	async debit(playerId: string, amount: number, kind: LedgerKind, tableId: string | null = null) {
		check(amount, kind);
		return this.db.transaction((tx) => applyEntry(tx, playerId, -amount, kind, tableId));
	}

	async credit(playerId: string, amount: number, kind: LedgerKind, tableId: string | null = null) {
		check(amount, kind);
		return this.db.transaction((tx) => applyEntry(tx, playerId, amount, kind, tableId));
	}

	async entries(playerId: string, limit = 50): Promise<Entry[]> {
		return this.db
			.select({
				kind: ledgerEntries.kind,
				amount: ledgerEntries.amount,
				balanceAfter: ledgerEntries.balanceAfter,
				tableId: ledgerEntries.tableId,
				at: epochOf(ledgerEntries.createdAt)
			})
			.from(ledgerEntries)
			.where(eq(ledgerEntries.playerId, playerId))
			.orderBy(desc(ledgerEntries.id))
			.limit(limit);
	}

	/** Nothing to do here: the entries go with the guest's row (`PlayerStore.erase`). */
	async erase(): Promise<void> {}
}

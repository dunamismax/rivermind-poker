// The Drizzle stores on PostgreSQL (P4B.5a), with the checks only a shared
// database needs: concurrent debits never overdraw, concurrent first visits
// pay one grant, a repeated report counts once however many arrive at once,
// and the schema's constraints hold.
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';
import { execute, resetDatabase, testDatabaseUrl } from '../db/testing.ts';
import { DatabasePlayers } from './players.ts';
import { DatabaseSafety } from './safety.ts';
import { checkLedgersOf, storeSuite } from './stores.testing.ts';
import { DatabaseWallet, InsufficientChips, STARTING_GRANT, UnknownPlayer } from './wallet.ts';

const url = testDatabaseUrl();

describe.skipIf(!url)('stores on PostgreSQL', () => {
	const database = url as string;
	let pool: ReturnType<typeof createPool>;
	let db: Database;

	beforeAll(async () => {
		await resetDatabase(database);
		await migrate(database);
		pool = createPool(database, { max: 16 });
		db = createDatabase(pool);
	});

	afterAll(async () => {
		await pool?.end();
	});

	beforeEach(async () => {
		await db.execute(
			sql`TRUNCATE players, ledger_entries, player_reports, player_relations, safety_signals CASCADE`
		);
	});

	/** Every ledger in the database, checked in one snapshot as test/db/test_wallet.py does. */
	async function checkEveryLedger(): Promise<void> {
		const result = await execute(
			database,
			`SELECT p.id, p.balance::bigint AS balance,
				coalesce((SELECT sum(amount) FROM ledger_entries e WHERE e.player_id = p.id), 0)::bigint AS total,
				coalesce((SELECT bool_and(ok) FROM (
					SELECT balance_after = sum(amount) OVER (ORDER BY id) AND balance_after >= 0 AS ok
					FROM ledger_entries e WHERE e.player_id = p.id) runs), true) AS running
			FROM players p`
		);
		for (const row of result.rows) {
			expect(row.total, row.id).toBe(row.balance);
			expect(row.running, row.id).toBe(true);
		}
	}

	storeSuite(async () => {
		const wallet = new DatabaseWallet(db);
		return {
			players: new DatabasePlayers(db),
			wallet,
			safety: new DatabaseSafety(db),
			checkLedgers: async (ids) => {
				await checkLedgersOf(wallet, ids);
				await checkEveryLedger();
			}
		};
	});

	it('never overdraws under concurrent debits, and pays one grant to concurrent first visits', async () => {
		const players = new DatabasePlayers(db);
		const wallet = new DatabaseWallet(db);
		const player = (await players.create()).playerId;
		await wallet.visit(player, 0);
		const results = await Promise.allSettled(
			Array.from({ length: 16 }, () => wallet.debit(player, 3_000, 'buy_in', 't1'))
		);
		const paid = results.filter((r) => r.status === 'fulfilled').length;
		expect(paid).toBe(Math.floor(STARTING_GRANT / 3_000));
		for (const r of results) {
			if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(InsufficientChips);
		}
		expect(await wallet.balance(player)).toBe(STARTING_GRANT % 3_000);
		const other = (await players.create()).playerId;
		await Promise.all(Array.from({ length: 8 }, () => wallet.visit(other, 0)));
		expect(await wallet.balance(other)).toBe(STARTING_GRANT);
		await expect(wallet.visit('p_nobody', 0)).rejects.toThrow(UnknownPlayer);
		await expect(wallet.debit('p_nobody', 5, 'buy_in')).rejects.toThrow(UnknownPlayer);
		await expect(wallet.balance('p_nobody')).rejects.toThrow(UnknownPlayer);
		await checkEveryLedger();
	});

	it('counts a repeated report once however many arrive at once', async () => {
		const players = new DatabasePlayers(db);
		const safety = new DatabaseSafety(db);
		const [alice, bob] = [await players.create(), await players.create()];
		const report = {
			reporterId: alice.playerId,
			targetId: bob.playerId,
			targetHandle: bob.handle,
			reason: 'abuse' as const,
			tableId: null,
			handNo: null,
			at: 5_000_000
		};
		const results = await Promise.all(Array.from({ length: 8 }, () => safety.report(report)));
		expect(results.sort()).toEqual([false, false, false, false, false, false, false, true]);
		expect((await safety.reports(10)).length).toBe(1);
	});

	it('makes distinct handles at once, and a claim keeps an existing handle', async () => {
		const players = new DatabasePlayers(db);
		const first = await players.create();
		await execute(database, "INSERT INTO players (id, handle) VALUES ('p_squatter', $1)", [
			`${first.handle} x`
		]);
		const made = await Promise.all(Array.from({ length: 200 }, () => players.create()));
		expect(new Set(made.map((p) => p.handle)).size).toBe(200);
		const claimed = await players.claim('p_squatter');
		expect(claimed.handle).toBe(`${first.handle} x`);
	});

	it('records the time of a visit and of the grant', async () => {
		const players = new DatabasePlayers(db);
		const wallet = new DatabaseWallet(db);
		const player = (await players.create()).playerId;
		await wallet.visit(player, 1_795_000_000.123456);
		const row = await execute(
			database,
			'SELECT extract(epoch FROM granted_at)::float8 AS granted FROM players WHERE id = $1',
			[player]
		);
		expect(row.rows[0].granted).toBe(1_795_000_000.123456);
	});

	it.each([
		'UPDATE players SET balance = -1',
		"INSERT INTO ledger_entries (player_id, kind, amount, balance_after) VALUES ('{p}', 'grant', -5, 0)",
		"INSERT INTO ledger_entries (player_id, kind, amount, balance_after) VALUES ('{p}', 'buy_in', 5, 0)",
		"INSERT INTO ledger_entries (player_id, kind, amount, balance_after) VALUES ('{p}', 'gift', 5, 5)",
		"INSERT INTO ledger_entries (player_id, kind, amount, balance_after) VALUES ('{p}', 'refund', 0, 5)",
		"INSERT INTO ledger_entries (player_id, kind, amount, balance_after) VALUES ('{p}', 'buy_in', -5, -5)",
		"INSERT INTO ledger_entries (player_id, kind, amount, balance_after) VALUES ('p_nobody', 'grant', 5, 5)"
	])('refuses a bad ledger row: %s', async (statement) => {
		const player = (await new DatabasePlayers(db).create()).playerId;
		await expect(execute(database, statement.replace('{p}', player))).rejects.toThrow();
	});
});

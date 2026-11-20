import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database } from './index.ts';
import { ALEMBIC_HEAD, MIGRATIONS_FOLDER, migrate } from './migrate.ts';
import { ledgerEntries, players, pokerTables, seats } from './schema.ts';
import { execute, resetDatabase, testDatabaseUrl } from './testing.ts';

const url = testDatabaseUrl();

/** The tables in `public`, sorted. */
async function tables(database: string): Promise<string[]> {
	const result = await execute(
		database,
		"SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
	);
	return result.rows.map((row) => row.tablename as string);
}

async function journal(database: string): Promise<{ hash: string; created_at: string }[]> {
	const result = await execute(
		database,
		'SELECT hash, created_at FROM drizzle.__drizzle_migrations'
	);
	return result.rows;
}

/**
 * A database as Alembic leaves it at `revision`: the baseline's tables (the
 * Python suite's `test_drizzle_baseline.py` checks they match Alembic's)
 * plus Alembic's own version table, and no Drizzle journal.
 */
async function alembicDatabase(database: string, revision: string): Promise<void> {
	const baseline = readFileSync(join(MIGRATIONS_FOLDER, '0000_baseline.sql'), 'utf8');
	await execute(database, baseline.split('--> statement-breakpoint').join('\n'));
	await execute(
		database,
		'CREATE TABLE alembic_version (version_num varchar(32) NOT NULL, ' +
			'CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num))'
	);
	await execute(database, 'INSERT INTO alembic_version VALUES ($1)', [revision]);
}

const BASELINE_TABLES = [
	'hand_histories',
	'hand_players',
	'hands',
	'ledger_entries',
	'player_relations',
	'player_reports',
	'players',
	'poker_tables',
	'safety_signals',
	'seats'
];

describe.skipIf(!url)('migrations against PostgreSQL', () => {
	const database = url as string;

	beforeEach(async () => {
		await resetDatabase(database);
	});

	it('create the schema on an empty database, then have nothing left to do', async () => {
		expect(await migrate(database)).toEqual({ adopted: false, applied: ['0000_baseline'] });
		expect(await tables(database)).toEqual(BASELINE_TABLES);
		expect(await journal(database)).toHaveLength(1);
		expect(await migrate(database)).toEqual({ adopted: false, applied: [] });
		expect(await journal(database)).toHaveLength(1);
	});

	it(`adopt a database at Alembic ${ALEMBIC_HEAD} without changing a row`, async () => {
		await alembicDatabase(database, ALEMBIC_HEAD);
		await execute(
			database,
			"INSERT INTO players (id, handle, balance) VALUES ('p1', 'Quiet Otter', 25)"
		);
		await execute(
			database,
			"INSERT INTO ledger_entries (player_id, kind, amount, balance_after) VALUES ('p1', 'grant', 25, 25)"
		);
		expect(await migrate(database)).toEqual({ adopted: true, applied: [] });
		const [entry] = await journal(database);
		const journalFile = JSON.parse(
			readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8')
		) as { entries: { when: number }[] };
		expect(Number(entry.created_at)).toBe(journalFile.entries[0].when);
		expect((await execute(database, 'SELECT id, balance FROM players')).rows).toEqual([
			{ id: 'p1', balance: '25' }
		]);
		expect((await execute(database, 'SELECT version_num FROM alembic_version')).rows).toEqual([
			{ version_num: ALEMBIC_HEAD }
		]);
		expect(await tables(database)).toEqual(['alembic_version', ...BASELINE_TABLES]);
		expect(await migrate(database)).toEqual({ adopted: false, applied: [] });
	});

	it('refuse a database Alembic has not brought to the baseline', async () => {
		await alembicDatabase(database, '0005');
		await expect(migrate(database)).rejects.toThrow(/Alembic is at 0005, not 0006/);
		expect(
			(await execute(database, "SELECT to_regclass('drizzle.__drizzle_migrations') AS t")).rows
		).toEqual([{ t: null }]);
	});

	it('switch to the owner role first, as the deploy does', async () => {
		await expect(migrate(database, { role: 'owner; DROP TABLE players' })).rejects.toThrow(
			/bad RIVERMIND_MIGRATION_ROLE/
		);
		const me = (await execute(database, 'SELECT current_user AS name')).rows[0].name as string;
		const result = await migrate(database, { role: me });
		expect(result.applied).toEqual(['0000_baseline']);
		const owners = await execute(
			database,
			"SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname IN ('public', 'drizzle')"
		);
		expect(owners.rows).toEqual([{ tableowner: me }]);
	});

	describe('the schema', () => {
		let pool: ReturnType<typeof createPool>;
		let db: Database;

		beforeAll(() => {
			pool = createPool(database, { max: 2 });
			db = createDatabase(pool);
		});

		afterAll(async () => {
			await pool.end();
		});

		beforeEach(async () => {
			await migrate(database);
		});

		it('reads and writes rows through Drizzle, with chips as numbers', async () => {
			await db.insert(players).values({ id: 'p1', handle: 'Quiet Otter', balance: 1000 });
			await db
				.insert(ledgerEntries)
				.values({ playerId: 'p1', kind: 'grant', amount: 1000, balanceAfter: 1000 });
			const [player] = await db.select().from(players).where(eq(players.id, 'p1'));
			expect(player).toMatchObject({ handle: 'Quiet Otter', balance: 1000, grantedAt: null });
			expect(player.createdAt).toBeInstanceOf(Date);
			const rows = await db.query.ledgerEntries.findMany();
			expect(rows).toMatchObject([{ id: 1, kind: 'grant', amount: 1000, balanceAfter: 1000 }]);

			await db.insert(pokerTables).values({
				id: 't1',
				name: 'Table 1',
				seatCount: 6,
				smallBlind: 1,
				bigBlind: 2,
				minBuyIn: 40,
				maxBuyIn: 200
			});
			await db
				.insert(seats)
				.values({ tableId: 't1', seatNo: 0, displayName: 'Quiet Otter', isBot: false, stack: 100 });
			const [table] = await db.select().from(pokerTables);
			expect(table).toMatchObject({ ante: 0, status: 'open', practice: false, state: null });
		});

		it('keeps the database checks and cascades', async () => {
			await db.insert(players).values({ id: 'p1', handle: 'Quiet Otter' });
			await expect(
				db.insert(players).values({ id: 'p2', handle: 'Broke', balance: -1 })
			).rejects.toMatchObject({ cause: { constraint: 'ck_players_balance' } });
			await expect(
				db.insert(players).values({ id: 'p3', handle: 'Quiet Otter' })
			).rejects.toMatchObject({ cause: { constraint: 'uq_players_handle' } });
			await expect(
				db
					.insert(ledgerEntries)
					.values({ playerId: 'p1', kind: 'buy_in', amount: 5, balanceAfter: 5 })
			).rejects.toMatchObject({ cause: { constraint: 'ck_ledger_entries_direction' } });
			await db
				.insert(ledgerEntries)
				.values({ playerId: 'p1', kind: 'grant', amount: 5, balanceAfter: 5 });
			await db.delete(players).where(eq(players.id, 'p1'));
			expect(await db.select().from(ledgerEntries)).toEqual([]);
		});
	});
});

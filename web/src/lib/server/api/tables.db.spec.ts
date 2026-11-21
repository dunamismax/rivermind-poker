// The table server on PostgreSQL (P4B.5b): the session recorded from serve-nl
// replays with every store in the database, and random play keeps every ledger
// balanced there (ported from test/db/test_wallet.py). A server stopped mid-hand
// and the next one taking the table over are in table/store.db.spec.ts.
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Database } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';
import { resetDatabase, testDatabaseUrl } from '../db/testing.ts';
import { replayRecord } from '../engine/history.ts';
import { TableStore } from '../table/store.ts';
import { checkOutcome, randomPlay } from './random-play.testing.ts';
import { contractServer, Replay } from './table-contract.testing.ts';
import { TestServer } from './tables.testing.ts';

const url = testDatabaseUrl();

describe.skipIf(!url)('the table server on PostgreSQL', () => {
	const database = url as string;
	let pool: ReturnType<typeof createPool>;
	let db: Database;
	const servers: TestServer[] = [];

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
			sql`TRUNCATE players, ledger_entries, player_reports, player_relations, safety_signals, poker_tables RESTART IDENTITY CASCADE`
		);
	});

	afterEach(async () => {
		while (servers.length) await servers.pop()!.stop();
	});

	/** Every ledger in the database, checked in one snapshot as test/db/test_wallet.py does. */
	async function checkEveryLedger(): Promise<void> {
		const found = await db.execute(sql`
			SELECT p.id, p.balance::text AS balance,
				coalesce((SELECT sum(amount) FROM ledger_entries e WHERE e.player_id = p.id), 0)::text AS total,
				coalesce((SELECT bool_and(ok) FROM (
					SELECT balance_after = sum(amount) OVER (ORDER BY id) AND balance_after >= 0 AS ok
					FROM ledger_entries e WHERE e.player_id = p.id) runs), true) AS running
			FROM players p`);
		expect(found.rows.length).toBeGreaterThan(0);
		for (const row of found.rows) {
			expect(row.total, String(row.id)).toBe(row.balance);
			expect(row.running, String(row.id)).toBe(true);
		}
	}

	it(
		'answers the session recorded from serve-nl with every store in the database',
		{
			timeout: 120_000
		},
		async () => {
			const options = {
				site: { db },
				store: new TableStore(db),
				// The database stamps ledger entries and finished hands with its own clock.
				// It also numbers a hand when it is dealt, not when it ends, so hand ids run ahead
				// of the recording's wherever a hand was under way; `before` pages by those ids.
				ignore: (path: string, body: string) =>
					path.includes('before=')
						? ''
						: body.replace(/"at":[0-9.e+]+/g, '"at":0').replace(/"hand_id":"\d+"/g, '"hand_id":"*"')
			};
			const server = await contractServer(options);
			servers.push(server);
			await new Replay(server, options).playAll();
			expect(server.tables.manager.tables.size).toBe(0);
			const open = await db.execute(sql`SELECT id FROM poker_tables WHERE status = 'open'`);
			expect(open.rows).toEqual([]);
			// Every hand of the session is stored with who played it, and replays to its result.
			const stored = await db.execute(sql`
			SELECT hh.record, (SELECT count(*) FROM hand_players hp WHERE hp.hand_id = h.id)::int AS seats
			FROM hands h JOIN hand_histories hh ON hh.hand_id = h.id`);
			expect(stored.rows.length).toBeGreaterThan(25);
			for (const row of stored.rows) {
				expect(replayRecord(row.record).result).not.toBeNull();
				expect(row.seats).toBeGreaterThanOrEqual(2);
			}
			const practice = await db.execute(
				sql`SELECT count(*)::int AS n FROM poker_tables WHERE practice`
			);
			expect(practice.rows[0].n).toBe(1);
			await checkEveryLedger();
		}
	);

	it('balances every ledger through random play', { timeout: 300_000 }, async () => {
		const server = await new TestServer({
			seed: 30,
			site: { db },
			store: new TableStore(db),
			tables: { maxTables: 50, idleSeconds: 1e9 }
		}).start();
		servers.push(server);
		checkOutcome(await randomPlay(server, 3, 300, checkEveryLedger));
		const open = await db.execute(sql`SELECT id FROM poker_tables WHERE status = 'open'`);
		expect(open.rows).toEqual([]);
	});
});

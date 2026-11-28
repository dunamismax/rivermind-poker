// Deleting a guest and their data (P5D.11) on PostgreSQL: the checks of
// deletion.testing.ts with every store and table in the database, what the
// database still holds afterwards, and a deletion a restart finishes.
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type * as p from '../../protocol-v2.ts';
import { createDatabase, createPool, type Database } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';
import { resetDatabase, testDatabaseUrl } from '../db/testing.ts';
import { TableStore } from '../table/store.ts';
import { deletionSuite } from './deletion.testing.ts';
import { DELETED_NAME, DELETED_PLAYER } from './hands.ts';
import { Player, TestServer } from './tables.testing.ts';

const url = testDatabaseUrl();

describe.skipIf(!url)('deleting a guest, on PostgreSQL', () => {
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

	async function serve(): Promise<TestServer> {
		const server = await new TestServer({
			seed: 41,
			site: { db },
			store: new TableStore(db)
		}).start();
		servers.push(server);
		return server;
	}

	/** Rows that still name the player, by table. */
	async function traces(playerId: string): Promise<Record<string, number>> {
		const count = async (query: ReturnType<typeof sql>) =>
			Number((await db.execute(query)).rows[0].n);
		return {
			players: await count(sql`SELECT count(*) AS n FROM players WHERE id = ${playerId}`),
			ledger: await count(
				sql`SELECT count(*) AS n FROM ledger_entries WHERE player_id = ${playerId}`
			),
			hands: await count(sql`SELECT count(*) AS n FROM hand_players WHERE player_id = ${playerId}`)
		};
	}

	deletionSuite(serve, { traces });

	it('leaves the anonymous seat in hand_players and drops the signals that name them', async () => {
		const server = await serve();
		const alice = await Player.create(server);
		const tableId = await alice.newTable(2, 'calling_station');
		const socket = await alice.socket();
		await socket.join(tableId);
		await socket.playUntil(tableId, (m) => m.events.some((e) => e.kind === 'hand_ended'));
		await server.site.safety.signal({
			kind: 'same_address',
			tableId,
			playerIds: [alice.playerId, 'p_someone'],
			detail: {},
			at: server.site.clock()
		});
		socket.send({ type: 'leave_table', table_id: tableId });
		await server.settle();
		const response = await alice.request('DELETE', '/api/guest', { confirm: true });
		expect((await response.json()) as p.DeleteGuestResponse).toEqual({ erased: true });
		await server.tables.erased();
		expect(await traces(alice.playerId)).toEqual({ players: 0, ledger: 0, hands: 0 });
		const seats = await db.execute(
			sql`SELECT player_id, display_name, bot_kind FROM hand_players ORDER BY seat_no`
		);
		const people = seats.rows.filter((row) => row.bot_kind === null);
		expect(people.length).toBeGreaterThan(0);
		for (const row of people) {
			expect(row).toMatchObject({ player_id: DELETED_PLAYER, display_name: DELETED_NAME });
		}
		const signals = await db.execute(sql`SELECT count(*) AS n FROM safety_signals`);
		expect(Number(signals.rows[0].n)).toBe(0);
	});

	it('finishes a deletion a restart cut short', async () => {
		const first = await serve();
		const alice = await Player.create(first);
		const bob = await Player.create(first);
		// As if the server stopped just after marking her: no session is hers any more.
		await first.site.markDeleted(alice.playerId);
		expect((await alice.request('GET', '/api/wallet')).status).toBe(401);
		expect(await traces(alice.playerId)).toMatchObject({ players: 1 });
		await first.stop();
		servers.pop();

		await serve();
		expect(await traces(alice.playerId)).toEqual({ players: 0, ledger: 0, hands: 0 });
		expect(await traces(bob.playerId)).toMatchObject({ players: 1, ledger: 1 });
	});
});

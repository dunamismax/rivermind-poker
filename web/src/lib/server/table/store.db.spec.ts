// Durable tables in PostgreSQL through Drizzle (P4B.5b), ported from
// test/db/test_durable_tables.py: tables are saved before any change is
// published and restored when the server starts, finished hands are stored as
// replayable histories, and a server that stops without a last save comes
// back with the identical table.
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type * as p from '../../protocol-v2.ts';
import { Player, TestServer, waitFor, type ServerOptions } from '../api/tables.testing.ts';
import { PythonRandom } from '../bots/mt.ts';
import { createDatabase, createPool, type Database } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';
import { resetDatabase, testDatabaseUrl } from '../db/testing.ts';
import { replayRecord } from '../engine/history.ts';
import { tableToDict } from './snapshot.ts';
import { seatRows, TableStore, type Save } from './store.ts';
import { Table, tableConfig } from './table.ts';

const url = testDatabaseUrl();

describe.skipIf(!url)('durable tables on PostgreSQL', () => {
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
			sql`TRUNCATE players, ledger_entries, player_reports, player_relations, safety_signals, poker_tables CASCADE`
		);
	});

	afterEach(async () => {
		while (servers.length) await servers.pop()!.stop();
	});

	async function serve(seed: number, options: ServerOptions = {}): Promise<TestServer> {
		const server = await new TestServer({
			seed,
			site: { db },
			store: new TableStore(db),
			...options
		}).start();
		servers.push(server);
		return server;
	}

	async function rows<T = Record<string, never>>(query: ReturnType<typeof sql>): Promise<T[]> {
		return (await db.execute(query)).rows as T[];
	}

	async function savedState(tableId: string): Promise<Record<string, never> | null> {
		const [row] = await rows<{ state: Record<string, never> | null }>(
			sql`SELECT state FROM poker_tables WHERE id = ${tableId}`
		);
		return row?.state ?? null;
	}

	/** Every wallet adds up: each balance is the sum of its entries, and never went below zero. */
	async function checkLedgers(): Promise<void> {
		const found = await rows<{ id: string; balance: string; total: string; running: boolean }>(sql`
			SELECT p.id, p.balance::text AS balance,
				coalesce((SELECT sum(amount) FROM ledger_entries e WHERE e.player_id = p.id), 0)::text AS total,
				coalesce((SELECT bool_and(ok) FROM (
					SELECT balance_after = sum(amount) OVER (ORDER BY id) AND balance_after >= 0 AS ok
					FROM ledger_entries e WHERE e.player_id = p.id) runs), true) AS running
			FROM players p`);
		expect(found.length).toBeGreaterThan(0);
		for (const row of found) {
			expect(row.total, row.id).toBe(row.balance);
			expect(row.running, row.id).toBe(true);
		}
	}

	it('saves, loads and closes tables', async () => {
		const store = new TableStore(db);
		const table = new Table(tableConfig({ seatCount: 6, smallBlind: 50, bigBlind: 100 }));
		table.sit(0, 'p_a', 'Guest 1000', 8_000);
		table.sit(3, 'bot:random:1', 'Random bot 4', 10_000, 'random');
		table.startHand(new PythonRandom(1));
		table.drainEvents();
		const state = tableToDict(table);
		const save = (): Promise<void> => {
			table.drainEvents();
			table.drainFinished();
			table.drainDepartures();
			return store.save({
				tableId: 't1',
				name: 'A table',
				state: tableToDict(table),
				seats: seatRows(table),
				current: { handNo: table.handNo, button: table.button as number }
			});
		};
		await save();
		const [saved] = await store.loadOpen();
		expect(saved).toEqual({ tableId: 't1', name: 'A table', state });
		interface SeatRow {
			seat_no: number;
			display_name: string;
			bot_kind: string | null;
			stack: string;
			at: string;
		}
		const seats = () =>
			rows<SeatRow>(
				sql`SELECT seat_no, display_name, bot_kind, stack::text AS stack, joined_at::text AS at
					FROM seats ORDER BY seat_no`
			);
		const before = await seats();
		expect(before.map((s) => [s.seat_no, s.bot_kind, Number(s.stack)])).toEqual([
			[0, null, table.stackOf(0)],
			[3, 'random', table.stackOf(3)]
		]);
		const hands = async () =>
			Number((await rows<{ n: string }>(sql`SELECT count(*) AS n FROM hands`))[0].n);
		expect(await hands()).toBe(1);
		// Saving again keeps one hand row and the first arrival time.
		await save();
		expect(await hands()).toBe(1);
		expect((await seats())[0].at).toBe(before[0].at);
		// Someone new in the seat is a new arrival; an emptied seat has no row.
		table.leave('p_a'); // folds heads-up, so the hand ends and the seat frees
		table.leave('bot:random:1');
		table.sit(0, 'p_b', 'Guest 2000', 8_000);
		await save();
		const after = await seats();
		expect(after.map((s) => [s.seat_no, s.display_name])).toEqual([[0, 'Guest 2000']]);
		expect(new Date(after[0].at).getTime()).toBeGreaterThan(new Date(before[0].at).getTime());
		await store.close('t1');
		expect(await store.loadOpen()).toEqual([]);
		expect(await rows(sql`SELECT status, state FROM poker_tables`)).toEqual([
			{ status: 'closed', state: null }
		]);
		expect(await seats()).toEqual([]);
		// A save that arrives after the close does not reopen the table.
		await store.save({ tableId: 't1', name: 'A table', state, seats: [], current: null });
		expect(await store.loadOpen()).toEqual([]);
	});

	it('saves tables before publishing and restores them at start-up', async () => {
		const published: [number, number | null][] = [];
		let server = await serve(1);
		const player = await Player.create(server);
		const tableId = await player.newTable(6, 'calling_station');
		let runner = server.runner(tableId);
		runner.listeners.unshift(async (r) => {
			const state = await savedState(r.tableId);
			published.push([r.table.seq, state === null ? null : (state.seq as number)]);
		});
		let socket = await player.socket();
		await socket.join(tableId);
		for (let i = 0; i < 25; i++) socket.play(tableId, await socket.myTurn(tableId));
		const turn = await socket.myTurn(tableId);
		socket.close();
		const seated = runner.table.seats[0]!;
		await waitFor(() => !seated.connected);
		await server.settle();
		const live = tableToDict(runner.table);
		const before = (await savedState(tableId)) as Record<string, unknown>;
		// The table's lobby settings (P4.3) are saved beside its snapshot.
		expect(before.lobby).toEqual({ fill: 'calling_station', private: false, invite: null });
		delete before.lobby;
		expect(published.length).toBeGreaterThan(25);
		// Nothing was shown before it was saved.
		expect(published.every(([seq, saved]) => seq === saved)).toBe(true);
		// The server stopped with the table saved as it was.
		expect(before).toEqual(JSON.parse(JSON.stringify(live)));
		await server.stop();
		servers.length = 0;

		const handNo = turn.view.hand!.hand_no;
		const records = await rows<{ hand_no: number; record: Record<string, never> }>(sql`
			SELECT h.hand_no, hh.record FROM hands h JOIN hand_histories hh ON hh.hand_id = h.id
			WHERE h.table_id = ${tableId} ORDER BY h.hand_no`);
		// Every finished hand, none in progress.
		expect(records.map((r) => r.hand_no)).toEqual(
			Array.from({ length: handNo - 1 }, (_, i) => i + 1)
		);
		for (const { record } of records) expect(replayRecord(record).result).not.toBeNull();

		server = await serve(2);
		runner = server.runner(tableId);
		// The player had already disconnected, so nothing changed on restoring.
		expect(JSON.parse(JSON.stringify(tableToDict(runner.table)))).toEqual(before);
		const again = Player.from(server, player); // the same player and session, on the new server
		socket = await again.socket();
		const view = (await socket.join(tableId)).view;
		expect(view.hand!.hand_no).toBe(handNo);
		expect(view.seats[0]!.cards).toEqual(turn.view.seats[0]!.cards);
		expect(view.you.legal).toEqual(turn.view.you.legal);
		await socket.playUntil(tableId, (m) => m.view.hand!.hand_no > handNo + 2);
		expect(await new TableStore(db).history(tableId, handNo + 1)).not.toBeNull();
		// "Your hands" is fed by the hands the table finished.
		const listed = await again.json<p.HandListResponse>('GET', '/api/hands?limit=50');
		expect(listed.hands.length).toBeGreaterThanOrEqual(handNo + 1);
		socket.close();
		await server.settle();
		await server.stop();
		servers.length = 0;

		// Once everyone has left, the table closes and is not restored again.
		server = await serve(3);
		const last = Player.from(server, player);
		socket = await last.socket();
		await socket.join(tableId);
		socket.send({ type: 'leave_table', table_id: tableId });
		await socket.until((m) => m.type === 'left_table');
		// The bots finish the hand, the seat frees and the table closes.
		await waitFor(() => server.tables.manager.get(tableId) === null);
		await server.tables.settled();
		expect(await new TableStore(db).loadOpen()).toEqual([]);
		expect(await rows(sql`SELECT status FROM poker_tables WHERE id = ${tableId}`)).toEqual([
			{ status: 'closed' }
		]);
		await checkLedgers();
		const wallet = await last.json<p.WalletResponse>('GET', '/api/wallet');
		expect(wallet.entries[0].kind).toBe('cash_out');
		expect(wallet.entries.reduce((total, e) => total + e.amount, 0)).toBe(wallet.balance);
	});

	it('restores a table identically after stopping without a last save', async () => {
		const first = await serve(4);
		const player = await Player.create(first);
		const tableId = await player.newTable(6, 'heuristic');
		let socket = await player.socket();
		await socket.join(tableId);
		for (let i = 0; i < 6; i++) socket.play(tableId, await socket.myTurn(tableId));
		const view = (await socket.myTurn(tableId)).view; // mid-hand, waiting for us
		await first.settle();
		const before = (await savedState(tableId)) as Record<string, never>;
		expect((before.hand as Record<string, unknown>).result).toBeNull();
		expect((before.turn as p.Turn).seat).toBe(0);
		expect(before.seq).toBe(view.seq);
		// The process dies: no shutdown, no disconnect, no last save. Its loops are stopped
		// only so that they do not run on beside the next server; a stopped runner saves nothing.
		servers.length = 0;
		await first.tables.manager.shutdown();
		expect(await savedState(tableId)).toEqual(before);

		const second = await serve(5);
		const after = await savedState(tableId);
		// The one change on restoring: nobody is connected, so the player's turn
		// loses its time bank until they come back (rule 13.2).
		const expected = structuredClone(before) as Record<string, unknown>;
		expected.seq = (before.seq as number) + 1;
		Object.assign((expected.seats as Record<string, unknown>[])[0], {
			connected: false,
			disconnected_this_hand: true
		});
		(expected.turn as p.Turn).final = (expected.turn as p.Turn).deadline;
		expect(after).toEqual(expected);

		socket = await Player.from(second, player).socket();
		const again = (await socket.join(tableId)).view;
		expect(again.hand).toEqual(view.hand);
		expect(again.settings).toEqual(view.settings);
		const connected = (seats: (p.SeatInfo | null)[]) =>
			seats.map((s) => s && { ...s, connected: true });
		expect(connected(again.seats)).toEqual(connected(view.seats));
		expect(again.you.legal).toEqual(view.you.legal);
		const handNo = view.hand!.hand_no;
		await socket.playUntil(tableId, (m) => m.view.hand!.hand_no > handNo);
		const final = replayRecord(await new TableStore(db).history(tableId, handNo));
		expect(final.result).not.toBeNull();
		expect(final.holeCards[0]).not.toBeNull();
	});

	it('lets a release candidate check the saved tables without touching them', async () => {
		const live = await serve(6);
		const player = await Player.create(live);
		const tableId = await player.newTable(6, 'heuristic');
		const socket = await player.socket();
		await socket.join(tableId);
		for (let i = 0; i < 4; i++) socket.play(tableId, await socket.myTurn(tableId));
		await socket.myTurn(tableId); // mid-hand, waiting for us
		await live.settle();
		const before = await savedState(tableId);
		const saved = await rows(sql`SELECT * FROM poker_tables ORDER BY id`);

		// A candidate's Tables on the same database is never started.
		const candidate = new TestServer({ seed: 7, site: { db }, store: new TableStore(db) });
		expect(await candidate.tables.restorable()).toBe(true);
		expect(candidate.tables.manager.tables.size).toBe(0);
		expect(await rows(sql`SELECT * FROM poker_tables ORDER BY id`)).toEqual(saved);
		expect(await savedState(tableId)).toEqual(before);
		// The live server's hand goes on.
		expect(live.runner(tableId).table.handInProgress).toBe(true);

		// A saved table this build could not restore fails the check, and is left as it was.
		await db.execute(
			sql`UPDATE poker_tables SET state = jsonb_set(state, '{format}', '999') WHERE id = ${tableId}`
		);
		const broken = await savedState(tableId);
		expect(await candidate.tables.restorable()).toBe(false);
		expect(await savedState(tableId)).toEqual(broken);
		expect(candidate.log.lines.some((line) => line.includes(tableId))).toBe(true);
	});

	it('keeps lobby settings, held seats and the waitlist over a restart', async () => {
		let server = await serve(5);
		const alice = await Player.create(server);
		const bob = await Player.create(server);
		const carol = await Player.create(server);
		const made = await alice.json<p.NewTableResponse>('POST', '/api/tables', {
			seats: 2,
			bots: null,
			private: true
		});
		const full = made.table_id;
		const code = made.invite as string;
		const seat = await bob.json<p.SeatResponse>('POST', `/api/tables/${full}/seat`, {
			invite: code
		});
		expect(seat.seated).toBe(true);
		expect(await carol.json('POST', `/api/tables/${full}/waitlist`, { invite: code })).toEqual({
			table_id: full,
			position: 1
		});
		const bots = await alice.newTable(3, 'random');
		await server.settle();
		const hold = await carol.json<p.SeatResponse>('POST', `/api/tables/${bots}/seat`, {
			hold_only: true
		});
		expect(hold.hold!.ready).toBe(false); // Alice's hand is under way; the bot finishes it first
		await server.settle();
		const before = new Map(
			[full, bots].map((id) => {
				const runner = server.runner(id);
				return [id, { state: tableToDict(runner.table), lobby: runner.lobbyState() }] as const;
			})
		);
		expect(before.get(full)!.lobby).toEqual({ fill: null, private: true, invite: code });
		expect(before.get(bots)!.lobby).toEqual({ fill: 'random', private: false, invite: null });
		await server.stop();
		servers.length = 0;

		server = await serve(6);
		for (const [tableId, { state, lobby }] of before) {
			const runner = server.runner(tableId);
			expect(runner.lobbyState()).toEqual(lobby);
			const restored = tableToDict(runner.table);
			expect(restored.reservations).toEqual(state.reservations);
			expect(restored.waitlist).toEqual(state.waitlist);
		}
		const back = Player.from(server, carol);
		const found = await back.request('GET', `/api/invites/${code}`);
		expect(found.status).toBe(200);
		expect(((await found.json()) as p.TableSummary).waitlist_position).toBe(1);
		const listed = await back.json<p.TableListResponse>('GET', '/api/tables');
		// Carol waits at the private one, so she sees it too.
		expect(new Set(listed.tables.map((t) => t.table_id))).toEqual(new Set([full, bots]));
	});

	it('plays on from memory when a save fails, and catches up with the next', async () => {
		const store = new TableStore(db);
		let failing = false;
		const flaky = {
			loadOpen: () => store.loadOpen(),
			close: (tableId: string) => store.close(tableId),
			save: (save: Save) =>
				failing ? Promise.reject(new Error('the database is away')) : store.save(save)
		};
		const server = await serve(8, { store: flaky });
		const player = await Player.create(server);
		const tableId = await player.newTable(2, 'calling_station');
		const runner = server.runner(tableId);
		const socket = await player.socket();
		await socket.join(tableId);
		const start = (await socket.myTurn(tableId)).view.hand!.hand_no;
		failing = true;
		await socket.playUntil(tableId, (m) => m.view.hand!.hand_no >= start + 3);
		await server.settle();
		const stale = (await savedState(tableId)) as Record<string, never>;
		expect(stale.seq).toBeLessThan(runner.table.seq); // the table played on from memory
		expect(server.log.lines.some((line) => line.includes('Could not save table'))).toBe(true);
		failing = false;
		socket.play(tableId, await socket.myTurn(tableId));
		await server.settle();
		const caught = (await savedState(tableId)) as Record<string, never>;
		expect(caught.seq).toBe(runner.table.seq);
		const stored = await rows<{ hand_no: number }>(sql`
			SELECT h.hand_no FROM hands h JOIN hand_histories hh ON hh.hand_id = h.id
			WHERE h.table_id = ${tableId} ORDER BY h.hand_no`);
		// Every hand that finished while the database was away is stored after all.
		const finished = runner.table.handInProgress ? runner.table.handNo - 1 : runner.table.handNo;
		expect(stored.map((r) => r.hand_no)).toEqual(Array.from({ length: finished }, (_, i) => i + 1));
	});
});

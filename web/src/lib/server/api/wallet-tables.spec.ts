// Play-chip wallets at running tables (P4.2), ported from the table-dependent
// tests of test/server/test_wallet.py (P4B.5b).
import { afterEach, describe, expect, it } from 'vitest';
import { checkOutcome, randomPlay } from './random-play.testing.ts';
import { checkLedgersOf } from './stores.testing.ts';
import { TestServer } from './tables.testing.ts';
import { STARTING_GRANT } from './wallet.ts';

const servers: TestServer[] = [];

async function serve(seed: number): Promise<TestServer> {
	const server = await new TestServer({
		seed: seed * 10,
		tables: { maxTables: 50, idleSeconds: 1e9 }
	}).start();
	servers.push(server);
	return server;
}

afterEach(async () => {
	while (servers.length) await servers.pop()!.stop();
});

describe('wallets at the tables', () => {
	it.each([0, 1, 2])('balance every ledger through random play (seed %i)', async (seed) => {
		const server = await serve(seed);
		const outcome = await randomPlay(server, seed, 600, (ids) =>
			checkLedgersOf(server.site.wallet, ids)
		);
		checkOutcome(outcome);
	});

	it('pay back the people still seated when an idle table closes', async () => {
		const server = await serve(0);
		const record = await server.site.players.create();
		const wallet = server.site.wallet;
		await wallet.visit(record.playerId, 0);
		const { tableId } = await server.tables.createTable(record, {
			seats: 2,
			bots: 'calling_station',
			big_blind: 100,
			buy_in: 4_000,
			private: false
		});
		expect(await wallet.balance(record.playerId)).toBe(STARTING_GRANT - 4_000);
		const runner = server.runner(tableId);
		await runner.sitOut(record.playerId);
		// The hand under way waits for the person, who is away: their clock runs out.
		for (let i = 0; i < 20 && runner.table.handInProgress; i++) {
			server.clock.advance(60);
			await server.settle();
		}
		expect(runner.table.handInProgress).toBe(false);
		const stack = runner.table.stackOf(runner.table.seatOf(record.playerId)!);
		await server.tables.close(tableId, 'The table closed after being idle.');
		expect(server.tables.manager.get(tableId)).toBeNull();
		expect(await wallet.balance(record.playerId)).toBe(STARTING_GRANT - 4_000 + stack);
		expect((await wallet.entries(record.playerId))[0].kind).toBe('cash_out');
	});

	it('pay back what was put into a hand that a closing table cuts short', async () => {
		// A hand is never idle, so only a close by hand meets one; it paid back the stacks
		// and kept the pot until P4C.9's session fixed it.
		const server = await serve(0);
		const [alice, bob] = [await server.site.players.create(), await server.site.players.create()];
		const wallet = server.site.wallet;
		for (const one of [alice, bob]) await wallet.visit(one.playerId, 0);
		const table = { seats: 2, bots: null, big_blind: 100, buy_in: 4_000, private: false };
		const { tableId } = await server.tables.createTable(alice, table);
		const runner = server.runner(tableId);
		await server.tables.takeSeat(bob, runner, null, 4_000, false);
		await server.settle();
		expect(runner.table.handInProgress).toBe(true);
		// The blinds are posted: 150 of their chips are in the pot, not in a stack.
		const seats = [alice, bob].map((one) => runner.table.seatOf(one.playerId)!);
		expect(seats.map((seat) => runner.table.inPotOf(seat)).sort((a, b) => a - b)).toEqual([
			50, 100
		]);
		expect(seats.reduce((sum, seat) => sum + runner.table.stackOf(seat), 0)).toBe(8_000 - 150);
		await server.tables.close(tableId, 'Closed for the test.');
		for (const one of [alice, bob]) {
			expect(await wallet.balance(one.playerId)).toBe(STARTING_GRANT);
			expect((await wallet.entries(one.playerId))[0]).toMatchObject({
				kind: 'cash_out',
				amount: 4_000
			});
		}
	});

	it('evict a table nobody follows once it has been idle too long', async () => {
		const server = await new TestServer({ tables: { idleSeconds: 100 } }).start();
		servers.push(server);
		const record = await server.site.players.create();
		const other = await server.site.players.create();
		const wallet = server.site.wallet;
		await wallet.visit(record.playerId, 0);
		await wallet.visit(other.playerId, 0);
		const table = { seats: 2, bots: null, big_blind: 100, buy_in: 4_000, private: false };
		const { tableId } = await server.tables.createTable(record, table);
		server.clock.advance(99);
		await server.tables.createTable(other, table);
		await server.tables.settled();
		expect(server.tables.manager.get(tableId)).not.toBeNull(); // not yet
		server.clock.advance(2);
		await server.tables.startPractice(other); // the server makes room when it needs a table
		await server.tables.settled();
		expect(server.tables.manager.get(tableId)).toBeNull();
		expect(await wallet.balance(record.playerId)).toBe(STARTING_GRANT); // seated chips came home
	});
});

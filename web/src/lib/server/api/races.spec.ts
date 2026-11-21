// Concurrent requests from several people and tabs (P4.4), ported from
// test/server/test_races.py (P4B.5b). Requests run at once through the
// table server, and every wallet payment takes a random number of turns of
// the event loop, so the requests really interleave: one pays while another
// sits. Whatever the order, a player holds at most one seat per table, an
// action counts once, refused buy-ins come back, and every ledger still adds
// up to its balance.
import { afterEach, describe, expect, it } from 'vitest';
import type * as p from '../../protocol-v2.ts';
import { PythonRandom } from '../bots/mt.ts';
import type { LedgerKind } from '../db/schema.ts';
import { legalActions, options } from '../engine/state.ts';
import type { TableEvent } from '../table/table.ts';
import { TableError } from '../table/table.ts';
import { HttpError, RequestError } from './errors.ts';
import type { PlayerRecord } from './players.ts';
import { checkLedgersOf } from './stores.testing.ts';
import type { Connection } from './tables.ts';
import { TestServer, tick } from './tables.testing.ts';
import { InsufficientChips, MemoryWallet, STARTING_GRANT, type Wallet } from './wallet.ts';

const isRefusal = (error: unknown): boolean =>
	error instanceof TableError ||
	error instanceof RequestError ||
	error instanceof HttpError ||
	error instanceof InsufficientChips;

/** A wallet whose payments take a while, and can be held back. */
class SlowWallet implements Wallet {
	readonly inner = new MemoryWallet();
	/** A player whose next debit waits until `release` is called. */
	held: string | null = null;
	paying = false;
	release: () => void = () => {};
	private readonly rng = new PythonRandom(99);

	private async wait(): Promise<void> {
		for (let turns = this.rng.below(4); turns > 0; turns--) await tick();
	}

	visit(playerId: string, now: number): Promise<number> {
		return this.inner.visit(playerId, now);
	}

	balance(playerId: string): Promise<number> {
		return this.inner.balance(playerId);
	}

	async debit(playerId: string, amount: number, kind: LedgerKind, tableId: string | null = null) {
		if (playerId === this.held) {
			this.paying = true;
			await new Promise<void>((resolve) => (this.release = resolve));
		}
		await this.wait();
		return this.inner.debit(playerId, amount, kind, tableId);
	}

	async credit(playerId: string, amount: number, kind: LedgerKind, tableId: string | null = null) {
		await this.wait();
		return this.inner.credit(playerId, amount, kind, tableId);
	}

	entries(playerId: string, limit?: number) {
		return this.inner.entries(playerId, limit);
	}
}

const servers: TestServer[] = [];

async function serve(seed: number): Promise<{ server: TestServer; wallet: SlowWallet }> {
	const wallet = new SlowWallet();
	const server = await new TestServer({
		seed,
		site: { wallet },
		tables: { maxTables: 50, idleSeconds: 1e9 }
	}).start();
	servers.push(server);
	return { server, wallet };
}

afterEach(async () => {
	while (servers.length) await servers.pop()!.stop();
});

const nowhere = { send: (_text: string, sent: () => void) => sent(), close: () => {} };

async function person(server: TestServer, tabs = 1): Promise<[PlayerRecord, Connection[]]> {
	const record = await server.site.players.create();
	await server.site.wallet.visit(record.playerId, 0);
	const connections = Array.from({ length: tabs }, () => server.tables.connect(nowhere, record));
	return [record, connections];
}

async function checkInvariants(server: TestServer, people: PlayerRecord[]): Promise<void> {
	await checkLedgersOf(
		server.site.wallet,
		people.map((record) => record.playerId)
	);
	for (const runner of server.tables.manager.tables.values()) {
		const table = runner.table;
		const ids = table.players().map(([, player]) => player.playerId);
		expect(new Set(ids).size, `someone holds two seats at ${runner.tableId}`).toBe(ids.length);
		const holders = [...table.reservations.values()].map((hold) => hold.playerId);
		expect(new Set(holders).size, 'someone holds two held seats').toBe(holders.length);
		const waiting = table.waitlist.map((w) => w.playerId);
		expect(new Set(waiting).size).toBe(waiting.length);
		for (const id of ids) {
			expect(
				holders.includes(id) || waiting.includes(id),
				'seated and still holding or waiting'
			).toBe(false);
		}
		for (const seat of table.reservations.keys()) {
			const occupant = table.seats[seat];
			expect(occupant === null || occupant.bot !== null, 'a held seat went to someone else').toBe(
				true
			);
		}
	}
}

const newTable = (seats: number, bots: string | null, buyIn: number) => ({
	seats,
	bots,
	big_blind: 100,
	buy_in: buyIn,
	private: false
});

const sit = (tableId: string, seat: number, buyIn: number) =>
	({ type: 'sit', table_id: tableId, seat, buy_in: buyIn }) as const;

const act = (tableId: string, seq: number, action: p.ActionKind) =>
	({ type: 'act', table_id: tableId, seq, action, amount: null }) as const;

/** Play the bots on until it is the player's turn; resolves to the table's seq. */
async function turnOf(server: TestServer, tableId: string, playerId: string): Promise<number> {
	const table = server.runner(tableId).table;
	for (let i = 0; i < 5_000; i++) {
		await server.settle();
		if (table.turn !== null && table.seatOf(playerId) === table.turn.seat) return table.seq;
	}
	throw new Error("the player's turn never came");
}

describe('concurrent requests', () => {
	it('never give one player two seats at once', async () => {
		const { server } = await serve(1);
		const [alice] = await person(server);
		const [bob, tabs] = await person(server, 3);
		const { tableId } = await server.tables.createTable(alice, newTable(6, null, 5_000));
		const runner = server.runner(tableId);
		for (const tab of tabs) await server.tables.join(tab, tableId);
		const results = await Promise.allSettled([
			server.tables.handle(tabs[0], sit(tableId, 2, 4_000)),
			server.tables.handle(tabs[1], sit(tableId, 3, 6_000)),
			server.tables.takeSeat(bob, runner, null, 5_000, false),
			server.tables.takeSeat(bob, runner, 4, 7_000, false),
			server.tables.quickSeat(bob, { seats: 6, big_blind: null, buy_in: null })
		]);
		await server.settle();
		const refused = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
		expect(refused.every(isRefusal), String(refused)).toBe(true);
		expect(refused.length).toBeGreaterThan(0);
		expect(runner.table.seatOf(bob.playerId)).not.toBeNull();
		// Only the seat Bob holds was paid for; every other buy-in came back.
		const entries = await server.site.wallet.entries(bob.playerId, 100);
		const sum = (kind: string) =>
			entries.reduce((total, e) => total + (e.kind === kind ? e.amount : 0), 0);
		const kept = -sum('buy_in') - sum('refund');
		expect([4_000, 5_000, 6_000, 7_000, 10_000]).toContain(kept);
		expect(await server.site.wallet.balance(bob.playerId)).toBe(STARTING_GRANT - kept);
		expect(runner.table.reservationOf(bob.playerId)).toBeNull();
		await checkInvariants(server, [alice, bob]);
	});

	it('give the last seat to one of two players racing for it', async () => {
		const { server } = await serve(2);
		const [alice] = await person(server);
		const [bob, bobTabs] = await person(server);
		const [carol, carolTabs] = await person(server);
		const { tableId } = await server.tables.createTable(alice, newTable(2, null, 5_000));
		const runner = server.runner(tableId);
		for (const tab of [...bobTabs, ...carolTabs]) await server.tables.join(tab, tableId);
		const results = await Promise.allSettled([
			server.tables.takeSeat(bob, runner, null, 5_000, false),
			server.tables.handle(carolTabs[0], sit(tableId, 1, 5_000)),
			server.tables.takeSeat(carol, runner, 1, 4_000, false)
		]);
		await server.settle();
		const refused = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
		expect(refused.every(isRefusal), String(refused)).toBe(true);
		const winner = runner.table.seats[1]!;
		expect([bob.playerId, carol.playerId]).toContain(winner.playerId);
		const loser = winner.playerId === bob.playerId ? carol : bob;
		expect(await server.site.wallet.balance(loser.playerId)).toBe(STARTING_GRANT); // refunded in full
		// The one who missed out can wait in line instead.
		expect(await server.tables.joinWaitlist(loser, runner)).toBe(1);
		await checkInvariants(server, [alice, bob, carol]);
	});

	it('count one action when two tabs act on one turn', async () => {
		const { server } = await serve(3);
		const [alice, tabs] = await person(server, 2);
		const { tableId, seat } = await server.tables.createTable(
			alice,
			newTable(3, 'calling_station', 10_000)
		);
		const runner = server.runner(tableId);
		const published: TableEvent[] = [];
		runner.listeners.push((_runner, events) => void published.push(...events));
		for (const tab of tabs) await server.tables.join(tab, tableId);
		for (let round = 0; round < 6; round++) {
			const seq = await turnOf(server, tableId, alice.playerId);
			const first = legalActions(runner.table.hand!).canCheck ? 'check' : 'call';
			const results = await Promise.allSettled([
				server.tables.handle(tabs[0], act(tableId, seq, first)),
				server.tables.handle(tabs[1], act(tableId, seq, 'fold')),
				server.tables.handle(tabs[1], act(tableId, seq, first))
			]);
			await server.settle();
			const refused = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
			expect(refused.length).toBe(2);
			for (const error of refused) {
				expect(error).toBeInstanceOf(TableError);
				expect(['stale', 'not_your_turn']).toContain((error as TableError).code);
			}
			// Alice acted once on that turn, whichever tab got there first.
			const mine = published.filter(
				(e) => e.kind === 'action' && e.data.seat === seat && e.seq > seq
			);
			expect(mine.length).toBe(1);
			published.length = 0;
		}
		await checkInvariants(server, [alice]);
	});

	it.each([0, 1, 2])(
		'keep the tables consistent through random requests (seed %i)',
		async (seed) => {
			// Every round, every tab of three people sends a random request at once.
			const rng = new PythonRandom(seed);
			const { server } = await serve(10 + seed);
			const tables = server.tables;
			const people: PlayerRecord[] = [];
			const tabs: Connection[] = [];
			for (let n = 0; n < 3; n++) {
				const [record, connections] = await person(server, 2);
				people.push(record);
				tabs.push(...connections);
			}
			const records = new Map(people.map((record) => [record.playerId, record]));
			const host = people[0];
			const ids = [
				(await tables.createTable(host, newTable(2, null, 4_000))).tableId,
				(await tables.createTable(host, newTable(3, 'calling_station', 4_000))).tableId
			];
			const counts = new Map<string, number>();

			async function request(tab: Connection): Promise<string> {
				const record = records.get(tab.playerId)!;
				const live = ids.filter((id) => tables.manager.get(id) !== null);
				if (!live.length) return 'none';
				const tableId = rng.choice(live);
				const runner = server.runner(tableId);
				const table = runner.table;
				const roll = rng.random();
				if (roll < 0.15) {
					await tables.join(tab, tableId);
					await tables.handle(tab, sit(tableId, rng.below(table.config.seatCount), 4_000));
					return 'sit';
				}
				if (roll < 0.3) {
					const buyIn = rng.choice([null, 4_000]);
					await tables.takeSeat(record, runner, null, buyIn, rng.random() < 0.3);
					return 'take_seat';
				}
				if (roll < 0.38) {
					await tables.joinWaitlist(record, runner);
					return 'waitlist';
				}
				if (roll < 0.46) {
					if (record === host) return 'idle'; // the host stays, so the tables stay open
					await tables.join(tab, tableId);
					await tables.handle(tab, { type: 'leave_table', table_id: tableId });
					return 'leave';
				}
				if (roll < 0.52) {
					await runner.cancelReservation(record.playerId);
					return 'give_up';
				}
				if (roll < 0.58) {
					await tables.join(tab, tableId);
					const amount = rng.choice([100, 2_000]);
					await tables.handle(tab, { type: 'rebuy', table_id: tableId, amount });
					return 'rebuy';
				}
				// Act on whatever turn this tab last saw, possibly a stale one.
				await tables.join(tab, tableId);
				const hand = table.hand;
				if (
					hand === null ||
					table.turn === null ||
					table.seatOf(record.playerId) !== table.turn.seat
				) {
					return 'idle';
				}
				const choices = options(legalActions(hand)).filter((o) =>
					['check', 'call', 'fold'].includes(o.kind)
				);
				const action = rng.choice(choices);
				const seq = table.seq - rng.choice([0, 0, 1]);
				await tables.handle(tab, act(tableId, seq, action.kind));
				return 'act';
			}

			async function attempt(tab: Connection): Promise<void> {
				let kind: string;
				try {
					kind = await request(tab);
				} catch (error) {
					if (!isRefusal(error)) throw error;
					kind = `refused:${(error as Error).name}`;
				}
				counts.set(kind, (counts.get(kind) ?? 0) + 1);
			}

			for (let round = 0; round < 150; round++) {
				await Promise.all(tabs.map(attempt));
				await server.settle();
				await checkInvariants(server, people);
			}
			for (const kind of ['sit', 'take_seat', 'leave', 'act']) {
				expect(counts.get(kind) ?? 0, `${kind} in ${JSON.stringify([...counts])}`).toBeGreaterThan(
					0
				);
			}
			expect([...counts.keys()].some((kind) => kind.startsWith('refused'))).toBe(true);
			// Everyone goes home: every chip the people hold is in a wallet again, and what they
			// won or lost was won from or lost to the bots.
			for (const tab of tabs) {
				for (const tableId of [...ids]) {
					if (tables.manager.get(tableId) === null) continue;
					await tables.join(tab, tableId).catch(() => {});
					await tables.handle(tab, { type: 'leave_table', table_id: tableId }).catch(() => {});
				}
			}
			for (let i = 0; i < 2_000 && tables.manager.tables.size; i++) {
				server.clock.advance(60); // anyone still in a hand folds or checks on the clock
				await server.settle();
			}
			expect(tables.manager.tables.size).toBe(0);
			await checkInvariants(server, people);
		}
	);

	it('let nobody act for another player', async () => {
		const { server } = await serve(4);
		const [alice, aliceTabs] = await person(server);
		const [bob, bobTabs] = await person(server);
		const [carol, carolTabs] = await person(server);
		const { tableId } = await server.tables.createTable(
			alice,
			newTable(3, 'calling_station', 5_000)
		);
		const runner = server.runner(tableId);
		// A bot's seat, held until its hand ends.
		await server.tables.takeSeat(bob, runner, null, 5_000, false);
		for (const tab of [...aliceTabs, ...bobTabs, ...carolTabs]) {
			await server.tables.join(tab, tableId);
		}
		const seq = await turnOf(server, tableId, alice.playerId);
		const before = runner.table.seq;
		for (const tab of [bobTabs[0], carolTabs[0]]) {
			for (const action of ['fold', 'call', 'check'] as const) {
				const refused = await server.tables
					.handle(tab, act(tableId, seq, action))
					.catch((error: unknown) => error);
				expect(isRefusal(refused)).toBe(true);
				expect(['not_seated', 'not_your_turn']).toContain((refused as TableError).code);
			}
		}
		expect(runner.table.seq).toBe(before); // nothing happened at the table
		// Bots act for themselves only: nobody may act in a bot's seat either.
		const [, bot] = runner.table.players().find(([, player]) => player.bot !== null)!;
		const anything = options(legalActions(runner.table.hand!))[0];
		await expect(runner.act(bot.playerId, anything, seq)).rejects.toBeInstanceOf(TableError);
		await checkInvariants(server, [alice, bob, carol]);
	});

	it.each(['sit', 'take_seat', 'rebuy'])(
		'give back chips paid for a %s while the table closes',
		async (kind) => {
			// A buy-in or rebuy whose payment is still on its way when the table closes
			// must be refused and refunded, not land on the closed table.
			const { server, wallet } = await serve(5);
			const tables = server.tables;
			const [alice] = await person(server);
			const [bob, bobTabs] = await person(server);
			const { tableId } = await tables.createTable(alice, newTable(6, null, 5_000));
			const runner = server.runner(tableId);
			await tables.join(bobTabs[0], tableId);
			if (kind === 'rebuy') {
				await runner.sitOut(alice.playerId); // no hand, so the rebuy is added at once
				await tables.handle(bobTabs[0], sit(tableId, 3, 4_000));
			}
			// Hold Bob's next payment until the table has closed.
			wallet.held = bob.playerId;
			let pending: Promise<unknown>;
			if (kind === 'sit') {
				pending = tables.handle(bobTabs[0], sit(tableId, 3, 4_000));
			} else if (kind === 'take_seat') {
				// Holding a seat takes no payment; give the hold up while the buy-in is being paid.
				pending = tables.takeSeat(bob, runner, 3, 4_000, false);
			} else {
				pending = tables.handle(bobTabs[0], { type: 'rebuy', table_id: tableId, amount: 1_000 });
			}
			const outcome = pending.then(
				() => null,
				(error: unknown) => error
			);
			while (!wallet.paying) await tick();
			if (kind === 'take_seat') await runner.cancelReservation(bob.playerId);
			if (kind === 'rebuy') {
				// As eviction does: the table closes with Alice and Bob still seated.
				await tables.close(tableId, 'The table closed after being idle.');
			} else {
				await runner.leave(alice.playerId); // the last person leaves, so the table closes
			}
			await server.settle();
			expect(tables.manager.get(tableId)).toBeNull();
			wallet.held = null;
			wallet.release();
			expect(isRefusal(await outcome)).toBe(true);
			await server.settle();
			expect(runner.table.seatOf(bob.playerId) === null || kind === 'rebuy').toBe(true);
			expect(await wallet.balance(alice.playerId)).toBe(STARTING_GRANT);
			expect(await wallet.balance(bob.playerId)).toBe(STARTING_GRANT); // the closed table kept nothing
			await checkInvariants(server, [alice, bob]);
		}
	);
});

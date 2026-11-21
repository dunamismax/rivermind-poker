// The randomized play of test/server/test_wallet.py (P4B.5b): several people
// at several bot tables through the table server. They visit (and come back
// days later for top-ups), start tables, take seats from the lobby (quick
// seat, held seats, the waitlist and bots giving up their seats), sit down,
// rebuy beyond their means, sit out, act and leave. After every step each
// wallet's ledger adds up to its balance and nothing is negative. At the end,
// once everyone has left and every table has closed, every chip is accounted
// for: the wallets hold exactly what grants and top-ups paid in, plus what the
// people won from the bots.
import { expect } from 'vitest';
import type * as p from '../../protocol-v2.ts';
import { PythonRandom } from '../bots/mt.ts';
import { legalActions, options } from '../engine/state.ts';
import type { Listener, TableRunner } from '../table/runner.ts';
import { TableError } from '../table/table.ts';
import { HttpError, RequestError } from './errors.ts';
import type { PlayerRecord } from './players.ts';
import type { Connection } from './tables.ts';
import type { TestServer } from './tables.testing.ts';
import { InsufficientChips, TOP_UP_SECONDS } from './wallet.ts';

const DAY = TOP_UP_SECONDS;
const nowhere = { send: (_text: string, sent: () => void) => sent(), close: () => {} };

/** Chips bots brought to the tables, and what they still held when each table closed. */
class BotChips {
	injected = 0;
	/** Chips bots took away when they gave up a seat to a person (P4.3). */
	left = 0;
	readonly held = new Map<string, number>();
	private readonly seats = new Map<string, Set<number>>();

	readonly listen: Listener = (runner, events) => {
		let seats = this.seats.get(runner.tableId);
		if (!seats) this.seats.set(runner.tableId, (seats = new Set()));
		for (const event of events) {
			const seat = event.data.seat as number;
			if (event.kind === 'seated') {
				if (event.data.bot !== null) {
					seats.add(seat);
					this.injected += event.data.stack as number;
				} else {
					seats.delete(seat);
				}
			} else if (event.kind === 'rebought' && seats.has(seat)) {
				this.injected += event.data.amount as number;
			} else if (event.kind === 'left') {
				if (seats.has(seat)) this.left += event.data.stack as number;
				seats.delete(seat);
			}
		}
		const table = runner.table;
		if (!table.handInProgress) {
			let held = 0;
			for (const [seat, player] of table.players()) {
				if (player.bot !== null) held += table.stackOf(seat);
			}
			this.held.set(runner.tableId, held);
		}
	};

	get kept(): number {
		return [...this.held.values()].reduce((total, chips) => total + chips, 0) + this.left;
	}
}

export interface Outcome {
	counts: Map<string, number>;
	balances: number[];
	paidIn: number;
	botsInjected: number;
	botsHeld: number;
	refunds: number;
	topUps: number;
}

const isRefusal = (error: unknown): error is Error =>
	error instanceof TableError ||
	error instanceof RequestError ||
	error instanceof HttpError ||
	error instanceof InsufficientChips;

async function actForPeople(
	server: TestServer,
	people: Map<string, Connection>,
	rng: PythonRandom
): Promise<void> {
	for (const runner of [...server.tables.manager.tables.values()]) {
		const table = runner.table;
		if (!table.handInProgress || table.turn === null || table.hand === null) continue;
		const player = table.seats[table.turn.seat];
		if (player === null || !people.has(player.playerId)) continue;
		const choices = options(legalActions(table.hand));
		// Mostly cautious, so people last; sometimes everything goes in.
		const cheap = choices.filter((a) => ['check', 'call', 'fold'].includes(a.kind));
		const action = rng.choice(rng.random() < 0.25 || !cheap.length ? choices : cheap);
		try {
			await runner.act(player.playerId, action, table.seq);
		} catch (error) {
			if (!(error instanceof TableError)) throw error;
		}
	}
}

/**
 * Play at random, checking the ledgers after every step with `checkWallets`.
 * The server must not have started any table yet. Returns what happened.
 */
export async function randomPlay(
	server: TestServer,
	seed: number,
	steps: number,
	checkWallets: (playerIds: string[]) => Promise<void>
): Promise<Outcome> {
	const rng = new PythonRandom(seed);
	const tables = server.tables;
	const bots = new BotChips();
	// From each table's first change, so the bots seated as it is made are counted.
	server.onTable.push((runner) => runner.listeners.unshift(bots.listen));
	let now = 1_000_000;
	const people = new Map<string, Connection>();
	const records = new Map<string, PlayerRecord>();
	for (let n = 0; n < 4; n++) {
		const record = await server.site.players.create();
		records.set(record.playerId, record);
		people.set(record.playerId, tables.connect(nowhere, record));
		await server.site.wallet.visit(record.playerId, now);
	}
	const ids = [...people.keys()];
	const counts = new Map<string, number>();
	const runnerOf = (tableId: string): TableRunner => {
		const runner = tables.manager.get(tableId);
		if (runner === null) throw new RequestError('unknown_table', 'the table closed');
		return runner;
	};

	for (let step = 0; step < steps; step++) {
		const playerId = rng.choice(ids);
		const connection = people.get(playerId)!;
		const record = records.get(playerId)!;
		const open = [...tables.manager.tables.keys()];
		// A closing table may linger among the ones a socket follows.
		const mine = [...connection.tables.keys()].filter((id) => tables.manager.get(id) !== null);
		const roll = rng.random();
		let kind = '';
		try {
			if (roll < 0.08) {
				kind = 'visit';
				now += rng.choice([0, DAY / 2, DAY, 3 * DAY]);
				await server.site.wallet.visit(playerId, now);
			} else if (roll < 0.14) {
				kind = 'new_table';
				const request = {
					seats: rng.choice([2, 3, 6]),
					bots: rng.choice(['random', 'calling_station', 'heuristic']),
					big_blind: rng.choice([50, 100, 200]),
					buy_in: rng.choice([null, null, 2_000, 4_000, 20_000]),
					private: false
				};
				const made = await tables.createTable(record, request);
				await tables.join(connection, made.tableId);
			} else if (roll < 0.22 && open.length) {
				kind = 'sit';
				const tableId = rng.choice(open);
				await tables.join(connection, tableId);
				const runner = runnerOf(tableId); // it may have closed while we joined
				const free = runner.table.seats.flatMap((s, i) => (s === null ? [i] : []));
				const config = runner.table.config;
				const amount = rng.choice([config.minBuyIn, config.maxBuyIn, config.maxBuyIn * 3]);
				const seat = rng.choice(free.length ? free : [0]);
				await tables.handle(connection, { type: 'sit', table_id: tableId, seat, buy_in: amount });
			} else if (roll < 0.28 && open.length) {
				let tableId = rng.choice(open);
				const runner = runnerOf(tableId);
				const config = runner.table.config;
				const pick = rng.random();
				if (pick < 0.4) {
					kind = 'take_seat';
					const amount = rng.choice([null, config.minBuyIn, config.maxBuyIn * 3]);
					await tables.takeSeat(record, runner, null, amount, false);
				} else if (pick < 0.6) {
					kind = 'quick_seat';
					const quick = {
						seats: rng.choice([null, 2, 6]),
						big_blind: rng.choice([null, 100]),
						buy_in: null
					};
					tableId = (await tables.quickSeat(record, quick)).table_id;
				} else if (pick < 0.8) {
					kind = 'hold';
					await tables.takeSeat(record, runner, rng.below(config.seatCount), null, true);
				} else {
					kind = 'waitlist';
					await tables.joinWaitlist(record, runner);
				}
				await tables.join(connection, tableId);
			} else if (roll < 0.38 && mine.length) {
				kind = 'rebuy';
				const tableId = rng.choice(mine);
				const config = runnerOf(tableId).table.config;
				const amount = rng.choice([
					config.bigBlind,
					config.minBuyIn,
					config.maxBuyIn,
					5 * config.maxBuyIn
				]);
				await tables.handle(connection, { type: 'rebuy', table_id: tableId, amount });
			} else if (roll < 0.44 && mine.length) {
				kind = 'leave';
				await tables.handle(connection, { type: 'leave_table', table_id: rng.choice(mine) });
			} else if (roll < 0.48 && mine.length) {
				kind = 'sit_out';
				const tableId = rng.choice(mine);
				const type = rng.random() < 0.5 ? 'sit_out' : 'sit_in';
				await tables.handle(connection, { type, table_id: tableId } as p.SitOutMessage);
			} else {
				kind = 'act';
				await actForPeople(server, people, rng);
			}
		} catch (error) {
			if (!isRefusal(error)) throw error;
			kind += `:${error.name}`;
		}
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
		await server.settle();
		await checkWallets(ids);
	}

	// Everyone leaves every seat, followed or not (a player follows at most
	// eight tables, but creating a table seats them without following it).
	for (const runner of [...tables.manager.tables.values()]) {
		for (const playerId of ids) {
			await runner.cancelReservation(playerId);
			await runner.leaveWaitlist(playerId);
		}
		for (const [, seated] of runner.table.players()) {
			if (!people.has(seated.playerId)) continue;
			await runner.leave(seated.playerId).catch((error: unknown) => {
				if (!(error instanceof TableError)) throw error;
			});
		}
	}
	for (const connection of people.values()) {
		for (const tableId of [...connection.tables.keys()]) await tables.unfollow(connection, tableId);
	}
	for (let i = 0; i < 2_000 && tables.manager.tables.size; i++) {
		await actForPeople(server, people, rng);
		await server.settle();
	}
	await server.tables.settled();
	// Every table closes once its people have left.
	expect([...tables.manager.tables.keys()]).toEqual([]);
	await checkWallets(ids);
	const wallet = server.site.wallet;
	const balances = await Promise.all(ids.map((id) => wallet.balance(id)));
	const entries = (await Promise.all(ids.map((id) => wallet.entries(id, 1e9)))).flat();
	// What grants and top-ups paid in, from the ledger: the balance before and
	// after a visit would also count a cash-out that a table paid meanwhile.
	const paidIn = entries
		.filter((e) => e.kind === 'grant' || e.kind === 'top_up')
		.reduce((total, e) => total + e.amount, 0);
	return {
		counts,
		balances,
		paidIn,
		botsInjected: bots.injected,
		botsHeld: bots.kept,
		refunds: entries.filter((e) => e.kind === 'refund').length,
		topUps: entries.filter((e) => e.kind === 'top_up').length
	};
}

export function checkOutcome(outcome: Outcome): void {
	const { counts } = outcome;
	const described = JSON.stringify([...counts].sort());
	// Every chip is accounted for: people hold what grants and top-ups paid,
	// plus what the bots brought to the tables minus what the bots kept.
	expect(outcome.balances.reduce((total, balance) => total + balance, 0)).toBe(
		outcome.paidIn + outcome.botsInjected - outcome.botsHeld
	);
	// The random play reached the interesting cases. Some always go through;
	// others only need to have been tried, since timing decides whether they
	// can (a rebuy is refused, and refunded, while the stack is full).
	for (const kind of ['new_table', 'leave', 'act', 'visit', 'quick_seat']) {
		expect(counts.get(kind) ?? 0, `${kind} in ${described}`).toBeGreaterThan(0);
	}
	for (const kind of ['rebuy', 'take_seat', 'hold']) {
		const tried = [...counts].reduce((n, [key, c]) => n + (key.split(':')[0] === kind ? c : 0), 0);
		expect(tried, `${kind} in ${described}`).toBeGreaterThan(0);
	}
	// Sitting in a seat a bot or a hold has is refused after being paid for:
	// the payment must come back.
	expect(counts.get('sit:TableError') ?? 0, described).toBeGreaterThan(0);
	// Someone could not afford something.
	expect(
		[...counts.keys()].some((kind) => kind.includes('RequestError')),
		described
	).toBe(true);
	expect(outcome.refunds).toBeGreaterThan(0);
	expect(outcome.topUps).toBeGreaterThan(0);
}

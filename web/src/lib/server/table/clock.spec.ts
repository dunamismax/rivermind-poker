// Action clocks, time banks and disconnects (rules section 13), ported from
// test/server/test_clock.py (P4B.5b). Every test reads time from a clock it
// moves itself; none of them waits for real time, except the two that check
// the system clock.
import { describe, expect, it } from 'vitest';
import { PythonRandom } from '../bots/mt.ts';
import { CallingStationPolicy } from '../bots/policies.ts';
import { Action, legalActions, STREET_LABELS } from '../engine/state.ts';
import { ManualClock, Signal, SystemClock } from './clock.ts';
import { TableManager } from './runner.ts';
import { BlockingBot, options, Recorder, tick } from './runner.testing.ts';
import { Table, tableConfig, type TableConfigOptions } from './table.ts';

class Now {
	t = 0;
	readonly read = (): number => this.t;
}

function tableWith(seats: number[], now: Now, config: Partial<TableConfigOptions> = {}): Table {
	const table = new Table(
		tableConfig({ seatCount: seats.length || 2, smallBlind: 50, bigBlind: 100, ...config }),
		now.read
	);
	for (const seat of seats) table.sit(seat, `p${seat}`, `Player ${seat}`, 10_000);
	table.drainEvents();
	return table;
}

/** Finish a hand: connected players check or call at once, others run out of time. */
function playOut(table: Table, now: Now): void {
	while (table.handInProgress) {
		const legal = legalActions(table.hand!);
		const player = table.seats[legal.seat]!;
		if (player.connected && player.playerId !== 'idle') {
			table.actSeat(legal.seat, legal.canCheck ? Action.check() : Action.call());
		} else {
			now.t += 100;
			expect(table.checkClock()).toBe(true);
		}
	}
}

describe('the turn clock', () => {
	it('has the rule 13 defaults', () => {
		const config = tableConfig({ seatCount: 6, smallBlind: 50, bigBlind: 100 });
		expect([config.actionSeconds, config.timeBankSeconds, config.bankRefillSeconds]).toEqual([
			20, 30, 2
		]);
		const stakes = { seatCount: 6, smallBlind: 50, bigBlind: 100 };
		expect(() => tableConfig({ ...stakes, actionSeconds: 0 })).toThrow(RangeError);
		expect(() => tableConfig({ ...stakes, timeBankSeconds: -1 })).toThrow(RangeError);
	});

	it('runs the action time, then the bank, then times out', () => {
		const now = new Now();
		const table = tableWith([0, 1, 2], now);
		table.button = 2;
		table.startHand(new PythonRandom(0)); // button S0 acts first, facing the big blind
		expect(table.turn).toMatchObject({ seat: 0, started: 0, deadline: 20, final: 50 });
		now.t = 49.9;
		expect(table.checkClock()).toBe(false);
		now.t = 50;
		expect(table.checkClock()).toBe(true);
		expect(table.hand!.folded[0]).toBe(true); // facing a bet, the timeout folds
		expect(table.seats[0]!.timeBank).toBe(0);
		const kinds = table.drainEvents().map((e) => e.kind);
		expect(kinds.slice(-3)).toEqual(['timed_out', 'action', 'turn']);
		expect(table.turn).toMatchObject({ seat: 1, started: 50, final: 100 });
	});

	it('spends the bank on a late action and refills it each hand', () => {
		const now = new Now();
		const table = tableWith([0, 1], now);
		table.button = 1;
		table.startHand(new PythonRandom(0)); // heads-up: button S0 is the small blind and acts first
		now.t = 26.5;
		table.act('p0', Action.call()); // 6.5 seconds into the bank
		const player = table.seats[0]!;
		expect(player.timeBank).toBeCloseTo(23.5);
		expect(table.turn).toMatchObject({ seat: 1, started: 26.5, deadline: 46.5, final: 76.5 });
		now.t = 30;
		table.act('p1', Action.check()); // in time: the bank is untouched
		const other = table.seats[1]!;
		expect(other.timeBank).toBe(30);
		table.timeOut(); // S1 checks on the flop by timing out, which empties its bank
		while (table.handInProgress) table.actSeat(legalActions(table.hand!).seat, Action.check());
		table.startHand(new PythonRandom(1));
		expect(player.timeBank).toBeCloseTo(25.5); // refilled by 2 seconds
		expect(other.timeBank).toBe(2); // emptied by the timeout, then refilled
	});

	it('checks or folds on a timeout (rules 13.1 example)', () => {
		const now = new Now();
		const table = tableWith([0, 1, 2, 3, 4], now);
		table.button = 4;
		table.startHand(new PythonRandom(2)); // button S0, small blind S1, big blind S2
		let hand = table.hand!;
		expect([hand.smallBlindSeat, hand.bigBlindSeat, hand.toAct]).toEqual([1, 2, 3]);
		for (const seat of [3, 4, 0]) table.actSeat(seat, Action.call());
		now.t += 50;
		expect(table.checkClock()).toBe(true); // the small blind's clock runs out facing 50 more: it folds
		now.t += 50;
		expect(table.checkClock()).toBe(true); // the big blind with no raise checks
		hand = table.hand!;
		expect(hand.folded[1]).toBe(true);
		expect(hand.folded[2]).toBe(false);
		expect(STREET_LABELS[hand.street]).toBe('flop');
		expect(hand.toAct).toBe(2);
		now.t += 50;
		expect(table.checkClock()).toBe(true); // no one has bet on the flop: S2 checks
		table.actSeat(3, Action.check());
		table.actSeat(4, Action.bet(200));
		table.actSeat(0, Action.call());
		expect(table.toAct).toBe(2);
		now.t += 50;
		expect(table.checkClock()).toBe(true); // facing S4's bet: S2 folds
		hand = table.hand!;
		expect(hand.folded[2]).toBe(true);
		const flop = hand.actions
			.filter((a) => STREET_LABELS[a.street] === 'flop')
			.map((a) => [a.seat, a.kind]);
		expect(flop).toEqual([
			[2, 'check'],
			[3, 'check'],
			[4, 'bet'],
			[0, 'call'],
			[2, 'fold']
		]);
	});

	it('gives a disconnected player the action time only', () => {
		const now = new Now();
		const table = tableWith([0, 1], now);
		table.button = 1;
		table.startHand(new PythonRandom(0));
		expect(table.toAct).toBe(0);
		const seq = table.turn!.seq;
		now.t = 5;
		table.setConnected('p0', false);
		expect(table.turn).toMatchObject({ started: 0, final: 20, seq }); // same turn, no bank
		now.t = 10;
		table.setConnected('p0', true);
		expect(table.turn).toMatchObject({ started: 0, final: 50, seq }); // back: the bank is there
		table.setConnected('p0', false);
		now.t = 20;
		expect(table.checkClock()).toBe(true);
		expect(table.seats[0]!.timeBank).toBe(30); // a disconnected timeout keeps the bank
	});

	it('sits out a player disconnected for a full orbit', () => {
		// Rule 13.2: three players dealt in, so three hands away is an orbit.
		const now = new Now();
		const table = tableWith([0, 1, 2], now);
		table.setConnected('p0', false);
		for (let hand = 1; hand < 4; hand++) {
			table.startHand(new PythonRandom(hand));
			playOut(table, now);
			expect(table.seats[0]!.sittingOut).toBe(hand === 3);
		}
		const events = table.drainEvents().filter((e) => e.kind === 'sat_out');
		expect(events.map((e) => [e.data.seat, e.data.reason])).toEqual([[0, 'away']]);
		expect(table.startHand(new PythonRandom(9)).dealtIn[0]).toBe(false);
	});

	it('starts the count again when the player comes back', () => {
		const now = new Now();
		const table = tableWith([0, 1, 2], now);
		table.setConnected('p0', false);
		for (let seed = 0; seed < 2; seed++) {
			table.startHand(new PythonRandom(seed));
			playOut(table, now);
		}
		table.setConnected('p0', true);
		table.setConnected('p0', false);
		for (let seed = 2; seed < 4; seed++) {
			table.startHand(new PythonRandom(seed));
			playOut(table, now);
		}
		const player = table.seats[0]!;
		expect(player.sittingOut).toBe(false);
		expect(player.absentHands).toBe(2);
	});

	it('sits out a connected player who only times out, too', () => {
		const now = new Now();
		const table = new Table(tableConfig({ seatCount: 3, smallBlind: 50, bigBlind: 100 }), now.read);
		table.sit(0, 'idle', 'Idle', 10_000);
		table.sit(1, 'p1', 'Player 1', 10_000);
		table.sit(2, 'p2', 'Player 2', 10_000);
		for (let seed = 0; seed < 3; seed++) {
			table.startHand(new PythonRandom(seed));
			playOut(table, now);
		}
		expect(table.seats[0]!.sittingOut).toBe(true);
	});

	it('never sits a bot out for absence', () => {
		const now = new Now();
		const table = new Table(tableConfig({ seatCount: 2, smallBlind: 50, bigBlind: 100 }), now.read);
		table.sit(0, 'bot:x', 'Bot', 10_000, 'random');
		table.sit(1, 'p1', 'Player 1', 10_000);
		for (let seed = 0; seed < 2; seed++) {
			table.startHand(new PythonRandom(seed));
			while (table.handInProgress) {
				now.t += 100;
				table.checkClock();
			}
		}
		const bot = table.seats[0]!;
		expect(bot.sittingOut).toBe(false);
		expect(bot.absentHands).toBe(0);
	});
});

describe('the runner and its clock', () => {
	const heads = tableConfig({ seatCount: 2, smallBlind: 50, bigBlind: 100 });

	it('times out a person on its clock', async () => {
		const clock = new ManualClock();
		const manager = new TableManager(
			{ calling_station: new CallingStationPolicy() },
			options(4, { clock })
		);
		const runner = manager.create(heads);
		const recorder = new Recorder();
		runner.listeners.push(recorder.listen);
		await runner.seatBot(0, 'calling_station');
		await runner.sit(1, 'alice', 'Alice', 10_000);
		const table = runner.table;
		const started = performance.now();
		for (let round = 0; round < 3; round++) {
			await runner.waitUntil((t) => t.toAct === 1);
			const turn = table.turn!;
			expect(turn.seat).toBe(1);
			const hand = table.hand!;
			const actions = hand.actions.length;
			clock.advance(turn.final - clock.now() - 0.01);
			for (let i = 0; i < 20; i++) await tick();
			expect(table.hand).toBe(hand); // not yet
			expect(hand.actions.length).toBe(actions);
			const timeouts = recorder.kinds('timed_out').length;
			clock.advance(0.01);
			await runner.waitUntil((t) => t.hand !== hand);
			const timedOut = recorder.kinds('timed_out');
			expect(timedOut.length).toBe(timeouts + 1);
			expect(timedOut[timedOut.length - 1].data.seat).toBe(1);
		}
		expect(performance.now() - started).toBeLessThan(5_000);
		await manager.shutdown();
	});

	it('times out a bot that is too slow', async () => {
		const clock = new ManualClock();
		const bot = new BlockingBot();
		const manager = new TableManager(
			{ blocking: bot, calling_station: new CallingStationPolicy() },
			options(4, { clock })
		);
		const runner = manager.create(heads);
		const recorder = new Recorder();
		runner.listeners.push(recorder.listen);
		await runner.seatBot(0, 'blocking');
		await runner.seatBot(1, 'calling_station');
		while (bot.calls === 0) await tick();
		const hand = runner.table.hand;
		clock.advance(51);
		await runner.waitUntil((t) => t.hand !== hand);
		const timedOut = recorder.kinds('timed_out');
		expect(timedOut.length).toBe(1);
		expect(timedOut[0].data.seat).toBe(0);
		bot.release(); // its late answer is ignored
		await runner.waitUntil((t) => t.handNo >= 3);
		await manager.shutdown();
	});

	it('lets a hold run out on its clock', async () => {
		const clock = new ManualClock();
		const manager = new TableManager({}, options(0, { clock }));
		const runner = manager.create(heads);
		const recorder = new Recorder();
		runner.listeners.push(recorder.listen);
		expect(await runner.reserve('alice', 'Alice')).toEqual({ seat: 0, ready: true });
		clock.advance(59.5);
		for (let i = 0; i < 10; i++) await tick();
		expect(runner.table.reservationOf('alice')).toBe(0);
		clock.advance(0.5);
		await runner.waitUntil((t) => t.reservationOf('alice') === null);
		expect(recorder.kinds('reservation_ended').map((e) => e.data.reason)).toEqual(['expired']);
		await manager.shutdown();
	});
});

describe('clocks', () => {
	it('wakes a manual wait when the signal is set or the deadline passes', async () => {
		const clock = new ManualClock(100);
		const signal = new Signal();
		const results: [string, boolean][] = [];
		void clock.wait(signal, 110).then((set) => results.push(['a', set]));
		void clock.wait(signal, 105).then((set) => results.push(['b', set]));
		void clock.wait(new Signal(), null).then((set) => results.push(['never', set]));
		expect(clock.waiting).toBe(2);
		expect(await clock.wait(signal, 100)).toBe(false); // already due
		clock.advance(5);
		await tick();
		expect(results).toEqual([['b', false]]);
		signal.set();
		await tick();
		expect(results).toEqual([
			['b', false],
			['a', true]
		]);
		expect(clock.waiting).toBe(0);
		expect(await clock.wait(signal, 500)).toBe(true); // already set
		signal.clear();
		expect(signal.isSet).toBe(false);
		expect(clock.now()).toBe(105);
	});

	it('wakes a system wait when the signal is set', async () => {
		const clock = new SystemClock();
		const signal = new Signal();
		const waiting = clock.wait(signal, clock.now() + 60);
		const forever = clock.wait(signal, null);
		signal.set();
		expect(await waiting).toBe(true);
		expect(await forever).toBe(true);
	});

	it('ends a system wait at its deadline', async () => {
		const clock = new SystemClock();
		const before = clock.now();
		expect(Math.abs(before - Date.now() / 1000)).toBeLessThan(1);
		expect(await clock.wait(new Signal(), before + 0.02)).toBe(false);
		expect(clock.now()).toBeGreaterThanOrEqual(before + 0.02);
		expect(await clock.wait(new Signal(), before - 1)).toBe(false); // already past
	});
});

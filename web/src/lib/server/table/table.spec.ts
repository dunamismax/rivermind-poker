// The table core (P4B.5b), ported from test/server/test_table.py: seating,
// buy-ins, sitting out, leaving and the button. The button and blind cases
// are the worked examples of docs/rules.md section 5 and rules 2.2 and 2.3,
// played through `Table`. Seeded deals are Python's, so each hand here is the
// hand the Python test plays.
import { describe, expect, it } from 'vitest';
import { cardStr } from '../../engine/cards.ts';
import { PythonRandom } from '../bots/mt.ts';
import { Action, legalActions, options, potTotal, STREET_LABELS } from '../engine/state.ts';
import {
	describeLegal,
	Table,
	tableConfig,
	TableError,
	type TableConfig,
	type TableErrorCode
} from './table.ts';

const CONFIG = tableConfig({ seatCount: 9, smallBlind: 50, bigBlind: 100 });

function tableWith(seats: number[], config: TableConfig = CONFIG, stack = 10_000): Table {
	const table = new Table(config);
	for (const seat of seats) table.sit(seat, `p${seat}`, `Player ${seat}`, stack);
	table.drainEvents();
	return table;
}

/** Play the hand out with everyone checking or folding. */
function finish(table: Table): void {
	while (table.handInProgress) table.timeOut();
}

/** Play the hand out with everyone checking or calling. */
function checkDown(table: Table): void {
	while (table.handInProgress) {
		const legal = legalActions(table.hand!);
		table.actSeat(legal.seat, legal.canCheck ? Action.check() : Action.call());
	}
}

function chips(table: Table): number {
	const pot = table.handInProgress && table.hand !== null ? potTotal(table.hand) : 0;
	return pot + table.players().reduce((total, [seat]) => total + table.stackOf(seat), 0);
}

function refusal(request: () => unknown): TableErrorCode {
	try {
		request();
	} catch (error) {
		if (error instanceof TableError) return error.code;
		throw error;
	}
	throw new Error('the table did not refuse');
}

const rng = (seed: number) => new PythonRandom(seed);

describe('table configuration', () => {
	it('has defaults and is validated', () => {
		expect([CONFIG.minBuyIn, CONFIG.maxBuyIn]).toEqual([4_000, 10_000]);
		const custom = tableConfig({
			seatCount: 6,
			smallBlind: 5,
			bigBlind: 10,
			ante: 1,
			minBuyIn: 200,
			maxBuyIn: 2_000
		});
		expect(custom.ante).toBe(1);
		expect(Object.isFrozen(custom)).toBe(true);
		for (const bad of [
			{ seatCount: 1, smallBlind: 50, bigBlind: 100 },
			{ seatCount: 10, smallBlind: 50, bigBlind: 100 },
			{ seatCount: 6, smallBlind: 100, bigBlind: 50 },
			{ seatCount: 6, smallBlind: 50, bigBlind: 100, ante: -1 },
			{ seatCount: 6, smallBlind: 50, bigBlind: 100, minBuyIn: 500, maxBuyIn: 400 }
		]) {
			expect(() => tableConfig(bad), JSON.stringify(bad)).toThrow(RangeError);
		}
		expect(() =>
			tableConfig({ seatCount: 6, smallBlind: 50, bigBlind: 100, minBuyIn: 0.5 })
		).toThrow(TypeError);
	});
});

describe('seating', () => {
	it('checks the seat, the player and the buy-in', () => {
		const table = tableWith([0]);
		const cases: [[number, string, string, number], TableErrorCode][] = [
			[[9, 'x', 'X', 5_000], 'unknown_seat'],
			[[-1, 'x', 'X', 5_000], 'unknown_seat'],
			[[0, 'x', 'X', 5_000], 'seat_taken'],
			[[1, 'p0', 'Again', 5_000], 'already_seated'],
			[[1, 'x', 'X', 3_999], 'bad_buy_in'],
			[[1, 'x', 'X', 10_001], 'bad_buy_in'],
			[[1, 'x', 'X', 0], 'bad_buy_in'],
			[[1, '', 'X', 5_000], 'bad_request']
		];
		for (const [args, code] of cases) expect(refusal(() => table.sit(...args))).toBe(code);
		expect(table.drainEvents()).toEqual([]); // refused requests change nothing
		table.sit(1, 'x', 'X', 4_000);
		const [event] = table.drainEvents();
		expect(event).toMatchObject({ kind: 'seated', data: { seat: 1, stack: 4_000 } });
	});

	it('starts hands only with two players dealt in', () => {
		const table = tableWith([3]);
		expect(table.canStart()).toBe(false);
		expect(refusal(() => table.startHand(rng(0)))).toBe('bad_request');
		table.sit(7, 'p7', 'Player 7', 5_000);
		expect(table.canStart()).toBe(true);
		table.sitOut('p7');
		expect(table.canStart()).toBe(false);
		table.sitIn('p7');
		const state = table.startHand(rng(0));
		expect(state.dealtIn.flatMap((dealt, seat) => (dealt ? [seat] : []))).toEqual([3, 7]);
		expect(table.canStart()).toBe(false); // a hand is in progress
		expect(refusal(() => table.startHand(rng(0)))).toBe('hand_in_progress');
	});

	it('picks the first button at random among the players dealt in', () => {
		const buttons = new Set<number>();
		for (let seed = 0; seed < 40; seed++) {
			buttons.add(tableWith([1, 4, 6]).startHand(rng(seed)).button);
		}
		expect(buttons).toEqual(new Set([1, 4, 6]));
	});

	it('moves the button and the blinds as rule 5.2 says', () => {
		// Rules example (seats emptying), first case: S0 to S5, button on S1.
		const table = tableWith([0, 1, 2, 3, 4, 5]);
		table.button = 1;
		let state = table.startHand(rng(0));
		expect([state.button, state.smallBlindSeat, state.bigBlindSeat]).toEqual([2, 3, 4]);
		finish(table);
		state = table.startHand(rng(1));
		expect([state.button, state.smallBlindSeat, state.bigBlindSeat]).toEqual([3, 4, 5]);
	});

	it('skips a seat that emptied', () => {
		// Rules example (seats emptying): S2 has left, so the button goes to S3.
		const table = tableWith([0, 1, 2, 3, 4, 5]);
		table.button = 1;
		table.leave('p2');
		const state = table.startHand(rng(0));
		expect([state.button, state.smallBlindSeat, state.bigBlindSeat]).toEqual([3, 4, 5]);
	});

	it('neither deals to nor takes blinds from a player sitting out', () => {
		// Rules example (seats emptying): S4 sitting out, so the big blind is S5.
		const table = tableWith([0, 1, 2, 3, 4, 5]);
		table.button = 1;
		table.sitOut('p4');
		const state = table.startHand(rng(0));
		expect([state.button, state.smallBlindSeat, state.bigBlindSeat]).toEqual([2, 3, 5]);
		expect(state.dealtIn[4]).toBe(false);
		expect(state.posts.every((post) => post.seat !== 4)).toBe(true);
	});

	it('deals a new player in next hand without posting', () => {
		// Rules example (seats filling) and rule 2.2.
		const table = tableWith([0, 1, 2, 3, 4, 5]);
		table.button = 0;
		table.startHand(rng(0)); // button S1
		table.sit(7, 'p7', 'Player 7', 5_000);
		expect(table.hand!.dealtIn[7]).toBe(false);
		finish(table);
		let state = table.startHand(rng(1));
		expect([state.button, state.smallBlindSeat, state.bigBlindSeat]).toEqual([2, 3, 4]);
		expect(state.dealtIn[7]).toBe(true);
		expect(state.posts.every((post) => post.seat !== 7)).toBe(true);
		for (let i = 0; i < 2; i++) {
			finish(table);
			state = table.startHand(rng(2));
		}
		expect(state.bigBlindSeat).toBe(7); // S7 first posts when its turn comes (here after S5)
	});

	it('goes heads-up after a player busts', () => {
		// Rules example (to heads-up): S5 is out of chips, so S3 is the button and small blind.
		const table = tableWith([1, 3, 5]);
		table.button = 0;
		table.startHand(rng(0));
		expect(table.button).toBe(1);
		finish(table);
		table.seats[5]!.stack = 0; // as if S5 had lost every chip
		const state = table.startHand(rng(1));
		expect([state.button, state.smallBlindSeat, state.bigBlindSeat]).toEqual([3, 3, 1]);
		expect(table.seats[5]).not.toBeNull(); // a busted player keeps the seat and can rebuy
	});
});

describe('leaving and sitting out', () => {
	it('folds a leaving player at each turn and frees the seat after the hand', () => {
		// Rule 2.3: the player folds when their turn comes; chips in the pot stay there.
		const table = tableWith([0, 1, 2]);
		table.button = 2;
		const state = table.startHand(rng(0));
		// Button S0, small blind S1, big blind S2: S0 acts first pre-flop.
		expect([state.button, state.toAct]).toEqual([0, 0]);
		table.actSeat(0, Action.call());
		expect(table.leave('p1')).toBeNull(); // the small blind leaves mid-hand
		expect(table.seats[1]!.leaving).toBe(true);
		// It was S1's turn, so S1 folded at once and the big blind is to act.
		expect(table.hand!.folded[1]).toBe(true);
		expect(table.toAct).toBe(2);
		expect(refusal(() => table.sit(1, 'x', 'X', 5_000))).toBe('seat_taken'); // freed only when the hand ends
		expect(refusal(() => table.sitIn('p1'))).toBe('bad_request');
		expect(refusal(() => table.rebuy('p1', 500))).toBe('bad_request');
		checkDown(table);
		expect(table.seats[1]).toBeNull();
		const [departure] = table.drainDepartures();
		expect(departure).toEqual({
			playerId: 'p1',
			seat: 1,
			chips: 10_000 - 50,
			left: true,
			bot: false
		});
		expect(table.stackOf(0) + table.stackOf(2)).toBe(20_050);
	});

	it('folds later turns but checks when that is free', () => {
		const table = tableWith([0, 1, 2]);
		table.button = 2;
		table.startHand(rng(0)); // button S0, blinds S1 and S2
		table.actSeat(0, Action.call());
		table.actSeat(1, Action.call());
		table.leave('p0'); // S0 has acted; its turn comes again on the flop
		expect(table.hand!.folded[0]).toBe(false);
		table.actSeat(2, Action.check()); // the big blind's option ends pre-flop
		table.actSeat(1, Action.check());
		table.actSeat(2, Action.check());
		let hand = table.hand!;
		// S0 checked on the flop when its turn came, since checking was free.
		const flop = hand.actions.filter((a) => STREET_LABELS[a.street] === 'flop');
		expect(flop.map((a) => [a.seat, a.kind])).toEqual([
			[1, 'check'],
			[2, 'check'],
			[0, 'check']
		]);
		expect(STREET_LABELS[hand.street]).toBe('turn');
		table.actSeat(1, Action.bet(200));
		table.actSeat(2, Action.call());
		hand = table.hand!;
		expect(hand.folded[0]).toBe(true); // facing a bet, S0 folded
		checkDown(table);
		expect(table.seats[0]).toBeNull();
		expect(table.drainDepartures()[0].chips).toBe(10_000 - 100);
	});

	it('frees the seat at once between hands', () => {
		const table = tableWith([0, 1, 2]);
		const departure = table.leave('p2');
		expect(departure?.chips).toBe(10_000);
		expect(table.seats[2]).toBeNull();
		expect(refusal(() => table.leave('p2'))).toBe('not_seated');
	});

	it('applies sitting out mid-hand when the hand ends', () => {
		const table = tableWith([0, 1, 2]);
		table.startHand(rng(3));
		table.sitOut('p0');
		const player = table.seats[0]!;
		expect([player.sitOutNext, player.sittingOut]).toEqual([true, false]);
		expect(table.hand!.folded[0]).toBe(false);
		finish(table);
		expect(player.sittingOut).toBe(true);
		expect(table.startHand(rng(4)).dealtIn[0]).toBe(false);
		table.sitIn('p0');
		finish(table);
		expect(table.startHand(rng(5)).dealtIn[0]).toBe(true);
	});

	it('cancels sitting out by sitting in before the hand ends', () => {
		const table = tableWith([0, 1]);
		table.startHand(rng(0));
		table.sitOut('p1');
		table.sitIn('p1');
		finish(table);
		expect(table.seats[1]!.sittingOut).toBe(false);
	});
});

describe('rebuys', () => {
	it('keep the stack in the buy-in range', () => {
		const table = tableWith([0, 1], CONFIG, 4_000);
		table.rebuy('p0', 6_000);
		expect(table.stackOf(0)).toBe(10_000);
		for (const amount of [1, 0, -5, 1.5]) {
			expect(refusal(() => table.rebuy('p0', amount))).toBe('bad_buy_in');
		}
		table.seats[1]!.stack = 1_000; // as if the player had lost most of their chips
		expect(refusal(() => table.rebuy('p1', 2_000))).toBe('bad_buy_in'); // 3,000 is below the minimum
		table.rebuy('p1', 3_000);
		expect(table.stackOf(1)).toBe(4_000);
	});

	it('are added when the hand ends', () => {
		const table = tableWith([0, 1], CONFIG, 5_000);
		table.startHand(rng(0));
		table.rebuy('p0', 2_000);
		expect(table.stackOf(0)).toBeLessThan(5_000); // blinds posted; the rebuy has not arrived
		expect(refusal(() => table.rebuy('p0', 4_000))).toBe('bad_buy_in'); // would pass the maximum
		finish(table);
		expect(table.stackOf(0) + table.stackOf(1)).toBe(12_000);
		const kinds = table.drainEvents().map((e) => e.kind);
		expect(kinds).toContain('rebuy_pending');
		expect(kinds[kinds.length - 1]).toBe('rebought');
	});

	it('are fitted to the maximum', () => {
		const table = tableWith([0, 1], CONFIG, 9_000);
		table.button = 1;
		table.startHand(rng(0)); // button S0 posts 50, S1 posts 100
		table.rebuy('p1', 1_000);
		finish(table); // S0 folds; S1 wins the small blind and is at 9,050
		expect(table.stackOf(1)).toBe(10_000);
		expect(table.drainDepartures()).toEqual([
			{ playerId: 'p1', seat: 1, chips: 50, left: false, bot: false }
		]);
	});
});

describe('acting', () => {
	it('lets only the seat to act act', () => {
		const table = tableWith([0, 1, 2]);
		expect(refusal(() => table.act('p0', Action.check()))).toBe('hand_over');
		const state = table.startHand(rng(0));
		const toAct = state.toAct as number;
		const other = [0, 1, 2].find((s) => s !== toAct) as number;
		expect(refusal(() => table.act(`p${other}`, Action.call()))).toBe('not_your_turn');
		// Facing the big blind, a check is not legal, and the refusal says what is.
		let message = '';
		try {
			table.act(`p${toAct}`, Action.check());
		} catch (error) {
			message = (error as TableError).message;
			expect((error as TableError).code).toBe('illegal_action');
		}
		expect(message).toBe(
			'That is not allowed now: you may call 100, raise to 200 to 10000 or fold.'
		);
		expect(refusal(() => table.act('nobody', Action.call()))).toBe('not_seated');
		expect(describeLegal(table.hand!)).toBe('you may call 100, raise to 200 to 10000 or fold');
	});

	it('refuses an action meant for an earlier turn', () => {
		const table = tableWith([0, 1]);
		table.button = 1;
		table.startHand(rng(0)); // S0 acts first
		const first = table.turn!.seq;
		table.act('p0', Action.call(), table.seq);
		table.act('p1', Action.check(), table.seq);
		expect(table.toAct).toBe(1); // the flop: the big blind acts first heads-up
		table.act('p1', Action.check(), table.seq);
		expect(table.toAct).toBe(0);
		expect(table.turn!.seq).toBeGreaterThan(first);
		expect(refusal(() => table.act('p0', Action.check(), first))).toBe('stale');
		table.act('p0', Action.check(), table.turn!.seq); // the seq of the turn itself is enough
	});

	it('numbers its events and never reveals unshown cards', () => {
		const table = tableWith([0, 1, 2]);
		table.startHand(rng(7));
		checkDown(table);
		const events = table.drainEvents();
		expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => events[0].seq + i));
		const kinds = events.map((e) => e.kind);
		expect(kinds[0]).toBe('hand_started');
		expect(kinds[kinds.length - 1]).toBe('hand_ended');
		expect(kinds.filter((kind) => kind === 'board').length).toBe(3);
		const state = table.hand!;
		const text = JSON.stringify(events.filter((e) => e.kind !== 'hand_ended').map((e) => e.data));
		const board = new Set(state.board.map(cardStr));
		for (let seat = 0; seat < 3; seat++) {
			for (const c of state.holeCards[seat]!) {
				expect(board.has(cardStr(c))).toBe(false);
				expect(text).not.toContain(`"${cardStr(c)}"`);
			}
		}
		const ended = events[events.length - 1];
		const shown = (ended.data.shown as { seat: number }[]).map((s) => s.seat);
		expect(new Set(shown)).toEqual(new Set(state.result!.shown));
	});
});

describe('chips', () => {
	it.each([2, 3, 6, 9])(
		'are conserved through random seating and play at %i seats',
		(seatCount) => {
			// Players come and go, sit out, rebuy and act at random; no chip appears or
			// vanishes. Seen from the wallets (P4.2): every accepted buy-in and rebuy is
			// paid when it is asked for, and every departure pays chips back. What was
			// paid minus what went back always equals the chips at the table plus the
			// rebuys still waiting for a hand to end.
			const random = rng(seatCount);
			const config = tableConfig({
				seatCount,
				smallBlind: 5,
				bigBlind: 10,
				ante: random.choice([0, 1])
			});
			const table = new Table(config);
			let paid = 0;
			let removed = 0;
			let nextId = 0;
			let hands = 0;
			for (let step = 0; step < 4_000; step++) {
				const roll = random.random();
				const seated = table.players().map(([, player]) => player.playerId);
				try {
					if (roll < 0.08) {
						const amount = random.randint(config.minBuyIn, config.maxBuyIn);
						table.sit(random.below(seatCount), `n${++nextId}`, 'N', amount);
						paid += amount;
					} else if (roll < 0.11 && seated.length) {
						table.leave(random.choice(seated));
					} else if (roll < 0.14 && seated.length) {
						table.sitOut(random.choice(seated));
					} else if (roll < 0.2 && seated.length) {
						table.sitIn(random.choice(seated));
					} else if (roll < 0.24 && seated.length) {
						const amount = random.randint(1, config.maxBuyIn);
						table.rebuy(random.choice(seated), amount);
						paid += amount;
					} else if (table.handInProgress) {
						const legal = legalActions(table.hand!);
						table.actSeat(legal.seat, random.choice(options(legal)));
					} else if (table.canStart()) {
						table.startHand(random);
						hands += 1;
					}
				} catch (error) {
					if (!(error instanceof TableError)) throw error;
				}
				for (const event of table.drainEvents()) {
					if (event.kind === 'left') removed += event.data.stack as number;
				}
				const back = table.departures.reduce((total, d) => total + d.chips, 0);
				const left = table.departures.reduce((total, d) => total + (d.left ? d.chips : 0), 0);
				expect(removed).toBe(left);
				const waiting = table.players().reduce((total, [, p]) => total + p.pendingRebuy, 0);
				expect(chips(table) + waiting).toBe(paid - back);
				// Stacks may pass the maximum buy-in by winning, never go below zero.
				for (const [, player] of table.players()) expect(player.stack).toBeGreaterThanOrEqual(0);
			}
			expect(hands).toBeGreaterThan(50);
			expect(table.departures.some((d) => !d.left)).toBe(true); // some waiting rebuys went back
		}
	);
});

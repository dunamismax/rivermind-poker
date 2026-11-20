// The rule tests of test/engine/test_rules.py and test_payouts.py, and every
// hand-worked rule hand of test/engine/fixtures.py (exported to rules.json by
// test/engine/export_fixtures.py), against the TypeScript engine.

import { describe, expect, it } from 'vitest';
import { FULL_DECK } from '../../engine/cards.ts';
import { dumps, formatText, handRecord, stateToDict } from './history.ts';
import { buildPots, split, uncalledBet } from './pots.ts';
import { seededRandom } from './random.ts';
import { blindSeats, initialButton, nextButton } from './seating.ts';
import {
	Action,
	FLOP,
	IllegalActionError,
	RIVER,
	TURN,
	apply,
	finalStacks,
	handConfig,
	isOver,
	legalActions,
	potTotal,
	startHand,
	timeoutAction,
	type HandState
} from './state.ts';
import { RULE_HANDS, actingOrder, deal, play, ruleHandStates } from './testing.ts';

const STACK = 10_000;
const BLINDS = handConfig(50, 100);
const seats = (n: number, stack = STACK): (number | null)[] => new Array(n).fill(stack);
const empty = (n: number): (number | null)[] => new Array(n).fill(null);

const FIXTURES = RULE_HANDS;

describe('rule hands from test/engine/fixtures.py', () => {
	it('has every fixture, each named once', () => {
		expect(FIXTURES.length).toBeGreaterThanOrEqual(30);
		expect(new Set(FIXTURES.map((f) => f.name)).size).toBe(FIXTURES.length);
	});

	it.each(FIXTURES.map((f) => [`${f.name} (rule ${f.rule})`, f] as const))('%s', (_, fixture) => {
		const state = ruleHandStates(fixture).at(-1)!;
		expect(isOver(state)).toBe(true);
		const result = state.result!;
		// The hand-worked expectations.
		expect(finalStacks(state)).toEqual(fixture.final);
		const total = (stacks: (number | null)[]) => stacks.reduce<number>((a, b) => a + (b ?? 0), 0);
		expect(total(fixture.final)).toBe(total(fixture.stacks));
		expect(result.winnings.reduce((a, b) => a + b, 0)).toBe(
			result.pots.reduce((a, p) => a + p.amount, 0)
		);
		if (fixture.pots !== null) {
			expect(result.pots.map((p) => [p.amount, p.winners])).toEqual(fixture.pots);
			for (const pot of result.pots) expect(pot.shares.reduce((a, b) => a + b, 0)).toBe(pot.amount);
		}
		expect(result.uncalled).toEqual(fixture.uncalled);
		if (fixture.shown !== null) expect(result.shown).toEqual(fixture.shown);
		if (fixture.mucked !== null) expect(result.mucked).toEqual(fixture.mucked);
		if (fixture.tabled !== null) expect(result.tabled).toBe(fixture.tabled);
		// The Python engine's documents and text, byte for byte.
		expect(dumps(handRecord(state))).toBe(fixture.reference.record);
		expect(dumps(stateToDict(state))).toBe(fixture.reference.state);
		expect(formatText(state)).toBe(fixture.reference.text);
	});
});

describe('payouts (rules 9 to 11)', () => {
	it('9.2 builds the side-pot table', () => {
		// A 100, B 300, C 600, D 600, E 200; E folded.
		const pots = buildPots([100, 300, 600, 600, 200], [0, 1, 2, 3]);
		expect(pots.map((p) => [p.amount, p.eligible])).toEqual([
			[500, [0, 1, 2, 3]],
			[700, [1, 2, 3]],
			[600, [2, 3]]
		]);
	});

	it('9.1 counts folded players for the uncalled bet', () => {
		expect(uncalledBet([50, 100, 0])).toEqual([1, 50]);
		expect(uncalledBet([1000, 400, 50, 100])).toEqual([0, 600]);
		expect(uncalledBet([300, 300, 100])).toBeNull();
	});

	it('11.2 gives odd chips clockwise from the button', () => {
		expect(split(301, [2, 5], 4, 6)).toEqual([
			[5, 2],
			[151, 150]
		]);
		expect(split(100, [1, 3, 6], 6, 9)).toEqual([
			[1, 3, 6],
			[34, 33, 33]
		]);
	});
});

describe('section 1 · deck and dealing', () => {
	it('1.4 deals six players from the right positions', () => {
		let state = startHand(BLINDS, seats(6), 2, { deck: FULL_DECK });
		const d = FULL_DECK;
		expect(state.holeCards[3]).toEqual([d[0], d[6]]);
		expect(state.holeCards[4]).toEqual([d[1], d[7]]);
		expect(state.holeCards[2]).toEqual([d[5], d[11]]);
		expect([5, 0, 1].map((s) => state.holeCards[s])).toEqual([
			[d[2], d[8]],
			[d[3], d[9]],
			[d[4], d[10]]
		]);
		state = play(state, 'S5:c S0:c S1:c S2:c S3:c S4:k');
		expect(state.street).toBe(FLOP);
		expect(state.board).toEqual([d[13], d[14], d[15]]);
		state = play(state, 'S3:k S4:k S5:k S0:k S1:k S2:k');
		expect(state.board[3]).toBe(d[17]);
		state = play(state, 'S3:k S4:k S5:k S0:k S1:k S2:k');
		expect(state.board[4]).toBe(d[19]);
	});

	it('1.4 does not deal streets that are never reached', () => {
		const state = play(deal(seats(3), 0), 'S0:f S1:f');
		expect(isOver(state)).toBe(true);
		expect(state.board).toEqual([]);
	});

	it('1.1 needs exactly one of a deck and a generator', () => {
		expect(() => startHand(BLINDS, seats(2), 0, {})).toThrow(RangeError);
		expect(() => startHand(BLINDS, seats(2), 0, { deck: FULL_DECK, rng: seededRandom(1) })).toThrow(
			RangeError
		);
		expect(() => startHand(BLINDS, seats(2), 0, { deck: FULL_DECK.slice(0, -1) })).toThrow(
			RangeError
		);
		const a = startHand(BLINDS, seats(6), 0, { rng: seededRandom(7) });
		const b = startHand(BLINDS, seats(6), 0, { rng: seededRandom(7) });
		expect(a).toEqual(b);
	});
});

describe('section 2 · seats and players dealt in', () => {
	it('2.1 plays two players at nine seats heads-up', () => {
		const stacks = empty(9);
		stacks[1] = stacks[6] = STACK;
		const state = deal(stacks, 6);
		expect([state.smallBlindSeat, state.bigBlindSeat]).toEqual([6, 1]);
		expect(state.toAct).toBe(6);
	});

	it('2.1 needs two players dealt in', () => {
		const stacks = empty(9);
		stacks[1] = STACK;
		stacks[6] = 0;
		expect(() => startHand(BLINDS, stacks, 1, { deck: FULL_DECK })).toThrow(RangeError);
		expect(() => startHand(BLINDS, seats(10), 0, { deck: FULL_DECK })).toThrow(RangeError);
		expect(() => startHand(BLINDS, [STACK, null, STACK], 1, { deck: FULL_DECK })).toThrow(
			RangeError
		);
	});

	it('2.2 deals a new player in at the next hand', () => {
		const stacks = empty(9);
		stacks[1] = stacks[6] = stacks[3] = STACK;
		const button = nextButton(6, new Set([1, 3, 6]), 9);
		const state = deal(stacks, button);
		expect(button).toBe(1);
		expect([state.smallBlindSeat, state.bigBlindSeat]).toEqual([3, 6]);
		expect(state.dealtIn.filter(Boolean).length).toBe(3);
	});
});

describe('section 3 · blinds and antes', () => {
	it('3.2 antes are not street bets', () => {
		const state = deal(seats(6), 2, {}, '', handConfig(50, 100, 10));
		expect(potTotal(state)).toBe(210);
		expect(state.posts.map((p) => p.kind)).toEqual([
			...new Array(6).fill('ante'),
			'small_blind',
			'big_blind'
		]);
		expect(state.posts.slice(0, 6).map((p) => p.seat)).toEqual([3, 4, 5, 0, 1, 2]);
		expect(state.toAct).toBe(5);
		const legal = legalActions(state);
		expect([legal.call, legal.raiseKind, legal.minTo]).toEqual([100, 'raise', 200]);
	});

	it('3.3 a short big blind keeps the price', () => {
		const stacks = seats(6);
		stacks[4] = 60;
		const state = deal(stacks, 2);
		const last = state.posts.at(-1)!;
		expect([last.amount, last.allIn]).toEqual([60, true]);
		expect(state.currentBet).toBe(100);
		const legal = legalActions(state);
		expect([legal.call, legal.minTo]).toEqual([100, 200]);
	});

	it('3.3 a short ante is all-in before the deal', () => {
		const state = deal([STACK, 5, STACK], 0, {}, '', handConfig(50, 100, 10));
		expect(state.posts[0]).toEqual({ seat: 1, kind: 'ante', amount: 5, allIn: true });
		expect(state.posts[3]).toEqual({ seat: 1, kind: 'small_blind', amount: 0, allIn: true });
	});

	it('3.4 gives the big blind the option', () => {
		const state = play(deal(seats(6), 2), 'S5:c S0:c S1:c S2:c S3:c');
		expect(state.toAct).toBe(4);
		const legal = legalActions(state);
		expect([legal.canCheck, legal.canFold, legal.raiseKind, legal.minTo]).toEqual([
			true,
			false,
			'raise',
			200
		]);
	});
});

describe('section 4 · heads-up', () => {
	it('posts, deals and acts in heads-up order', () => {
		const stacks: (number | null)[] = [STACK, null, null, null, null, STACK];
		let state = startHand(BLINDS, stacks, 0, { deck: FULL_DECK });
		expect([state.smallBlindSeat, state.bigBlindSeat]).toEqual([0, 5]);
		expect(state.holeCards[5]).toEqual([FULL_DECK[0], FULL_DECK[2]]);
		expect(state.holeCards[0]).toEqual([FULL_DECK[1], FULL_DECK[3]]);
		expect(state.toAct).toBe(0);
		const legal = legalActions(state);
		expect([legal.canFold, legal.call, legal.minTo]).toEqual([true, 50, 200]);
		state = play(state, 'S0:c S5:k');
		expect(state.street).toBe(FLOP);
		expect(actingOrder(state)).toEqual([5, 0]);
	});
});

describe('section 5 · the button', () => {
	it('5.1 starts at a random player dealt in', () => {
		const picks = new Set<number>();
		for (let seed = 0; seed < 50; seed++) picks.add(initialButton([1, 4, 7], seededRandom(seed)));
		expect([...picks].sort()).toEqual([1, 4, 7]);
	});

	it('5.2 moves past emptying seats', () => {
		const everyone = new Set([0, 1, 2, 3, 4, 5]);
		expect(nextButton(1, everyone, 6)).toBe(2);
		expect(blindSeats(2, everyone, 6)).toEqual([3, 4]);
		const withoutS2 = new Set([0, 1, 3, 4, 5]);
		expect(nextButton(1, withoutS2, 6)).toBe(3);
		expect(blindSeats(3, withoutS2, 6)).toEqual([4, 5]);
		const withoutS4 = new Set([0, 1, 2, 3, 5]);
		expect(nextButton(1, withoutS4, 6)).toBe(2);
		expect(blindSeats(2, withoutS4, 6)).toEqual([3, 5]);
	});

	it('5.2 moves past filling seats', () => {
		const dealt = new Set([0, 1, 2, 3, 4, 5, 7]);
		const buttons = [nextButton(1, dealt, 9)];
		expect(buttons[0]).toBe(2);
		expect(blindSeats(2, dealt, 9)).toEqual([3, 4]);
		for (let i = 0; i < 2; i++) buttons.push(nextButton(buttons.at(-1)!, dealt, 9));
		expect(blindSeats(buttons.at(-1)!, dealt, 9)).toEqual([5, 7]);
	});

	it('5.3 goes to heads-up', () => {
		const button = nextButton(1, new Set([1, 3]), 6);
		expect(button).toBe(3);
		expect(blindSeats(button, new Set([1, 3]), 6)).toEqual([3, 1]);
	});
});

function checkDownStreet(state: HandState, order: number[]): HandState {
	for (const seat of order) {
		expect(state.toAct).toBe(seat);
		state = apply(state, legalActions(state).canCheck ? Action.check() : Action.call());
	}
	return state;
}

describe('section 6 · betting rounds and order of action', () => {
	it.each([
		[2, 0, [0, 1], [1, 0]],
		[2, 1, [1, 0], [0, 1]],
		[3, 0, [0, 1, 2], [1, 2, 0]],
		[3, 2, [2, 0, 1], [0, 1, 2]],
		[6, 2, [5, 0, 1, 2, 3, 4], [3, 4, 5, 0, 1, 2]],
		[9, 0, [3, 4, 5, 6, 7, 8, 0, 1, 2], [1, 2, 3, 4, 5, 6, 7, 8, 0]],
		[9, 8, [2, 3, 4, 5, 6, 7, 8, 0, 1], [0, 1, 2, 3, 4, 5, 6, 7, 8]]
	])('%i seats, button S%i: orders on every street', (count, button, preflop, postflop) => {
		let state = deal(seats(count), button);
		expect(actingOrder(state)).toEqual(preflop);
		state = checkDownStreet(state, preflop);
		for (const street of [FLOP, TURN, RIVER]) {
			expect(state.street).toBe(street);
			expect(actingOrder(state)).toEqual(postflop);
			state = checkDownStreet(state, postflop);
		}
		expect(isOver(state) && state.result!.showdown).toBe(true);
	});

	it('6.2 skips empty and all-in seats', () => {
		const stacks = [STACK, null, STACK, STACK, null, STACK, STACK, null, STACK];
		let state = deal(stacks, 2);
		expect([state.smallBlindSeat, state.bigBlindSeat]).toEqual([3, 5]);
		expect(actingOrder(state)).toEqual([6, 8, 0, 2, 3, 5]);
		const short = seats(6);
		short[3] = 100;
		state = play(deal(short, 2), 'S5:c S0:c S1:c S2:c S3:c S4:k');
		expect([state.street, state.toAct]).toEqual([FLOP, 4]);
	});

	it('6.3 continues the round after a raise', () => {
		let state = play(deal(seats(6), 2), 'S5:c S0:c S1:c S2:c S3:c S4:r300');
		expect(actingOrder(state)).toEqual([5, 0, 1, 2, 3]);
		state = play(deal(seats(4), 0), 'S3:c S0:c S1:c S2:k S1:b100 S2:r300 S3:c S0:c S1:c');
		expect(state.street).toBe(TURN);
	});

	it('6.4 skips later betting once players are all-in', () => {
		let state = play(deal([2_000, STACK, STACK], 0), 'S0:a S1:c S2:c');
		expect([state.street, state.toAct]).toEqual([FLOP, 1]);
		state = play(state, 'S1:b500 S2:c');
		expect(state.street).toBe(TURN);
		state = play(state, 'S1:a S2:c');
		expect(isOver(state) && state.result!.tabled).toBe(true);
		expect(state.board.length).toBe(5);
		state = play(deal(seats(2), 0), 'S0:r10000 S1:c');
		expect(isOver(state) && state.board.length === 5 && state.result!.tabled).toBe(true);
	});

	it('6.4 gives no option when everyone else is all-in', () => {
		const state = deal([30, STACK], 0);
		expect(isOver(state)).toBe(true);
		expect(state.board.length).toBe(5);
	});

	it('6.5 a fold-out wins at once', () => {
		const state = play(deal(seats(3), 0), 'S0:r300 S1:f S2:f');
		expect(isOver(state)).toBe(true);
		expect(state.board).toEqual([]);
		expect([state.result!.showdown, state.result!.shown]).toEqual([false, []]);
	});
});

describe('section 7 · legal actions and amounts', () => {
	it('gives the pre-flop re-raise range', () => {
		const legal = legalActions(play(deal(seats(6), 2), 'S5:r300'));
		expect([legal.seat, legal.call, legal.minTo, legal.maxTo]).toEqual([0, 300, 500, STACK]);
	});

	it('re-raises after the flop and calls for less', () => {
		const script = 'S5:c S0:c S1:c S2:c S3:c S4:k S3:b100 S4:r350';
		let legal = legalActions(play(deal(seats(6), 2), script));
		expect([legal.seat, legal.minTo]).toEqual([5, 600]);
		const stacks = seats(6);
		stacks[5] = 180;
		let state = play(deal(stacks, 2), script);
		legal = legalActions(state);
		expect([legal.call, legal.raiseKind]).toEqual([80, null]);
		state = play(state, 'S5:c');
		expect([state.stacks[5], state.streetBets[5], state.actions.at(-1)!.allIn]).toEqual([
			0,
			80,
			true
		]);
	});

	it('lets a short stack raise only all-in', () => {
		const stacks = seats(6);
		stacks[1] = 150;
		const state = play(deal(stacks, 2), 'S5:f S0:f');
		const legal = legalActions(state);
		expect([legal.canFold, legal.call, legal.raiseKind, legal.minTo, legal.maxTo]).toEqual([
			true,
			100,
			'raise',
			150,
			150
		]);
		expect(() => apply(state, Action.raiseTo(140))).toThrow(IllegalActionError);
	});

	it('7.3 opens with at least one big blind', () => {
		const state = play(deal(seats(3), 0), 'S0:c S1:c S2:k');
		const legal = legalActions(state);
		expect([legal.raiseKind, legal.minTo, legal.canCheck, legal.canFold]).toEqual([
			'bet',
			100,
			true,
			false
		]);
		for (const bad of [Action.bet(99), Action.raiseTo(100), Action.fold()]) {
			expect(() => apply(state, bad)).toThrow(IllegalActionError);
		}
	});

	it('7.8 allows no raise when everyone else is all-in', () => {
		let legal = legalActions(play(deal([STACK, null, 20_000], 0), 'S0:a'));
		expect([legal.seat, legal.call, legal.raiseKind]).toEqual([2, 9_900, null]);
		legal = legalActions(deal([STACK, null, null, null, null, 60], 0));
		expect([legal.call, legal.raiseKind]).toEqual([50, null]);
	});
});

describe('section 8 · incomplete raises and reopening', () => {
	it('an incomplete raise does not reopen the betting', () => {
		let state = play(deal([STACK, STACK, 250, STACK], 0), 'S3:c S0:c S1:c S2:k S1:b100 S2:a');
		expect([state.currentBet, state.minRaise]).toEqual([150, 100]);
		let legal = legalActions(state);
		expect([legal.seat, legal.call, legal.minTo]).toEqual([3, 150, 250]);
		state = play(state, 'S3:c S0:f');
		legal = legalActions(state);
		expect([legal.seat, legal.call, legal.raiseKind]).toEqual([1, 50, null]);
	});

	it('8.2 incomplete raises add up', () => {
		const state = play(
			deal([STACK, STACK, 250, 310], 0),
			'S3:c S0:c S1:c S2:k S1:b100 S2:a S3:a S0:c'
		);
		const legal = legalActions(state);
		expect([legal.seat, legal.call, legal.raiseKind, legal.minTo]).toEqual([1, 110, 'raise', 310]);
	});

	it('8.1 the raiser cannot re-raise after an incomplete raise', () => {
		let state = play(
			deal([STACK, STACK, STACK, 350], 0),
			'S3:c S0:c S1:c S2:k S1:b100 S2:r200 S3:a S0:f'
		);
		let legal = legalActions(state);
		expect([legal.seat, legal.raiseKind, legal.minTo]).toEqual([1, 'raise', 350]);
		state = play(state, 'S1:c');
		legal = legalActions(state);
		expect([legal.seat, legal.call, legal.raiseKind]).toEqual([2, 50, null]);
	});
});

describe('section 13 · timeouts', () => {
	it('checks or folds', () => {
		let state = play(deal(seats(6), 2), 'S5:c S0:c S1:c S2:c S3:c S4:k S3:k S4:k S5:k S0:k S1:k');
		expect(state.toAct).toBe(2);
		expect(timeoutAction(state)).toEqual(Action.check());
		state = play(deal(seats(6), 2), 'S5:c S0:c S1:c S2:c S3:c S4:k S3:b100');
		expect(timeoutAction(state)).toEqual(Action.fold());
		state = play(deal(seats(6), 2), 'S5:c S0:c S1:c S2:c S3:c');
		expect(timeoutAction(state)).toEqual(Action.check());
		state = play(deal(seats(6), 2), 'S5:c S0:c S1:c S2:c');
		expect(timeoutAction(state)).toEqual(Action.fold());
	});
});

describe('illegal actions', () => {
	it('are rejected, as is acting after the hand', () => {
		const state = deal(seats(3), 0);
		for (const bad of [
			Action.check(),
			Action.bet(200),
			Action.raiseTo(199),
			Action.raiseTo(10_001),
			Action.raiseTo(250.5),
			Action.of('call', 100)
		]) {
			expect(() => apply(state, bad)).toThrow(IllegalActionError);
		}
		expect(() => apply(state, { kind: 'shove', amount: null } as unknown as Action)).toThrow(
			IllegalActionError
		);
		const over = play(state, 'S0:f S1:f');
		expect(() => legalActions(over)).toThrow(IllegalActionError);
		expect(() => apply(over, Action.check())).toThrow(IllegalActionError);
	});

	it('leave the state untouched', () => {
		const state = deal(seats(3), 0);
		const before = dumps(stateToDict(state));
		expect(() => apply(state, Action.raiseTo(1))).toThrow(IllegalActionError);
		expect(dumps(stateToDict(state))).toBe(before);
	});

	it('validates stakes', () => {
		expect(() => handConfig(0, 100)).toThrow(RangeError);
		expect(() => handConfig(100, 50)).toThrow(RangeError);
		expect(() => handConfig(50, 100, -1)).toThrow(RangeError);
		expect(() => handConfig(50.5, 100)).toThrow(TypeError);
	});
});

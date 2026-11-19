import { describe, expect, it } from 'vitest';
import type { SeatView, TableEvent } from './protocol.ts';
import {
	buttonLabel,
	cardName,
	describe as describeEvent,
	lastActions,
	logEntries,
	rankLabel,
	resultLine
} from './wording.ts';

function event(partial: Partial<TableEvent>): TableEvent {
	return { seat: 1, action: 'call', stage: 'flop', chips: 0, facing: 0, ...partial };
}

function view(partial: Partial<SeatView> = {}): SeatView {
	const seat = (i: number, name: string) => ({
		seat: i,
		name,
		kind: i === 0 ? ('human' as const) : ('bot' as const),
		position: (['small_blind', 'big_blind', 'button'] as const)[i],
		stack: 10000,
		bet: 0,
		folded: false,
		is_turn: false,
		balance: 0,
		cards: null
	});
	return {
		hand: 3,
		seq: 10,
		seat: 0,
		stage: 'flop',
		board: [],
		pot: 300,
		seats: [seat(0, 'You'), seat(1, 'Random 1'), seat(2, 'Random 2')],
		your_turn: false,
		legal_actions: [],
		action_amounts: {},
		events: [],
		result: null,
		...partial
	};
}

describe('buttonLabel', () => {
	it.each([
		['fold', {}, 'Fold'],
		['call', { call: 0 }, 'Check'],
		['call', { call: 150 }, 'Call 150'],
		['raise', { call: 0, raise: 100 }, 'Bet 100'],
		['raise', { call: 150, raise: 250 }, 'Raise 250']
	] as const)('%s with %o reads %s', (action, amounts, label) => {
		expect(buttonLabel(action, amounts)).toBe(label);
	});
});

describe('describe', () => {
	it.each([
		[event({ action: 'call' }), 'checks', 'check'],
		[event({ action: 'call', chips: 100, facing: 100 }), 'calls 100', 'call 100'],
		[event({ action: 'raise', chips: 100 }), 'bets 100', 'bet 100'],
		[
			event({ action: 'raise', chips: 200, facing: 100 }),
			'calls 100 and raises 100',
			'call 100 and raise 100'
		],
		[event({ action: 'fold', chips: 0, facing: 100 }), 'folds', 'fold'],
		// Pre-flop the big blind is a bet already, so the opener raises.
		[event({ action: 'raise', stage: 'pre_flop', chips: 100 }), 'raises 100', 'raise 100'],
		[
			event({ action: 'raise', stage: 'pre_flop', chips: 150, facing: 50 }),
			'calls 50 and raises 100',
			'call 50 and raise 100'
		]
	])('%o reads "%s" and "%s"', (e, third, second) => {
		expect(describeEvent(e)).toBe(third);
		expect(describeEvent(e, true)).toBe(second);
	});
});

describe('cards', () => {
	it('names ranks and cards', () => {
		expect([10, 11, 12, 13, 14].map(rankLabel)).toEqual(['10', 'J', 'Q', 'K', 'A']);
		expect(cardName({ rank: 14, suit: 'spades' })).toBe('Ace of spades');
		expect(cardName({ rank: 11, suit: 'hearts' })).toBe('Jack of hearts');
		expect(cardName({ rank: 10, suit: 'clubs' })).toBe('10 of clubs');
	});
});

describe('lastActions', () => {
	it('keeps this street’s latest action per seat, and folds from any street', () => {
		const events = [
			event({ seat: 2, action: 'fold', stage: 'pre_flop' }),
			event({ seat: 1, action: 'call', stage: 'pre_flop', chips: 100, facing: 100 }),
			event({ seat: 1, action: 'call', stage: 'flop' }),
			event({ seat: 1, action: 'raise', stage: 'flop', chips: 200, facing: 100 })
		];
		const last = lastActions(view({ events }));
		expect(last.get(2)?.event.action).toBe('fold');
		expect(last.get(1)).toEqual({ event: events[3], index: 3 });
		expect(last.has(0)).toBe(false);
	});
});

describe('resultLine', () => {
	it('is empty while the hand is played', () => {
		expect(resultLine(view())).toBeNull();
	});
	it('names a single winner and whether it went to showdown', () => {
		const payouts = { 0: -100, 1: 200, 2: -100 };
		expect(resultLine(view({ result: { payouts, showdown: true } }))).toBe(
			'Random 1 wins 200 at showdown'
		);
		expect(
			resultLine(view({ result: { payouts: { 0: 150, 1: -50, 2: -100 }, showdown: false } }))
		).toBe('You win 150');
	});
	it('splits pots', () => {
		const result = { payouts: { 0: 75, 1: 75, 2: -150 }, showdown: true };
		expect(resultLine(view({ result }))).toBe('You and Random 1 win 75 each at showdown');
	});
});

describe('logEntries', () => {
	it('heads the hand, marks streets and your actions, and pauses after bots', () => {
		const events = [
			event({ seat: 1, action: 'call', stage: 'pre_flop', chips: 100, facing: 100 }),
			event({ seat: 0, action: 'call', stage: 'pre_flop', chips: 50, facing: 50 }),
			event({ seat: 1, action: 'call', stage: 'flop' })
		];
		const result = { payouts: { 0: 150, 1: -100, 2: -50 }, showdown: false };
		expect(logEntries(view({ events, result }))).toEqual([
			{ text: 'Hand 3', kind: 'street', pauseAfter: false },
			{ text: 'Random 1 calls 100', kind: 'other', pauseAfter: true },
			{ text: 'You call 50', kind: 'mine', pauseAfter: false },
			{ text: 'Flop', kind: 'street', pauseAfter: false },
			{ text: 'Random 1 checks', kind: 'other', pauseAfter: true },
			{ text: 'You +150 · Random 1 -100 · Random 2 -50', kind: 'street', pauseAfter: false }
		]);
	});
});

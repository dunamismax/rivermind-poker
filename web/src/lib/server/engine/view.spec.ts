// SeatView v2 never exposes another seat's private cards, ported from
// test/engine/test_view.py.

import { describe, expect, it } from 'vitest';
import { choice, randomAction, randomStacks } from './fuzz.ts';
import { seededRandom, shuffle } from './random.ts';
import {
	apply,
	handConfig,
	isOver,
	legalActions,
	seatOrder,
	startHand,
	type HandState
} from './state.ts';
import { ruleHand, ruleHandStates } from './testing.ts';
import { opponents, seatView, toCall } from './view.ts';

/** Deck positions the viewer cannot see: other hole cards, burns and undealt cards. */
function hiddenPositions(numDealt: number, orderIndex: number): number[] {
	const n = numDealt;
	const visible = new Set([
		orderIndex,
		n + orderIndex,
		2 * n + 1,
		2 * n + 2,
		2 * n + 3,
		2 * n + 5,
		2 * n + 7
	]);
	return Array.from({ length: 52 }, (_, p) => p).filter((p) => !visible.has(p));
}

describe('seat views', () => {
	it.each(Array.from({ length: 60 }, (_, seed) => seed))(
		'seed %i: a view does not depend on other seats’ cards',
		(seed) => {
			const rng = seededRandom(seed);
			const numSeats = 2 + (seed % 8);
			const config = handConfig(50, 100, choice(rng, [0, 10]));
			const stacks = randomStacks(numSeats, config, rng);
			const dealt = stacks.map((_, s) => s).filter((s) => stacks[s]);
			const button = choice(rng, dealt);
			const deck = shuffle(
				Array.from({ length: 52 }, (_, c) => c),
				rng
			);
			let first: HandState = startHand(config, stacks, button, { deck });
			const viewer = choice(rng, dealt);
			const positions = hiddenPositions(dealt.length, seatOrder(first).indexOf(viewer));
			const otherDeck = [...deck];
			const hidden = shuffle(
				positions.map((p) => deck[p]),
				rng
			);
			positions.forEach((p, i) => (otherDeck[p] = hidden[i]));
			let second: HandState = startHand(config, stacks, button, { deck: otherDeck });
			for (;;) {
				const a = seatView(first, viewer);
				const b = seatView(second, viewer);
				if (isOver(first) && first.result!.showdown) {
					expect(a.revealed).toEqual(first.result!.shown.map((s) => [s, first.holeCards[s]]));
					expect({ ...a, revealed: [], stacks: [] }).toEqual({ ...b, revealed: [], stacks: [] });
					break;
				}
				expect(a).toEqual(b);
				if (isOver(first)) break;
				const action = randomAction(first, legalActions(first), rng);
				first = apply(first, action);
				second = apply(second, action);
			}
		}
	);

	it('has no field for the deck or other hands', () => {
		const state = startHand(handConfig(50, 100), [1_000, 1_000, 1_000], 0, {
			rng: seededRandom(2)
		});
		for (let seat = 0; seat < 3; seat++) {
			const view = seatView(state, seat);
			expect(Object.keys(view)).not.toContain('deck');
			expect(view.holeCards).toEqual(state.holeCards[seat]);
			const others = new Set(
				[0, 1, 2].filter((s) => s !== seat).flatMap((s) => [...state.holeCards[s]!])
			);
			expect(view.holeCards!.some((c) => others.has(c))).toBe(false);
		}
	});

	it('reveals only shown hands', () => {
		const state = ruleHandStates(ruleHand('river bettor shows first and a loser mucks')).at(-1)!;
		const view = seatView(state, 1);
		expect(view.revealed.map(([seat]) => seat)).toEqual([1, 5]);
		expect(view.revealed.some(([, cards]) => cards === state.holeCards[3])).toBe(false);
	});

	it('has the expected fields', () => {
		const state = startHand(handConfig(50, 100), [1_000, null, 600, 900], 0, {
			rng: seededRandom(5)
		});
		const view = seatView(state, state.toAct!);
		expect([view.seat, view.legal !== null, toCall(view)]).toEqual([0, true, 100]);
		expect(view.stacks).toEqual([1_000, null, 550, 800]);
		expect([view.pot, view.currentBet]).toEqual([150, 100]);
		expect(view.seatOrder).toEqual([2, 3, 0]);
		expect(opponents(view)).toEqual([2, 3]);
		expect(seatView(state, 2).legal).toBeNull();
		expect(() => seatView(state, 4)).toThrow(RangeError);
	});
});

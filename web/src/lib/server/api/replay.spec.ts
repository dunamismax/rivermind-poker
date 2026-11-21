// The replay of a finished hand (P6.1), checked against hands the engine
// played: a showdown, a fold-out, a side pot and a split. Each replay is built
// from the `HandDetail` a viewer is sent, so it can show only the cards they
// may see, and its pots, shares and nets must be the stored result's.
import { describe, expect, it } from 'vitest';
import { buildDeck, cards } from '../../engine/cards.ts';
import { buildReplay, type ReplayStep } from '../../nl/replay.ts';
import type * as p from '../../protocol-v2.ts';
import { handRecord } from '../engine/history.ts';
import { Action, apply, handConfig, startHand, type HandState } from '../engine/state.ts';
import type { PlayedHand } from './hands.ts';
import { handDetail } from './views.ts';

const NAMES = ['Ann', 'Bob', 'Cy'];

/** Play `actions` from the deal and return the hand as each seat may see it. */
function play(
	stacks: number[],
	holes: string[],
	board: string,
	actions: Action[]
): { state: HandState; view: (seat: number) => p.HandDetail } {
	// Hole cards are given by seat; the deck wants them in dealing order, left of the button first.
	const n = stacks.length;
	const order = Array.from({ length: n }, (_, i) => (i + 1) % n);
	const deck = buildDeck(
		order.map((seat) => cards(holes[seat])),
		cards(board)
	);
	let state = startHand(handConfig(50, 100), stacks, 0, { deck });
	for (const action of actions) state = apply(state, action);
	expect(state.result, 'the hand is over').not.toBeNull();
	const played: PlayedHand = {
		handId: '7',
		tableId: 't1',
		tableName: 'Test table',
		handNo: 3,
		at: 0,
		record: handRecord(state),
		seats: stacks.map((stack, seat) => ({
			seat,
			playerId: `p${seat}`,
			name: NAMES[seat],
			bot: null,
			net: state.stacks[seat] - stack
		})),
		practice: false
	};
	return { state, view: (seat) => handDetail(played, seat) };
}

const kinds = (steps: ReplayStep[]) => steps.map((s) => s.kind);
const seatOf = (step: ReplayStep, seat: number) => step.seats.find((s) => s.seat === seat)!;
const shown = (step: ReplayStep) => step.seats.filter((s) => s.cards !== null).map((s) => s.seat);

/** What every replay must have in common with the stored result. */
function agrees(detail: p.HandDetail, steps: ReplayStep[]): void {
	const last = steps[steps.length - 1];
	expect(last.kind).toBe('result');
	expect(last.pot).toBe(detail.hand.pot);
	expect(last.awards.reduce((sum, a) => sum + a.amount, 0)).toBe(detail.hand.pot);
	expect(last.awards.map((a) => a.winners.map((w) => w.seat))).toEqual(
		detail.pots.map((pot) => pot.winners)
	);
	expect(last.awards.map((a) => a.winners.map((w) => w.share))).toEqual(
		detail.pots.map((pot) => pot.shares)
	);
	for (const seat of last.seats) {
		const stored = detail.seats.find((s) => s.seat === seat.seat)!;
		expect(seat.net).toBe(stored.net);
		// What a seat won less what it put in is what the hand cost or paid it.
		expect(seat.won - seat.total).toBe(stored.net);
	}
	// A step's sentences are its line; the result has one for each pot after any returned bet.
	for (const step of steps) expect(step.lines.join(' ')).toBe(step.text);
	expect(last.lines.slice(-last.awards.length)).toEqual(last.awards.map((a) => a.text));
	// The pot only grows until the result, and each action adds what it says.
	steps.slice(0, -1).forEach((step, i) => {
		if (i === 0) return;
		expect(step.pot - steps[i - 1].pot).toBe(step.kind === 'action' ? step.amount : 0);
	});
	// A board card, once dealt, stays; cards come only with a street step.
	steps.forEach((step, i) => {
		if (i === 0) return expect(step.board).toEqual([]);
		const grew = step.board.length > steps[i - 1].board.length;
		expect(grew).toBe(step.kind === 'street');
	});
}

describe('replaying a stored hand', () => {
	it('walks a showdown street by street and names the winning hand', () => {
		const { state, view } = play([10_000, 10_000], ['Kc Qd', 'Ah 7h'], 'Jh Td 9c 2s 3d', [
			Action.raiseTo(250),
			Action.call(),
			Action.check(),
			Action.bet(300),
			Action.call(),
			Action.check(),
			Action.check(),
			Action.check(),
			Action.bet(600),
			Action.call()
		]);
		// Bob, who lost, sees Ann's hand because she showed it.
		const detail = view(1);
		const steps = buildReplay(detail);
		agrees(detail, steps);
		expect(kinds(steps)).toEqual([
			'posts',
			'action',
			'action',
			'street',
			'action',
			'action',
			'action',
			'street',
			'action',
			'action',
			'street',
			'action',
			'action',
			'action',
			'showdown',
			'result'
		]);
		expect(steps[0].text).toBe('Ann posts the small blind, 50 and Bob posts the big blind, 100.');
		expect(steps[0].pot).toBe(150);
		expect(seatOf(steps[0], 0)).toMatchObject({ bet: 50, total: 50, folded: false });
		expect(steps[1]).toMatchObject({
			text: 'Ann raises to 250.',
			acting: 0,
			amount: 200,
			pot: 350
		});
		expect(steps[2]).toMatchObject({ text: 'Bob calls 150.', acting: 1, amount: 150, pot: 500 });
		expect(steps[3]).toMatchObject({ kind: 'street', street: 'flop', text: 'Flop: J♥ 10♦ 9♣' });
		// A new street: the bets in front of the seats are gathered, the totals stay.
		expect(seatOf(steps[3], 0)).toMatchObject({ bet: 0, total: 250 });
		expect(steps[5]).toMatchObject({ text: 'Ann bets 300.', street: 'flop', pot: 800 });
		expect(steps[7].text).toBe('Turn: 2♠');
		expect(steps[10].text).toBe('River: 3♦');
		expect(steps[12]).toMatchObject({ text: 'Ann bets 600.', pot: 1_700 });
		expect(steps[13]).toMatchObject({ text: 'Bob calls 600.', pot: 2_300 });
		// Ann's cards stay face down for Bob until the showdown.
		for (const step of steps.slice(0, 14)) expect(shown(step)).toEqual([1]);
		expect(steps[14].text).toBe('Showdown: Ann shows a king-high straight.');
		expect(shown(steps[14])).toEqual([0, 1]);
		const result = steps[15];
		expect(result.text).toBe('Ann wins the pot of 2,300 with a king-high straight.');
		expect(result.awards).toEqual([
			{
				label: 'The pot',
				amount: 2_300,
				winners: [{ seat: 0, name: 'Ann', share: 2_300 }],
				eligible: [0, 1],
				text: 'Ann wins the pot of 2,300 with a king-high straight.'
			}
		]);
		expect(seatOf(result, 0)).toMatchObject({ won: 2_300, net: 1_150 });
		expect(seatOf(result, 1)).toMatchObject({ won: 0, net: -1_150 });

		// Ann never sees the hand Bob mucked, at any step.
		const hers = view(0);
		const mucked = hers.seats.find((s) => s.seat === 1)!;
		expect(mucked).toMatchObject({ cards: null, shown: false });
		const forAnn = buildReplay(hers);
		agrees(hers, forAnn);
		for (const step of forAnn) expect(shown(step)).toEqual([0]);
		expect(JSON.stringify(forAnn)).not.toContain('"rank":14,"suit":"hearts"');
		expect(state.holeCards[1]).toEqual(cards('Ah 7h'));
	});

	it('says who was left standing when everyone else folded', () => {
		const { view } = play([10_000, 10_000], ['7c 2d', 'Ah Kh'], '', [
			Action.raiseTo(300),
			Action.fold()
		]);
		for (const viewer of [0, 1]) {
			const detail = view(viewer);
			expect(detail.hand.showdown).toBe(false);
			const steps = buildReplay(detail);
			agrees(detail, steps);
			expect(kinds(steps)).toEqual(['posts', 'action', 'action', 'result']);
			expect(steps[2]).toMatchObject({ text: 'Bob folds.', acting: 1, amount: 0 });
			expect(seatOf(steps[2], 1).folded).toBe(true);
			const result = steps[3];
			// The raise nobody called goes back before the pot is counted.
			expect(result.text).toBe(
				'Ann takes back 200 that nobody called. Ann wins the pot of 200: everyone else folded.'
			);
			expect(result.lines).toEqual([
				'Ann takes back 200 that nobody called.',
				'Ann wins the pot of 200: everyone else folded.'
			]);
			expect(result.pot).toBe(200);
			expect(seatOf(result, 0)).toMatchObject({ total: 100, won: 200, net: 100 });
			// No showdown: each viewer sees their own cards and nobody else's, to the end.
			for (const step of steps) expect(shown(step)).toEqual([viewer]);
		}
	});

	it('explains a main pot and a side pot', () => {
		const { view } = play([1_000, 5_000, 5_000], ['As Ad', 'Kc Kd', 'Qc Qd'], '2h 7s 9d 3c 4h', [
			Action.raiseTo(1_000), // Ann, on the button, all-in
			Action.call(),
			Action.call(),
			Action.bet(1_000), // Bob, into the side pot
			Action.call(),
			Action.check(),
			Action.check(),
			Action.check(),
			Action.check()
		]);
		const detail = view(0);
		expect(detail.pots.map((pot) => [pot.amount, pot.eligible, pot.winners])).toEqual([
			[3_000, [0, 1, 2], [0]],
			[2_000, [1, 2], [1]]
		]);
		const steps = buildReplay(detail);
		agrees(detail, steps);
		expect(steps[1]).toMatchObject({ text: 'Ann raises to 1,000 and is all-in.', pot: 1_150 });
		expect(seatOf(steps[1], 0).allIn).toBe(true);
		const result = steps[steps.length - 1];
		expect(result.awards.map((a) => [a.label, a.text])).toEqual([
			['Main pot', 'Ann wins the main pot of 3,000 with a pair of aces.'],
			['Side pot', 'Bob wins the side pot of 2,000 with a pair of kings.']
		]);
		expect(result.awards[1].eligible).toEqual([1, 2]);
		expect(seatOf(result, 0)).toMatchObject({ total: 1_000, won: 3_000, net: 2_000 });
		expect(seatOf(result, 1)).toMatchObject({ total: 2_000, won: 2_000, net: 0 });
		expect(seatOf(result, 2)).toMatchObject({ total: 2_000, won: 0, net: -2_000 });
		const showdown = steps[steps.length - 2];
		expect(showdown.kind).toBe('showdown');
		// Whoever showed is named with their hand; a hand that was mucked is not.
		const mucked = detail.seats.filter((s) => !s.shown).map((s) => s.name);
		for (const seat of detail.seats) {
			if (seat.shown) expect(showdown.text).toContain(`${seat.name} shows`);
		}
		for (const name of mucked) expect(showdown.text).not.toContain(`${name} shows`);
		expect(showdown.text).toContain('Ann shows a pair of aces');
		expect(showdown.text).toContain('Bob shows a pair of kings');
	});

	it('deals out the board when the betting ended early, and splits a tied pot', () => {
		const { view } = play([2_000, 2_000], ['2c 3d', '4c 5d'], 'As Ks Qs Js Ts', [
			Action.raiseTo(2_000),
			Action.call()
		]);
		const detail = view(1);
		const steps = buildReplay(detail);
		agrees(detail, steps);
		// Both all-in before the flop: the hands are turned over (rule 12.1), then the
		// three streets come one after another.
		expect(kinds(steps)).toEqual([
			'posts',
			'action',
			'action',
			'tabled',
			'street',
			'street',
			'street',
			'showdown',
			'result'
		]);
		expect(steps[3].text).toBe('All in: Ann shows 2♣ 3♦ and Bob shows 4♣ 5♦.');
		expect(steps[3].board).toEqual([]);
		// Bob sees only his own cards until then, and both hands from then on.
		expect(steps.map(shown)).toEqual([
			[1],
			[1],
			[1],
			[0, 1],
			[0, 1],
			[0, 1],
			[0, 1],
			[0, 1],
			[0, 1]
		]);
		expect(steps.slice(4, 7).map((s) => s.text)).toEqual([
			'Flop: A♠ K♠ Q♠',
			'Turn: J♠',
			'River: 10♠'
		]);
		// Winners are named in the stored order, first left of the button.
		expect(steps[steps.length - 1].text).toBe(
			'Bob and Ann split the pot of 4,000, each with a royal flush: 2,000 and 2,000.'
		);
		expect(steps[steps.length - 1].seats.map((s) => s.net)).toEqual([0, 0]);
	});
});

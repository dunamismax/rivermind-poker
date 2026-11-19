import { describe, expect, it } from 'vitest';
import type { HandInfo, Legal, TableEvent } from '../protocol-v2.ts';
import { callLabel, clampAmount, describeEvent, potFraction, presets, raiseLabel } from './bet.ts';

function hand(pot: number, current_bet: number): HandInfo {
	return {
		hand_no: 1,
		button: 0,
		small_blind_seat: 1,
		big_blind_seat: 2,
		street: 'flop',
		board: [],
		pot,
		current_bet,
		to_act: 0,
		posts: [],
		actions: [],
		result: null
	};
}

const facing: Legal = {
	can_fold: true,
	can_check: false,
	call: 100,
	raise_kind: 'raise',
	min_to: 200,
	max_to: 5000
};
const opening: Legal = {
	can_fold: false,
	can_check: true,
	call: 0,
	raise_kind: 'bet',
	min_to: 100,
	max_to: 5000
};

describe('bet sizing', () => {
	it('sizes pot bets and raises the card-room way', () => {
		expect(potFraction(1, opening, hand(300, 0))).toBe(300);
		// Facing 100 into 250 (pot 350 with the bet): pot raise is to 100 + (350 + 100).
		expect(potFraction(1, facing, hand(350, 100))).toBe(550);
		expect(potFraction(0.5, facing, hand(350, 100))).toBe(325);
	});

	it('clamps every preset to the legal range', () => {
		expect(presets(opening, hand(300, 0))).toEqual([
			{ label: 'Min', amount: 100 },
			{ label: '½ pot', amount: 150 },
			{ label: '¾ pot', amount: 225 },
			{ label: 'Pot', amount: 300 },
			{ label: 'All-in', amount: 5000 }
		]);
		const small = presets(opening, hand(150, 0));
		expect(small.find((p) => p.label === '½ pot')?.amount).toBe(100); // below the minimum bet
		const short = { ...facing, max_to: 400 };
		expect(presets(short, hand(350, 100)).map((p) => p.amount)).toEqual([200, 325, 400, 400, 400]);
		expect(presets({ ...facing, raise_kind: null }, hand(350, 100))).toEqual([]);
	});

	it('keeps typed amounts whole and in range', () => {
		expect(clampAmount(50, facing)).toBe(200);
		expect(clampAmount(9999, facing)).toBe(5000);
		expect(clampAmount(333.7, facing)).toBe(333);
		expect(clampAmount(Number.NaN, facing)).toBe(200);
	});

	it('labels the buttons', () => {
		expect(callLabel(opening)).toBe('Check');
		expect(callLabel(facing)).toBe('Call 100');
		expect(raiseLabel(opening, 300)).toBe('Bet 300');
		expect(raiseLabel(facing, 600)).toBe('Raise to 600');
		expect(raiseLabel(facing, 5000)).toBe('Raise to 5000 (all-in)');
	});
});

describe('describeEvent', () => {
	const names = (seat: number) => `S${seat}`;
	const event = (fields: Partial<TableEvent>): TableEvent => ({
		seq: 1,
		kind: 'action',
		...fields
	});

	it('words actions with what they put in', () => {
		expect(describeEvent(event({ seat: 2, action: 'raise', amount: 600, added: 500 }), names)).toBe(
			'S2 raises to 600'
		);
		expect(describeEvent(event({ seat: 1, action: 'call', amount: 600, added: 550 }), names)).toBe(
			'S1 calls 550'
		);
		expect(describeEvent(event({ seat: 3, action: 'check', amount: 0, added: 0 }), names)).toBe(
			'S3 checks'
		);
		expect(
			describeEvent(event({ seat: 0, action: 'bet', amount: 900, added: 900, all_in: true }), names)
		).toBe('S0 bets 900 and is all-in');
	});

	it('words table events and skips the rest', () => {
		expect(describeEvent(event({ kind: 'hand_started', seat: 4, hand_no: 7 }), names)).toBe(
			'Hand #7 · S4 has the button'
		);
		expect(describeEvent(event({ kind: 'sat_out', seat: 1, reason: 'away' }), names)).toBe(
			'S1 is away and sits out'
		);
		expect(describeEvent(event({ kind: 'board', street: 'turn' }), names)).toBe('Turn dealt');
		expect(describeEvent(event({ kind: 'turn', seat: 1 }), names)).toBeNull();
	});
});

// The hand evaluator (rule 10), ported from test/engine/test_evaluator.py, with
// digests pinned from the Python reference (rivermind/engine/differential.py).
// scripts/engine-parity.ts compares larger samples against Python directly.

import { describe as group, expect, it } from 'vitest';
import {
	SplitMix32,
	allFiveCardHands,
	evaluatorReport,
	sampleHands
} from '../server/engine/parity.ts';
import { cards } from './cards.ts';
import { MAX_HIGH_CARD, combinations, describe, evaluate, rankClass } from './evaluator.ts';

group('evaluator', () => {
	it('ranks the rule 10 example', () => {
		const board = cards('Ks Kh 7d 7c 2s');
		const a = evaluate([...cards('Ah 3d'), ...board]);
		const b = evaluate([...cards('Qc Jc'), ...board]);
		expect(a).toBeLessThan(b);
		expect([describe(a), describe(b)]).toEqual(['Two Pair', 'Two Pair']);
		expect(evaluate([...cards('Ac 4c'), ...board])).toBe(a);
	});

	it('knows the extremes and classes', () => {
		expect(evaluate(cards('As Ks Qs Js Ts 2c 3d'))).toBe(1);
		expect(evaluate(cards('7c 5d 4h 3s 2c'))).toBe(MAX_HIGH_CARD);
		expect(describe(evaluate(cards('5s 4h 3d 2c Ah 9c 9d')))).toBe('Straight');
		expect(evaluate(cards('5s 4h 3d 2c Ah'))).toBeGreaterThan(evaluate(cards('6s 5h 4d 3c 2h')));
		expect([1, 11, 167, 323, 1600, 1610, 2468, 3326, 6186].map(rankClass)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9
		]);
		expect(() => evaluate(cards('As Ks'))).toThrow(RangeError);
		expect(() => rankClass(7463)).toThrow(RangeError);
	});

	it('samples with the same SplitMix32 as test/engine/test_differential.py', () => {
		const gen = new SplitMix32(0);
		expect([gen.next(), gen.next(), gen.next()]).toEqual([1684164658, 3653269916, 2939563536]);
	});

	it('generates combinations in itertools order', () => {
		expect([...combinations([0, 1, 2, 3], 2)]).toEqual([
			[0, 1],
			[0, 2],
			[0, 3],
			[1, 2],
			[1, 3],
			[2, 3]
		]);
		expect([...combinations([1, 2], 3)]).toEqual([]);
	});

	it('scores every five-card hand into the known class counts and all 7,462 ranks', () => {
		const seen = new Set<number>();
		const report = evaluatorReport(
			(function* () {
				for (const hand of allFiveCardHands()) {
					seen.add(evaluate(hand));
					yield hand;
				}
			})(),
			{}
		);
		expect(report.hands).toBe(2_598_960);
		expect(report.classes).toEqual([
			40, 624, 3_744, 5_108, 10_200, 54_912, 123_552, 1_098_240, 1_302_540
		]);
		expect(seen.size).toBe(MAX_HIGH_CARD);
	}, 60_000);

	// Digests of the ranks the Python evaluator gives the same seeded samples:
	// `python -m rivermind.engine.differential evaluator --size N --hands 50000`.
	it.each([
		[5, '27101dbe21b9c95b24dc06c454f5736d0f3b7b7ef720995171400fab8154e5e4'],
		[6, 'dee2357219ae639274628510a5fc074c7b571ca14d9baa1dec72cc955e6415b7'],
		[7, 'e90ab8e3284b0da1adbdbba801df36544f70480bd337980abb956529b96a860a']
	])('agrees with Python on 50,000 seeded %i-card hands', (size, sha256) => {
		expect(evaluatorReport(sampleHands(size, 50_000, 0), {}).sha256).toBe(sha256);
	});
});

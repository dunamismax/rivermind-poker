import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clockLeft, placeClass, placeOf, places, placesCss } from './layout.ts';

describe('seat places', () => {
	it('puts the viewer at the bottom and the others clockwise in seat order', () => {
		expect([0, 1, 2, 3, 4, 5].map((seat) => placeOf(seat, 3, 6))).toEqual([3, 4, 5, 0, 1, 2]);
		expect(placeOf(4, null, 9)).toBe(4);
		expect(placeClass(1, 0, 2)).toBe('at-2-1');
	});

	it('spreads the places around the rail, apart from each other', () => {
		for (let count = 2; count <= 9; count += 1) {
			const spots = places(count);
			expect(spots).toHaveLength(count);
			expect(spots[0]).toEqual({ left: 50, top: 100 }); // the viewer, bottom centre
			for (const { left, top } of spots) {
				expect(Math.min(left, top)).toBeGreaterThanOrEqual(0);
				expect(Math.max(left, top)).toBeLessThanOrEqual(100);
			}
			// Clockwise: left side first, then across the top, then the right side.
			const half = spots.slice(1, Math.ceil(count / 2));
			expect(half.every((s) => s.left <= 50)).toBe(true);
			// No two seats closer than a seat box on the smallest (phone) felt, 279 × 418 px, with seats about 78 × 120.
			for (let a = 0; a < count; a += 1) {
				for (let b = a + 1; b < count; b += 1) {
					const dx = (Math.abs(spots[a].left - spots[b].left) * 279) / 100;
					const dy = (Math.abs(spots[a].top - spots[b].top) * 418) / 100;
					expect(dx >= 78 || dy >= 120, `${count} seats: places ${a} and ${b} overlap`).toBe(true);
				}
			}
		}
		expect(places(2)[1]).toEqual({ left: 50, top: 0 }); // heads-up: straight across
		expect(() => places(10)).toThrow(RangeError);
	});

	it('has current generated CSS', () => {
		const css = readFileSync(new URL('./seat-places.css', import.meta.url), 'utf8');
		expect(css, 'Regenerate src/lib/nl/seat-places.css from placesCss()').toBe(placesCss());
	});
});

describe('clockLeft', () => {
	const turn = { started: 100, deadline: 120, final: 150 };

	it('counts down the action time, then the time bank', () => {
		expect(clockLeft(turn, 100)).toEqual({ fraction: 1, bank: false, seconds: 20 });
		expect(clockLeft(turn, 110)).toEqual({ fraction: 0.5, bank: false, seconds: 10 });
		expect(clockLeft(turn, 135)).toEqual({ fraction: 0.5, bank: true, seconds: 15 });
		expect(clockLeft(turn, 160)).toEqual({ fraction: 0, bank: true, seconds: 0 });
	});

	it('has no bank to run for a seat without one', () => {
		expect(clockLeft({ started: 0, deadline: 20, final: 20 }, 25)).toEqual({
			fraction: 0,
			bank: false,
			seconds: 0
		});
	});
});

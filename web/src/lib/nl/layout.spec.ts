import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	betClass,
	betSpot,
	clockLeft,
	placeClass,
	placeOf,
	places,
	placesCss,
	sideClass,
	sideOf
} from './layout.ts';

describe('seat places', () => {
	it('puts the viewer at the bottom and the others clockwise in seat order', () => {
		expect([0, 1, 2, 3, 4, 5].map((seat) => placeOf(seat, 3, 6))).toEqual([3, 4, 5, 0, 1, 2]);
		expect(placeOf(4, null, 9)).toBe(4);
		expect(placeClass(1, 0, 2)).toBe('at-2-1');
	});

	// The smallest felt and the largest seat box for each map: a tablet held
	// sideways, and a 360 px wide phone whose screen leaves the table its least
	// height (a pod is 84 × 44, with 16 px of tags under it).
	const FELTS = {
		wide: { width: 600, height: 375, seat: { width: 150, height: 135 } },
		tall: { width: 344, height: 356, seat: { width: 84, height: 62 } }
	} as const;

	for (const shape of ['wide', 'tall'] as const) {
		it(`spreads the ${shape} places around the table, apart from each other`, () => {
			const felt = FELTS[shape];
			for (let count = 2; count <= 9; count += 1) {
				const spots = places(count, shape);
				expect(spots).toHaveLength(count);
				expect(spots[0]).toEqual({ left: 50, top: 100 }); // the viewer, bottom centre
				for (const { left, top } of spots) {
					expect(Math.min(left, top)).toBeGreaterThanOrEqual(0);
					expect(Math.max(left, top)).toBeLessThanOrEqual(100);
				}
				// Clockwise: left side first, then across the top, then the right side.
				const half = spots.slice(1, Math.ceil(count / 2));
				expect(half.every((s) => s.left <= 50)).toBe(true);
				for (let a = 0; a < count; a += 1) {
					for (let b = a + 1; b < count; b += 1) {
						const dx = (Math.abs(spots[a].left - spots[b].left) * felt.width) / 100;
						const dy = (Math.abs(spots[a].top - spots[b].top) * felt.height) / 100;
						const apart = dx >= felt.seat.width || dy >= felt.seat.height;
						expect(apart, `${count} ${shape} seats: places ${a} and ${b} overlap`).toBe(true);
					}
				}
			}
			expect(places(2, shape)[1].left).toBe(50); // heads-up: straight across
			expect(() => places(10, shape)).toThrow(RangeError);
		});
	}

	it('keeps the phone seats clear of the board across the middle', () => {
		for (let count = 2; count <= 9; count += 1) {
			for (const { top } of places(count, 'tall').slice(1)) {
				expect(Math.abs(top - 50), `${count} seats`).toBeGreaterThanOrEqual(22);
			}
		}
	});

	it('knows which way each place faces', () => {
		expect(sideOf({ left: 50, top: 100 }, 0)).toBe('bottom');
		expect(sideOf({ left: 37.5, top: 10 }, 4)).toBe('top');
		expect(sideOf({ left: 12.5, top: 13 }, 3)).toBe('top');
		expect(sideOf({ left: 12.5, top: 77 }, 2)).toBe('left');
		expect(sideOf({ left: 87.5, top: 77 }, 7)).toBe('right');
		expect(sideOf({ left: 12.5, top: 100 }, 1)).toBe('low-left');
		expect(sideOf({ left: 87.5, top: 100 }, 8)).toBe('low-right');
		expect(sideClass(2, 0, 9)).toBe('side-left');
		expect(sideClass(1, 0, 9)).toBe('side-low-left');
		expect(sideClass(3, 0, 9)).toBe('side-top');
	});

	it('keeps the phone table to one row above the board, a seat each side below it and the corners', () => {
		for (let count = 2; count <= 9; count += 1) {
			const others = places(count, 'tall').slice(1);
			const sides = others.map((spot, i) => sideOf(spot, i + 1));
			// Two rows of pods above the board do not fit a short felt.
			const top = others.filter((_, i) => sides[i] === 'top');
			expect(Math.max(...top.map((s) => s.top)) - Math.min(...top.map((s) => s.top))).toBeLessThan(
				5
			);
			for (const side of ['left', 'right', 'low-left', 'low-right'] as const) {
				expect(
					sides.filter((s) => s === side).length,
					`${count} seats, ${side}`
				).toBeLessThanOrEqual(1);
			}
		}
	});

	it('moves a phone bet by pixels where it must clear its own pod', () => {
		const spots = places(9, 'tall');
		expect(betSpot(spots[4], 4, 'tall')).toEqual({ left: 37.5, top: 10, shift: 'var(--pod-drop)' });
		expect(betSpot(spots[1], 1, 'tall')).toEqual({
			left: 17.5,
			top: 100,
			shift: 'var(--pod-lift)'
		});
		expect(betSpot(spots[8], 8, 'tall')).toEqual({
			left: 82.5,
			top: 100,
			shift: 'var(--pod-lift)'
		});
		expect(betSpot(spots[2], 2, 'tall')).toEqual({ left: 34, top: 72 });
		expect(placesCss()).toContain('top: calc(10% + var(--pod-drop));');
	});

	it('puts each bet between its seat and the pot', () => {
		for (const shape of ['wide', 'tall'] as const) {
			for (let count = 2; count <= 9; count += 1) {
				places(count, shape).forEach((spot, place) => {
					const bet = betSpot(spot, place, shape);
					expect(Math.abs(bet.left - 50)).toBeLessThanOrEqual(Math.abs(spot.left - 50));
					expect(Math.abs(bet.top - 50)).toBeLessThan(Math.abs(spot.top - 50) + 2);
				});
			}
		}
		expect(betClass(1, 0, 6)).toBe('bet-6-1');
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

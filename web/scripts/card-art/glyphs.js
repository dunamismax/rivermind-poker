// RiverMind Poker card artwork. SPDX-License-Identifier: GPL-3.0-or-later
// Rank numerals and suit silhouettes, drawn for this deck.
//
// Each rank is a set of centre lines stroked RANK_STROKE wide inside a box
// RANK_HEIGHT tall. Strokes run past the box where a terminal should be cut
// square, and the box is applied as a clip, so diagonals end flat on the
// baseline and cap line. Round strokes are drawn to touch the box exactly.

import { d as path } from './svg.js';

export const RANK_HEIGHT = 54;
export const RANK_STROKE = 9.5;

const h = RANK_STROKE / 2;
const T = h; // centre line of a stroke touching the cap line
const B = RANK_HEIGHT - h; // centre line of a stroke touching the baseline
const M = RANK_HEIGHT / 2;

// Half-width of the box for a single numeral, and the centre line of a
// stroke that touches its sides.
const W = 16.5;
const X = W - h;

/** Centre lines and the half-width of the clip box for each rank. */
export const RANKS = {
	2: {
		half: W,
		d: path`M${-X} 16 C${-X} 8.4 ${-X + 5.6} ${T} 0 ${T} C${X - 5} ${T} ${X} 8.6 ${X} 15.6
			C${X} 22.6 ${X - 4.6} 27 ${X - 10.6} 32.6 L${-W - 3} 54 M${-W} ${B} H${W}`
	},
	3: {
		half: W,
		d: path`M${-X - 0.4} 13 C${-X + 2} 7.4 ${-X + 6.6} ${T} 0 ${T} C${X - 5.8} ${T} ${X - 1} 8.6 ${X - 1} 13.8
			C${X - 1} 19.8 ${X - 6} 23.8 -2 23.8 H-4 M-4 23.8 H0.4 C${X - 5.4} 23.8 ${X} 28.6 ${X} 35.8
			C${X} 43.6 ${X - 5.6} ${B} -0.4 ${B} C${-X + 5.4} ${B} ${-X + 1} 46.6 ${-X - 0.8} 41.8`
	},
	4: {
		half: W,
		d: path`M${X - 4.6} -2 V56 M${-W} 37.6 H${W} M${X - 1} -4.4 L${-W + 1.6} 39`
	},
	5: {
		half: W,
		d: path`M${-X + 1.4} ${T} H${W} M${-X + 1.4} 2 V27.6 M${-X + 1.4} 25.8 C${-X + 5} 22.6 ${-X + 8.4} 21.6 0.8 21.6
			C${X - 5.4} 21.6 ${X} 26.8 ${X} 35 C${X} 43.6 ${X - 5.6} ${B} -0.6 ${B} C${-X + 6} ${B} ${-X + 1.6} 46.6 ${-X - 0.6} 42`
	},
	6: {
		half: W,
		d: path`M${X - 1.4} 8.8 C${X - 4} 6 ${X - 7.2} ${T} 0.6 ${T} C${-X + 4} ${T} ${-X} 13.4 ${-X} 27
			C${-X} 41.2 ${-X + 4.4} ${B} 0 ${B} C${X - 5.2} ${B} ${X} 44 ${X} 35.6 C${X} 27.4 ${X - 4.6} 22.4 0.2 22.4
			C${-X + 6} 22.4 ${-X + 1.4} 26.4 ${-X} 31.8`
	},
	7: {
		half: W,
		d: path`M${-W} ${T} H${W} M${X + 2} -2 C${X - 6.6} 12 ${-1.6} 30 ${-3.4} 58`
	},
	8: {
		half: W,
		d: path`M0 ${T} C${X - 6.2} ${T} ${X - 1.6} 9 ${X - 1.6} 14.6 C${X - 1.6} 20.4 ${X - 6} 24.6 0 24.6
			C${-X + 6} 24.6 ${-X + 1.6} 20.4 ${-X + 1.6} 14.6 C${-X + 1.6} 9 ${-X + 6.2} ${T} 0 ${T}Z
			M0 24.6 C${X - 5.2} 24.6 ${X} 29.4 ${X} 36.8 C${X} 44.2 ${X - 5.2} ${B} 0 ${B}
			C${-X + 5.2} ${B} ${-X} 44.2 ${-X} 36.8 C${-X} 29.4 ${-X + 5.2} 24.6 0 24.6Z`
	},
	// The 10 is set a little lighter so both numerals fit the index column.
	10: {
		half: 18.5,
		shift: -1.5,
		stroke: 8.5,
		d: path`M-11.5 -2 V56 M-11.5 2.4 L-21 10.6
			M8 4.25 C12.6 4.25 14.25 13.4 14.25 ${M} C14.25 40.6 12.6 49.75 8 49.75
			C3.4 49.75 1.75 40.6 1.75 ${M} C1.75 13.4 3.4 4.25 8 4.25Z`
	},
	11: {
		half: W,
		d: path`M${-X + 3} ${T} H${X + 4.75} M${X - 2} 0 V36.4 C${X - 2} 44.6 ${X - 6.6} ${B} -1.4 ${B}
			C${-X + 4.6} ${B} ${-X + 0.6} 45.8 ${-X - 0.4} 40.4`
	},
	12: {
		half: W,
		d: path`M0 ${T} C${X - 4.2} ${T} ${X} 13 ${X} ${M} C${X} 41 ${X - 4.2} ${B} 0 ${B}
			C${-X + 4.2} ${B} ${-X} 41 ${-X} ${M} C${-X} 13 ${-X + 4.2} ${T} 0 ${T}Z M1 35.4 L${W + 3} 59`
	},
	13: {
		half: W,
		d: path`M${-X} -2 V56 M${W + 3} -3.6 L${-X + 2} 32.4 M${-X + 8} 22.2 L${W + 2} 58`
	},
	14: {
		half: W + 1,
		d: path`M${-W - 0.8} 58 L-3.8 -1 H3.8 L${W + 0.8} 58 M-10 38.4 H10`
	}
};
// The 9 is the 6 turned about the centre of its box.
RANKS[9] = { ...RANKS[6], turned: true };

/**
 * Suit silhouettes about the origin, about 100 units across, each one closed
 * outline so a pip renders as a single crisp shape.
 */
export const SUITS = {
	spades:
		'M0-54C9-39 25-29 39-17C50-7 54 4 52 14C49 29 34 35 22 31C14 28 8 23 4.2 17.6C5 31 10.4 43 22 51H-22C-10.4 43-5 31-4.2 17.6C-8 23-14 28-22 31C-34 35-49 29-52 14C-54 4-50-7-39-17C-25-29-9-39 0-54Z',
	hearts:
		'M0-29C4.6-43.4 15-50 27-50C42-50 52-38.4 52-23.4C52-1 31.4 19.4 0 50C-31.4 19.4-52-1-52-23.4C-52-38.4-42-50-27-50C-15-50-4.6-43.4 0-29Z',
	clubs:
		'M0-54C13.8-54 24-43.6 24-30.4C24-24 21.6-18.8 18.2-14.6C21-15.6 23.6-16 26.6-16C40.6-16 51-5.6 51 8C51 21.6 40.6 32 27 32C17.4 32 9.8 27 5.4 18.6C6.2 32 11.4 43.4 22 51H-22C-11.4 43.4-6.2 32-5.4 18.6C-9.8 27-17.4 32-27 32C-40.6 32-51 21.6-51 8C-51-5.6-40.6-16-26.6-16C-23.6-16-21-15.6-18.2-14.6C-21.6-18.8-24-24-24-30.4C-24-43.6-13.8-54 0-54Z',
	diamonds:
		'M0-56C11.4-34.4 25-17.6 45 0C25 17.6 11.4 34.4 0 56C-11.4 34.4-25 17.6-45 0C-25-17.6-11.4-34.4 0-56Z'
};

// RiverMind Poker card artwork. SPDX-License-Identifier: GPL-3.0-or-later
import { court } from './courts.js';

const PAPER = '#fbf9f1';
const BLACK = '#1b1b1b';
const RED = '#a71f34';
const GOLD = '#a97d34';

export const INKS = {
	standard: { spades: BLACK, hearts: RED, clubs: BLACK, diamonds: RED },
	'four-colour': { spades: BLACK, hearts: RED, clubs: '#126047', diamonds: '#215588' }
};

// Indices are drawn on the same baseline and need no font at render time.
const RANK_MARKS = {
	2: 'M-10 8 C-9-2 11-2 11 8 C11 15 3 19-4 25 L-11 33 H12',
	3: 'M-11 4 Q-6 0 0 0 C13 0 15 13 3 16 C17 18 14 34 0 34 Q-7 34-12 29',
	4: 'M6 33 V1 L-12 23 H12',
	5: 'M10 0 H-9 L-11 16 Q-6 13 0 13 C16 13 15 34 0 34 Q-7 34-12 29',
	6: 'M10 3 Q6 0 1 0 C-15 0-17 34 0 34 C15 34 16 13 1 13 Q-6 13-11 19',
	7: 'M-12 0 H12 L-3 33',
	8: 'M0 16 C-15 14-14 0 0 0 C14 0 15 14 0 16 C-17 19-15 34 0 34 C15 34 17 19 0 16 Z',
	9: 'M-10 31 Q-6 34-1 34 C15 34 17 0 0 0 C-15 0-16 21-1 21 Q6 21 11 15',
	10: 'M-16 6 -10 0 V33 M2 11 C2-4 17-4 17 11 V22 C17 37 2 37 2 22 Z',
	11: 'M-3 0 H10 V23 Q10 34 0 34 Q-10 34-11 25',
	12: 'M0 0 C17 0 17 33 0 33 C-17 33-17 0 0 0 Z M3 24 L13 35',
	13: 'M-10 0 V33 M11 0 -9 18 M-1 12 L12 33',
	14: 'M-13 33 L0 0 13 33 M-8 22 H8'
};

// Each silhouette is drawn around the origin on a roughly 32-unit square.
const SUIT_MARKS = {
	spades:
		'M0-16 C4-10 16-4 16 5 C16 13 6 16 2 9 C2 12 4 15 7 17 H-7 C-4 15-2 12-2 9 C-6 16-16 13-16 5 C-16-4-4-10 0-16Z',
	hearts: 'M0-8 C-5-18-17-15-17-6 C-17 3-6 11 0 16 C6 11 17 3 17-6 C17-15 5-18 0-8Z',
	clubs:
		'M0-16 C8-16 12-8 7-2 C13-5 18-1 18 5 C18 14 7 16 2 9 C2 12 4 15 7 17 H-7 C-4 15-2 12-2 9 C-7 16-18 14-18 5 C-18-1-13-5-7-2 C-12-8-8-16 0-16Z',
	diamonds: 'M0-17 Q7-7 15 0 Q7 7 0 17 Q-7 7-15 0 Q-7-7 0-17Z'
};

function pip(suit, x, y, scale, inverted = false) {
	return `<path d="${SUIT_MARKS[suit]}" transform="translate(${x} ${y}) scale(${inverted ? -scale : scale})"/>`;
}

function index(rank, suit) {
	return `<path d="${RANK_MARKS[rank]}" transform="translate(23 15)" fill="none" stroke="currentColor" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
	${pip(suit, 23, 68, 0.78)}`;
}

// Traditional layouts, with the outer rows clear of the corner indices.
// Lower pips turn towards the other index.
const PIP_ROWS = {
	2: [
		[47, 84],
		[185, 84]
	],
	3: [
		[47, 84],
		[116, 84],
		[185, 84]
	],
	4: [
		[47, 59, 109],
		[185, 59, 109]
	],
	5: [
		[47, 59, 109],
		[116, 84],
		[185, 59, 109]
	],
	6: [
		[47, 59, 109],
		[116, 59, 109],
		[185, 59, 109]
	],
	7: [
		[47, 59, 109],
		[81, 84],
		[116, 59, 109],
		[185, 59, 109]
	],
	8: [
		[47, 59, 109],
		[81, 84],
		[116, 59, 109],
		[151, 84],
		[185, 59, 109]
	],
	9: [
		[47, 59, 109],
		[93, 59, 109],
		[116, 84],
		[139, 59, 109],
		[185, 59, 109]
	],
	10: [
		[47, 59, 109],
		[70, 84],
		[93, 59, 109],
		[139, 59, 109],
		[162, 84],
		[185, 59, 109]
	]
};

// Each ace carries its own escutcheon around the oversized suit.
const ACE_FRAMES = {
	spades: 'M84 63 Q102 71 121 76 V113 Q121 146 84 169 Q47 146 47 113 V76 Q66 71 84 63Z',
	hearts:
		'M84 68 C104 68 123 84 123 107 V125 C123 148 104 164 84 164 C64 164 45 148 45 125 V107 C45 84 64 68 84 68Z',
	clubs:
		'M84 67 Q94 67 99 78 Q121 78 121 102 Q129 116 121 130 Q121 154 99 154 Q94 165 84 165 Q74 165 69 154 Q47 154 47 130 Q39 116 47 102 Q47 78 69 78 Q74 67 84 67Z',
	diamonds: 'M84 62 L123 94 V138 L84 170 45 138 V94Z'
};

function ace(suit) {
	const flourish = `<path d="M84 49 90 55 84 61 78 55Z" fill="${GOLD}"/>
	<path d="M52 67 Q66 62 74 65 M94 65 Q102 62 116 67" fill="none" stroke="${GOLD}" stroke-width="2"/>`;
	return `<g id="ace">
		<path d="${ACE_FRAMES[suit]}" fill="currentColor" fill-opacity=".06" stroke="${GOLD}" stroke-width="2.4"/>
		${flourish}<g transform="rotate(180 84 116)">${flourish}</g>
		${pip(suit, 84, 116, 1.73)}
	</g>`;
}

export function face(rank, suit, treatment) {
	const ink = INKS[treatment][suit];
	let centre;
	if (rank === 14) {
		centre = ace(suit);
	} else if (rank >= 11) {
		centre = court(rank);
	} else {
		const pips = PIP_ROWS[rank].flatMap(([y, ...columns]) =>
			columns.map((x) => pip(suit, x, y, 0.89, y > 116))
		);
		centre = `<g id="pips">${pips.join('\n\t')}</g>`;
	}
	const corner = index(rank, suit);
	return `<rect x=".8" y=".8" width="166.4" height="230.4" rx="20" fill="${PAPER}" stroke="#dfd9c8" stroke-width="1.6"/>
<g color="${ink}" fill="currentColor">
	<g id="index">${corner}</g>
	<use href="#index" transform="rotate(180 84 116)"/>
	${centre}
</g>`;
}

// Where seats and their bets sit around the table (P3.6, redrawn for the pixel
// table). The viewer's seat is always at the bottom centre and the others
// follow clockwise in seat order, so the action moves around the table the
// way it does in a card room. Positions are CSS classes (`at-<count>-<place>`
// and `bet-<count>-<place>`, generated into seat-places.css) rather than inline
// styles, which the site's CSP blocks.
//
// There are two maps: a wide oval for tablets and desktops, and a tall one for
// phones, where the seats keep clear of the board across the middle.

/** The place of `seat` around a table of `count`, 0 being the bottom centre. */
export function placeOf(seat: number, anchor: number | null, count: number): number {
	const from = anchor ?? 0;
	return (((seat - from) % count) + count) % count;
}

export function placeClass(seat: number, anchor: number | null, count: number): string {
	return `at-${count}-${placeOf(seat, anchor, count)}`;
}

export function betClass(seat: number, anchor: number | null, count: number): string {
	return `bet-${count}-${placeOf(seat, anchor, count)}`;
}

export type Shape = 'wide' | 'tall';

/**
 * When the tall map applies: phones, and tablets held upright. The Svelte
 * styles repeat this query, since CSS cannot share it.
 */
export const TALL_MEDIA = '(max-width: 639px), (max-width: 1099px) and (orientation: portrait)';

/**
 * Percent coordinates of each place, clockwise from the bottom centre, for 2
 * to 9 seats: on the rail of the wide oval, and inside the tall one's edge.
 * Spaced by hand rather than by equal angles, which would crowd the ends.
 */
const PLACES: Record<Shape, Record<number, [number, number][]>> = {
	wide: {
		2: [
			[50, 100],
			[50, 0]
		],
		3: [
			[50, 100],
			[8, 22],
			[92, 22]
		],
		4: [
			[50, 100],
			[2, 50],
			[50, 0],
			[98, 50]
		],
		5: [
			[50, 100],
			[4, 66],
			[24, 2],
			[76, 2],
			[96, 66]
		],
		6: [
			[50, 100],
			[6, 78],
			[6, 22],
			[50, 0],
			[94, 22],
			[94, 78]
		],
		7: [
			[50, 100],
			[10, 88],
			[1, 38],
			[30, 0],
			[70, 0],
			[99, 38],
			[90, 88]
		],
		8: [
			[50, 100],
			[16, 96],
			[1, 50],
			[18, 4],
			[50, 0],
			[82, 4],
			[99, 50],
			[84, 96]
		],
		9: [
			[50, 100],
			[20, 98],
			[1, 56],
			[8, 12],
			[36, 0],
			[64, 0],
			[92, 12],
			[99, 56],
			[80, 98]
		]
	},
	// Phones: compact seats in bands above and below the board, which fills
	// the middle third: a top row, upper and lower sides, and lower corners.
	tall: {
		2: [
			[50, 100],
			[50, 9]
		],
		3: [
			[50, 100],
			[13, 22],
			[87, 22]
		],
		4: [
			[50, 100],
			[13, 27],
			[50, 9],
			[87, 27]
		],
		5: [
			[50, 100],
			[13, 72],
			[13, 27],
			[87, 27],
			[87, 72]
		],
		6: [
			[50, 100],
			[13, 72],
			[13, 27],
			[50, 9],
			[87, 27],
			[87, 72]
		],
		7: [
			[50, 100],
			[13, 72],
			[13, 27],
			[34, 9],
			[66, 9],
			[87, 27],
			[87, 72]
		],
		8: [
			[50, 100],
			[13, 88],
			[13, 72],
			[13, 27],
			[50, 9],
			[87, 27],
			[87, 72],
			[87, 88]
		],
		9: [
			[50, 100],
			[13, 88],
			[13, 72],
			[13, 27],
			[34, 9],
			[66, 9],
			[87, 27],
			[87, 72],
			[87, 88]
		]
	}
};

/**
 * Which way a place faces the middle: the viewer at the bottom, a top row,
 * and the left and right sides. Phones put shown cards on that side.
 */
export function sideOf(spot: { left: number; top: number }, place: number): Side {
	if (place === 0) return 'bottom';
	if (spot.top < 20 && spot.left > 25 && spot.left < 75) return 'top';
	return spot.left < 50 ? 'left' : 'right';
}

export type Side = 'bottom' | 'top' | 'left' | 'right';

export function sideClass(seat: number, anchor: number | null, count: number): string {
	const place = placeOf(seat, anchor, count);
	// The phone map decides; on the wide one only the cards' order uses it.
	return `side-${sideOf(places(count, 'tall')[place], place)}`;
}

export function places(count: number, shape: Shape = 'wide'): { left: number; top: number }[] {
	const spots = PLACES[shape][count];
	if (!spots) throw new RangeError(`a table has 2 to 9 seats, not ${count}`);
	return spots.map(([left, top]) => ({ left, top }));
}

/**
 * Where a place's bet sits. On the wide table, part of the way from the seat
 * towards the pot; the viewer's bet clears the viewer's larger cards. On the
 * tall one, beside the seat on the side facing the middle, so no bet lands on
 * the board.
 */
export function betSpot(spot: { left: number; top: number }, place: number, shape: Shape) {
	const round = (v: number) => Math.round(v * 10) / 10;
	if (shape === 'tall') {
		const side = sideOf(spot, place);
		if (side === 'bottom') return { left: 50, top: 76 };
		if (side === 'top') return { left: spot.left, top: round(spot.top + 13) };
		// Beside the seat; the lower corners' bets rise clear of the viewer's cards.
		const lift = spot.top > 80 ? 8 : 0;
		return { left: round(spot.left + (side === 'left' ? 22 : -22)), top: spot.top - lift };
	}
	const toward = place === 0 ? 0.52 : 0.36;
	return {
		left: round(spot.left + (50 - spot.left) * toward),
		top: round(spot.top + (48 - spot.top) * toward)
	};
}

function rules(shape: Shape, indent: string): string[] {
	const out: string[] = [];
	for (let count = 2; count <= 9; count += 1) {
		places(count, shape).forEach((spot, place) => {
			const bet = betSpot(spot, place, shape);
			out.push(
				`${indent}.at-${count}-${place} {\n${indent}\tleft: ${spot.left}%;\n${indent}\ttop: ${spot.top}%;\n${indent}}`
			);
			out.push(
				`${indent}.bet-${count}-${place} {\n${indent}\tleft: ${bet.left}%;\n${indent}\ttop: ${bet.top}%;\n${indent}}`
			);
		});
	}
	return out;
}

/** The CSS for every place and bet at every table size, wide and tall. */
export function placesCss(): string {
	return (
		'/* Generated by placesCss() in layout.ts; layout.spec.ts fails if it is stale. */\n' +
		rules('wide', '').join('\n') +
		`\n@media ${TALL_MEDIA} {\n` +
		rules('tall', '\t').join('\n') +
		'\n}\n'
	);
}

/** How much of the turn's time is left, from 1 (all) to 0 (none), and whether the bank is running. */
export function clockLeft(
	turn: { started: number; deadline: number; final: number },
	now: number
): { fraction: number; bank: boolean; seconds: number } {
	if (now < turn.deadline) {
		const span = turn.deadline - turn.started;
		return {
			fraction: span > 0 ? Math.max(0, (turn.deadline - now) / span) : 0,
			bank: false,
			seconds: Math.ceil(turn.deadline - now)
		};
	}
	const span = turn.final - turn.deadline;
	const left = Math.max(0, turn.final - now);
	return { fraction: span > 0 ? left / span : 0, bank: span > 0, seconds: Math.ceil(left) };
}

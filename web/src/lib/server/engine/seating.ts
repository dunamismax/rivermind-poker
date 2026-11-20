// Button and blind positions between hands (rules 4 and 5): a port of
// rivermind/engine/seating.py.

import type { Random } from './random.ts';

/** Rule 5.1: the first hand's button is a random player dealt in. */
export function initialButton(dealtIn: Iterable<number>, rng: Random): number {
	const seats = [...dealtIn].sort((a, b) => a - b);
	if (seats.length < 2) throw new RangeError('a hand needs at least two players dealt in');
	return seats[rng.below(seats.length)];
}

/**
 * Rule 5.2: the first player dealt in clockwise from the previous button seat.
 *
 * The previous button seat itself is skipped whether or not it is still
 * occupied, so the button always moves (a moving button).
 */
export function nextButton(
	previous: number,
	dealtIn: ReadonlySet<number>,
	numSeats: number
): number {
	if (dealtIn.size < 2) throw new RangeError('a hand needs at least two players dealt in');
	if (!(previous >= 0 && previous < numSeats))
		throw new RangeError('previous button is not a seat');
	for (let step = 1; step <= numSeats; step++) {
		const seat = (previous + step) % numSeats;
		if (dealtIn.has(seat)) return seat;
	}
	throw new Error('unreachable');
}

/**
 * Players dealt in, clockwise from the player left of the button.
 *
 * The last entry is the button. Cards are dealt in this order (rule 1.2).
 */
export function dealOrder(
	button: number,
	dealtIn: ReadonlySet<number>,
	numSeats: number
): number[] {
	const order: number[] = [];
	for (let step = 1; step <= numSeats; step++) {
		const seat = (button + step) % numSeats;
		if (dealtIn.has(seat)) order.push(seat);
	}
	return order;
}

/** The small-blind and big-blind seats for a hand (rules 3.1 and 4.1). */
export function blindSeats(
	button: number,
	dealtIn: ReadonlySet<number>,
	numSeats: number
): [number, number] {
	if (!dealtIn.has(button)) throw new RangeError('the button must be a player dealt in');
	const order = dealOrder(button, dealtIn, numSeats);
	if (order.length < 2) throw new RangeError('a hand needs at least two players dealt in');
	if (order.length === 2) return [button, order[0]];
	return [order[0], order[1]];
}

/** Seats with a player holding at least one chip (rule 2.1). */
export function seatsDealtIn(stacks: readonly (number | null)[]): Set<number> {
	const seats = new Set<number>();
	stacks.forEach((stack, seat) => {
		if (stack) seats.add(seat);
	});
	return seats;
}

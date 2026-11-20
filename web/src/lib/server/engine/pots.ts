// Uncalled bets, side pots, split pots and odd chips (rules 9 and 11): a port
// of rivermind/engine/pots.py.

/** One pot, as built by rule 9.2 and awarded by rule 11. */
export interface Pot {
	readonly amount: number;
	readonly eligible: readonly number[];
	readonly winners: readonly number[];
	/** Chips each winner receives, in the same order as `winners`. */
	readonly shares: readonly number[];
}

/**
 * Rule 9.1: the seat and amount of an uncalled excess, or null.
 *
 * The excess is the largest contribution minus the next largest, counting
 * every player, folded or not.
 */
export function uncalledBet(contributions: readonly number[]): [number, number] | null {
	let top = -1;
	let second = -1;
	let topSeat = -1;
	contributions.forEach((amount, seat) => {
		if (amount > top) {
			second = top;
			top = amount;
			topSeat = seat;
		} else if (amount > second) {
			second = amount;
		}
	});
	second = Math.max(second, 0);
	return top > second ? [topSeat, top - second] : null;
}

/**
 * Rule 9.2: split contributions into a main pot and side pots.
 *
 * `contributions` is indexed by seat and must already have any uncalled bet
 * removed. `live` lists the seats that have not folded. Each pot lists its
 * eligible seats in ascending order.
 */
export function buildPots(contributions: readonly number[], live: readonly number[]): Pot[] {
	const levels = [...new Set(live.map((seat) => contributions[seat]))].sort((a, b) => a - b);
	const pots: Pot[] = [];
	let previous = 0;
	levels.forEach((level, i) => {
		const last = i === levels.length - 1;
		let amount = 0;
		for (const paid of contributions) {
			const above = paid - previous;
			if (above > 0) amount += last ? above : Math.min(above, level - previous);
		}
		const eligible = live.filter((seat) => contributions[seat] >= level).sort((a, b) => a - b);
		if (amount) pots.push({ amount, eligible, winners: [], shares: [] });
		previous = level;
	});
	return pots;
}

/**
 * Rule 11.2: share a pot among winners, odd chips clockwise from the button.
 *
 * Returns the winners in clockwise order from the seat left of the button and
 * each one's share.
 */
export function split(
	amount: number,
	winners: readonly number[],
	button: number,
	numSeats: number
): [number[], number[]] {
	const distance = (seat: number) => (((seat - button - 1) % numSeats) + numSeats) % numSeats;
	const ordered = [...winners].sort((a, b) => distance(a) - distance(b));
	const base = Math.floor(amount / ordered.length);
	const odd = amount - base * ordered.length;
	return [ordered, ordered.map((_, i) => base + (i < odd ? 1 : 0))];
}

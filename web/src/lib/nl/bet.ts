// Bet sizing and wording for the no-limit table (P3.6). Amounts are street
// totals, as the protocol's `min_to` and `max_to` are: "raise to 600" means
// the seat's bet on this street becomes 600.

import type { ActionKind, HandInfo, Legal, TableEvent } from '../protocol-v2.ts';

export interface Preset {
	label: string;
	amount: number;
}

/** Keep an amount inside the legal range, as a whole number of chips. */
export function clampAmount(amount: number, legal: Legal): number {
	if (!Number.isFinite(amount)) return legal.min_to;
	return Math.min(legal.max_to, Math.max(legal.min_to, Math.floor(amount)));
}

/**
 * The street total for a bet or raise of `fraction` of the pot. The pot
 * counts the call first, as card rooms do: facing 100 into a pot of 250, a
 * pot-sized raise is to 100 + (250 + 100) = 450.
 */
export function potFraction(fraction: number, legal: Legal, hand: HandInfo): number {
	return hand.current_bet + fraction * (hand.pot + legal.call);
}

/** Minimum, ½ pot, ¾ pot, pot and all-in, clamped to the legal range. */
export function presets(legal: Legal, hand: HandInfo): Preset[] {
	if (legal.raise_kind === null) return [];
	const sized = (label: string, fraction: number): Preset => ({
		label,
		amount: clampAmount(potFraction(fraction, legal, hand), legal)
	});
	return [
		{ label: 'Min', amount: legal.min_to },
		sized('½ pot', 0.5),
		sized('¾ pot', 0.75),
		sized('Pot', 1),
		{ label: 'All-in', amount: legal.max_to }
	];
}

/** The text of the button that bets or raises to `amount`. */
export function raiseLabel(legal: Legal, amount: number): string {
	const allIn = amount >= legal.max_to ? ' (all-in)' : '';
	return legal.raise_kind === 'bet' ? `Bet ${amount}${allIn}` : `Raise to ${amount}${allIn}`;
}

/** The text of the check or call button. */
export function callLabel(legal: Legal): string {
	return legal.can_check ? 'Check' : `Call ${legal.call}`;
}

const VERBS: Record<ActionKind, string> = {
	fold: 'folds',
	check: 'checks',
	call: 'calls',
	bet: 'bets',
	raise: 'raises to'
};

/** One line for the hand log, or null for events that need no line. */
export function describeEvent(event: TableEvent, nameOf: (seat: number) => string): string | null {
	const who = event.seat === null || event.seat === undefined ? '' : nameOf(event.seat);
	switch (event.kind) {
		case 'hand_started':
			return `Hand #${event.hand_no} · ${who} has the button`;
		case 'action': {
			const action = event.action as ActionKind;
			const amount = action === 'call' ? (event.added ?? 0) : event.amount;
			const tail = action === 'fold' || action === 'check' ? '' : ` ${amount}`;
			return `${who} ${VERBS[action]}${tail}${event.all_in ? ' and is all-in' : ''}`;
		}
		case 'board':
			return `${event.street === 'flop' ? 'Flop' : event.street === 'turn' ? 'Turn' : 'River'} dealt`;
		case 'timed_out':
			return `${who} ran out of time`;
		case 'seated':
			return `${event.name ?? who} sits down with ${event.amount}`;
		case 'left':
			return `${who} leaves`;
		case 'sat_out':
			return event.reason === 'away' ? `${who} is away and sits out` : `${who} sits out`;
		case 'sat_in':
			return `${who} is back`;
		case 'rebought':
			return `${who} adds ${event.amount}`;
		case 'rebuy_dropped':
			return `${who}’s rebuy of ${event.amount} no longer fits and goes back to the wallet`;
		case 'disconnected':
			return `${who} disconnected`;
		case 'connected':
			return `${who} reconnected`;
		case 'reserved':
			return `Seat ${(event.seat ?? 0) + 1} is held for ${event.name ?? 'a player'}`;
		case 'reservation_ended':
			return event.reason === 'expired'
				? `The hold on seat ${(event.seat ?? 0) + 1} ran out`
				: null;
		default:
			return null;
	}
}

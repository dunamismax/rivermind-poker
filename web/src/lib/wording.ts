// How the table reads: card names, button labels, action wording, the
// result line and the hand log. Pure functions of the server's view.

import type { Action, Card, Position, SeatView, Stage, TableEvent } from './protocol.ts';

/** Pause after each bot action in the hand log so they appear one after another. */
export const EVENT_DELAY_MS = 450;

export const RANK_LABELS: Record<number, string> = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
export const POSITION_BADGES: Record<Position, string> = {
	small_blind: 'SB',
	big_blind: 'BB',
	button: 'D'
};
export const STAGE_NAMES: Record<Stage, string> = {
	pre_flop: 'Pre-flop',
	flop: 'Flop',
	turn: 'Turn',
	river: 'River',
	show_down: 'Showdown',
	terminal: 'Hand over'
};

export function rankLabel(rank: number): string {
	return RANK_LABELS[rank] ?? String(rank);
}

export function cardName(card: Card): string {
	return `${rankLabel(card.rank)} of ${card.suit}`;
}

/** "Fold", "Check", "Call 150", "Bet 100" or "Raise 250" for an action button. */
export function buttonLabel(action: Action, amounts: SeatView['action_amounts']): string {
	const call = amounts.call ?? 0;
	if (action === 'call') return call ? `Call ${call}` : 'Check';
	if (action === 'raise') return `${call ? 'Raise' : 'Bet'} ${amounts.raise ?? 0}`;
	return 'Fold';
}

/**
 * "checks", "calls 100", "bets 100", "calls 100 and raises 100"; with `you`
 * the second-person form ("check", "call 100").
 */
export function describe(event: TableEvent, you = false): string {
	let verb: string;
	let chips = event.chips;
	if (event.action === 'fold') {
		verb = 'fold';
		chips = 0;
	} else if (event.action === 'call') {
		verb = event.facing ? 'call' : 'check';
	} else {
		// Pre-flop the big blind is the opening bet, so any raise is a raise.
		verb = event.facing || event.stage === 'pre_flop' ? 'raise' : 'bet';
	}
	const word = (v: string) => (you ? v : `${v}s`);
	if (verb === 'raise' && event.facing) {
		// Fixed-limit raise: the call plus one bet, e.g. "calls 150 and raises 100".
		return `${word('call')} ${event.facing} and ${word('raise')} ${chips - event.facing}`;
	}
	return chips ? `${word(verb)} ${chips}` : word(verb);
}

export function capitalize(text: string): string {
	return text.replace(/^./, (c) => c.toUpperCase());
}

/** Each seat's latest action on the current street (folds stay shown). */
export function lastActions(view: SeatView): Map<number, { event: TableEvent; index: number }> {
	const last = new Map<number, { event: TableEvent; index: number }>();
	view.events.forEach((event, index) => {
		if (event.stage === view.stage || event.action === 'fold')
			last.set(event.seat, { event, index });
	});
	return last;
}

/** What a seat is called from the viewer's side of the table. */
export function seatNames(view: SeatView): Map<number, string> {
	return new Map(view.seats.map((s) => [s.seat, s.seat === view.seat ? 'You' : s.name]));
}

export function payoutOf(view: SeatView, seat: number): number | null {
	if (!view.result) return null;
	return view.result.payouts[seat] ?? 0;
}

export function signed(chips: number): string {
	return chips > 0 ? `+${chips}` : `${chips}`;
}

/** "You win 150 at showdown", "Random 1 wins 60", "You and Random 2 win 75 each". */
export function resultLine(view: SeatView): string | null {
	if (!view.result) return null;
	const winners = view.seats.filter((s) => (payoutOf(view, s.seat) ?? 0) > 0);
	const names = winners.map((s) => (s.seat === view.seat ? 'You' : s.name));
	const amount = winners.length ? (payoutOf(view, winners[0].seat) ?? 0) : 0;
	const plural = names.length > 1 || names[0] === 'You';
	const each = names.length > 1 ? ' each' : '';
	const where = view.result.showdown ? ' at showdown' : '';
	return `${names.join(' and ')} ${plural ? 'win' : 'wins'} ${amount}${each}${where}`;
}

export interface LogEntry {
	text: string;
	kind: 'street' | 'mine' | 'other';
	/** Bot actions pause before the next line so they read in sequence. */
	pauseAfter: boolean;
}

/** The hand log for a view, top to bottom. */
export function logEntries(view: SeatView): LogEntry[] {
	const names = seatNames(view);
	const entries: LogEntry[] = [{ text: `Hand ${view.hand}`, kind: 'street', pauseAfter: false }];
	let stage: Stage = 'pre_flop';
	for (const event of view.events) {
		if (event.stage !== stage) {
			stage = event.stage;
			entries.push({ text: STAGE_NAMES[stage], kind: 'street', pauseAfter: false });
		}
		const mine = event.seat === view.seat;
		entries.push({
			text: `${names.get(event.seat)} ${describe(event, mine)}`,
			kind: mine ? 'mine' : 'other',
			pauseAfter: !mine
		});
	}
	if (view.result) {
		const parts = view.seats.map(
			(s) => `${names.get(s.seat)} ${signed(payoutOf(view, s.seat) ?? 0)}`
		);
		entries.push({ text: parts.join(' · '), kind: 'street', pauseAfter: false });
	}
	return entries;
}

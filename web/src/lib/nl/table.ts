// What the no-limit table works out from a view only to show it (P5D.7): who is
// named where, the lines under the action dock and in the join panel, what each
// empty seat offers, and when the rebuy, the refill and the review are offered.
// NlTable.svelte reads it, and the iPhone app ports it (TableWords.swift), held
// to it by the display fixture (ios-display.spec.ts), so the two cannot drift.

import type { TableEvent, TableView } from '../protocol-v2.ts';
import { describeEvent } from './bet.ts';

/** A seat's name, or its number when nobody sits there. */
export function nameOf(view: TableView, seat: number): string {
	return view.seats[seat]?.name ?? `Seat ${seat + 1}`;
}

/** A chip count grouped by commas. */
export function chips(amount: number): string {
	return amount.toLocaleString('en-US');
}

/** Whether a hand is being played: dealt and not yet settled. */
export function inHand(view: TableView): boolean {
	return view.hand !== null && (view.hand.result ?? null) === null;
}

/** It is the viewer's turn, with their legal actions. */
export function myTurn(view: TableView): boolean {
	return Boolean(view.you.legal && view.hand && view.turn);
}

/** The name of the player the table waits for, when it is not the viewer. */
export function waitingFor(view: TableView): string | null {
	return view.turn && view.turn.seat !== view.you.seat ? nameOf(view, view.turn.seat) : null;
}

/** How many chips the viewer may still add to their stack. */
export function rebuyRoom(view: TableView): number {
	const me = view.you.seat === null ? null : view.seats[view.you.seat];
	return me ? view.settings.max_buy_in - me.stack - view.you.pending_rebuy : 0;
}

/** The viewer has a seat with no chips and no hand under way. */
export function busted(view: TableView): boolean {
	const me = view.you.seat === null ? null : view.seats[view.you.seat];
	return me !== null && me !== undefined && me.stack === 0 && !inHand(view);
}

/** Whether the viewer was dealt into the hand on the felt, so it is among their hands. */
export function dealtIn(view: TableView): boolean {
	const hand = view.hand;
	const mine = view.you.seat;
	if (hand === null || mine === null) return false;
	return (
		hand.posts.some((post) => post.seat === mine) ||
		hand.actions.some((action) => action.seat === mine) ||
		(hand.result?.net[mine] ?? 0) !== 0
	);
}

/** A hand has finished at this table, so there may be one of the viewer's to review. */
export function reviewable(view: TableView): boolean {
	return view.hand !== null && ((view.hand.result ?? null) !== null || view.hand.hand_no > 1);
}

/** A seat the viewer could take: empty or a bot's, and not held for someone. */
export function hasSeatRoom(view: TableView): boolean {
	const held = new Set(view.holds.map((h) => h.seat));
	return view.seats.some((info, seat) => !held.has(seat) && (info === null || info.kind === 'bot'));
}

/** What a place with nobody in it shows: held for the viewer or someone else, open to take, or empty. */
export type EmptySeat = 'mine' | 'held' | 'open' | 'empty';

export function emptySeat(view: TableView, seat: number): EmptySeat {
	if (view.holds.some((h) => h.seat === seat))
		return view.you.hold?.seat === seat ? 'mine' : 'held';
	if (view.you.seat === null && !view.you.hold && view.you.waitlist_position === null)
		return 'open';
	return 'empty';
}

export const EMPTY_SEAT_TEXT: Record<EmptySeat, string> = {
	mine: 'Your seat',
	held: 'Held',
	open: 'Sit here',
	empty: 'Empty'
};

/** The bar's middle: the hand's number and street, or that the table waits. */
export function handLine(view: TableView): string {
	return view.hand ? `#${view.hand.hand_no} · ${view.hand.street}` : 'Waiting for players';
}

/** The line in the dock while it is not the viewer's turn; empty when there is nothing to say. */
export function dockLine(view: TableView): string {
	if (busted(view)) return 'You are out of chips. Rebuy to keep playing.';
	if (view.you.sitting_out) return 'You are sitting out.';
	const waiting = waitingFor(view);
	if (waiting) return `Waiting for ${waiting}…`;
	if (view.hand?.result) return 'Next hand soon…';
	return '';
}

/**
 * The join panel's line for someone without a seat: a held seat (with `holdLeft`
 * seconds when it runs out), a place in line, or watching (`short` when the
 * wallet cannot cover the minimum buy-in).
 */
export function joinLine(view: TableView, holdLeft: number | null, short: boolean): string {
	const hold = view.you.hold;
	if (hold?.ready) {
		return `Seat ${hold.seat + 1} is held for you${holdLeft !== null ? ` for ${holdLeft}s` : ''}. Buy in to sit down.`;
	}
	if (hold) return `Seat ${hold.seat + 1} is yours when the bot there finishes this hand.`;
	if (view.you.waitlist_position !== null) {
		return `You are number ${view.you.waitlist_position} in line. A seat is held for you when one opens.`;
	}
	return `You are watching.${short ? ' You need more play chips to sit at this table.' : ''}`;
}

/** Under the buy-in field. */
export function buyInHint(view: TableView): string {
	return `Buy in for ${chips(view.settings.min_buy_in)} to ${chips(view.settings.max_buy_in)} play chips.`;
}

/** The refill button at a practice table. */
export function refillText(view: TableView): string {
	return `Play again with ${chips(view.settings.max_buy_in)} chips`;
}

/** The note beside the seat tools while a rebuy waits for the hand to end. */
export function pendingRebuyText(view: TableView): string | null {
	return view.you.pending_rebuy ? `+${view.you.pending_rebuy} after this hand` : null;
}

/** The hand log, newest first: at most 30 lines, each naming the player seated when it happened. */
export function logLines(
	log: readonly (TableEvent & { who?: string | null })[],
	view: TableView
): { seq: number; text: string }[] {
	return log
		.map((event) => ({
			seq: event.seq,
			text: describeEvent(event, (seat) => event.who ?? nameOf(view, seat))
		}))
		.filter((line): line is { seq: number; text: string } => line.text !== null)
		.slice(-30)
		.reverse();
}

/** What “Review last hand” and the review open when the viewer asks for a hand they were not in. */
export function noHandText(handNo: number | null): string {
	return handNo === null
		? 'You have not finished a hand at this table yet.'
		: `You were not dealt into hand #${handNo}, so it is not among your hands.`;
}

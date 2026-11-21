/**
 * Protocol v2 messages built from stored hands (P4.6), ported from the hand
 * parts of `rivermind/server/views.py` (P4B.5a). The table views follow
 * with the table runner (P4B.5b).
 *
 * Objects list their fields in the Pydantic models' order, so a response's
 * JSON matches the Python server's byte for byte.
 */
import { rank, suit } from '../../engine/cards.ts';
import type * as p from '../../protocol-v2.ts';
import { formatText, replayRecord } from '../engine/history.ts';
import { STREET_LABELS, type HandState } from '../engine/state.ts';
import type { PlayedHand } from './hands.ts';

const SUITS: readonly p.Suit[] = ['clubs', 'diamonds', 'hearts', 'spades'];

export function toCard(c: number): p.Card {
	return { rank: rank(c) + 2, suit: SUITS[suit(c)] };
}

export function toCards(cs: Iterable<number>): p.Card[] {
	return [...cs].map(toCard);
}

function summary(played: PlayedHand, state: HandState, seat: number): p.HandSummary {
	const result = state.result;
	if (result === null) throw new Error(`hand ${played.handId} is not over`);
	return {
		hand_id: played.handId,
		table_id: played.tableId,
		table_name: played.tableName,
		hand_no: played.handNo,
		at: played.at,
		seat,
		seat_count: state.startingStacks.length,
		small_blind: state.config.smallBlind,
		big_blind: state.config.bigBlind,
		cards: toCards(state.holeCards[seat] ?? []),
		board: toCards(state.board),
		pot: result.pots.reduce((total, pot) => total + pot.amount, 0),
		net: state.stacks[seat] - (state.startingStacks[seat] ?? 0),
		showdown: result.showdown,
		practice: played.practice
	};
}

/** A hand the player in `seat` played, as their hand history lists it. */
export function handSummary(played: PlayedHand, seat: number): p.HandSummary {
	return summary(played, replayRecord(played.record), seat);
}

/** A hand as the player in `seat` may see it: their cards and the hands shown, nothing mucked. */
export function handDetail(played: PlayedHand, seat: number): p.HandDetail {
	const state = replayRecord(played.record);
	const result = state.result;
	if (result === null) throw new Error(`hand ${played.handId} is not over`);
	const shown = new Set(result.shown);
	const names = new Map(played.seats.map((record) => [record.seat, record.name]));
	const seats: p.HandSeat[] = played.seats.map((record) => {
		const hole = state.holeCards[record.seat];
		const visible = record.seat === seat || shown.has(record.seat);
		return {
			seat: record.seat,
			name: record.name,
			kind: record.bot ? 'bot' : 'human',
			bot: record.bot,
			you: record.seat === seat,
			cards: visible && hole ? toCards(hole) : null,
			shown: shown.has(record.seat),
			net: record.net
		};
	});
	const text = formatText(state, seat).replace(
		/\bS([0-8])\b/g,
		(found, n: string) => names.get(Number(n)) ?? found
	);
	return {
		hand: summary(played, state, seat),
		button: state.button,
		seats,
		posts: state.posts.map((x) => ({
			seat: x.seat,
			kind: x.kind,
			amount: x.amount,
			all_in: x.allIn
		})),
		actions: state.actions.map((a) => ({
			seat: a.seat,
			street: STREET_LABELS[a.street],
			action: a.kind,
			to: a.to,
			added: a.added,
			all_in: a.allIn
		})),
		pots: result.pots.map((pot) => ({
			amount: pot.amount,
			eligible: [...pot.eligible],
			winners: [...pot.winners],
			shares: [...pot.shares]
		})),
		uncalled:
			result.uncalled === null ? null : { seat: result.uncalled[0], amount: result.uncalled[1] },
		text
	};
}

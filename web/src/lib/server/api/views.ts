/**
 * Protocol v2 messages built from stored hands (P4.6) and from running
 * tables, ported from `rivermind/server/views.py` (P4B.5a, P4B.5b).
 *
 * Objects list their fields in the Pydantic models' order, so a response's
 * JSON matches the Python server's byte for byte.
 */
import { card, rank, suit } from '../../engine/cards.ts';
import type * as p from '../../protocol-v2.ts';
import { formatText, replayRecord } from '../engine/history.ts';
import { legalActions, potTotal, STREET_LABELS, type HandState } from '../engine/state.ts';
import type { TableRunner } from '../table/runner.ts';
import type { Reservation, Table, TableEvent } from '../table/table.ts';
import { publicRef } from './auth.ts';
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

// Tables (P4B.5b): ported from `table_summary`, `table_view` and
// `table_events` in `rivermind/server/views.py`.

export function seatHold(seat: number, hold: Reservation): p.SeatHold {
	return { seat, name: hold.name, ready: hold.until !== null, until: hold.until };
}

export function yourHold(table: Table, playerId: string): p.SeatHold | null {
	const seat = table.reservationOf(playerId);
	const hold = seat === null ? undefined : table.reservations.get(seat);
	return seat === null || hold === undefined ? null : seatHold(seat, hold);
}

/** The table as the lobby lists it, for `playerId`, who blocked or was blocked by `blocks`. */
export function tableSummary(
	runner: TableRunner,
	playerId: string,
	blocks: ReadonlySet<string> = new Set()
): p.TableSummary {
	const table = runner.table;
	const config = table.config;
	const people = table.people();
	const players = table.players();
	return {
		table_id: runner.tableId,
		name: runner.name,
		seat_count: config.seatCount,
		small_blind: config.smallBlind,
		big_blind: config.bigBlind,
		min_buy_in: config.minBuyIn,
		max_buy_in: config.maxBuyIn,
		private: runner.private,
		people,
		bots: players.length - people,
		free_seats: table.freeSeats().length,
		bot_seats: table.botSeats().length,
		holds: table.reservations.size,
		waitlist: table.waitlist.length,
		hand_no: table.handNo,
		seated: table.seatOf(playerId) !== null,
		hold: yourHold(table, playerId),
		waitlist_position: table.waitlistPosition(playerId),
		blocked: players.some(([, player]) => blocks.has(player.playerId))
	};
}

const posts = (state: HandState): p.Post[] =>
	state.posts.map((x) => ({ seat: x.seat, kind: x.kind, amount: x.amount, all_in: x.allIn }));

const actions = (state: HandState): p.ActionRecord[] =>
	state.actions.map((a) => ({
		seat: a.seat,
		street: STREET_LABELS[a.street],
		action: a.kind,
		to: a.to,
		added: a.added,
		all_in: a.allIn
	}));

/**
 * Everything one player may see at a table: their own hole cards, the cards
 * shown at showdown and public information, never another seat's hidden cards.
 */
export function tableView(runner: TableRunner, playerId: string): p.TableView {
	const table = runner.table;
	const config = table.config;
	const youSeat = table.seatOf(playerId);
	const hand = table.hand;
	const inProgress = table.handInProgress;
	const result = hand?.result ?? null;
	const shown = new Set(result?.shown ?? []);
	const seats: (p.SeatInfo | null)[] = table.seats.map((player, seat) => {
		if (player === null) return null;
		const dealt =
			hand !== null && hand.dealtIn[seat] && table.handPlayers[seat] === player.playerId;
		const folded = dealt && hand !== null && hand.folded[seat];
		let cards: p.Card[] | null = null;
		let hasCards = false;
		if (dealt && hand !== null) {
			const hole = hand.holeCards[seat];
			if (hole !== null && (seat === youSeat || shown.has(seat))) cards = toCards(hole);
			hasCards = !folded && (inProgress || shown.has(seat) || seat === youSeat);
		}
		const live = inProgress && dealt && hand !== null;
		return {
			seat,
			name: player.name,
			kind: player.bot !== null ? 'bot' : 'human',
			ref: player.bot !== null ? null : publicRef(player.playerId),
			bot: player.bot,
			stack: table.stackOf(seat),
			bet: live ? hand.streetBets[seat] : 0,
			in_hand: live && !folded,
			folded,
			all_in: live && !folded && hand.stacks[seat] === 0,
			sitting_out: player.sittingOut,
			leaving: player.leaving,
			connected: player.connected,
			has_cards: hasCards,
			cards
		};
	});
	let handInfo: p.HandInfo | null = null;
	if (hand !== null) {
		let handResult: p.HandResult | null = null;
		if (result !== null) {
			handResult = {
				pots: result.pots.map((pot) => ({
					amount: pot.amount,
					eligible: [...pot.eligible],
					winners: [...pot.winners],
					shares: [...pot.shares]
				})),
				uncalled:
					result.uncalled === null
						? null
						: { seat: result.uncalled[0], amount: result.uncalled[1] },
				showdown: result.showdown,
				shown: [...result.shown],
				mucked: [...result.mucked],
				winnings: [...result.winnings],
				net: hand.stacks.map((stack, s) =>
					hand.dealtIn[s] ? stack - (hand.startingStacks[s] ?? 0) : 0
				)
			};
		}
		handInfo = {
			hand_no: table.handNo,
			button: hand.button,
			small_blind_seat: hand.smallBlindSeat,
			big_blind_seat: hand.bigBlindSeat,
			street: STREET_LABELS[hand.street],
			board: toCards(hand.board),
			pot: potTotal(hand),
			current_bet: hand.currentBet,
			to_act: hand.toAct,
			posts: posts(hand),
			actions: actions(hand),
			result: handResult
		};
	}
	const turn = inProgress ? table.turn : null;
	let legal: p.Legal | null = null;
	if (inProgress && hand !== null && youSeat !== null && hand.toAct === youSeat) {
		const options = legalActions(hand);
		legal = {
			can_fold: options.canFold,
			can_check: options.canCheck,
			call: options.call,
			raise_kind: options.raiseKind,
			min_to: options.minTo,
			max_to: options.maxTo
		};
	}
	const you = youSeat === null ? null : table.seats[youSeat];
	return {
		table_id: runner.tableId,
		name: runner.name,
		seq: table.seq,
		server_time: runner.options.clock.now(),
		settings: {
			seat_count: config.seatCount,
			small_blind: config.smallBlind,
			big_blind: config.bigBlind,
			ante: config.ante,
			min_buy_in: config.minBuyIn,
			max_buy_in: config.maxBuyIn,
			action_seconds: config.actionSeconds,
			time_bank_seconds: config.timeBankSeconds
		},
		seats,
		hand: handInfo,
		turn:
			turn === null
				? null
				: {
						seat: turn.seat,
						seq: turn.seq,
						started: turn.started,
						deadline: turn.deadline,
						final: turn.final
					},
		you: {
			player_id: playerId,
			seat: youSeat,
			hold: yourHold(table, playerId),
			waitlist_position: table.waitlistPosition(playerId),
			legal,
			time_bank: you?.timeBank ?? null,
			pending_rebuy: you?.pendingRebuy ?? 0,
			sitting_out: you?.sittingOut ?? false,
			sitting_out_next: you?.sitOutNext ?? false
		},
		private: runner.private,
		invite: runner.invite,
		holds: table.holds().map(([seat, hold]) => seatHold(seat, hold)),
		waitlist: table.waitlist.length,
		practice: runner.practice !== null
	};
}

/** The table's public events as protocol events, each with every field. */
export function tableEvents(events: readonly TableEvent[]): p.TableEvent[] {
	return events.map((event) => {
		const data = event.data as Record<string, never>;
		const out: Required<p.TableEvent> = {
			seq: event.seq,
			kind: event.kind as p.EventKind,
			seat: 'seat' in data ? data.seat : null,
			name: null,
			amount: null,
			added: null,
			all_in: null,
			action: null,
			street: null,
			cards: null,
			reason: null,
			hand_no: null,
			count: null
		};
		switch (event.kind) {
			case 'seated':
				out.name = data.name;
				out.amount = data.stack;
				break;
			case 'left':
				out.amount = data.stack;
				break;
			case 'rebuy_pending':
			case 'rebought':
			case 'rebuy_dropped':
				out.amount = data.amount;
				break;
			case 'sat_out':
			case 'reservation_ended':
				out.reason = data.reason;
				break;
			case 'hand_started':
				out.hand_no = data.hand_no;
				out.seat = data.button;
				break;
			case 'hand_ended':
				out.hand_no = data.hand_no;
				break;
			case 'reserved':
				out.name = data.name;
				break;
			case 'waitlist':
				out.count = data.count;
				break;
			case 'action':
				out.action = data.action;
				out.amount = data.to;
				out.added = data.added;
				out.all_in = data.all_in;
				out.street = data.street;
				break;
			case 'board':
				out.street = data.street;
				out.cards = (data.cards as string[]).map((c) => toCard(card(c)));
				break;
		}
		return out;
	});
}

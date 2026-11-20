// Versioned JSON for hand states and histories, replay and plain-text
// histories: a port of rivermind/engine/history.py. Documents written here are
// byte-identical to the Python engine's (`dumps` matches Python's
// `json.dumps(..., separators=(",", ":"), sort_keys=True)`), so tables and
// hands stored by either server load in the other.
//
// A *state* document is a complete snapshot of a HandState (for durable
// tables). A *history* document records only what is needed to replay a hand:
// the stakes, starting stacks, button, deck order and actions. Both carry
// "format" (the version of this layout) and "kind". Cards are written as text
// such as "As". Both include every hole card and the deck, so they are private
// to the server. `formatText` renders a readable history for a viewer and
// leaves out the cards that viewer may not see.

import { card, cardStr, pretty } from '../../engine/cards.ts';
import { describe } from '../../engine/evaluator.ts';
import type { Pot } from './pots.ts';
import {
	ACTION_KINDS,
	Action,
	FLOP,
	POST_KINDS,
	PREFLOP,
	RIVER,
	TURN,
	apply,
	finalStacks,
	handConfig,
	numSeats,
	potTotal,
	seatOrder,
	startHand,
	type ActionKind,
	type ActionRecord,
	type HandConfig,
	type HandResult,
	type HandState,
	type HoleCards,
	type Post,
	type PostKind,
	type Street
} from './state.ts';

export const FORMAT = 1;
export const STATE_KIND = 'hand_state';
export const HISTORY_KIND = 'hand_history';

const STREET_NAMES = ['preflop', 'flop', 'turn', 'river'] as const;

/** A document has an unknown format, the wrong kind or bad contents. */
export class FormatError extends Error {
	override name = 'FormatError';
}

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** The inputs of a hand: enough to replay it exactly. */
export interface HandHistory {
	readonly config: HandConfig;
	readonly startingStacks: readonly (number | null)[];
	readonly button: number;
	readonly deck: readonly number[];
	readonly actions: readonly Action[];
}

/** The history of the hand so far. */
export function historyOf(state: HandState): HandHistory {
	return {
		config: state.config,
		startingStacks: state.startingStacks,
		button: state.button,
		deck: state.deck,
		actions: state.actions.map(asAction)
	};
}

function asAction(record: ActionRecord): Action {
	return record.kind === 'bet' || record.kind === 'raise'
		? Action.of(record.kind, record.to)
		: Action.of(record.kind);
}

/** Replay a history from its first state. */
export function replay(history: HandHistory): HandState {
	let state = startHand(history.config, history.startingStacks, history.button, {
		deck: history.deck
	});
	for (const action of history.actions) state = apply(state, action);
	return state;
}

// JSON documents

function cardList(cs: readonly number[]): string[] {
	return cs.map(cardStr);
}

function configDoc(config: HandConfig): JsonObject {
	return { small_blind: config.smallBlind, big_blind: config.bigBlind, ante: config.ante };
}

function actionDoc(action: Action): JsonObject {
	const doc: JsonObject = { action: action.kind };
	if (action.amount !== null && action.amount !== undefined) doc.amount = action.amount;
	return doc;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function check(data: unknown, kind: string): asserts data is Record<string, unknown> {
	if (!isObject(data)) throw new FormatError('a document must be a JSON object');
	if (data.format !== FORMAT) {
		throw new FormatError(
			`unsupported format ${JSON.stringify(data.format ?? null)}; this engine reads format ${FORMAT}`
		);
	}
	if (data.kind !== kind) {
		throw new FormatError(`expected a ${kind} document, got ${JSON.stringify(data.kind ?? null)}`);
	}
}

/** Read a field, failing as Python's KeyError would. */
function field(data: Record<string, unknown>, key: string): unknown {
	if (!(key in data)) throw new FormatError(`missing ${JSON.stringify(key)}`);
	return data[key];
}

function list(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) throw new FormatError(`${what} must be a list`);
	return value;
}

function integer(value: unknown, what: string): number {
	if (!Number.isInteger(value)) throw new FormatError(`${what} must be an integer`);
	return value as number;
}

function optionalInteger(value: unknown, what: string): number | null {
	return value === null ? null : integer(value, what);
}

function boolean(value: unknown, what: string): boolean {
	if (typeof value !== 'boolean') throw new FormatError(`${what} must be true or false`);
	return value;
}

function parseCards(value: unknown): number[] {
	return list(value, 'cards').map((c) => card(c as string));
}

function parseConfig(value: unknown): HandConfig {
	if (!isObject(value)) throw new FormatError('config must be an object');
	return handConfig(
		field(value, 'small_blind') as number,
		field(value, 'big_blind') as number,
		('ante' in value ? value.ante : 0) as number
	);
}

function parseKind(value: unknown): ActionKind {
	if (!ACTION_KINDS.includes(value as ActionKind)) {
		throw new FormatError(`${JSON.stringify(value)} is not a valid action`);
	}
	return value as ActionKind;
}

function parseStreet(value: unknown): Street {
	const index = STREET_NAMES.indexOf(value as (typeof STREET_NAMES)[number]);
	if (index < 0) throw new FormatError(`${JSON.stringify(value)} is not a street`);
	return index as Street;
}

/** Run a parser, turning any failure into a FormatError as the Python reader does. */
function parsing<T>(what: string, parse: () => T): T {
	try {
		return parse();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new FormatError(`bad ${what}: ${message}`, { cause: error });
	}
}

/** A history document. */
export function historyToDict(history: HandHistory): JsonObject {
	return {
		format: FORMAT,
		kind: HISTORY_KIND,
		game: 'no_limit_holdem',
		config: configDoc(history.config),
		starting_stacks: [...history.startingStacks],
		button: history.button,
		deck: cardList(history.deck),
		actions: history.actions.map(actionDoc)
	};
}

export function historyFromDict(data: unknown): HandHistory {
	check(data, HISTORY_KIND);
	return parsing('hand history', () => ({
		config: parseConfig(field(data, 'config')),
		startingStacks: list(field(data, 'starting_stacks'), 'starting_stacks') as (number | null)[],
		button: field(data, 'button') as number,
		deck: parseCards(field(data, 'deck')),
		actions: list(field(data, 'actions'), 'actions').map((a) => {
			if (!isObject(a)) throw new FormatError('an action must be an object');
			const amount = 'amount' in a ? a.amount : null;
			return Action.of(parseKind(field(a, 'action')), amount as number | null);
		})
	}));
}

/** A history document for a hand, with a summary used to check the replay. */
export function handRecord(state: HandState): JsonObject {
	const doc = historyToDict(historyOf(state));
	if (state.result !== null) {
		doc.final_stacks = finalStacks(state);
		doc.board = cardList(state.board);
	}
	return doc;
}

/** Replay a history document and check it against its recorded summary. */
export function replayRecord(data: unknown): HandState {
	const state = replay(historyFromDict(data));
	const record = data as Record<string, unknown>;
	if (
		'final_stacks' in record &&
		dumps(finalStacks(state)) !== dumps(record.final_stacks as Json)
	) {
		throw new FormatError('replay does not reproduce the recorded final stacks');
	}
	if ('board' in record && dumps(cardList(state.board)) !== dumps(record.board as Json)) {
		throw new FormatError('replay does not reproduce the recorded board');
	}
	return state;
}

/** A complete, versioned snapshot of a state. */
export function stateToDict(state: HandState): JsonObject {
	return {
		format: FORMAT,
		kind: STATE_KIND,
		game: 'no_limit_holdem',
		config: configDoc(state.config),
		button: state.button,
		small_blind_seat: state.smallBlindSeat,
		big_blind_seat: state.bigBlindSeat,
		starting_stacks: [...state.startingStacks],
		deck: cardList(state.deck),
		dealt_in: [...state.dealtIn],
		hole_cards: state.holeCards.map((h) => (h === null ? null : cardList(h))),
		stacks: [...state.stacks],
		street_bets: [...state.streetBets],
		contributions: [...state.contributions],
		folded: [...state.folded],
		acted_at: [...state.actedAt],
		street: STREET_NAMES[state.street],
		board: cardList(state.board),
		current_bet: state.currentBet,
		min_raise: state.minRaise,
		to_act: state.toAct,
		posts: state.posts.map((p) => ({
			seat: p.seat,
			kind: p.kind,
			amount: p.amount,
			all_in: p.allIn
		})),
		actions: state.actions.map((r) => ({
			seat: r.seat,
			street: STREET_NAMES[r.street],
			action: r.kind,
			to: r.to,
			added: r.added,
			all_in: r.allIn
		})),
		result: state.result === null ? null : resultDoc(state.result)
	};
}

function resultDoc(result: HandResult): JsonObject {
	return {
		uncalled: result.uncalled === null ? null : [...result.uncalled],
		pots: result.pots.map((p) => ({
			amount: p.amount,
			eligible: [...p.eligible],
			winners: [...p.winners],
			shares: [...p.shares]
		})),
		showdown: result.showdown,
		tabled: result.tabled,
		shown: [...result.shown],
		mucked: [...result.mucked],
		hand_ranks: [...result.handRanks],
		winnings: [...result.winnings]
	};
}

export function stateFromDict(data: unknown): HandState {
	check(data, STATE_KIND);
	return parsing('hand state', () => {
		const ints = (key: string) => list(field(data, key), key).map((v) => integer(v, key));
		const flags = (key: string) => list(field(data, key), key).map((v) => boolean(v, key));
		const holeCards = list(field(data, 'hole_cards'), 'hole_cards').map((h): HoleCards | null => {
			if (h === null) return null;
			const pair = list(h, 'hole cards');
			return [card(pair[0] as string), card(pair[1] as string)];
		});
		const resultData = field(data, 'result');
		return {
			config: parseConfig(field(data, 'config')),
			button: integer(field(data, 'button'), 'button'),
			smallBlindSeat: integer(field(data, 'small_blind_seat'), 'small_blind_seat'),
			bigBlindSeat: integer(field(data, 'big_blind_seat'), 'big_blind_seat'),
			startingStacks: list(field(data, 'starting_stacks'), 'starting_stacks').map((v) =>
				optionalInteger(v, 'starting_stacks')
			),
			deck: parseCards(field(data, 'deck')),
			dealtIn: flags('dealt_in'),
			holeCards,
			stacks: ints('stacks'),
			streetBets: ints('street_bets'),
			contributions: ints('contributions'),
			folded: flags('folded'),
			actedAt: list(field(data, 'acted_at'), 'acted_at').map((v) => optionalInteger(v, 'acted_at')),
			street: parseStreet(field(data, 'street')),
			board: parseCards(field(data, 'board')),
			currentBet: integer(field(data, 'current_bet'), 'current_bet'),
			minRaise: integer(field(data, 'min_raise'), 'min_raise'),
			toAct: optionalInteger(field(data, 'to_act'), 'to_act'),
			posts: list(field(data, 'posts'), 'posts').map((p): Post => {
				if (!isObject(p)) throw new FormatError('a post must be an object');
				const kind = field(p, 'kind') as PostKind;
				if (!POST_KINDS.includes(kind))
					throw new FormatError(`${JSON.stringify(kind)} is not a post`);
				return {
					seat: integer(field(p, 'seat'), 'seat'),
					kind,
					amount: integer(field(p, 'amount'), 'amount'),
					allIn: boolean(field(p, 'all_in'), 'all_in')
				};
			}),
			actions: list(field(data, 'actions'), 'actions').map((r): ActionRecord => {
				if (!isObject(r)) throw new FormatError('an action must be an object');
				return {
					seat: integer(field(r, 'seat'), 'seat'),
					street: parseStreet(field(r, 'street')),
					kind: parseKind(field(r, 'action')),
					to: integer(field(r, 'to'), 'to'),
					added: integer(field(r, 'added'), 'added'),
					allIn: boolean(field(r, 'all_in'), 'all_in')
				};
			}),
			result: resultData === null ? null : parseResult(resultData)
		};
	});
}

function parseResult(data: unknown): HandResult {
	if (!isObject(data)) throw new FormatError('result must be an object');
	const ints = (key: string) => list(field(data, key), key).map((v) => integer(v, key));
	const uncalled = field(data, 'uncalled');
	let pair: [number, number] | null = null;
	if (uncalled !== null) {
		const values = list(uncalled, 'uncalled');
		pair = [integer(values[0], 'uncalled'), integer(values[1], 'uncalled')];
	}
	return {
		uncalled: pair,
		pots: list(field(data, 'pots'), 'pots').map((p): Pot => {
			if (!isObject(p)) throw new FormatError('a pot must be an object');
			const seats = (key: string) => list(field(p, key), key).map((v) => integer(v, key));
			return {
				amount: integer(field(p, 'amount'), 'amount'),
				eligible: seats('eligible'),
				winners: seats('winners'),
				shares: seats('shares')
			};
		}),
		showdown: boolean(field(data, 'showdown'), 'showdown'),
		tabled: boolean(field(data, 'tabled'), 'tabled'),
		shown: ints('shown'),
		mucked: ints('mucked'),
		handRanks: list(field(data, 'hand_ranks'), 'hand_ranks').map((v) =>
			optionalInteger(v, 'hand_ranks')
		),
		winnings: ints('winnings')
	};
}

// Python's json module escapes everything outside printable ASCII.
function pythonString(text: string): string {
	return JSON.stringify(text).replace(
		/[^\x20-\x7e]/g,
		(ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')
	);
}

/**
 * Compact, stable JSON text for a document, byte-identical to Python's
 * `json.dumps(document, separators=(",", ":"), sort_keys=True)` for the values
 * these documents hold (whole numbers, strings, booleans, null, lists and
 * objects).
 */
export function dumps(value: Json | readonly Json[] | undefined): string {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value))
			throw new TypeError(`dumps writes only whole numbers: ${value}`);
		return String(value);
	}
	if (typeof value === 'string') return pythonString(value);
	if (Array.isArray(value)) return '[' + value.map((v) => dumps(v)).join(',') + ']';
	const object = value as JsonObject;
	// Python sorts keys by code point; for these ASCII keys that is UTF-16 order.
	const keys = Object.keys(object).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return '{' + keys.map((k) => pythonString(k) + ':' + dumps(object[k])).join(',') + '}';
}

export function loads(text: string): JsonObject {
	const data: unknown = JSON.parse(text);
	if (!isObject(data)) throw new FormatError('a document must be a JSON object');
	return data as JsonObject;
}

// Plain-text histories

function chips(amount: number): string {
	const sign = amount < 0 ? '-' : '';
	return sign + String(Math.abs(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function hand(cs: readonly number[]): string {
	return cs.map(pretty).join(' ');
}

const POST_WORDS: Record<PostKind, string> = {
	ante: 'the ante',
	small_blind: 'the small blind',
	big_blind: 'the big blind'
};

function actionText(record: ActionRecord): string {
	const seat = `S${record.seat}`;
	let text: string;
	if (record.kind === 'fold') text = `${seat} folds`;
	else if (record.kind === 'check') text = `${seat} checks`;
	else if (record.kind === 'call') text = `${seat} calls ${chips(record.added)}`;
	else if (record.kind === 'bet') text = `${seat} bets ${chips(record.to)}`;
	else text = `${seat} raises to ${chips(record.to)}`;
	return text + (record.allIn ? ' and is all-in' : '');
}

function streetHeader(street: Street, board: readonly number[]): string {
	if (street === FLOP) return `*** Flop *** ${hand(board.slice(0, 3))}`;
	if (street === TURN) return `*** Turn *** ${hand(board.slice(0, 3))} · ${pretty(board[3])}`;
	return `*** River *** ${hand(board.slice(0, 4))} · ${pretty(board[4])}`;
}

/**
 * A readable hand history.
 *
 * With `viewer` null every hole card is shown, as the server sees the hand.
 * With a seat number, only that seat's cards and the hands shown at showdown
 * appear; mucked and folded hands stay hidden (rule 12.4).
 */
export function formatText(state: HandState, viewer: number | null = null): string {
	const config = state.config;
	const result = state.result;
	const shown = new Set(result?.shown ?? []);
	const ante = config.ante ? ` · Ante ${chips(config.ante)}` : '';
	const lines = [
		`RiverMind Poker · No-limit hold'em · ${numSeats(state)} seats · ` +
			`Blinds ${chips(config.smallBlind)}/${chips(config.bigBlind)}${ante}`,
		`Button S${state.button} · Small blind S${state.smallBlindSeat} · Big blind S${state.bigBlindSeat}`
	];
	state.startingStacks.forEach((stack, seat) => {
		if (state.dealtIn[seat]) lines.push(`S${seat}: ${chips(stack ?? 0)} chips`);
	});
	for (const post of state.posts) {
		const allIn = post.allIn ? ' and is all-in' : '';
		lines.push(`S${post.seat} posts ${POST_WORDS[post.kind]} ${chips(post.amount)}${allIn}`);
	}

	const visible = (seat: number) => viewer === null || seat === viewer;

	lines.push('*** Hole cards ***');
	for (const seat of seatOrder(state)) {
		const hole = state.holeCards[seat];
		if (hole !== null && visible(seat)) lines.push(`S${seat}: ${hand(hole)}`);
	}

	let street: Street = PREFLOP;
	lines.push('*** Pre-flop ***');
	const tabled = result !== null && result.tabled;

	for (const record of state.actions) {
		while (record.street > street) {
			street = (street + 1) as Street;
			lines.push(streetHeader(street, state.board));
		}
		lines.push(actionText(record));
	}
	if (result !== null) {
		if (tabled) {
			lines.push('*** All in: hands shown ***');
			for (const seat of result.shown) {
				lines.push(`S${seat} shows ${hand(state.holeCards[seat] as HoleCards)}`);
			}
		}
		while (street < RIVER && state.board.length >= 3 + street) {
			street = (street + 1) as Street;
			lines.push(streetHeader(street, state.board));
		}
		if (result.showdown) {
			lines.push('*** Showdown ***');
			const seats = result.tabled ? result.shown : [...result.shown, ...result.mucked];
			for (const seat of seats) {
				const hole = state.holeCards[seat] as HoleCards;
				const rank = result.handRanks[seat] as number;
				if (shown.has(seat)) lines.push(`S${seat} shows ${hand(hole)} (${describe(rank)})`);
				else if (visible(seat)) lines.push(`S${seat} mucks ${hand(hole)}`);
				else lines.push(`S${seat} mucks`);
			}
		}
		lines.push('*** Result ***');
		if (result.uncalled !== null) {
			const [seat, amount] = result.uncalled;
			lines.push(`Uncalled bet of ${chips(amount)} returned to S${seat}`);
		}
		result.pots.forEach((pot, i) => {
			const name = result.pots.length === 1 ? 'Pot' : i === 0 ? 'Main pot' : `Side pot ${i}`;
			const wins = pot.winners.map((s, j) => `S${s} wins ${chips(pot.shares[j])}`).join(', ');
			lines.push(`${name} ${chips(pot.amount)}: ${wins}`);
		});
		const finals = finalStacks(state)
			.map((stack, seat) => (stack === null ? null : `S${seat} ${chips(stack)}`))
			.filter((text) => text !== null)
			.join(' · ');
		lines.push(`Final stacks: ${finals}`);
	} else {
		lines.push(`(in progress: S${state.toAct} to act, pot ${chips(potTotal(state))})`);
	}
	return lines.join('\n') + '\n';
}

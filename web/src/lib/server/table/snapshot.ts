// Versioned JSON snapshots of whole tables (D-4): a port of
// rivermind/server/snapshot.py (P4B.5b), reading and writing the same
// documents, so tables saved by serve-nl load here and the other way round.
//
// `tableToDict` captures everything a `Table` needs to carry on after a
// restart: its configuration, every seated player, the hand in progress (or
// the last one) as an engine state document, the turn clock and the event
// counter. `tableFromDict` rebuilds an identical table. Events, finished
// hands and departures waiting to be drained are not part of a snapshot: they
// are published, and stored, before the next snapshot is taken.
//
// A snapshot holds every hole card and the deck, so it is as private as the
// server. Turn times are seconds since the epoch, so a deadline saved before a
// restart still means the same moment after it.
//
// Format 2 (P4.3) adds held seats and the waitlist. Format 1 documents, saved
// before them, still load, with neither.

import { FormatError, stateFromDict, stateToDict, type JsonObject } from '../engine/history.ts';
import { numSeats } from '../engine/state.ts';
import {
	Table,
	tableConfig,
	type Player,
	type Reservation,
	type TableConfig,
	type Turn
} from './table.ts';

export const FORMAT = 2;
export const READABLE: ReadonlySet<number> = new Set([1, 2]);
export const KIND = 'table';

type Kind = 'string' | 'int' | 'number' | 'boolean' | 'string?';

/** Snapshot field, the property it is kept in, and its type. */
const CONFIG_FIELDS = [
	['seat_count', 'seatCount'],
	['small_blind', 'smallBlind'],
	['big_blind', 'bigBlind'],
	['ante', 'ante'],
	['min_buy_in', 'minBuyIn'],
	['max_buy_in', 'maxBuyIn'],
	['action_seconds', 'actionSeconds'],
	['time_bank_seconds', 'timeBankSeconds'],
	['bank_refill_seconds', 'bankRefillSeconds']
] as const satisfies readonly (readonly [string, keyof TableConfig])[];

const PLAYER_FIELDS = [
	['player_id', 'playerId', 'string'],
	['name', 'name', 'string'],
	['stack', 'stack', 'int'],
	['bot', 'bot', 'string?'],
	['sitting_out', 'sittingOut', 'boolean'],
	['sit_out_next', 'sitOutNext', 'boolean'],
	['leaving', 'leaving', 'boolean'],
	['pending_rebuy', 'pendingRebuy', 'int'],
	['time_bank', 'timeBank', 'number'],
	['connected', 'connected', 'boolean'],
	['absent_hands', 'absentHands', 'int'],
	['acted_this_hand', 'actedThisHand', 'boolean'],
	['timed_out_this_hand', 'timedOutThisHand', 'boolean'],
	['disconnected_this_hand', 'disconnectedThisHand', 'boolean']
] as const satisfies readonly (readonly [string, keyof Player, Kind])[];

const TURN_FIELDS = ['seat', 'seq', 'started', 'deadline', 'final'] as const;

class Bad extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(data: Record<string, unknown>, name: string): unknown {
	if (!Object.hasOwn(data, name)) throw new Bad(`'${name}'`);
	return data[name];
}

function hasKind(value: unknown, kind: Kind): boolean {
	if (kind === 'string') return typeof value === 'string';
	if (kind === 'string?') return value === null || typeof value === 'string';
	if (kind === 'boolean') return typeof value === 'boolean';
	if (kind === 'int') return Number.isSafeInteger(value);
	return typeof value === 'number' && Number.isFinite(value);
}

function player(data: unknown): Player {
	if (!isObject(data)) throw new Bad('a seat must be an object or null');
	const values: Record<string, unknown> = {};
	for (const [name, key, kind] of PLAYER_FIELDS) {
		const value = field(data, name);
		if (!hasKind(value, kind)) throw new Bad(`player field ${name} has the wrong type`);
		values[key] = value;
	}
	const found = values as unknown as Player;
	if (found.stack < 0 || found.pendingRebuy < 0) {
		throw new Bad('a player cannot hold negative chips');
	}
	return found;
}

export function configToDict(config: TableConfig): JsonObject {
	const out: JsonObject = {};
	for (const [name, key] of CONFIG_FIELDS) out[name] = config[key];
	return out;
}

export function configFromDict(data: unknown): TableConfig {
	if (!isObject(data)) throw new Bad('the config must be an object');
	const values: Record<string, unknown> = {};
	for (const [name, key] of CONFIG_FIELDS) {
		const value = field(data, name);
		if (typeof value !== 'number') throw new Bad(`config field ${name} has the wrong type`);
		values[key] = value;
	}
	return tableConfig(values as unknown as TableConfig);
}

/** A complete, versioned snapshot of `table` between changes. */
export function tableToDict(table: Table): JsonObject {
	if (table.events.length || table.finished.length || table.departures.length) {
		throw new Error("drain a table's events, finished hands and departures before saving it");
	}
	const turn = table.turn;
	return {
		format: FORMAT,
		kind: KIND,
		config: configToDict(table.config),
		seats: table.seats.map((seated) => {
			if (seated === null) return null;
			const out: JsonObject = {};
			for (const [name, key] of PLAYER_FIELDS) out[name] = seated[key];
			return out;
		}),
		hand: table.hand === null ? null : stateToDict(table.hand),
		hand_players: [...table.handPlayers],
		hand_no: table.handNo,
		button: table.button,
		seq: table.seq,
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
		reservations: table.holds().map(([seat, hold]) => ({
			seat,
			player_id: hold.playerId,
			name: hold.name,
			until: hold.until,
			bot: hold.bot
		})),
		waitlist: table.waitlist.map((w) => ({ player_id: w.playerId, name: w.name }))
	};
}

function reservation(data: unknown, seatCount: number): [number, Reservation] {
	if (!isObject(data)) throw new Bad('a held seat must be an object');
	const seat = field(data, 'seat');
	const until = field(data, 'until');
	const bot = field(data, 'bot');
	const playerId = field(data, 'player_id');
	const name = field(data, 'name');
	if (!Number.isInteger(seat) || (seat as number) < 0 || (seat as number) >= seatCount) {
		throw new Bad('a held seat is out of range');
	}
	if (typeof playerId !== 'string' || typeof name !== 'string') {
		throw new Bad('a held seat needs a player id and a name');
	}
	if (until !== null && typeof until !== 'number') {
		throw new Bad("a held seat's time has the wrong type");
	}
	if (bot !== null && typeof bot !== 'string') {
		throw new Bad("a held seat's bot has the wrong type");
	}
	return [seat as number, { playerId, name, until, bot }];
}

function list(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) throw new Bad(`${what} must be a list`);
	return value;
}

function int(value: unknown, what: string): number {
	if (!Number.isSafeInteger(value)) throw new Bad(`${what} must be a whole number`);
	return value as number;
}

/** Rebuild a table from `tableToDict`. Throws `FormatError` for a bad document. */
export function tableFromDict(data: unknown, clock?: () => number): Table {
	if (!isObject(data)) throw new FormatError('a table snapshot must be a JSON object');
	if (typeof data.format !== 'number' || !READABLE.has(data.format)) {
		throw new FormatError(`unknown table snapshot format ${JSON.stringify(data.format ?? null)}`);
	}
	if (data.kind !== KIND) {
		throw new FormatError(`expected a ${KIND} document, got ${JSON.stringify(data.kind ?? null)}`);
	}
	try {
		const config = configFromDict(field(data, 'config'));
		const table = new Table(config, clock);
		const seats = list(field(data, 'seats'), 'seats');
		const handPlayers = list(field(data, 'hand_players'), 'hand_players');
		if (seats.length !== config.seatCount || handPlayers.length !== config.seatCount) {
			throw new Bad('the seat lists do not match the seat count');
		}
		table.seats = seats.map((s) => (s === null ? null : player(s)));
		const hand = field(data, 'hand');
		table.hand = hand === null ? null : stateFromDict(hand);
		if (table.hand !== null && numSeats(table.hand) !== config.seatCount) {
			throw new Bad('the hand does not match the seat count');
		}
		table.handPlayers = handPlayers.map((id) => {
			if (id !== null && typeof id !== 'string') throw new Bad('hand_players holds player ids');
			return id;
		});
		table.handNo = int(field(data, 'hand_no'), 'hand_no');
		const button = field(data, 'button');
		table.button = button === null ? null : int(button, 'button');
		table.seq = int(field(data, 'seq'), 'seq');
		const turn = field(data, 'turn');
		if (turn !== null) {
			if (!isObject(turn)) throw new Bad('the turn must be an object');
			const values: Record<string, number> = {};
			for (const name of TURN_FIELDS) {
				const value = field(turn, name);
				if (typeof value !== 'number') throw new Bad(`turn field ${name} has the wrong type`);
				values[name] = value;
			}
			table.turn = values as unknown as Turn;
		}
		if (data.format >= 2) {
			table.reservations = new Map(
				list(field(data, 'reservations'), 'reservations').map((r) =>
					reservation(r, config.seatCount)
				)
			);
			table.waitlist = list(field(data, 'waitlist'), 'waitlist').map((w) => {
				if (!isObject(w)) throw new Bad('a waitlist entry must be an object');
				return { playerId: String(field(w, 'player_id')), name: String(field(w, 'name')) };
			});
		}
		return table;
	} catch (error) {
		if (error instanceof FormatError) throw error;
		if (error instanceof Bad || error instanceof RangeError || error instanceof TypeError) {
			throw new FormatError(`bad table snapshot: ${error.message}`);
		}
		throw error;
	}
}

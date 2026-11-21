// Replays the fuzzed tables of test/server/table_differential.py against the
// TypeScript table and reports where its documents differ from Python's
// (P4B.5b). `scripts/table-parity.ts` runs the long check; `parity.spec.ts`
// replays the small committed set.

import { createHash } from 'node:crypto';
import { PythonRandom } from '../bots/mt.ts';
import { handRecord, type Json } from '../engine/history.ts';
import { Action, type ActionKind } from '../engine/state.ts';
import { tableFromDict, tableToDict } from './snapshot.ts';
import { Table, tableConfig, TableError, type Departure } from './table.ts';

export type Op = [name: string, ...args: unknown[]];

export interface Sequence {
	seed: number;
	config: Record<string, number>;
	start: number;
	deal_seed: number;
	ops: Op[];
	digests: string[];
	/** With `--full`: Python's whole document for each request. */
	documents?: unknown[];
}

/**
 * Compact JSON with sorted keys, as Python's `json.dumps(…, sort_keys=True,
 * separators=(",", ":"))` writes a document whose whole-number floats were
 * made whole numbers. Other numbers are written the same in both languages
 * at the sizes tables use.
 */
export function canonical(value: unknown): string {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError(`not a JSON number: ${value}`);
		return String(value);
	}
	if (typeof value === 'string') {
		return JSON.stringify(value).replace(
			/[^\x20-\x7e]/g,
			(ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')
		);
	}
	if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
	const object = value as Record<string, unknown>;
	const keys = Object.keys(object).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return '{' + keys.map((k) => canonical(k) + ':' + canonical(object[k])).join(',') + '}';
}

export function digest(document: unknown): string {
	return createHash('sha256').update(canonical(document), 'utf8').digest('hex').slice(0, 16);
}

function departureDoc(d: Departure) {
	return { player_id: d.playerId, seat: d.seat, chips: d.chips, left: d.left, bot: d.bot };
}

/** A table, its clock and its dealing generator, changed only through `apply`. */
export class Driver {
	now: number;
	table: Table;
	readonly deal: PythonRandom;
	private readonly clock = () => this.now;

	constructor(config: Record<string, number>, start: number, dealSeed: number) {
		this.now = start;
		this.table = new Table(
			tableConfig({
				seatCount: config.seat_count,
				smallBlind: config.small_blind,
				bigBlind: config.big_blind,
				ante: config.ante,
				minBuyIn: config.min_buy_in,
				maxBuyIn: config.max_buy_in,
				actionSeconds: config.action_seconds,
				timeBankSeconds: config.time_bank_seconds,
				bankRefillSeconds: config.bank_refill_seconds
			}),
			this.clock
		);
		this.deal = new PythonRandom(dealSeed);
	}

	/** Apply one request and return its answer. Throws `TableError` on a refusal. */
	apply(op: Op): unknown {
		const table = this.table;
		const [name, ...args] = op;
		const a = args as never[];
		switch (name) {
			case 'advance':
				this.now += args[0] as number;
				return null;
			case 'restore':
				this.table = tableFromDict(JSON.parse(JSON.stringify(tableToDict(table))), this.clock);
				return null;
			case 'sit':
				table.sit(a[0], a[1], a[2], a[3], a[4]);
				return null;
			case 'leave': {
				const departure = table.leave(a[0]);
				return departure === null ? null : departureDoc(departure);
			}
			case 'sit_out':
				table.sitOut(a[0]);
				return null;
			case 'sit_in':
				table.sitIn(a[0]);
				return null;
			case 'set_connected':
				table.setConnected(a[0], a[1]);
				return null;
			case 'rebuy':
				table.rebuy(a[0], a[1]);
				return null;
			case 'reserve':
				return table.reserve(a[0], a[1], a[2]);
			case 'cancel_reservation':
				table.cancelReservation(a[0]);
				return null;
			case 'join_waitlist':
				return table.joinWaitlist(a[0], a[1]);
			case 'leave_waitlist':
				table.leaveWaitlist(a[0]);
				return null;
			case 'settle':
				table.settleSeats();
				return null;
			case 'start':
				table.startHand(this.deal);
				return null;
			case 'act':
				table.act(a[0], Action.of(args[1] as ActionKind, args[2] as number | null), a[3]);
				return null;
			case 'act_seat':
				table.actSeat(a[0], Action.of(args[1] as ActionKind, args[2] as number | null));
				return null;
			case 'time_out': {
				const action = table.timeOut();
				return { kind: action.kind, amount: action.amount };
			}
			case 'check_clock':
				return table.checkClock();
			default:
				throw new Error(`unknown request ${name}`);
		}
	}

	/** Everything a request did, in the shape Python's driver writes. */
	document(op: Op): Record<string, unknown> {
		let result: unknown;
		try {
			result = { ok: this.apply(op) };
		} catch (error) {
			if (!(error instanceof TableError)) throw error;
			result = { error: error.code };
		}
		const table = this.table;
		const events = table.drainEvents().map((e) => ({ seq: e.seq, kind: e.kind, data: e.data }));
		const finished = table.drainFinished().map((f) => ({
			hand_no: f.handNo,
			seats: f.seats.map((s) => s && { player_id: s.playerId, name: s.name, bot: s.bot }),
			record: handRecord(f.state)
		}));
		const departures = table.drainDepartures().map(departureDoc);
		const players = table.players();
		return {
			result,
			events,
			finished,
			departures,
			reads: {
				can_start: table.canStart(),
				hand_in_progress: table.handInProgress,
				to_act: table.toAct,
				dealt_in_next: table.dealtInNext(),
				free_seats: table.freeSeats(),
				bot_seats: table.botSeats(),
				people: table.people(),
				reservation_deadline: table.reservationDeadline(),
				stacks: players.map(([seat]) => [seat, table.stackOf(seat)]),
				in_hand: players.filter(([seat]) => table.inHand(seat)).map(([seat]) => seat)
			},
			snapshot: tableToDict(table) as Json
		};
	}
}

export interface Difference {
	seed: number;
	/** The index of the first request whose document differs. */
	index: number;
	op: Op;
	/** The TypeScript table's document for that request. */
	document: Record<string, unknown>;
	/** Python's, when the sequence was written with `--full`. */
	expected?: unknown;
}

/** Replay a sequence. Returns the first difference, or null when every digest matches. */
export function replaySequence(sequence: Sequence): Difference | null {
	const driver = new Driver(sequence.config, sequence.start, sequence.deal_seed);
	for (let index = 0; index < sequence.ops.length; index++) {
		const op = sequence.ops[index];
		const document = driver.document(op);
		if (digest(document) !== sequence.digests[index]) {
			return { seed: sequence.seed, index, op, document, expected: sequence.documents?.[index] };
		}
	}
	return null;
}

/** Where two documents first differ, as a path and the two values. */
export function firstDifference(ours: unknown, theirs: unknown, path = ''): string | null {
	if (canonical(ours) === canonical(theirs)) return null;
	const bothObjects =
		typeof ours === 'object' && ours !== null && typeof theirs === 'object' && theirs !== null;
	if (bothObjects && Array.isArray(ours) === Array.isArray(theirs)) {
		const a = ours as Record<string, unknown>;
		const b = theirs as Record<string, unknown>;
		for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
			const found = firstDifference(a[key], b[key], path ? `${path}.${key}` : key);
			if (found !== null) return found;
		}
	}
	return `${path || 'document'}: ts ${canonical(ours)} != python ${canonical(theirs)}`;
}

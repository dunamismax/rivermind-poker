// A no-limit cash table: seats, buy-ins and hands on the TypeScript engine.
// A port of rivermind/server/table.py (P4B.5b), which stays the reference
// until the cutover: scripts/table-parity.ts replays Python's tables and
// compares every event and snapshot.
//
// `Table` is synchronous and deterministic. It owns the seats and the hand in
// progress, applies every change and records each one as a public `TableEvent`
// with a sequence number. It never sleeps, never decides for bots and takes
// randomness only from its caller, so tests drive it directly. `TableRunner`
// (runner.ts) runs a table, asks bots for decisions and starts hands.
//
// Seating follows docs/rules.md:
//
// - A player is dealt in when seated, not sitting out and holding chips
//   (rule 2.1). A hand can start whenever at least two players are dealt in.
// - A player who sits down or comes back is dealt in from the next hand, with
//   no missed-blind charges (rule 2.2).
// - Leaving or sitting out takes effect between hands. A player who leaves
//   during a hand they are in folds when their turn comes, and their seat
//   frees up when the hand ends (rule 2.3).
// - The button moves as rule 5.2 says (`nextButton`).
//
// Buy-ins and rebuys keep a stack between the table's minimum and maximum
// buy-in. A rebuy asked for during a hand the player is in is added when the
// hand ends. Chips are play money only (D-1).
//
// Every turn has a clock (rule 13). The player to act has `actionSeconds`,
// then their time bank, which starts at `timeBankSeconds` and regains
// `bankRefillSeconds` per hand they are dealt into. A disconnected player
// gets the action time only. When the time runs out `checkClock` checks for
// them if that is free and folds otherwise. A player who is absent for a full
// orbit is sat out. The table reads the time from the `clock` it is given.
//
// Seats can be held (rule 2.4). `reserve` holds a seat for a player for
// `RESERVE_SECONDS` while they buy in: an empty seat, or a bot's seat, which
// the bot gives up at once between hands or when the hand it is playing ends.
// Only the holder can sit in a held seat. When no seat is free or held by a
// bot, a player can join the `waitlist`; `settleSeats` expires old holds and
// offers each free seat to the first player waiting.

import { cardStr } from '../../engine/cards.ts';
import type { Random } from '../engine/random.ts';
import { initialButton, nextButton } from '../engine/seating.ts';
import {
	Action,
	apply,
	handConfig,
	IllegalActionError,
	isOver,
	legalActions,
	numSeats,
	potTotal,
	startHand,
	STREET_LABELS,
	timeoutAction,
	finalStacks,
	type HandConfig,
	type HandState
} from '../engine/state.ts';
import { seatView, type SeatView } from '../engine/view.ts';

export const DEFAULT_MIN_BUY_IN_BB = 40;
export const DEFAULT_MAX_BUY_IN_BB = 100;
/** How long a held seat waits for its player to buy in (rule 2.4). */
export const RESERVE_SECONDS = 60;

/** Why a table refused a request. Clients branch on these codes. */
export type TableErrorCode =
	| 'bad_request'
	| 'unknown_seat'
	| 'seat_taken'
	| 'already_seated'
	| 'not_seated'
	| 'bad_buy_in'
	| 'not_your_turn'
	| 'stale'
	| 'illegal_action'
	| 'hand_over'
	| 'hand_in_progress'
	/** The table has closed (a request that reached its runner too late). */
	| 'unknown_table';

/** A request the table refused. The table is unchanged. */
export class TableError extends Error {
	override name = 'TableError';
	readonly code: TableErrorCode;

	constructor(code: TableErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

/** A table's stakes and size. Buy-ins default to 40 and 100 big blinds. */
export interface TableConfig {
	readonly seatCount: number;
	readonly smallBlind: number;
	readonly bigBlind: number;
	readonly ante: number;
	readonly minBuyIn: number;
	readonly maxBuyIn: number;
	readonly actionSeconds: number;
	readonly timeBankSeconds: number;
	readonly bankRefillSeconds: number;
}

export interface TableConfigOptions {
	seatCount: number;
	smallBlind: number;
	bigBlind: number;
	ante?: number;
	/** 0 or missing: 40 big blinds. */
	minBuyIn?: number;
	/** 0 or missing: 100 big blinds. */
	maxBuyIn?: number;
	actionSeconds?: number;
	timeBankSeconds?: number;
	bankRefillSeconds?: number;
}

/** A checked {@link TableConfig}. Throws `RangeError` or `TypeError` for bad values. */
export function tableConfig(options: TableConfigOptions): TableConfig {
	const { seatCount, smallBlind, bigBlind } = options;
	const ante = options.ante ?? 0;
	if (!Number.isInteger(seatCount) || seatCount < 2 || seatCount > 9) {
		throw new RangeError('a table has 2 to 9 seats');
	}
	const hand = handConfig(smallBlind, bigBlind, ante); // validates the stakes
	const minBuyIn = options.minBuyIn || DEFAULT_MIN_BUY_IN_BB * hand.bigBlind;
	const maxBuyIn = options.maxBuyIn || DEFAULT_MAX_BUY_IN_BB * hand.bigBlind;
	for (const [name, value] of [
		['min_buy_in', minBuyIn],
		['max_buy_in', maxBuyIn]
	] as const) {
		if (!Number.isInteger(value)) throw new TypeError(`${name} must be an int`);
	}
	if (!(0 < minBuyIn && minBuyIn <= maxBuyIn)) {
		throw new RangeError('buy-ins must satisfy 0 < minimum <= maximum');
	}
	const actionSeconds = options.actionSeconds ?? 20;
	const timeBankSeconds = options.timeBankSeconds ?? 30;
	const bankRefillSeconds = options.bankRefillSeconds ?? 2;
	for (const value of [actionSeconds, timeBankSeconds, bankRefillSeconds]) {
		if (typeof value !== 'number' || Number.isNaN(value)) {
			throw new TypeError('clock settings must be numbers');
		}
	}
	if (!(actionSeconds > 0)) throw new RangeError('the action clock must be positive');
	if (timeBankSeconds < 0 || bankRefillSeconds < 0) {
		throw new RangeError('the time bank and its refill must not be negative');
	}
	return Object.freeze({
		seatCount,
		smallBlind,
		bigBlind,
		ante,
		minBuyIn,
		maxBuyIn,
		actionSeconds,
		timeBankSeconds,
		bankRefillSeconds
	});
}

export function handConfigOf(config: TableConfig): HandConfig {
	return handConfig(config.smallBlind, config.bigBlind, config.ante);
}

/**
 * Someone in a seat. `stack` is the stack between hands; during a hand the
 * engine state holds the live stack, and `Table.stackOf` gives the current
 * one either way.
 */
export interface Player {
	playerId: string;
	name: string;
	stack: number;
	/** The bot kind for a bot seat, null for a person (D-7). */
	bot: string | null;
	sittingOut: boolean;
	/** Sit out when the current hand ends. */
	sitOutNext: boolean;
	/** Leave when the current hand ends, folding at every turn until then. */
	leaving: boolean;
	/** Chips to add when the current hand ends. */
	pendingRebuy: number;
	timeBank: number;
	connected: boolean;
	/** Hands in a row the player was dealt into but was away for. */
	absentHands: number;
	actedThisHand: boolean;
	timedOutThisHand: boolean;
	disconnectedThisHand: boolean;
}

export function newPlayer(
	playerId: string,
	name: string,
	stack: number,
	bot: string | null = null,
	timeBank = 0
): Player {
	return {
		playerId,
		name,
		stack,
		bot,
		sittingOut: false,
		sitOutNext: false,
		leaving: false,
		pendingRebuy: 0,
		timeBank,
		connected: true,
		absentHands: 0,
		actedThisHand: false,
		timedOutThisHand: false,
		disconnectedThisHand: false
	};
}

/** Who played a seat in a finished hand (P4.6). */
export interface HandSeat {
	readonly playerId: string;
	readonly name: string;
	readonly bot: string | null;
}

/** A hand that ended, with who was dealt into each seat (null for seats not dealt in). */
export interface Finished {
	readonly handNo: number;
	readonly state: HandState;
	readonly seats: readonly (HandSeat | null)[];
}

export type EventData = Record<string, unknown>;

/** A public change at the table. `seq` increases by one per event. */
export interface TableEvent {
	readonly seq: number;
	readonly kind: string;
	readonly data: EventData;
}

/** The clock for the player to act. */
export interface Turn {
	readonly seat: number;
	/** The seq of the event that started the turn. */
	readonly seq: number;
	readonly started: number;
	/** When the action time runs out; after it the time bank runs. */
	readonly deadline: number;
	/** When the time bank runs out too and the player is timed out. */
	readonly final: number;
}

/** A seat held for a player while they buy in (rule 2.4). */
export interface Reservation {
	playerId: string;
	name: string;
	/** When the hold runs out; null while a bot plays out the hand before giving up the seat. */
	until: number | null;
	/** The bot that gives up the seat when the current hand ends. */
	bot: string | null;
}

/** A player on the waitlist. */
export interface Waiting {
	readonly playerId: string;
	readonly name: string;
}

/**
 * Chips that went back from the table to a player's wallet (P4.2).
 *
 * `left` is set when the player left, taking `chips`: their stack and any
 * rebuy still waiting. Otherwise the player stays and `chips` is the part of a
 * waiting rebuy that no longer fit the buy-in range when the hand ended.
 */
export interface Departure {
	readonly playerId: string;
	readonly seat: number;
	readonly chips: number;
	readonly left: boolean;
	readonly bot: boolean;
}

const wallClock = (): number => Date.now() / 1000;

/** What the seat to act may do, in words, for the message of a refused action. */
export function describeLegal(hand: HandState): string {
	const legal = legalActions(hand);
	const options: string[] = [];
	if (legal.canCheck) options.push('check');
	if (legal.call) options.push(`call ${legal.call}`);
	if (legal.raiseKind !== null) {
		const verb = legal.raiseKind === 'bet' ? 'bet' : 'raise to';
		options.push(
			legal.minTo === legal.maxTo
				? `${verb} ${legal.minTo}`
				: `${verb} ${legal.minTo} to ${legal.maxTo}`
		);
	}
	if (legal.canFold) options.push('fold');
	if (options.length < 2) return `you may ${options[0] ?? 'wait'}`;
	return `you may ${options.slice(0, -1).join(', ')} or ${options[options.length - 1]}`;
}

/** One cash table. Every method either applies a whole change or throws `TableError`. */
export class Table {
	readonly config: TableConfig;
	readonly clock: () => number;
	/** The clock of the player to act, while a hand is in progress. */
	turn: Turn | null = null;
	seats: (Player | null)[];
	/** The current hand, or the last one once it is over, until the next starts. */
	hand: HandState | null = null;
	/** The player id in each seat when `hand` was dealt. */
	handPlayers: (string | null)[];
	handNo = 0;
	/** The button seat of the last hand dealt. */
	button: number | null = null;
	seq = 0;
	/** Events not yet taken with `drainEvents`. */
	events: TableEvent[] = [];
	/** Finished hands not yet taken with `drainFinished`. */
	finished: Finished[] = [];
	/** Players who left, not yet taken with `drainDepartures`. */
	departures: Departure[] = [];
	/** Held seats by seat number (rule 2.4). */
	reservations = new Map<number, Reservation>();
	/** Players waiting for a seat, first come first served. */
	waitlist: Waiting[] = [];

	constructor(config: TableConfig, clock: () => number = wallClock) {
		this.config = config;
		this.clock = clock;
		this.seats = new Array<Player | null>(config.seatCount).fill(null);
		this.handPlayers = new Array<string | null>(config.seatCount).fill(null);
	}

	// Reading the table

	get handInProgress(): boolean {
		return this.hand !== null && !isOver(this.hand);
	}

	/** The occupied seats, in seat order. */
	players(): [seat: number, player: Player][] {
		const found: [number, Player][] = [];
		this.seats.forEach((player, seat) => {
			if (player !== null) found.push([seat, player]);
		});
		return found;
	}

	seatOf(playerId: string): number | null {
		const seat = this.seats.findIndex((player) => player?.playerId === playerId);
		return seat === -1 ? null : seat;
	}

	/** Whether `seat` was dealt into the hand in progress. */
	inHand(seat: number): boolean {
		const hand = this.hand;
		return hand !== null && !isOver(hand) && hand.dealtIn[seat] === true;
	}

	/** The seat's chips behind right now, including during a hand. */
	stackOf(seat: number): number {
		const player = this.seats[seat] ?? null;
		if (player === null) throw new TableError('unknown_seat', `S${seat} is empty`);
		if (this.inHand(seat)) return (this.hand as HandState).stacks[seat];
		return player.stack;
	}

	/**
	 * What the seat has put into the hand in progress: nothing between hands. A table that
	 * closes mid-hand owes it back with the stack, since the hand is never finished.
	 */
	inPotOf(seat: number): number {
		return this.inHand(seat) ? (this.hand as HandState).contributions[seat] : 0;
	}

	/** Seats that would be dealt into a hand started now (rule 2.1). */
	dealtInNext(): number[] {
		return this.players()
			.filter(([, player]) => !player.sittingOut && !player.leaving && player.stack > 0)
			.map(([seat]) => seat);
	}

	canStart(): boolean {
		return !this.handInProgress && this.dealtInNext().length >= 2;
	}

	get toAct(): number | null {
		return this.handInProgress ? (this.hand as HandState).toAct : null;
	}

	/** The engine's private view of the current or last hand for `seat`. */
	view(seat: number): SeatView | null {
		return this.hand === null ? null : seatView(this.hand, seat);
	}

	// Seating

	private seated(playerId: string): [number, Player] {
		const seat = this.seatOf(playerId);
		if (seat === null) throw new TableError('not_seated', `${playerId} is not seated here`);
		return [seat, this.seats[seat] as Player];
	}

	private isSeat(seat: unknown): seat is number {
		return (
			Number.isInteger(seat) && (seat as number) >= 0 && (seat as number) < this.config.seatCount
		);
	}

	/** Seat a player with a buy-in. They are dealt in from the next hand. */
	sit(
		seat: number,
		playerId: string,
		name: string,
		buyIn: number,
		bot: string | null = null
	): void {
		if (!this.isSeat(seat))
			throw new TableError('unknown_seat', `there is no seat ${String(seat)}`);
		if (!playerId || !name) throw new TableError('bad_request', 'a player needs an id and a name');
		if (this.seatOf(playerId) !== null) {
			throw new TableError('already_seated', `${playerId} already has a seat here`);
		}
		if (this.seats[seat] !== null) throw new TableError('seat_taken', `S${seat} is taken`);
		const held = this.reservations.get(seat);
		if (held !== undefined && held.playerId !== playerId) {
			throw new TableError('seat_taken', `S${seat} is held for another player`);
		}
		this.checkBuyIn(buyIn, 0);
		this.seats[seat] = newPlayer(playerId, name, buyIn, bot, this.config.timeBankSeconds);
		// A player who sits anywhere gives up any other hold and their place in line.
		for (const [other, hold] of [...this.reservations]) {
			if (hold.playerId === playerId) this.reservations.delete(other);
		}
		this.waitlist = this.waitlist.filter((w) => w.playerId !== playerId);
		this.emit('seated', { seat, name, bot, stack: buyIn });
	}

	private checkBuyIn(amount: number, stack: number): void {
		const { minBuyIn: low, maxBuyIn: high } = this.config;
		if (!Number.isInteger(amount) || amount <= 0) {
			throw new TableError('bad_buy_in', 'a buy-in is a positive whole number of chips');
		}
		if (!(low <= stack + amount && stack + amount <= high)) {
			throw new TableError(
				'bad_buy_in',
				`the stack after buying in must be ${low} to ${high} chips; it would be ${stack + amount}`
			);
		}
	}

	/**
	 * Leave now, or when the current hand ends if the player is in it.
	 * Returns the departure when the seat is freed at once, otherwise null.
	 */
	leave(playerId: string): Departure | null {
		const [seat, player] = this.seated(playerId);
		if (!this.inHand(seat)) return this.remove(seat);
		if (!player.leaving) {
			player.leaving = true;
			this.emit('leaving', { seat });
			this.foldAbsent();
		}
		return null;
	}

	/** Sit out now, or when the current hand ends if the player is in it. */
	sitOut(playerId: string): void {
		const [seat, player] = this.seated(playerId);
		if (player.sittingOut || player.sitOutNext) return;
		if (this.inHand(seat)) {
			player.sitOutNext = true;
			this.emit('sitting_out_next', { seat });
		} else {
			player.sittingOut = true;
			this.emit('sat_out', { seat, reason: 'asked' });
		}
	}

	/** Come back from sitting out; dealt in from the next hand (rule 2.2). */
	sitIn(playerId: string): void {
		const [seat, player] = this.seated(playerId);
		if (player.leaving)
			throw new TableError('bad_request', 'a player who is leaving cannot sit in');
		if (!(player.sittingOut || player.sitOutNext)) return;
		player.sittingOut = false;
		player.sitOutNext = false;
		this.emit('sat_in', { seat });
	}

	/** Record that the player's connection dropped or came back (rule 13.2). */
	setConnected(playerId: string, connected: boolean): void {
		const [seat, player] = this.seated(playerId);
		if (player.connected === connected) return;
		player.connected = connected;
		if (!connected && this.inHand(seat)) player.disconnectedThisHand = true;
		if (connected) player.absentHands = 0;
		this.emit(connected ? 'connected' : 'disconnected', { seat });
		if (this.turn !== null && this.turn.seat === seat) this.startTurn(true);
	}

	/**
	 * Add chips, keeping the stack within the buy-in range. During a hand the
	 * player is in, the chips are added when it ends.
	 */
	rebuy(playerId: string, amount: number): void {
		const [seat, player] = this.seated(playerId);
		if (player.leaving) throw new TableError('bad_request', 'a player who is leaving cannot rebuy');
		if (this.inHand(seat)) {
			// The stack at the end of the hand is not known yet. Check against
			// the chips behind now, and fit the rebuy to the range when it is added.
			if (!Number.isInteger(amount) || amount <= 0) {
				throw new TableError('bad_buy_in', 'a rebuy is a positive whole number of chips');
			}
			const behind = (this.hand as HandState).stacks[seat];
			if (player.pendingRebuy + amount + behind > this.config.maxBuyIn) {
				throw new TableError(
					'bad_buy_in',
					`the stack after a rebuy must be at most ${this.config.maxBuyIn} chips`
				);
			}
			player.pendingRebuy += amount;
			this.emit('rebuy_pending', { seat, amount });
			return;
		}
		this.checkBuyIn(amount, player.stack);
		player.stack += amount;
		this.emit('rebought', { seat, amount, stack: player.stack });
	}

	private remove(seat: number): Departure {
		const player = this.seats[seat] as Player;
		this.seats[seat] = null;
		// A rebuy that never reached the table goes back too.
		const chips = player.stack + player.pendingRebuy;
		const departure: Departure = {
			playerId: player.playerId,
			seat,
			chips,
			left: true,
			bot: player.bot !== null
		};
		this.departures.push(departure);
		this.emit('left', { seat, stack: chips });
		return departure;
	}

	// Held seats and the waitlist (rule 2.4)

	/** The seat held for `playerId`, if any. */
	reservationOf(playerId: string): number | null {
		for (const [seat, hold] of this.reservations) {
			if (hold.playerId === playerId) return seat;
		}
		return null;
	}

	/** The player's place on the waitlist, counting from 1. */
	waitlistPosition(playerId: string): number | null {
		const index = this.waitlist.findIndex((w) => w.playerId === playerId);
		return index === -1 ? null : index + 1;
	}

	/** Empty seats nobody holds. */
	freeSeats(): number[] {
		const free: number[] = [];
		this.seats.forEach((player, seat) => {
			if (player === null && !this.reservations.has(seat)) free.push(seat);
		});
		return free;
	}

	/** Bots' seats nobody holds, which a player can claim. */
	botSeats(): number[] {
		return this.players()
			.filter(([seat, player]) => player.bot !== null && !this.reservations.has(seat))
			.map(([seat]) => seat);
	}

	people(): number {
		return this.players().filter(([, player]) => player.bot === null).length;
	}

	/** Held seats in seat order. */
	holds(): [seat: number, hold: Reservation][] {
		return [...this.reservations].sort(([a], [b]) => a - b);
	}

	/** When the next hold runs out. */
	reservationDeadline(): number | null {
		let soonest: number | null = null;
		for (const hold of this.reservations.values()) {
			if (hold.until !== null && (soonest === null || hold.until < soonest)) soonest = hold.until;
		}
		return soonest;
	}

	/**
	 * Hold a seat for `playerId` while they buy in. Returns the seat.
	 *
	 * Without a `seat`, a seat the player already holds, else an empty seat,
	 * else a bot's. A bot gives up its seat at once between hands and when its
	 * hand ends otherwise; the hold's time starts then. Holding a new seat gives
	 * up the player's old hold and their place in line.
	 */
	reserve(playerId: string, name: string, seat: number | null = null): number {
		if (!playerId || !name) throw new TableError('bad_request', 'a player needs an id and a name');
		if (this.seatOf(playerId) !== null) {
			throw new TableError('already_seated', `${playerId} already has a seat here`);
		}
		const current = this.reservationOf(playerId);
		if (seat === null) {
			if (current !== null) return current;
			const free = this.freeSeats();
			const bots = this.botSeats();
			if (!free.length && !bots.length) {
				throw new TableError('seat_taken', 'every seat is taken; join the waitlist');
			}
			// Prefer a bot that is not in the hand, so the player can sit at once.
			const idle = bots.filter((s) => !this.inHand(s));
			seat = free.length ? free[0] : (idle.length ? idle : bots)[0];
		}
		if (!this.isSeat(seat))
			throw new TableError('unknown_seat', `there is no seat ${String(seat)}`);
		if (seat === current) return seat;
		if (this.reservations.has(seat)) {
			throw new TableError('seat_taken', `S${seat} is held for another player`);
		}
		const occupant = this.seats[seat];
		if (occupant !== null && occupant.bot === null) {
			throw new TableError('seat_taken', `S${seat} is taken`);
		}
		if (current !== null) this.release(current, 'moved');
		this.waitlist = this.waitlist.filter((w) => w.playerId !== playerId);
		const hold: Reservation = { playerId, name, until: null, bot: null };
		this.reservations.set(seat, hold);
		this.emit('reserved', { seat, name });
		if (occupant !== null && this.inHand(seat)) {
			hold.bot = occupant.playerId;
		} else {
			if (occupant !== null) this.remove(seat);
			hold.until = this.clock() + RESERVE_SECONDS;
		}
		return seat;
	}

	/** Give up the player's hold, if any. A bot that was to leave stays. */
	cancelReservation(playerId: string): void {
		const seat = this.reservationOf(playerId);
		if (seat !== null) this.release(seat, 'cancelled');
	}

	private release(seat: number, reason: string): void {
		this.reservations.delete(seat);
		this.emit('reservation_ended', { seat, reason });
	}

	/** Wait for a seat at a full table. Returns the player's place in line. */
	joinWaitlist(playerId: string, name: string): number {
		if (!playerId || !name) throw new TableError('bad_request', 'a player needs an id and a name');
		if (this.seatOf(playerId) !== null) {
			throw new TableError('already_seated', `${playerId} already has a seat here`);
		}
		if (this.reservationOf(playerId) !== null) {
			throw new TableError('bad_request', 'a seat is already held for you');
		}
		const place = this.waitlistPosition(playerId);
		if (place !== null) return place;
		if (this.freeSeats().length || this.botSeats().length) {
			throw new TableError('bad_request', 'a seat is free; take it instead');
		}
		this.waitlist.push({ playerId, name });
		this.emit('waitlist', { count: this.waitlist.length });
		return this.waitlist.length;
	}

	leaveWaitlist(playerId: string): void {
		if (this.waitlistPosition(playerId) === null) return;
		this.waitlist = this.waitlist.filter((w) => w.playerId !== playerId);
		this.emit('waitlist', { count: this.waitlist.length });
	}

	/** Expire holds whose time ran out and offer free seats to the waitlist, in order. */
	settleSeats(): void {
		const now = this.clock();
		for (const [seat, hold] of this.holds()) {
			if (hold.until !== null && now >= hold.until) this.release(seat, 'expired');
		}
		for (const seat of this.freeSeats()) {
			const waiting = this.waitlist.shift();
			if (waiting === undefined) break;
			this.reservations.set(seat, {
				playerId: waiting.playerId,
				name: waiting.name,
				until: now + RESERVE_SECONDS,
				bot: null
			});
			this.emit('reserved', { seat, name: waiting.name });
			this.emit('waitlist', { count: this.waitlist.length });
		}
	}

	// Hands

	/** Deal the next hand. `rng` picks the button for the first hand, then shuffles. */
	startHand(rng: Random): HandState {
		if (this.handInProgress) {
			throw new TableError('hand_in_progress', 'a hand is already in progress');
		}
		const dealt = this.dealtInNext();
		if (dealt.length < 2) {
			throw new TableError('bad_request', 'a hand needs at least two players dealt in');
		}
		const stacks = new Array<number | null>(this.config.seatCount).fill(null);
		for (const seat of dealt) stacks[seat] = (this.seats[seat] as Player).stack;
		const button =
			this.button === null
				? initialButton(dealt, rng)
				: nextButton(this.button, new Set(dealt), this.config.seatCount);
		const state = startHand(handConfigOf(this.config), stacks, button, { rng });
		for (const seat of dealt) {
			const player = this.seats[seat] as Player;
			player.actedThisHand = false;
			player.timedOutThisHand = false;
			player.disconnectedThisHand = !player.connected;
			player.timeBank = Math.min(
				this.config.timeBankSeconds,
				player.timeBank + this.config.bankRefillSeconds
			);
		}
		this.hand = state;
		this.handPlayers = this.seats.map((p) => p?.playerId ?? null);
		this.handNo += 1;
		this.button = button;
		this.emit('hand_started', {
			hand_no: this.handNo,
			button,
			small_blind_seat: state.smallBlindSeat,
			big_blind_seat: state.bigBlindSeat,
			dealt_in: state.dealtIn.flatMap((dealtIn, seat) => (dealtIn ? [seat] : [])),
			stacks: [...state.startingStacks],
			posts: state.posts.map((p) => ({
				seat: p.seat,
				kind: p.kind,
				amount: p.amount,
				all_in: p.allIn
			}))
		});
		this.afterChange(null, state);
		return state;
	}

	/**
	 * Apply the player's action. Only the seat to act may act.
	 *
	 * With `seq`, the seq of the state the player saw, an action meant for an
	 * earlier turn is refused as stale rather than applied to this one.
	 */
	act(playerId: string, action: Action, seq: number | null = null): void {
		const [seat] = this.seated(playerId);
		const hand = this.hand;
		if (hand !== null && !isOver(hand) && hand.toAct === seat && seq !== null) {
			if (this.turn !== null && seq < this.turn.seq) {
				throw new TableError(
					'stale',
					`that action was for an earlier turn (seq ${seq} < ${this.turn.seq})`
				);
			}
		}
		this.actSeat(seat, action);
	}

	/** Apply an action for `seat`, charging any time past the action clock to its bank. */
	actSeat(seat: number, action: Action, timedOut = false): void {
		const hand = this.hand;
		if (hand === null || isOver(hand)) {
			throw new TableError('hand_over', 'there is no hand in progress');
		}
		if (hand.toAct !== seat) {
			throw new TableError('not_your_turn', `it is S${hand.toAct}'s turn, not S${seat}'s`);
		}
		let after: HandState;
		try {
			after = apply(hand, action);
		} catch (error) {
			if (!(error instanceof IllegalActionError)) throw error;
			throw new TableError('illegal_action', `That is not allowed now: ${describeLegal(hand)}.`);
		}
		const player = this.seats[seat] as Player;
		const turn = this.turn;
		if (timedOut) {
			player.timedOutThisHand = true;
			if (player.connected) player.timeBank = 0;
		} else {
			player.actedThisHand = true;
			player.absentHands = 0;
			if (turn !== null && turn.seat === seat) {
				const over = this.clock() - turn.deadline;
				if (over > 0) player.timeBank = Math.max(0, player.timeBank - over);
			}
		}
		this.turn = null;
		this.hand = after;
		this.afterChange(hand, after);
		this.foldAbsent();
	}

	/** Rule 13.1: the seat to act checks if it can, otherwise folds. */
	timeOut(): Action {
		const hand = this.hand;
		if (hand === null || isOver(hand) || hand.toAct === null) {
			throw new TableError('hand_over', 'there is no hand in progress');
		}
		const action = timeoutAction(hand);
		this.emit('timed_out', { seat: hand.toAct });
		this.actSeat(hand.toAct, action, true);
		return action;
	}

	/** Time out the player to act if their time has run out. Returns whether it did. */
	checkClock(): boolean {
		const turn = this.turn;
		if (turn === null || !this.handInProgress || this.clock() < turn.final) return false;
		this.timeOut();
		return true;
	}

	private startTurn(keepStart = false): void {
		const seat = this.toAct;
		if (seat === null) {
			this.turn = null;
			return;
		}
		const player = this.seats[seat] as Player;
		const kept = keepStart && this.turn !== null && this.turn.seat === seat ? this.turn : null;
		const started = kept !== null ? kept.started : this.clock();
		const deadline = started + this.config.actionSeconds;
		const final = deadline + (player.connected ? player.timeBank : 0);
		let seq: number;
		if (kept !== null) {
			seq = kept.seq;
		} else {
			this.emit('turn', { seat, started, deadline, final });
			seq = this.seq;
		}
		this.turn = { seat, seq, started, deadline, final };
	}

	/** Fold for players who have left, whenever their turn comes (rule 2.3). */
	private foldAbsent(): void {
		while (this.handInProgress) {
			const before = this.hand as HandState;
			const seat = before.toAct as number;
			const player = this.seats[seat];
			if (player === null || !player.leaving) return;
			// A player who is leaving never puts in more chips; checking costs nothing.
			const action = legalActions(before).canCheck ? Action.check() : Action.fold();
			this.turn = null;
			this.hand = apply(before, action);
			this.afterChange(before, this.hand);
		}
	}

	private afterChange(before: HandState | null, after: HandState): void {
		if (before !== null && after.actions.length > before.actions.length) {
			const record = after.actions[after.actions.length - 1];
			this.emit('action', {
				seat: record.seat,
				street: STREET_LABELS[record.street],
				action: record.kind,
				to: record.to,
				added: record.added,
				all_in: record.allIn,
				pot: potTotal(after)
			});
		}
		const shown = before !== null ? before.board.length : 0;
		if (after.board.length > shown) {
			this.emit('board', {
				street: STREET_LABELS[after.street],
				cards: after.board.slice(shown).map(cardStr),
				board: after.board.map(cardStr)
			});
		}
		if (isOver(after)) {
			this.turn = null;
			this.finishHand(after);
		} else if (this.turn === null || this.turn.seat !== after.toAct) {
			this.startTurn();
		}
	}

	private finishHand(final: HandState): void {
		const result = final.result;
		if (result === null) throw new Error('the hand is not over');
		const seatCount = numSeats(final);
		for (let seat = 0; seat < seatCount; seat++) {
			if (final.dealtIn[seat]) (this.seats[seat] as Player).stack = final.stacks[seat];
		}
		this.emit('hand_ended', {
			hand_no: this.handNo,
			uncalled:
				result.uncalled === null ? null : { seat: result.uncalled[0], amount: result.uncalled[1] },
			pots: result.pots.map((p) => ({
				amount: p.amount,
				eligible: [...p.eligible],
				winners: [...p.winners],
				shares: [...p.shares]
			})),
			showdown: result.showdown,
			shown: result.shown.flatMap((s) => {
				const hole = final.holeCards[s];
				return hole === null ? [] : [{ seat: s, cards: hole.map(cardStr) }];
			}),
			mucked: [...result.mucked],
			winnings: [...result.winnings],
			stacks: finalStacks(final)
		});
		const seats: (HandSeat | null)[] = [];
		for (let seat = 0; seat < seatCount; seat++) {
			const player = final.dealtIn[seat] ? this.seats[seat] : null;
			seats.push(
				player === null ? null : { playerId: player.playerId, name: player.name, bot: player.bot }
			);
		}
		this.finished.push({ handNo: this.handNo, state: final, seats });
		const orbit = final.dealtIn.filter(Boolean).length;
		for (const [seat, player] of this.players()) {
			if (!final.dealtIn[seat] || player.bot !== null) continue;
			const away = !player.connected || player.disconnectedThisHand || player.timedOutThisHand;
			if (player.actedThisHand || !away) {
				player.absentHands = 0;
			} else {
				player.absentHands += 1;
				if (player.absentHands >= orbit && !player.sittingOut) player.sitOutNext = true;
			}
		}
		for (const [seat, player] of this.players()) {
			if (player.leaving) {
				this.remove(seat);
				continue;
			}
			const hold = this.reservations.get(seat);
			if (hold !== undefined && hold.bot === player.playerId) {
				// The bot gives up the seat it was holding for a player (rule 2.4).
				this.remove(seat);
				hold.bot = null;
				hold.until = this.clock() + RESERVE_SECONDS;
				continue;
			}
			if (player.pendingRebuy) {
				const requested = player.pendingRebuy;
				let amount = requested;
				player.pendingRebuy = 0;
				try {
					this.checkBuyIn(amount, player.stack);
				} catch (error) {
					if (!(error instanceof TableError)) throw error;
					// Still within the maximum: add what fits, if that reaches the minimum.
					amount = Math.min(amount, this.config.maxBuyIn - player.stack);
					if (amount <= 0 || player.stack + amount < this.config.minBuyIn) amount = 0;
				}
				if (amount < requested) {
					this.departures.push({
						playerId: player.playerId,
						seat,
						chips: requested - amount,
						left: false,
						bot: player.bot !== null
					});
					if (!amount) this.emit('rebuy_dropped', { seat, amount: requested });
				}
				if (amount) {
					player.stack += amount;
					this.emit('rebought', { seat, amount, stack: player.stack });
				}
			}
			if (player.sitOutNext) {
				player.sitOutNext = false;
				player.sittingOut = true;
				const away = player.absentHands >= orbit;
				player.absentHands = 0;
				this.emit('sat_out', { seat, reason: away ? 'away' : 'asked' });
			}
		}
	}

	// Events

	private emit(kind: string, data: EventData): void {
		this.seq += 1;
		this.events.push({ seq: this.seq, kind, data });
	}

	drainEvents(): TableEvent[] {
		const events = this.events;
		this.events = [];
		return events;
	}

	drainFinished(): Finished[] {
		const finished = this.finished;
		this.finished = [];
		return finished;
	}

	drainDepartures(): Departure[] {
		const departures = this.departures;
		this.departures = [];
		return departures;
	}
}

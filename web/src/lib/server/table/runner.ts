// Tables as running tasks: a port of rivermind/server/runner.py (P4B.5b).
//
// A `TableRunner` owns one `Table`. Its loop deals a new hand whenever at
// least two players are dealt in, asks bots for their decisions and waits for
// people to act. Every change, whether from a player request or from the loop
// itself, happens under the runner's lock, so changes are applied one at a
// time and published in order. Publishing runs the `beforePublish` hooks,
// which save the table so nothing is shown before it is safe, then hands the
// table's new events to each listener.
//
// A change, once started, is applied, saved, accounted for and published as
// one unit. Nothing can cancel it part-way: a socket that closes or a request
// whose client went away only stops reading the answer. Add new runner
// requests through `change`, never as a bare `lock.run` around a table call.
//
// Bots decide on the event loop: the simple bots and the blueprint answer in
// microseconds. A policy may also return a promise; one that has not answered
// by its turn's deadline is timed out like a person. If the table changed
// while a bot was deciding, its decision is dropped and it is asked again.
//
// Live tables shuffle with the operating system's cryptographic randomness
// (D-8, `cryptoDealer`). Tests pass a seeded generator, an instant `sleep`
// and a `ManualClock`.
//
// Each runner also keeps the table's lobby settings (P4.3): whether it is
// private, its invite code, and the kind of bot that `fill` puts in empty
// seats. After every change the runner settles held seats (rule 2.4) and,
// while a person is at the table, fills each free seat nobody is waiting for
// with a bot. It wakes when a hold runs out as it does for a turn's deadline.
//
// A practice table (P6.0b) belongs to one guest, named by `practice`. Its
// chips never come from or go back to a wallet: `refill` gives a guest who
// ran out a fresh practice stack, and `switchBot` changes the opponent between
// hands (P5.7a).
//
// A policy that remembers hands gives each table its own copy (`forTable`).
// A saved table whose bot this server does not run, such as the trained bot
// after its bundle went missing or after a rollback, plays on against the
// fallback bot under that bot's label, so nobody's seat or chips are lost.

import { randomBytes, randomInt } from 'node:crypto';
import { PythonRandom } from '../bots/mt.ts';
import { defaultBots, type BotRandom } from '../bots/policies.ts';
import type { Random } from '../engine/random.ts';
import type { Action } from '../engine/state.ts';
import type { SeatView } from '../engine/view.ts';
import { Signal, SystemClock, type Clock } from './clock.ts';
import { Table, TableError, type Departure, type TableConfig, type TableEvent } from './table.ts';

export const BOT_LABELS: Readonly<Record<string, string>> = {
	random: 'Random bot',
	calling_station: 'Calling bot',
	heuristic: 'RiverMind Easy',
	medium: 'RiverMind Medium',
	hard: 'RiverMind Hard'
};
/** The bot that stands in for one this server does not run. */
export const FALLBACK_BOT = 'heuristic';

/** A bot as a table runs it. It may answer at once or with a promise. */
export interface BotPolicy {
	readonly name: string;
	act(view: SeatView, rng: BotRandom): Action | Promise<Action>;
	/** A policy for one table, when the bot keeps a memory of its hands. */
	forTable?(): BotPolicy;
}

/** The name a bot of `kind` wears in `seat` (D-7). */
export function botName(kind: string, seat: number): string {
	return `${BOT_LABELS[kind] ?? kind} ${seat + 1}`;
}

/** A table's dealing generator, which also seeds the bots' own. */
export interface Dealer extends Random {
	/** 64 random bits to seed the bots' generator; drawn once, when the table is made. */
	botSeed(): bigint;
}

/** Deals from the operating system's cryptographic randomness (D-8). */
export const cryptoDealer: Dealer = {
	below: (bound) => randomInt(bound),
	botSeed: () => randomBytes(8).readBigUInt64LE()
};

/**
 * A seeded dealer for tests: CPython's generator, drawing as serve-nl does
 * with `rng_factory=lambda: random.Random(seed)`, so a seeded table deals the
 * same cards and its bots make the same choices in both servers.
 */
export function seededDealer(seed: number | bigint): Dealer {
	const rng = new PythonRandom(seed);
	return {
		below: (bound) => rng.below(bound),
		// `getrandbits(64)`: two words, the low one first.
		botSeed: () => {
			const low = BigInt(rng.uint32());
			return (BigInt(rng.uint32()) << 32n) | low;
		}
	};
}

export type Listener = (runner: TableRunner, events: readonly TableEvent[]) => Promise<void> | void;

/** Timing and bot behaviour shared by the tables a manager runs. */
export interface RunnerOptions {
	/** Seconds between the end of one hand and the start of the next. */
	handPause: number;
	/** Seconds a bot waits before acting, so people can follow the play. */
	botDelay: number;
	/** Bots that lose every chip buy in again for the maximum. */
	botRebuy: boolean;
	/** Deal only when a person would be dealt in, so bots never play on alone. */
	requirePerson: boolean;
	/** Waits for the pauses above. */
	sleep: (seconds: number) => Promise<void>;
	/** Times each turn. */
	clock: Clock;
	/** Makes each table's dealing generator (D-8). */
	dealer: () => Dealer;
	/** Where failures are reported. */
	log: Log;
}

export interface Log {
	info(message: string): void;
	warn(message: string): void;
	error(message: string, error?: unknown): void;
}

export const consoleLog: Log = {
	info: (message) => console.log(message),
	warn: (message) => console.warn(message),
	error: (message, error) =>
		error === undefined ? console.error(message) : console.error(message, error)
};

export const systemSleep = (seconds: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, seconds * 1000));

export function runnerOptions(options: Partial<RunnerOptions> = {}): RunnerOptions {
	return {
		handPause: 3,
		botDelay: 0.6,
		botRebuy: true,
		requirePerson: false,
		sleep: systemSleep,
		clock: new SystemClock(),
		dealer: () => cryptoDealer,
		log: consoleLog,
		...options
	};
}

/** One holder at a time, first come first served, as `asyncio.Lock`. */
export class Lock {
	private tail: Promise<unknown> = Promise.resolve();
	private holders = 0;

	/** Whether anything holds or waits for the lock. */
	get busy(): boolean {
		return this.holders > 0;
	}

	run<T>(body: () => T | Promise<T>): Promise<T> {
		this.holders += 1;
		const result = this.tail.then(body);
		this.tail = result.then(
			() => void (this.holders -= 1),
			() => void (this.holders -= 1)
		);
		return result;
	}
}

/** The lobby settings saved with a table's snapshot (P4.3). */
export interface LobbyState {
	fill: string | null;
	private: boolean;
	invite: string | null;
	practice?: string;
}

export interface RunnerSettings {
	name?: string;
	fill?: string | null;
	private?: boolean;
	invite?: string | null;
	practice?: string | null;
}

export class TableRunner {
	readonly tableId: string;
	readonly table: Table;
	name: string;
	/** The kind of bot that takes free seats, or null to leave them for people. */
	readonly fill: string | null;
	/** Private tables are not listed; people join them with `invite`. */
	readonly private: boolean;
	readonly invite: string | null;
	/** The guest a practice table belongs to (P6.0b), or null for a wallet-backed table. */
	readonly practice: string | null;
	readonly bots: Readonly<Record<string, BotPolicy>>;
	readonly options: RunnerOptions;
	readonly rng: Dealer;
	/** Bots' own choices need no cryptographic generator, only an unseeded one. */
	readonly botRng: PythonRandom;
	readonly lock = new Lock();
	listeners: Listener[] = [];
	/** Hooks run under the lock before listeners hear of a change (the table is saved here). */
	beforePublish: Listener[] = [];
	lastActive: number;
	private readonly wake = new Signal();
	private readonly stopped = new Signal();
	private task: Promise<void> | null = null;
	private isClosed = false;
	private botCount = 0;
	/** This table's own policies, for bots that keep a memory of their hands. */
	private readonly policies = new Map<string, BotPolicy>();
	/** At a practice table: the kind that takes the bot's seat when its hand ends (P5.7a). */
	private nextBot: string | null = null;

	constructor(
		tableId: string,
		table: Table,
		bots: Readonly<Record<string, BotPolicy>>,
		options: RunnerOptions,
		settings: RunnerSettings = {}
	) {
		this.tableId = tableId;
		this.table = table;
		this.name = settings.name || tableId;
		const fill = settings.fill ?? null;
		if (fill !== null && !Object.hasOwn(bots, fill))
			throw new RangeError(`no bot called '${fill}'`);
		this.fill = fill;
		this.private = settings.private ?? false;
		this.invite = settings.invite ?? null;
		this.practice = settings.practice ?? null;
		this.bots = { ...bots };
		this.options = options;
		this.rng = options.dealer();
		this.botRng = new PythonRandom(this.rng.botSeed());
		this.lastActive = options.clock.now();
	}

	// Lifecycle

	start(): void {
		if (this.task === null && !this.isClosed) this.task = this.run();
	}

	/** Stop the loop. A change being saved or published finishes first. */
	async stop(): Promise<void> {
		this.isClosed = true;
		this.wake.set();
		this.stopped.set();
		await this.lock.run(() => {});
		this.task = null;
	}

	get closed(): boolean {
		return this.isClosed;
	}

	get running(): boolean {
		return this.task !== null && !this.isClosed;
	}

	lobbyState(): LobbyState {
		const state: LobbyState = { fill: this.fill, private: this.private, invite: this.invite };
		if (this.practice !== null) state.practice = this.practice;
		return state;
	}

	/** Whether the player is seated, holds a seat or is waiting here. */
	isMember(playerId: string): boolean {
		const table = this.table;
		return (
			table.seatOf(playerId) !== null ||
			table.reservationOf(playerId) !== null ||
			table.waitlistPosition(playerId) !== null
		);
	}

	/** Number new bots after those already seated, so bot ids stay unique. */
	adoptBots(): void {
		for (const [, player] of this.table.players()) {
			if (player.bot === null) continue;
			const text = player.playerId.slice(player.playerId.lastIndexOf(':') + 1);
			if (/^[+-]?\d+$/.test(text.trim())) this.botCount = Math.max(this.botCount, Number(text));
		}
	}

	// Requests from players. Each rejects with TableError and leaves the table unchanged on refusal.

	sit(seat: number, playerId: string, name: string, buyIn: number): Promise<void> {
		return this.change(() => {
			this.refuseIfClosed();
			this.table.sit(seat, playerId, name, buyIn);
		});
	}

	/** Seat a bot of `kind`, labelled as a bot (D-7). Resolves to its player id. */
	async seatBot(seat: number, kind: string, buyIn: number | null = null): Promise<string> {
		if (!Object.hasOwn(this.bots, kind)) {
			throw new TableError('bad_request', `no bot called '${kind}'`);
		}
		return this.change(() => this.sitBot(seat, kind, buyIn));
	}

	private sitBot(seat: number, kind: string, buyIn: number | null = null): string {
		this.botCount += 1;
		const playerId = `bot:${kind}:${this.botCount}`;
		this.table.sit(seat, playerId, botName(kind, seat), buyIn || this.table.config.maxBuyIn, kind);
		return playerId;
	}

	/** The seat of this table's first bot, or null. */
	private botSeat(): number | null {
		for (const [seat, player] of this.table.players()) if (player.bot !== null) return seat;
		return null;
	}

	/**
	 * At a practice table: play against a bot of `kind` instead (P5.7a). The
	 * bot changes at once between hands, and otherwise when the hand in progress
	 * ends. Resolves to the kind still waiting to sit, or null once it has.
	 */
	async switchBot(kind: string): Promise<string | null> {
		if (!Object.hasOwn(this.bots, kind)) {
			throw new TableError('bad_request', `no bot called '${kind}'`);
		}
		return this.change(() => {
			if (this.practice === null) {
				throw new TableError('bad_request', 'only practice tables change their bot');
			}
			this.refuseIfClosed();
			const seat = this.botSeat();
			if (seat === null) throw new TableError('bad_request', 'there is no bot to change');
			this.nextBot = this.table.seats[seat]?.bot === kind ? null : kind;
			this.settleBot();
			return this.nextBot;
		});
	}

	/** The kind waiting to take the bot's seat at a practice table, or null. */
	get pendingBot(): string | null {
		return this.nextBot;
	}

	/** Seat the bot a practice table is waiting for, once the bot it replaces is out of the hand. */
	private settleBot(): void {
		const kind = this.nextBot;
		if (kind === null) return;
		const seat = this.botSeat();
		const old = seat === null ? null : this.table.seats[seat];
		if (seat === null || old === null) {
			this.nextBot = null;
			return;
		}
		if (this.table.inHand(seat)) return;
		this.nextBot = null;
		this.table.leave(old.playerId);
		this.sitBot(seat, kind);
		this.name = `Practice vs ${BOT_LABELS[kind] ?? kind}`;
	}

	/** The policy that plays `kind` at this table. */
	private policyFor(kind: string): BotPolicy {
		let policy = this.policies.get(kind);
		if (policy === undefined) {
			const shared = this.bots[kind];
			policy = shared.forTable?.() ?? shared;
			this.policies.set(kind, policy);
		}
		return policy;
	}

	/** Hold a seat (rule 2.4). Resolves to the seat and whether it is free to sit in now. */
	reserve(
		playerId: string,
		name: string,
		seat: number | null = null
	): Promise<{ seat: number; ready: boolean }> {
		return this.changeThen(
			() => this.table.reserve(playerId, name, seat),
			(held) => ({ seat: held, ready: (this.table.reservations.get(held)?.until ?? null) !== null })
		);
	}

	cancelReservation(playerId: string): Promise<void> {
		return this.change(() => this.table.cancelReservation(playerId));
	}

	joinWaitlist(playerId: string, name: string): Promise<number> {
		return this.changeThen(
			() => this.table.joinWaitlist(playerId, name),
			(place) => this.table.waitlistPosition(playerId) || place
		);
	}

	leaveWaitlist(playerId: string): Promise<void> {
		return this.change(() => this.table.leaveWaitlist(playerId));
	}

	leave(playerId: string): Promise<Departure | null> {
		return this.change(() => this.table.leave(playerId));
	}

	sitOut(playerId: string): Promise<void> {
		return this.change(() => this.table.sitOut(playerId));
	}

	sitIn(playerId: string): Promise<void> {
		return this.change(() => this.table.sitIn(playerId));
	}

	setConnected(playerId: string, connected: boolean): Promise<void> {
		return this.change(() => this.table.setConnected(playerId, connected));
	}

	rebuy(playerId: string, amount: number): Promise<void> {
		return this.change(() => {
			this.refuseIfClosed();
			this.table.rebuy(playerId, amount);
		});
	}

	/** At a practice table: a fresh practice stack for a player who ran out of chips. */
	refill(playerId: string): Promise<void> {
		return this.change(() => {
			const seat = this.table.seatOf(playerId);
			if (this.practice === null) {
				throw new TableError('bad_request', 'only practice tables refill for free');
			}
			if (seat === null) throw new TableError('not_seated', `${playerId} is not seated here`);
			if (this.table.inHand(seat) || this.table.stackOf(seat) > 0) {
				throw new TableError('bad_request', 'practice chips refill once you run out');
			}
			this.table.rebuy(playerId, this.table.config.maxBuyIn);
		});
	}

	act(playerId: string, action: Action, seq: number | null = null): Promise<void> {
		return this.change(() => {
			const seat = this.table.seatOf(playerId);
			if (seat !== null && this.isBot(seat)) {
				throw new TableError('not_your_turn', 'bots act for themselves');
			}
			this.table.act(playerId, action, seq);
		});
	}

	/**
	 * Refuse chips paid for after the table closed. Its seated chips went back
	 * to the wallets when it closed, and nothing saves or pays out a closed
	 * table, so chips that reached it would be lost; refused, the caller refunds
	 * them. Call under the lock.
	 */
	private refuseIfClosed(): void {
		if (this.isClosed) throw new TableError('unknown_table', 'the table has closed');
	}

	private change<T>(apply: () => T): Promise<T> {
		return this.changeThen(apply, (result) => result);
	}

	/**
	 * Apply a request under the lock, then save and publish it; `after` reads
	 * the answer from the table once it is published.
	 */
	private changeThen<R, T>(apply: () => R, after: (result: R) => T): Promise<T> {
		return this.lock.run(async () => {
			const result = apply();
			await this.changed();
			return after(result);
		});
	}

	// The loop

	private isBot(seat: number): boolean {
		return (this.table.seats[seat]?.bot ?? null) !== null;
	}

	/** Publish the table's new events. Call with the lock held. */
	private async changed(): Promise<void> {
		try {
			await this.publish();
		} finally {
			// The loop looks again only once the change is saved and published. A bot's
			// next turn then never overtakes what the request that made this change does
			// next, however long the save took, so events come in one order whether the
			// tables are in memory or in PostgreSQL.
			this.wake.set();
		}
	}

	private async publish(): Promise<void> {
		const table = this.table;
		this.settleBot();
		table.settleSeats();
		if (this.fill !== null && table.people()) {
			for (const seat of table.freeSeats()) this.sitBot(seat, this.fill);
		}
		if (this.options.botRebuy) {
			for (const [seat, player] of table.players()) {
				if (player.bot !== null && player.stack === 0 && !table.inHand(seat)) {
					table.rebuy(player.playerId, table.config.maxBuyIn);
				}
			}
		}
		const events = table.drainEvents();
		if (!events.length || this.isClosed) return;
		this.lastActive = this.options.clock.now();
		for (const hook of this.beforePublish) await hook(this, events);
		// Whatever the hooks did not take is not kept: tables play on for days.
		table.drainFinished();
		table.drainDepartures();
		for (const listener of [...this.listeners]) {
			try {
				await listener(this, events);
			} catch (error) {
				this.options.log.error(`A listener of table ${this.tableId} failed`, error);
			}
		}
	}

	/** Wait for a pause, or until the runner stops. */
	private async pause(seconds: number): Promise<void> {
		if (this.isClosed) return;
		await new Promise<void>((resolve) => {
			const cancel = this.stopped.onSet(resolve);
			void this.options.sleep(seconds).then(() => {
				cancel();
				resolve();
			});
		});
	}

	private async run(): Promise<void> {
		while (!this.isClosed) {
			this.wake.clear();
			try {
				await this.step();
			} catch (error) {
				this.options.log.error(`Table ${this.tableId} failed a step; retrying`, error);
				await this.pause(1);
			}
		}
	}

	mayDeal(): boolean {
		const table = this.table;
		if (!table.canStart()) return false;
		if (!this.options.requirePerson) return true;
		return table.dealtInNext().some((seat) => !this.isBot(seat));
	}

	/** Whether any person is seated or has a seat held for them. */
	hasPeople(): boolean {
		return this.table.people() > 0 || this.table.reservations.size > 0;
	}

	private async step(): Promise<void> {
		const table = this.table;
		if (this.mayDeal()) {
			if (table.hand !== null && this.options.handPause) await this.pause(this.options.handPause);
			await this.lock.run(async () => {
				if (this.isClosed || !this.mayDeal()) return;
				table.startHand(this.rng);
				await this.changed();
			});
			return;
		}
		const seat = table.toAct;
		if (seat !== null && this.isBot(seat)) {
			await this.botTurn(seat);
			return;
		}
		const turn = seat !== null ? table.turn : null;
		const hold = table.reservationDeadline();
		const deadlines = [turn?.final ?? null, hold].filter((t): t is number => t !== null);
		const deadline = deadlines.length ? Math.min(...deadlines) : null;
		if (await this.options.clock.wait(this.wake, deadline)) return; // something changed; look again
		await this.lock.run(async () => {
			if (this.isClosed) return;
			if (table.turn === turn) table.checkClock();
			await this.changed(); // also lets a hold that ran out go
		});
	}

	private async botTurn(seat: number): Promise<void> {
		const table = this.table;
		const state = table.hand;
		const player = table.seats[seat];
		const view = table.view(seat);
		if (state === null || player === null || player.bot === null || view === null) return;
		const kind = player.bot;
		const policy = this.policyFor(kind);
		const turn = table.turn;
		// Even with no delay, a bot's turn waits its place behind the requests and
		// sockets already due, as serve-nl's did while its bot thought in a thread:
		// a table of quick bots never keeps the event loop to itself.
		if (this.options.botDelay) await this.pause(this.options.botDelay);
		else await new Promise<void>((resolve) => setImmediate(resolve));
		if (this.isClosed) return;
		const decided = new Signal();
		let action: Action | null = null;
		void (async () => policy.act(view, this.botRng))()
			.then(
				(chosen) => void (action = chosen),
				(error: unknown) =>
					this.options.log.error(
						`Bot ${kind} at table ${this.tableId} failed; timing it out`,
						error
					)
			)
			.finally(() => decided.set());
		if (!(await this.options.clock.wait(decided, turn?.final ?? null))) {
			// Out of time. Its answer, if one ever comes, is ignored.
			this.options.log.warn(`Bot ${kind} at table ${this.tableId} ran out of time`);
			await this.lock.run(async () => {
				if (this.isClosed) return;
				if (table.hand === state && table.checkClock()) await this.changed();
			});
			return;
		}
		const chosen = action as Action | null;
		await this.lock.run(async () => {
			if (this.isClosed || table.hand !== state) return; // the table moved on while the bot was thinking
			try {
				if (chosen === null) table.timeOut();
				else table.actSeat(seat, chosen);
			} catch (error) {
				if (!(error instanceof TableError)) throw error;
				this.options.log.error(
					`Bot ${kind} at table ${this.tableId} chose an illegal action; timing it out`,
					error
				);
				table.timeOut();
			}
			await this.changed();
		});
	}

	/** Wait until `predicate(table)` holds after a change (for tests and tools). */
	async waitUntil(predicate: (table: Table) => boolean, timeoutSeconds = 10): Promise<void> {
		if (predicate(this.table)) return;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				remove();
				reject(new Error(`table ${this.tableId} did not reach the awaited state`));
			}, timeoutSeconds * 1000);
			const check: Listener = (runner) => {
				if (!predicate(runner.table)) return;
				clearTimeout(timer);
				remove();
				resolve();
			};
			const remove = () => {
				const at = this.listeners.indexOf(check);
				if (at !== -1) this.listeners.splice(at, 1);
			};
			this.listeners.push(check);
		});
	}
}

/** A fresh table id, as `secrets.token_urlsafe(9)` makes them: 12 URL-safe characters. */
export function newTableId(): string {
	return randomBytes(9).toString('base64url');
}

/**
 * Creates, finds and closes the server's tables.
 *
 * `setup` is called with each new or restored runner before its loop starts,
 * to attach hooks and listeners that must see every change.
 */
export class TableManager {
	readonly bots: Readonly<Record<string, BotPolicy>>;
	readonly options: RunnerOptions;
	readonly tables = new Map<string, TableRunner>();
	private readonly setup: ((runner: TableRunner) => void) | null;
	private readonly newId: () => string;

	constructor(
		bots: Readonly<Record<string, BotPolicy>> = defaultBots(),
		options: RunnerOptions = runnerOptions(),
		setup: ((runner: TableRunner) => void) | null = null,
		newId: () => string = newTableId
	) {
		this.bots = { ...bots };
		this.options = options;
		this.setup = setup;
		this.newId = newId;
	}

	/** Make a table and start its loop. */
	create(
		config: TableConfig,
		settings: { name?: string; tableId?: string; lobby?: Record<string, unknown> | null } = {}
	): TableRunner {
		const table = new Table(config, () => this.options.clock.now());
		return this.restore(settings.tableId ?? this.newId(), table, settings);
	}

	/**
	 * Run an existing table, such as one loaded from the database. `lobby`
	 * holds the settings of `TableRunner.lobbyState`.
	 */
	restore(
		tableId: string,
		table: Table,
		settings: { name?: string; lobby?: Record<string, unknown> | null } = {}
	): TableRunner {
		if (this.tables.has(tableId)) throw new RangeError(`table ${tableId} exists`);
		const lobby = settings.lobby ?? {};
		const text = (value: unknown) => (typeof value === 'string' ? value : null);
		// A bot this server does not run gives its seat, stack and place in the hand
		// to the fallback bot, which is then what the seat's label says (D-7).
		const fallback = Object.hasOwn(this.bots, FALLBACK_BOT) ? FALLBACK_BOT : null;
		const runs = (kind: string | null) => kind === null || Object.hasOwn(this.bots, kind);
		const missing = new Set<string>();
		for (const [seat, player] of table.players()) {
			if (runs(player.bot)) continue;
			missing.add(player.bot as string);
			if (fallback !== null) {
				player.bot = fallback;
				player.name = botName(fallback, seat);
			}
		}
		let fill = text(lobby.fill);
		if (!runs(fill)) {
			missing.add(fill as string);
			fill = fallback;
		}
		if (missing.size) {
			const kinds = [...missing].sort().join(', ');
			if (fallback === null) {
				throw new RangeError(`table ${tableId} has bots this server does not run: ${kinds}`);
			}
			this.options.log.warn(
				`Table ${tableId} has bots this server does not run (${kinds}); ${BOT_LABELS[fallback]} plays instead`
			);
			if (settings.name?.startsWith('Practice vs ')) {
				settings = { ...settings, name: `Practice vs ${BOT_LABELS[fallback]}` };
			}
		}
		const runner = new TableRunner(tableId, table, this.bots, this.options, {
			name: settings.name,
			fill,
			private: lobby.private === true,
			invite: text(lobby.invite),
			practice: text(lobby.practice)
		});
		runner.adoptBots();
		this.tables.set(tableId, runner);
		this.setup?.(runner);
		runner.start();
		return runner;
	}

	get(tableId: string): TableRunner | null {
		return this.tables.get(tableId) ?? null;
	}

	async close(tableId: string): Promise<void> {
		const runner = this.tables.get(tableId);
		if (runner === undefined) return;
		this.tables.delete(tableId);
		await runner.stop();
	}

	async shutdown(): Promise<void> {
		for (const tableId of [...this.tables.keys()]) await this.close(tableId);
	}
}

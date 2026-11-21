/**
 * The site's tables and sockets, ported from `Server` in
 * `rivermind/server/app.py` (P4B.5b), on the {@link Site} of P4B.5a.
 *
 * Each table runs as a `TableRunner`. After every change at a table, a
 * listener builds each subscribed player's own view and sends it on that
 * player's socket, so a slow client never holds up a table.
 *
 * A player's seat is marked disconnected when their last socket following
 * that table closes, and connected again when one follows it; the table's
 * clock then sits them out if they stay away. A table closes when no person
 * holds a seat, and idle tables are evicted when the server needs room.
 *
 * Buy-ins and rebuys are paid from the wallet before they reach the table
 * and refunded if the table refuses them; chips come back when the player
 * leaves or a waiting rebuy no longer fits, and when a table closes with
 * them still seated.
 *
 * The lobby (P4.3) lists the public tables with filters and seats people at
 * them. Bots keep the seats warm: a person who wants a seat at a table full
 * of bots takes a bot's, at once between hands or when the bot's hand ends,
 * and a seat a person leaves goes to the first player on the waitlist or else
 * back to a bot. A private table is unlisted and needs its invite code.
 *
 * Practice (P6.0b): each guest has at most one practice table, heads-up
 * against RiverMind Easy, which only they can follow and which is not
 * listed. Its chips never come from or go back to the wallet.
 *
 * With a table store every table is saved after each change and before any
 * socket hears of it, and the open tables are restored at start-up. Nobody is
 * connected to a restored table yet, so its people are marked disconnected
 * until they rejoin.
 */
import { randomBytes } from 'node:crypto';
import type * as p from '../../protocol-v2.ts';
import { defaultBots } from '../bots/policies.ts';
import { FormatError } from '../engine/history.ts';
import { Action } from '../engine/state.ts';
import {
	BOT_LABELS,
	runnerOptions,
	TableManager,
	type BotPolicy,
	type Listener,
	type Log,
	type RunnerOptions,
	type TableRunner
} from '../table/runner.ts';
import { tableFromDict } from '../table/snapshot.ts';
import { TableSaver, type TableStorage } from '../table/store.ts';
import { tableConfig, TableError, type TableConfig, type TableEvent } from '../table/table.ts';
import { publicRef, sameText } from './auth.ts';
import { HttpError, RequestError } from './errors.ts';
import type { PlayerRecord } from './players.ts';
import { PROTOCOL_VERSION } from './protocol.ts';
import { REACTIONS, type Reaction, type RelationKind } from './safety.ts';
import { PRACTICE_BLINDS, STAKES, type Site } from './site.ts';
import { commas } from './time.ts';
import { tableEvents, tableSummary, tableView, yourHold } from './views.ts';
import { creditsFor, InsufficientChips, type Credit } from './wallet.ts';
import type { LedgerKind } from '../db/schema.ts';

export const MAX_SUBSCRIPTIONS = 8;
/** Messages a socket may have waiting to be written before it is dropped as not reading. */
export const QUEUE_LIMIT = 512;
export const LIST_LIMIT = 100;
export const DEFAULT_BIG_BLIND = 100;
export const GONE = 'That table no longer exists.';
/** RiverMind Easy, the labelled bot a guest practises against (P6.0b). */
export const PRACTICE_BOT = 'heuristic';
/** A practice table nobody follows closes after this long without a change. */
export const PRACTICE_IDLE_SECONDS = 3600;
export const PRACTICE_REFUSED =
	'Practice chips are not from your wallet: start practice from the lobby.';

/** Python's `repr` of a list of strings or whole numbers, for messages that quote one. */
function pythonList(items: readonly (string | number)[]): string {
	return `[${items.map((item) => (typeof item === 'string' ? `'${item}'` : String(item))).join(', ')}]`;
}

/** The client end of one socket, as the table server needs it. */
export interface Transport {
	/** Send a text frame; `sent` is called once it has left the process. */
	send(text: string, sent: () => void): void;
	close(code: number): void;
}

/** Close code for a socket the server gives up on ("try again later"). */
export const CLOSE_TRY_AGAIN = 1013;

type ServerMessage =
	| p.WelcomeMessage
	| p.TableMessage
	| p.LeftTableMessage
	| p.TableClosedMessage
	| p.ReactionMessage
	| p.ErrorMessage;

/** One client socket, authenticated as one player. */
export class Connection {
	readonly playerId: string;
	readonly name: string;
	/** Table id -> the listener registered on that table's runner. */
	readonly tables = new Map<string, Listener>();
	closed = false;
	private readonly transport: Transport;
	private readonly log: Log;
	private unsent = 0;

	constructor(transport: Transport, playerId: string, name: string, log: Log) {
		this.transport = transport;
		this.playerId = playerId;
		this.name = name;
		this.log = log;
	}

	send(message: ServerMessage): void {
		if (this.closed) return;
		if (this.unsent >= QUEUE_LIMIT) {
			this.log.warn(`Dropping a client of ${this.playerId} that is not reading`);
			this.closed = true;
			this.transport.close(CLOSE_TRY_AGAIN);
			return;
		}
		this.unsent += 1;
		this.transport.send(JSON.stringify(message), () => void (this.unsent -= 1));
	}

	/** Close the socket once the messages already queued are sent. */
	end(): void {
		if (this.closed) return;
		this.closed = true;
		this.transport.close(CLOSE_TRY_AGAIN);
	}
}

export interface TablesOptions {
	/** The bots a table can seat, by kind. */
	bots?: Readonly<Record<string, BotPolicy>>;
	/** Timing, the clock and the dealer; tables deal only with a person in the hand by default. */
	runner?: Partial<RunnerOptions>;
	maxTables?: number;
	/** A table nobody follows is evicted after this long without a change. */
	idleSeconds?: number;
	/** With a store, tables are saved after every change and restored at start-up. */
	store?: TableStorage | null;
	/** Makes table ids and invite codes; tests pass fixed ones. */
	tableIds?: () => string;
	inviteCodes?: () => string;
	/** Called with each new or restored table before its loop starts, to listen to it from its first change. */
	onTable?: (runner: TableRunner) => void;
	log?: Log;
}

type ClientMessage = Exclude<p.ClientMessage, undefined>;

export class Tables {
	readonly site: Site;
	readonly bots: Readonly<Record<string, BotPolicy>>;
	readonly options: RunnerOptions;
	readonly maxTables: number;
	readonly idleSeconds: number;
	readonly store: TableStorage | null;
	readonly manager: TableManager;
	/** (table id, player id) -> open sockets following that table. */
	private readonly watchers = new Map<string, number>();
	readonly connections = new Set<Connection>();
	/** Tables being closed, and the work closing each. */
	private readonly closing = new Map<string, Promise<void>>();
	/** Guest id -> their practice table's id (P6.0b). */
	readonly practice = new Map<string, string>();
	/** Guest id -> the last request to start practice, which the next one waits for. */
	private readonly practiceStarts = new Map<string, Promise<unknown>>();
	private signalled = new Set<string>();
	private readonly inviteCodes: () => string;
	private readonly onTable: ((runner: TableRunner) => void) | null;
	private readonly log: Log;
	private started = false;

	constructor(site: Site, options: TablesOptions = {}) {
		this.site = site;
		this.bots = options.bots ?? defaultBots();
		this.options = runnerOptions({ requirePerson: true, ...options.runner });
		this.log = options.log ?? this.options.log;
		this.maxTables = options.maxTables ?? 200;
		this.idleSeconds = options.idleSeconds ?? 24 * 3600;
		this.store = options.store ?? null;
		this.inviteCodes = options.inviteCodes ?? (() => randomBytes(12).toString('base64url'));
		this.onTable = options.onTable ?? null;
		this.manager = new TableManager(
			this.bots,
			this.options,
			(runner) => this.setup(runner),
			options.tableIds
		);
	}

	/** Restore the open tables saved in the database. Call once, before serving. */
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		if (this.store !== null) await this.restore(this.store);
	}

	/** Stop every table. A change being saved or published finishes first. */
	async stop(): Promise<void> {
		await Promise.allSettled([...this.closing.values()]);
		await this.manager.shutdown();
	}

	/** Resolves once every table being closed has closed (for tests). */
	async settled(): Promise<void> {
		while (this.closing.size) await Promise.allSettled([...this.closing.values()]);
	}

	private setup(runner: TableRunner): void {
		if (this.store !== null) {
			// Pays departing chips in the same transaction as the save.
			runner.beforePublish.push(new TableSaver(this.store, this.log).hook);
		} else {
			runner.beforePublish.push((r) => this.cashOut(r));
			runner.beforePublish.push((r) => this.rememberHands(r));
		}
		runner.listeners.push((r, events) => this.watchTable(r, events));
		this.onTable?.(runner);
	}

	/** Without a database: pay departing chips back to the wallets (practice chips stay at the table). */
	private async cashOut(runner: TableRunner): Promise<void> {
		const departures = runner.table.drainDepartures();
		if (runner.practice !== null) return;
		for (const credit of creditsFor(runner.tableId, departures)) {
			await this.site.wallet.credit(credit.playerId, credit.amount, credit.kind, credit.tableId);
		}
	}

	/** Without a database: keep finished hands for the players' hand histories (P4.6). */
	private rememberHands(runner: TableRunner): void {
		const archive = this.site.memoryHands;
		if (archive === null) return;
		for (const finished of runner.table.finished) {
			archive.add(
				runner.tableId,
				runner.name,
				finished,
				runner.practice !== null,
				this.site.clock()
			);
		}
	}

	// Wallets

	/** Take a buy-in or rebuy from the wallet before it reaches the table. */
	async payIn(
		playerId: string,
		amount: number,
		kind: LedgerKind,
		tableId: string | null
	): Promise<void> {
		if (!Number.isSafeInteger(amount) || amount <= 0) {
			throw new RequestError('bad_buy_in', 'a buy-in is a positive whole number of chips');
		}
		try {
			await this.site.wallet.debit(playerId, amount, kind, tableId);
		} catch (error) {
			if (error instanceof InsufficientChips) {
				throw new RequestError('insufficient_chips', error.message);
			}
			throw error;
		}
	}

	/** Give back chips the table refused. */
	async refund(playerId: string, amount: number, tableId: string | null): Promise<void> {
		await this.site.wallet.credit(playerId, amount, 'refund', tableId);
	}

	/**
	 * Whether every open table saved in the database could be restored by this
	 * build, without restoring, running or changing any: a release candidate's
	 * check while the live server still owns the tables. True without a store.
	 */
	async restorable(): Promise<boolean> {
		if (this.store === null) return true;
		let ok = true;
		for (const saved of await this.store.loadOpen()) {
			try {
				tableFromDict(saved.state, () => this.options.clock.now());
			} catch (error) {
				if (!(error instanceof FormatError || error instanceof RangeError)) throw error;
				this.log.error(`Table ${saved.tableId} could not be restored by this build`, error);
				ok = false;
			}
		}
		return ok;
	}

	/** Run every open table saved in the database again. */
	private async restore(store: TableStorage): Promise<void> {
		let restored = 0;
		for (const saved of await store.loadOpen()) {
			let runner: TableRunner;
			try {
				const table = tableFromDict(saved.state, () => this.options.clock.now());
				const lobby = saved.state.lobby;
				runner = this.manager.restore(saved.tableId, table, {
					name: saved.name,
					lobby:
						typeof lobby === 'object' && lobby !== null ? (lobby as Record<string, unknown>) : null
				});
			} catch (error) {
				if (!(error instanceof FormatError || error instanceof RangeError)) throw error;
				this.log.error(`Could not restore table ${saved.tableId}; closing it`, error);
				await store.close(saved.tableId);
				continue;
			}
			restored += 1;
			if (runner.practice !== null) this.practice.set(runner.practice, saved.tableId);
			if (!runner.hasPeople()) {
				this.scheduleClose(saved.tableId, 'Everyone has left the table.');
				continue;
			}
			for (const [, player] of runner.table.players()) {
				if (player.bot === null && player.connected) {
					await runner.setConnected(player.playerId, false);
				}
			}
		}
		if (restored) this.log.info(`Restored ${restored} table(s) from the database`);
	}

	// Safety (P4.5)

	/** The person in a seat, to report, mute or block: not a bot, an empty seat or oneself. */
	personAt(runner: TableRunner, seat: number, playerId: string): PlayerRecord {
		const table = runner.table;
		const player = seat >= 0 && seat < table.config.seatCount ? table.seats[seat] : null;
		if (player === null) throw new HttpError(404, 'Nobody sits in that seat.');
		if (player.bot !== null) throw new HttpError(400, 'That seat is a bot.');
		if (player.playerId === playerId) throw new HttpError(400, 'That is your own seat.');
		return { playerId: player.playerId, handle: player.name };
	}

	/** Mute or block someone, as {@link Site.setRelation}. */
	setRelation(playerId: string, target: PlayerRecord, kind: RelationKind): Promise<void> {
		return this.site.setRelation(playerId, target, kind);
	}

	/** Show a seated person's reaction to everyone following the table who has not muted them. */
	private react(connection: Connection, runner: TableRunner, reaction: Reaction): void {
		const playerId = connection.playerId;
		const seat = runner.table.seatOf(playerId);
		const player = seat === null ? null : runner.table.seats[seat];
		if (seat === null || player === null) {
			throw new RequestError('not_seated', 'Take a seat to react.');
		}
		if (!this.site.limiters.reaction.allow(playerId)) {
			throw new RequestError('rate_limited', 'Wait a moment before reacting again.');
		}
		const message: p.ReactionMessage = {
			type: 'reaction',
			table_id: runner.tableId,
			seat,
			name: player.name,
			ref: publicRef(playerId),
			reaction,
			text: REACTIONS[reaction]
		};
		for (const other of [...this.connections]) {
			if (
				other.tables.has(runner.tableId) &&
				!this.site.loadedRelations(other.playerId)?.has(playerId)
			) {
				other.send(message);
			}
		}
	}

	/** Store a signal when a person sits at a table with someone from the same address. */
	private async checkAddresses(runner: TableRunner, events: readonly TableEvent[]): Promise<void> {
		const table = runner.table;
		const addresses = this.site.addresses;
		for (const event of events) {
			if (event.kind !== 'seated' || event.data.bot) continue;
			const seat = event.data.seat as number;
			const newcomer = table.seats[seat];
			if (newcomer === null || newcomer.bot !== null) continue;
			const tag = addresses.get(newcomer.playerId);
			if (tag === undefined) continue;
			for (const [otherSeat, other] of table.players()) {
				if (
					other.bot !== null ||
					other.playerId === newcomer.playerId ||
					addresses.get(other.playerId) !== tag
				) {
					continue;
				}
				const [first, second] = [newcomer.playerId, other.playerId].sort();
				const key = `${runner.tableId}\n${first}\n${second}`;
				if (this.signalled.has(key)) continue;
				this.signalled.add(key);
				this.log.warn(
					`Two people at table ${runner.tableId} share an address: ${first} and ${second}`
				);
				try {
					await this.site.safety.signal({
						kind: 'same_address',
						tableId: runner.tableId,
						playerIds: [first, second],
						detail: {
							address: tag,
							seats: [seat, otherSeat].sort((a, b) => a - b),
							hand_no: table.handNo
						},
						at: this.site.clock()
					});
				} catch (error) {
					this.log.error(`Could not store a safety signal for table ${runner.tableId}`, error);
				}
			}
		}
	}

	// Tables

	private isWatched(tableId: string): boolean {
		const prefix = `${tableId}\n`;
		for (const key of this.watchers.keys()) if (key.startsWith(prefix)) return true;
		return false;
	}

	private evict(): void {
		const now = this.options.clock.now();
		for (const [tableId, runner] of [...this.manager.tables]) {
			const idle = runner.practice !== null ? PRACTICE_IDLE_SECONDS : this.idleSeconds;
			if (!this.isWatched(tableId) && now - runner.lastActive > idle) {
				this.scheduleClose(tableId, 'The table closed after being idle.');
			}
		}
	}

	/** The buy-in asked for, or as much of the maximum as the wallet holds. */
	async buyInFor(playerId: string, config: TableConfig, requested: number | null): Promise<number> {
		if (requested === null) {
			const balance = await this.site.wallet.balance(playerId);
			const buyIn = Math.min(config.maxBuyIn, balance);
			if (buyIn < config.minBuyIn) {
				throw new HttpError(
					400,
					`You have ${commas(balance)} chips; this table needs at least ${commas(config.minBuyIn)}.`
				);
			}
			return buyIn;
		}
		if (!(config.minBuyIn <= requested && requested <= config.maxBuyIn)) {
			throw new HttpError(400, `buy_in must be ${config.minBuyIn} to ${config.maxBuyIn}`);
		}
		return requested;
	}

	/** Start a table with the player in seat 0. Resolves to its id, the seat and any invite code. */
	async createTable(
		player: PlayerRecord,
		request: Required<p.NewTableRequest>
	): Promise<{ tableId: string; seat: number; invite: string | null }> {
		const kinds = Object.keys(this.bots);
		if (request.bots !== null && !Object.hasOwn(this.bots, request.bots)) {
			throw new HttpError(400, `bots must be one of ${pythonList([...kinds].sort())} or null`);
		}
		if (request.bots !== null && !this.site.botPlays(request.bots, request.seats)) {
			const sizes = this.site.trained[request.bots]?.seats.join(' or ');
			throw new HttpError(
				400,
				`${BOT_LABELS[request.bots] ?? request.bots} plays only at tables of ${sizes} seats`
			);
		}
		const stakes = STAKES.find(([, big]) => big === request.big_blind);
		if (stakes === undefined) {
			const bigs = STAKES.map(([, big]) => big).sort((a, b) => a - b);
			throw new HttpError(400, `big_blind must be one of ${pythonList(bigs)}`);
		}
		const config = tableConfig({
			seatCount: request.seats,
			smallBlind: stakes[0],
			bigBlind: request.big_blind
		});
		const buyIn = await this.buyInFor(player.playerId, config, request.buy_in);
		this.evict();
		if (this.manager.tables.size >= this.maxTables) {
			throw new HttpError(503, 'Every table is in use; try again later.');
		}
		const name =
			request.bots === null
				? `${request.seats}-seat table`
				: `${request.seats}-seat table with ${BOT_LABELS[request.bots] ?? request.bots}s`;
		const invite = request.private ? this.inviteCodes() : null;
		const runner = this.manager.create(config, {
			name,
			lobby: { fill: request.bots, private: request.private, invite }
		});
		try {
			await this.payIn(player.playerId, buyIn, 'buy_in', runner.tableId);
		} catch (error) {
			this.scheduleClose(runner.tableId, 'The table was not needed.');
			if (error instanceof RequestError) throw new HttpError(400, error.message);
			throw error;
		}
		try {
			// Bots first: with requirePerson, nothing is dealt until the person sits.
			if (request.bots !== null) {
				for (let seat = 1; seat < request.seats; seat++) await runner.seatBot(seat, request.bots);
			}
			await runner.sit(0, player.playerId, player.handle, buyIn);
		} catch (error) {
			await this.refund(player.playerId, buyIn, runner.tableId);
			this.scheduleClose(runner.tableId, 'The table could not be set up.');
			throw error;
		}
		return { tableId: runner.tableId, seat: 0, invite };
	}

	// Practice (P6.0b)

	/** The guest's practice table, while they still sit at it. */
	practiceRunner(playerId: string): TableRunner | null {
		const tableId = this.practice.get(playerId);
		const runner = tableId === undefined ? null : this.manager.get(tableId);
		if (runner === null || tableId === undefined || this.closing.has(tableId)) return null;
		const seat = runner.table.seatOf(playerId);
		const player = seat === null ? null : runner.table.seats[seat];
		return player === null || player.leaving ? null : runner;
	}

	/**
	 * Seat the guest heads-up against a bot with practice chips, or return the
	 * table they have. `bot` chooses the opponent (P5.7a): RiverMind Easy at a
	 * new table when null, and at a table already running, a change of bot.
	 */
	startPractice(player: PlayerRecord, bot: string | null = null): Promise<p.PracticeResponse> {
		if (bot !== null && !(Object.hasOwn(this.bots, bot) && this.site.botPlays(bot, 2))) {
			const kinds = Object.keys(this.bots).filter((kind) => this.site.botPlays(kind, 2));
			throw new HttpError(400, `bot must be one of ${pythonList(kinds.sort())} or null`);
		}
		// One start at a time per guest, so two quick clicks make one table.
		const playerId = player.playerId;
		const before = this.practiceStarts.get(playerId) ?? Promise.resolve();
		const mine = before.then(
			() => this.startPracticeNow(player, bot),
			() => this.startPracticeNow(player, bot)
		);
		this.practiceStarts.set(playerId, mine);
		const forget = () => {
			if (this.practiceStarts.get(playerId) === mine) this.practiceStarts.delete(playerId);
		};
		mine.then(forget, forget);
		return mine;
	}

	private async startPracticeNow(
		player: PlayerRecord,
		asked: string | null
	): Promise<p.PracticeResponse> {
		const playerId = player.playerId;
		const existing = this.practiceRunner(playerId);
		if (existing !== null) {
			let waiting: string | null = existing.pendingBot;
			if (asked !== null) {
				try {
					waiting = await existing.switchBot(asked);
				} catch (error) {
					// The table closed, or lost its bot, while the request waited: nothing changed.
					if (!(error instanceof TableError)) throw error;
				}
			}
			const bots = existing.table.players().flatMap(([, other]) => other.bot ?? []);
			const response: p.PracticeResponse = {
				table_id: existing.tableId,
				seat: existing.table.seatOf(playerId) as number,
				created: false,
				bot: bots[0] ?? PRACTICE_BOT,
				stack: existing.table.config.maxBuyIn
			};
			if (waiting !== null) response.next_bot = waiting;
			return response;
		}
		const bot =
			asked ?? (Object.hasOwn(this.bots, PRACTICE_BOT) ? PRACTICE_BOT : Object.keys(this.bots)[0]);
		this.evict();
		if (this.manager.tables.size >= this.maxTables) {
			throw new HttpError(503, 'Every table is in use; try again later.');
		}
		const [smallBlind, bigBlind] = PRACTICE_BLINDS;
		const stack = this.site.practiceStack;
		const config = tableConfig({
			seatCount: 2,
			smallBlind,
			bigBlind,
			minBuyIn: stack,
			maxBuyIn: stack
		});
		const runner = this.manager.create(config, {
			name: `Practice vs ${BOT_LABELS[bot] ?? bot}`,
			lobby: { fill: null, private: true, invite: null, practice: playerId }
		});
		try {
			await runner.seatBot(1, bot);
			await runner.sit(0, playerId, player.handle, stack);
		} catch (error) {
			this.scheduleClose(runner.tableId, 'The table could not be set up.');
			throw error;
		}
		this.practice.set(playerId, runner.tableId);
		return { table_id: runner.tableId, seat: 0, created: true, bot, stack };
	}

	// The lobby (P4.3)

	openTables(): TableRunner[] {
		return [...this.manager.tables.values()].filter((r) => !this.closing.has(r.tableId));
	}

	/** A table the player may see: public, one they are at, or private with its invite code. */
	lobbyRunner(tableId: string, playerId: string, invite: string | null = null): TableRunner {
		const runner = this.manager.get(tableId);
		if (runner === null || this.closing.has(tableId)) throw new HttpError(404, GONE);
		if (runner.private && !runner.isMember(playerId) && !inviteMatches(runner, invite)) {
			throw new HttpError(404, GONE);
		}
		return runner;
	}

	/** A table the player may take a seat or wait at: not a practice table, which seats only its guest. */
	seatingRunner(tableId: string, playerId: string, invite: string | null = null): TableRunner {
		const runner = this.lobbyRunner(tableId, playerId, invite);
		if (runner.practice !== null) throw new HttpError(400, PRACTICE_REFUSED);
		return runner;
	}

	listTables(
		playerId: string,
		seats: number | null,
		bigBlind: number | null,
		openOnly: boolean,
		blocks: ReadonlySet<string> = new Set()
	): p.TableSummary[] {
		const summaries: p.TableSummary[] = [];
		for (const runner of this.openTables()) {
			if (runner.practice !== null || (runner.private && !runner.isMember(playerId))) continue;
			const config = runner.table.config;
			if (seats !== null && config.seatCount !== seats) continue;
			if (bigBlind !== null && config.bigBlind !== bigBlind) continue;
			const summary = tableSummary(runner, playerId, blocks);
			if (openOnly && !(summary.free_seats || summary.bot_seats)) continue;
			summaries.push(summary);
		}
		const full = (t: p.TableSummary) => (t.free_seats + t.bot_seats === 0 ? 1 : 0);
		summaries.sort(
			(a, b) =>
				b.people - a.people ||
				full(a) - full(b) ||
				a.big_blind - b.big_blind ||
				a.seat_count - b.seat_count ||
				(a.table_id < b.table_id ? -1 : a.table_id > b.table_id ? 1 : 0)
		);
		return summaries.slice(0, LIST_LIMIT);
	}

	findInvite(code: string): TableRunner | null {
		return this.openTables().find((r) => r.private && inviteMatches(r, code)) ?? null;
	}

	/** Hold a seat and, unless `holdOnly`, buy in and sit in it if it is free now. */
	async takeSeat(
		player: PlayerRecord,
		runner: TableRunner,
		seat: number | null,
		buyIn: number | null,
		holdOnly: boolean
	): Promise<p.SeatResponse> {
		const tableId = runner.tableId;
		const playerId = player.playerId;
		const amount = holdOnly ? null : await this.buyInFor(playerId, runner.table.config, buyIn);
		let held: { seat: number; ready: boolean };
		try {
			held = await runner.reserve(playerId, player.handle, seat);
		} catch (error) {
			throw seatingError(error);
		}
		if (amount === null || !held.ready) {
			return {
				table_id: tableId,
				seat: held.seat,
				seated: false,
				hold: yourHold(runner.table, playerId)
			};
		}
		try {
			await this.payIn(playerId, amount, 'buy_in', tableId);
		} catch (error) {
			if (error instanceof RequestError) throw new HttpError(400, error.message);
			throw error;
		}
		try {
			await runner.sit(held.seat, playerId, player.handle, amount);
		} catch (error) {
			await this.refund(playerId, amount, tableId);
			throw seatingError(error);
		}
		return { table_id: tableId, seat: held.seat, seated: true, hold: null };
	}

	/** A seat at the busiest matching public table, or a new table with bots. */
	async quickSeat(
		player: PlayerRecord,
		request: Required<p.QuickSeatRequest>
	): Promise<p.SeatResponse> {
		const playerId = player.playerId;
		const balance = await this.site.wallet.balance(playerId);
		const blocks = await this.site.safety.blocksInvolving(playerId);
		const candidates: { key: [number, number, number]; runner: TableRunner }[] = [];
		for (const runner of this.openTables()) {
			const table = runner.table;
			const config = table.config;
			if (runner.practice !== null || (runner.private && !runner.isMember(playerId))) continue;
			if (request.seats !== null && config.seatCount !== request.seats) continue;
			if (request.big_blind !== null && config.bigBlind !== request.big_blind) continue;
			const seat = table.seatOf(playerId);
			if (seat !== null) return { table_id: runner.tableId, seat, seated: true, hold: null };
			const mine = table.reservationOf(playerId) !== null;
			if (!mine && !(table.freeSeats().length || table.botSeats().length)) continue;
			if (table.players().some(([, other]) => blocks.has(other.playerId))) continue;
			const buyIn = request.buy_in;
			if (buyIn !== null && !(config.minBuyIn <= buyIn && buyIn <= config.maxBuyIn)) continue;
			if ((buyIn || config.minBuyIn) > balance) continue;
			const now = table.freeSeats().length > 0 || table.botSeats().some((s) => !table.inHand(s));
			candidates.push({ key: [Number(mine), table.people(), Number(now)], runner });
		}
		// Most wanted first; equal tables keep the order they were made in.
		candidates.sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1] || b.key[2] - a.key[2]);
		for (const { runner } of candidates) {
			try {
				return await this.takeSeat(player, runner, null, request.buy_in, false);
			} catch (error) {
				if (!(error instanceof HttpError) || error.status !== 409) throw error;
			}
		}
		let bigBlind = request.big_blind;
		if (bigBlind === null) {
			// The usual stakes if the wallet covers them, else the largest it does.
			const affordable = STAKES.map(([, big]) => big).filter(
				(big) =>
					tableConfig({ seatCount: 2, smallBlind: big / 2, bigBlind: big }).minBuyIn <= balance
			);
			bigBlind = affordable.includes(DEFAULT_BIG_BLIND)
				? DEFAULT_BIG_BLIND
				: affordable.length
					? Math.max(...affordable)
					: STAKES[0][1];
		}
		const made = await this.createTable(player, {
			seats: request.seats ?? 6,
			bots: 'heuristic',
			big_blind: bigBlind,
			buy_in: request.buy_in,
			private: false
		});
		return { table_id: made.tableId, seat: made.seat, seated: true, hold: null };
	}

	async joinWaitlist(player: PlayerRecord, runner: TableRunner): Promise<number> {
		const balance = await this.site.wallet.balance(player.playerId);
		const minimum = runner.table.config.minBuyIn;
		if (balance < minimum) {
			throw new HttpError(
				400,
				`You have ${commas(balance)} chips; this table needs at least ${commas(minimum)}.`
			);
		}
		try {
			return await runner.joinWaitlist(player.playerId, player.handle);
		} catch (error) {
			throw seatingError(error);
		}
	}

	/** Check who sat down, and close a table once no person is seated or has a seat held. */
	private async watchTable(runner: TableRunner, events: readonly TableEvent[]): Promise<void> {
		await this.checkAddresses(runner, events);
		if (
			events.some((e) => e.kind === 'left' || e.kind === 'reservation_ended') &&
			!runner.hasPeople()
		) {
			this.scheduleClose(runner.tableId, 'Everyone has left the table.');
		}
	}

	/**
	 * Close a table now, as eviction does: its people are told why, and anyone
	 * still seated gets their chips back. Resolves once it has closed.
	 */
	async close(tableId: string, message: string): Promise<void> {
		if (this.manager.get(tableId) === null) return;
		this.scheduleClose(tableId, message);
		await this.closing.get(tableId);
	}

	private scheduleClose(tableId: string, message: string): void {
		if (this.closing.has(tableId)) return;
		const closing = this.closeTable(tableId, message)
			.catch((error: unknown) => this.log.error(`Could not close table ${tableId}`, error))
			.finally(() => {
				if (this.closing.get(tableId) === closing) this.closing.delete(tableId);
			});
		this.closing.set(tableId, closing);
	}

	private async closeTable(tableId: string, message: string): Promise<void> {
		// Let whoever scheduled the close finish its own change first.
		await Promise.resolve();
		const runner = this.manager.get(tableId);
		await this.manager.close(tableId);
		// Anyone still seated (an idle table is evicted) gets their chips back.
		const credits = runner === null ? [] : seatedChips(runner);
		if (this.store !== null) {
			try {
				await this.store.close(tableId, credits);
			} catch (error) {
				this.log.error(`Could not mark table ${tableId} closed in the database`, error);
			}
		} else {
			for (const credit of credits) {
				await this.site.wallet.credit(credit.playerId, credit.amount, 'cash_out', tableId);
			}
		}
		for (const connection of [...this.connections]) {
			if (connection.tables.delete(tableId)) {
				connection.send({ type: 'table_closed', table_id: tableId, message });
			}
		}
		const prefix = `${tableId}\n`;
		for (const key of [...this.watchers.keys()]) {
			if (key.startsWith(prefix)) this.watchers.delete(key);
		}
		if (runner !== null && runner.practice !== null) {
			if (this.practice.get(runner.practice) === tableId) this.practice.delete(runner.practice);
		}
		this.signalled = new Set([...this.signalled].filter((key) => !key.startsWith(prefix)));
	}

	// Sockets

	/** A socket for `player`, greeted with a welcome message. */
	connect(transport: Transport, player: PlayerRecord): Connection {
		const connection = new Connection(transport, player.playerId, player.handle, this.log);
		this.connections.add(connection);
		connection.send({
			type: 'welcome',
			protocol: PROTOCOL_VERSION,
			player_id: player.playerId,
			name: player.handle
		});
		return connection;
	}

	private runner(tableId: string): TableRunner {
		const runner = this.manager.get(tableId);
		if (runner === null || this.closing.has(tableId)) {
			throw new RequestError('unknown_table', GONE);
		}
		return runner;
	}

	private tableMessage(
		runner: TableRunner,
		playerId: string,
		events: readonly TableEvent[] = []
	): p.TableMessage {
		return {
			type: 'table',
			table_id: runner.tableId,
			view: tableView(runner, playerId),
			events: tableEvents(events)
		};
	}

	async join(connection: Connection, tableId: string): Promise<void> {
		const runner = this.runner(tableId);
		const playerId = connection.playerId;
		if (runner.private && !connection.tables.has(tableId) && !runner.isMember(playerId)) {
			// Only its people may follow a private table; to others it does not exist.
			throw new RequestError('unknown_table', GONE);
		}
		if (!connection.tables.has(tableId) && connection.tables.size >= MAX_SUBSCRIPTIONS) {
			throw new RequestError('bad_request', `follow at most ${MAX_SUBSCRIPTIONS} tables`);
		}
		await runner.lock.run(() => {
			if (!connection.tables.has(tableId)) {
				const listener: Listener = (r, events) =>
					connection.send(this.tableMessage(r, playerId, events));
				runner.listeners.push(listener);
				connection.tables.set(tableId, listener);
				const key = `${tableId}\n${playerId}`;
				this.watchers.set(key, (this.watchers.get(key) ?? 0) + 1);
			}
			connection.send(this.tableMessage(runner, playerId));
		});
		if (runner.table.seatOf(playerId) !== null) await runner.setConnected(playerId, true);
	}

	async unfollow(connection: Connection, tableId: string): Promise<void> {
		const listener = connection.tables.get(tableId);
		if (listener === undefined) return;
		connection.tables.delete(tableId);
		const runner = this.manager.get(tableId);
		if (runner !== null) {
			const at = runner.listeners.indexOf(listener);
			if (at !== -1) runner.listeners.splice(at, 1);
		}
		const key = `${tableId}\n${connection.playerId}`;
		const count = (this.watchers.get(key) ?? 0) - 1;
		if (count > 0) {
			this.watchers.set(key, count);
			return;
		}
		this.watchers.delete(key);
		if (
			runner !== null &&
			!this.closing.has(tableId) &&
			runner.table.seatOf(connection.playerId) !== null
		) {
			try {
				await runner.setConnected(connection.playerId, false);
			} catch (error) {
				if (!(error instanceof TableError)) throw error;
			}
		}
	}

	/** Act on one message from a socket. Rejects with `TableError` or `RequestError` on a refusal. */
	async handle(connection: Connection, message: ClientMessage): Promise<void> {
		const playerId = connection.playerId;
		const tableId = message.table_id;
		if (message.type === 'join_table') {
			await this.join(connection, tableId);
			return;
		}
		const runner = this.runner(tableId);
		if (!connection.tables.has(tableId)) {
			throw new RequestError('not_subscribed', 'join the table first');
		}
		switch (message.type) {
			case 'refresh':
				await runner.lock.run(() => connection.send(this.tableMessage(runner, playerId)));
				break;
			case 'leave_table':
				if (runner.table.seatOf(playerId) !== null) await runner.leave(playerId);
				// A seat held for someone who walked away goes to the next player.
				if (runner.table.reservationOf(playerId) !== null) {
					await runner.cancelReservation(playerId);
				}
				await this.unfollow(connection, tableId);
				connection.send({ type: 'left_table', table_id: tableId });
				break;
			case 'sit':
				if (runner.practice !== null) throw new RequestError('bad_request', PRACTICE_REFUSED);
				await this.payIn(playerId, message.buy_in, 'buy_in', tableId);
				try {
					await runner.sit(message.seat, playerId, connection.name, message.buy_in);
				} catch (error) {
					await this.refund(playerId, message.buy_in, tableId);
					throw error;
				}
				break;
			case 'react':
				this.react(connection, runner, message.reaction);
				break;
			case 'sit_out':
				await runner.sitOut(playerId);
				break;
			case 'sit_in':
				await runner.sitIn(playerId);
				break;
			case 'rebuy':
				if (runner.practice !== null) {
					// A fresh practice stack, whatever amount was asked for; the wallet is not touched.
					await runner.refill(playerId);
					break;
				}
				await this.payIn(playerId, message.amount, 'rebuy', tableId);
				try {
					await runner.rebuy(playerId, message.amount);
				} catch (error) {
					await this.refund(playerId, message.amount, tableId);
					throw error;
				}
				break;
			case 'act': {
				const amount = message.amount ?? null;
				const sized = message.action === 'bet' || message.action === 'raise';
				if (sized !== (amount !== null)) {
					throw new RequestError(
						'bad_request',
						'bets and raises need an amount, other actions none'
					);
				}
				await runner.act(playerId, Action.of(message.action, amount), message.seq);
				break;
			}
		}
	}

	async closeConnection(connection: Connection): Promise<void> {
		connection.closed = true;
		this.connections.delete(connection);
		for (const tableId of [...connection.tables.keys()]) await this.unfollow(connection, tableId);
	}
}

function inviteMatches(runner: TableRunner, invite: string | null): boolean {
	return runner.invite !== null && invite !== null && sameText(runner.invite, invite);
}

/** A seating refusal over HTTP: 409 when someone else has the seat, else 400. */
function seatingError(error: unknown): unknown {
	if (!(error instanceof TableError)) return error;
	const taken = error.code === 'seat_taken' || error.code === 'already_seated';
	return new HttpError(taken ? 409 : 400, error.message);
}

/** What a closing table owes the people still seated. Practice chips never came from a wallet. */
function seatedChips(runner: TableRunner): Credit[] {
	const table = runner.table;
	const departures = table.drainDepartures();
	if (runner.practice !== null) return [];
	const credits = creditsFor(runner.tableId, departures);
	for (const [seat, player] of table.players()) {
		const chips = table.stackOf(seat) + player.pendingRebuy;
		if (player.bot === null && chips > 0) {
			credits.push({
				playerId: player.playerId,
				amount: chips,
				kind: 'cash_out',
				tableId: runner.tableId
			});
		}
	}
	return credits;
}

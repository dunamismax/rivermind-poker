// The browser side of the no-limit table (protocol v2, P3.6). The page first
// asks the server who this browser is (`POST /api/session`, P4.1), which sets
// the session cookie that authenticates everything after. One WebSocket says
// hello and follows the player's table. Each
// `table` message carries this player's whole view, so the newest one is all
// the page needs; its events feed the hand log. Actions carry the view's `seq`,
// so an action meant for an earlier turn is refused rather than misapplied.
// After a dropped connection or a server restart the socket says hello again
// and rejoins with backoff. The table is kept in localStorage so a reload
// rejoins it; the player lives in the cookie, which the page cannot read.
//
// The lobby (P4.3) seats the player over HTTP: quick seat, a seat at a listed
// or invited table, or a place on a waitlist. A seat that is not free yet (a
// bot is finishing its hand) is held, and the page sits in it as soon as the
// table says it is ready.
//
// Practice (P6.0b): one request seats the player heads-up against RiverMind
// Easy with practice chips, whatever the wallet holds, and asking again
// returns the same table. A `rebuy` there refills a player who ran out.
//
// Safety (P4.5): seated people send preset reactions, which show beside their
// seat for a few seconds, and anyone can mute, block or report the person in
// a seat. The server leaves out reactions from muted and blocked players.

import type {
	ActMessage,
	ActionKind,
	ClientMessage,
	NewTableRequest,
	Reaction,
	RelationItem,
	RelationKind,
	ReportReason,
	QuickSeatRequest,
	SeatRequest,
	SeatResponse,
	ServerMessage,
	TableEvent,
	TableView
} from '../protocol-v2.ts';
import {
	createTable,
	fetchRelations,
	fetchWallet,
	giveUpSeat,
	joinWaitlist,
	leaveWaitlist,
	quickSeat,
	removeRelation,
	reportSeat,
	setRelation,
	startPractice,
	startSession,
	takeSeat
} from './api.ts';
import { REACTION_MS } from './safety.ts';

/** Where a Phase 3 page kept its player and bearer token, until P4.1. */
export const LEGACY_PLAYER_KEY = 'rivermind.nl.player';
export const TABLE_KEY = 'rivermind.nl.table';
export const MAX_BACKOFF_MS = 8000;
export const LOG_LIMIT = 60;
export const CLOSED_TABLE_MESSAGE = 'That table has closed. Start a new one.';
/** Where the short-deck client kept its seat, until the cutover (P3.7). */
export const LEGACY_SEAT_KEY = 'rivermind.seat';
export const LEGACY_CLOSED_MESSAGE =
	'The short-deck tables have closed. RiverMind Poker now plays no-limit hold’em: start a table below.';

/**
 * A logged event with the name of the player in its seat when it happened, so
 * the log still names a player who has since left and someone else sat down.
 */
export type LoggedEvent = TableEvent & { who: string | null };

/** A reaction showing beside a seat. */
export interface ShownReaction {
	id: number;
	ref: string;
	text: string;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed';

export interface Player {
	player_id: string;
	name: string;
}

/** The part of the WebSocket API the connection uses. */
export interface SocketLike {
	readonly readyState: number;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: unknown) => void) | null;
	send(data: string): void;
	close(): void;
}

export type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface ConnectionOptions {
	connect?: () => SocketLike;
	storage?: Storage | null;
	fetcher?: typeof fetch;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	/** Seconds since the epoch, for the clock offset. */
	now?: () => number;
}

const OPEN = 1;

export function backoff(retries: number): number {
	return Math.min(1000 * 2 ** retries, MAX_BACKOFF_MS);
}

function sameOriginSocket(): SocketLike {
	const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
	return new WebSocket(`${scheme}://${location.host}/ws`) as unknown as SocketLike;
}

function defaultStorage(): Storage | null {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

function legacyToken(value: unknown): value is { token: string } {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as Record<string, unknown>).token === 'string'
	);
}

/** The name in the event's seat when it happened: before this change, unless it is the arrival. */
function whoWas(event: TableEvent, before: TableView | null, after: TableView): string | null {
	if (event.seat === null || event.seat === undefined) return null;
	if (event.kind === 'seated' && event.name) return event.name;
	return before?.seats[event.seat]?.name ?? after.seats[event.seat]?.name ?? null;
}

export class NlConnection {
	player = $state<Player | null>(null);
	/** Play chips in the wallet, not counting chips at the table (P4.2). */
	balance = $state<number | null>(null);
	tableId = $state<string | null>(null);
	view = $state<TableView | null>(null);
	/** Recent public events at the table, oldest first. */
	log = $state<LoggedEvent[]>([]);
	status = $state<ConnectionStatus>('idle');
	connected = $state(false);
	/** An action was sent and the table has not answered yet. */
	pending = $state(false);
	notice = $state<{ id: number; text: string } | null>(null);
	closedMessage = $state<string | null>(null);
	/** Local clock minus the server's, in seconds, for the turn timers. */
	clockOffset = $state(0);
	/** Seat -> the reaction showing beside it (P4.5). */
	reactions = $state<Record<number, ShownReaction>>({});
	/** Everyone this player muted or blocked. */
	relations = $state<RelationItem[]>([]);
	retries = 0;

	/** Sit as soon as the held seat is ready, with this buy-in (null: as much as fits). */
	#autoSit: { buyIn: number | null } | null = null;
	#socket: SocketLike | null = null;
	#timer: unknown = null;
	#notices = 0;
	#reactionIds = 0;
	#connect: () => SocketLike;
	#storage: Storage | null;
	#fetch: typeof fetch;
	#setTimer: (callback: () => void, ms: number) => unknown;
	#clearTimer: (handle: unknown) => void;
	#now: () => number;

	constructor(options: ConnectionOptions = {}) {
		this.#connect = options.connect ?? sameOriginSocket;
		this.#storage = options.storage === undefined ? defaultStorage() : options.storage;
		this.#fetch = options.fetcher ?? ((...args) => fetch(...args));
		this.#setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
		this.#clearTimer =
			options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
		this.#now = options.now ?? (() => Date.now() / 1000);
	}

	/**
	 * Find out who this browser is (making a player on the first visit), then
	 * rejoin the table saved by an earlier page load. Returns whether there was one.
	 */
	async start(): Promise<boolean> {
		if (this.#storage?.getItem(LEGACY_SEAT_KEY) != null) {
			this.#remove(LEGACY_SEAT_KEY);
			this.closedMessage = LEGACY_CLOSED_MESSAGE;
		}
		try {
			await this.#session();
			void this.loadRelations();
		} catch {
			// The server may be restarting; the socket retries, and its welcome names the player.
		}
		const tableId = this.#load(TABLE_KEY, (v): v is string => typeof v === 'string');
		if (!tableId) return false;
		this.#follow(tableId);
		return true;
	}

	/** Start a table with bots and sit at it. */
	async newTable(request: NewTableRequest): Promise<void> {
		const created = await this.#withSession(() => createTable(request, this.#fetch));
		this.#autoSit = null;
		this.#follow(created.table_id);
		void this.refreshBalance();
	}

	/** Practise heads-up against RiverMind Easy, at the player's practice table. */
	async practice(): Promise<void> {
		const started = await this.#withSession(() => startPractice(this.#fetch));
		this.#autoSit = null;
		if (this.tableId !== started.table_id || !this.#socket) this.#follow(started.table_id);
	}

	/** A fresh practice stack, for a player out of chips at a practice table. */
	refill(): boolean {
		const view = this.view;
		if (!view?.practice) return false;
		return this.rebuy(view.settings.max_buy_in);
	}

	/** A seat at the busiest matching table, or a new table with bots. */
	async quickSeat(request: QuickSeatRequest): Promise<void> {
		const seat = await this.#withSession(() => quickSeat(request, this.#fetch));
		this.#arrive(seat, request.buy_in ?? null);
	}

	/**
	 * Take a seat at a listed or invited table. A seat that is not free yet is
	 * held, and taken as soon as it is ready; `hold_only` just holds it.
	 */
	async takeSeat(tableId: string, request: SeatRequest = {}): Promise<void> {
		const seat = await this.#withSession(() => takeSeat(tableId, request, this.#fetch));
		if (request.hold_only) {
			if (this.tableId !== tableId) this.#follow(tableId);
			return;
		}
		this.#arrive(seat, request.buy_in ?? null);
	}

	/** Follow a table without a seat, or go back to the one the player has. */
	watch(tableId: string): void {
		this.#autoSit = null;
		this.#follow(tableId);
	}

	/** From the table: hold an empty seat, to buy in with `sit`. */
	async holdSeat(seat: number): Promise<void> {
		const tableId = this.tableId;
		if (tableId)
			await this.#withSession(() => takeSeat(tableId, { seat, hold_only: true }, this.#fetch));
	}

	/** Sit in the seat held for the player, buying in for `buyIn`. */
	sit(seat: number, buyIn: number): boolean {
		const tableId = this.tableId;
		if (!tableId) return false;
		const sent = this.#send({ type: 'sit', table_id: tableId, seat, buy_in: buyIn }, false);
		if (sent) setTimeout(() => void this.refreshBalance(), 500);
		return sent;
	}

	/** Give up the seat held at `tableId` (the current table by default). */
	async giveUpHold(tableId: string | null = this.tableId): Promise<void> {
		this.#autoSit = null;
		if (tableId) await giveUpSeat(tableId, this.#fetch);
	}

	async joinWaitlist(tableId: string, invite: string | null = null): Promise<number> {
		return (await this.#withSession(() => joinWaitlist(tableId, invite, this.#fetch))).position;
	}

	async leaveWaitlist(tableId: string): Promise<void> {
		await leaveWaitlist(tableId, this.#fetch);
	}

	#arrive(seat: SeatResponse, buyIn: number | null): void {
		this.#autoSit = seat.seated ? null : { buyIn };
		this.#follow(seat.table_id);
		void this.refreshBalance();
	}

	/** Run an HTTP call, starting a new session once if the old one ended. */
	async #withSession<T>(call: () => Promise<T>): Promise<T> {
		if (!this.player) await this.#session();
		try {
			return await call();
		} catch (error) {
			if ((error as { status?: number }).status !== 401) throw error;
			// The session ended (it expired, or the server's secret changed): start a new one.
			await this.#session();
			return await call();
		}
	}

	async #session(): Promise<void> {
		const legacy = this.#load(LEGACY_PLAYER_KEY, legacyToken);
		const session = await startSession(legacy?.token ?? null, this.#fetch);
		this.player = { player_id: session.player_id, name: session.name };
		this.balance = session.balance;
		if (legacy) this.#remove(LEGACY_PLAYER_KEY);
	}

	/** Read the wallet again, as after leaving a table. */
	async refreshBalance(): Promise<void> {
		try {
			this.balance = (await fetchWallet(this.#fetch)).balance;
		} catch {
			// Shown again on the next successful read.
		}
	}

	/** Leave the table: give up the seat, forget the table and close the socket. */
	leave(): void {
		const tableId = this.tableId;
		if (tableId) this.#send({ type: 'leave_table', table_id: tableId }, false);
		this.#stop();
	}

	act(action: ActionKind, amount?: number): boolean {
		const view = this.view;
		if (!view || !view.you.legal) return false;
		const message: ActMessage = { type: 'act', table_id: view.table_id, seq: view.seq, action };
		if (amount !== undefined) message.amount = amount;
		return this.#send(message, true);
	}

	sitOut(): boolean {
		return this.tableId ? this.#send({ type: 'sit_out', table_id: this.tableId }, false) : false;
	}

	sitIn(): boolean {
		return this.tableId ? this.#send({ type: 'sit_in', table_id: this.tableId }, false) : false;
	}

	rebuy(amount: number): boolean {
		return this.tableId
			? this.#send({ type: 'rebuy', table_id: this.tableId, amount }, false)
			: false;
	}

	/** Send a preset reaction from the player's seat. */
	react(reaction: Reaction): boolean {
		return this.tableId
			? this.#send({ type: 'react', table_id: this.tableId, reaction }, false)
			: false;
	}

	/** Who this player muted or blocked, by public reference. */
	relationOf(ref: string | null): RelationKind | null {
		return ref ? (this.relations.find((r) => r.ref === ref)?.kind ?? null) : null;
	}

	async loadRelations(): Promise<void> {
		try {
			this.relations = await fetchRelations(this.#fetch);
		} catch {
			// Read again after the next change.
		}
	}

	/** Mute or block the person in a seat at this table. */
	async relate(seat: number, kind: RelationKind): Promise<void> {
		const tableId = this.tableId;
		if (!tableId) return;
		this.relations = await this.#withSession(() => setRelation(tableId, seat, kind, this.#fetch));
		if (this.reactions[seat]) this.#clearReaction(seat);
	}

	/** Unmute or unblock someone. */
	async unrelate(ref: string): Promise<void> {
		this.relations = await this.#withSession(() => removeRelation(ref, this.#fetch));
	}

	/** Report the person in a seat at this table. Resolves to false if it was already reported today. */
	async report(seat: number, reason: ReportReason): Promise<boolean> {
		const tableId = this.tableId;
		if (!tableId) return false;
		return this.#withSession(() => reportSeat(tableId, seat, reason, this.#fetch));
	}

	/** Show a short message, as for a refused request. */
	notify(text: string): void {
		this.notice = { id: ++this.#notices, text };
	}

	/** Close the socket without leaving, as a page unload does. */
	disconnect(): void {
		this.#closeSocket();
		this.status = 'idle';
	}

	#follow(tableId: string): void {
		this.#closeSocket();
		this.tableId = tableId;
		this.view = null;
		this.log = [];
		this.reactions = {};
		this.closedMessage = null;
		this.#save(TABLE_KEY, tableId);
		this.#open();
	}

	#stop(): void {
		this.#autoSit = null;
		this.#closeSocket();
		this.#remove(TABLE_KEY);
		this.tableId = null;
		this.view = null;
		this.log = [];
		this.reactions = {};
		this.status = 'idle';
	}

	#send(message: ClientMessage, isAction: boolean): boolean {
		const socket = this.#socket;
		if (!socket || socket.readyState !== OPEN || (isAction && this.pending)) return false;
		if (isAction) this.pending = true;
		socket.send(JSON.stringify(message));
		return true;
	}

	#open(): void {
		const tableId = this.tableId;
		if (!tableId) return;
		const socket = this.#connect();
		this.#socket = socket;
		this.status = 'connecting';
		socket.onopen = () => {
			if (this.#socket !== socket) return;
			this.connected = true;
			socket.send(JSON.stringify({ type: 'hello', protocol: 2 }));
			socket.send(JSON.stringify({ type: 'join_table', table_id: tableId }));
		};
		socket.onmessage = (event) => {
			if (this.#socket === socket) this.#receive(event.data);
		};
		socket.onclose = () => {
			if (this.#socket !== socket) return;
			this.#socket = null;
			this.connected = false;
			this.pending = false;
			if (!this.tableId) return;
			this.status = 'closed';
			const delay = backoff(this.retries);
			this.retries += 1;
			this.#timer = this.#setTimer(() => {
				this.#timer = null;
				if (this.tableId === tableId && !this.#socket) this.#open();
			}, delay);
		};
	}

	#receive(data: unknown): void {
		let message: ServerMessage;
		try {
			message = JSON.parse(String(data)) as ServerMessage;
		} catch {
			return;
		}
		switch (message.type) {
			case 'welcome':
				this.player = { player_id: message.player_id, name: message.name };
				return;
			case 'table': {
				if (message.table_id !== this.tableId) return;
				this.retries = 0;
				this.status = 'open';
				this.pending = false;
				const before = this.view?.table_id === message.table_id ? this.view : null;
				this.view = message.view;
				this.clockOffset = this.#now() - message.view.server_time;
				this.#sitWhenReady(message.view);
				if (message.events.length) {
					const logged = message.events.map((event) => ({
						...event,
						who: whoWas(event, before, message.view)
					}));
					this.log = [...this.log, ...logged].slice(-LOG_LIMIT);
				}
				return;
			}
			case 'reaction': {
				if (message.table_id !== this.tableId) return;
				const id = ++this.#reactionIds;
				const seat = message.seat;
				this.reactions = {
					...this.reactions,
					[seat]: { id, ref: message.ref, text: message.text }
				};
				this.#setTimer(() => {
					if (this.reactions[seat]?.id === id) this.#clearReaction(seat);
				}, REACTION_MS);
				return;
			}
			case 'left_table':
				return;
			case 'table_closed':
				if (message.table_id !== this.tableId) return;
				this.#stop();
				this.closedMessage = message.message;
				return;
			case 'error':
				this.pending = false;
				if (message.code === 'unknown_table') {
					this.#stop();
					this.closedMessage = CLOSED_TABLE_MESSAGE;
					return;
				}
				if (message.code === 'unauthorized') {
					this.player = null;
					this.#stop();
					this.closedMessage = message.message;
					return;
				}
				this.notice = { id: ++this.#notices, text: message.message };
				// The view may have moved on while the action was on its way
				// (but a refused reaction or a flood changed nothing).
				if (this.tableId && message.code !== 'rate_limited' && message.code !== 'not_seated')
					this.#send({ type: 'refresh', table_id: this.tableId }, false);
				return;
		}
	}

	#clearReaction(seat: number): void {
		const rest = { ...this.reactions };
		delete rest[seat];
		this.reactions = rest;
	}

	#sitWhenReady(view: TableView): void {
		const auto = this.#autoSit;
		if (!auto) return;
		const hold = view.you.hold;
		if (view.you.seat !== null || !hold) {
			// Seated, or the hold is gone (it ran out, or was given up).
			this.#autoSit = null;
			return;
		}
		if (!hold.ready) return;
		this.#autoSit = null;
		const most = view.settings.max_buy_in;
		const amount = auto.buyIn ?? Math.min(most, this.balance ?? most);
		this.sit(hold.seat, amount);
	}

	#closeSocket(): void {
		if (this.#timer !== null) this.#clearTimer(this.#timer);
		this.#timer = null;
		const socket = this.#socket;
		this.#socket = null;
		if (socket) socket.close();
		this.connected = false;
		this.pending = false;
		this.retries = 0;
	}

	#load<T>(key: string, check: (value: unknown) => value is T): T | null {
		try {
			const value: unknown = JSON.parse(this.#storage?.getItem(key) ?? 'null');
			return check(value) ? value : null;
		} catch {
			return null;
		}
	}

	#save(key: string, value: unknown): void {
		try {
			this.#storage?.setItem(key, JSON.stringify(value));
		} catch {
			// Private windows may refuse; it then lasts only this page.
		}
	}

	#remove(key: string): void {
		try {
			this.#storage?.removeItem(key);
		} catch {
			// ignore
		}
	}
}

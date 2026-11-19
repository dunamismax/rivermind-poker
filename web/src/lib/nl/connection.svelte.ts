// The browser side of the no-limit table (protocol v2, P3.6). One WebSocket
// says hello with the player's token and follows the player's table. Each
// `table` message carries this player's whole view, so the newest one is all
// the page needs; its events feed the hand log. Actions carry the view's `seq`,
// so an action meant for an earlier turn is refused rather than misapplied.
// After a dropped connection or a server restart the socket says hello again
// and rejoins with backoff. The player and table are kept in localStorage so
// a reload rejoins them.

import type {
	ActMessage,
	ActionKind,
	ClientMessage,
	NewPlayerResponse,
	NewTableRequest,
	ServerMessage,
	TableEvent,
	TableView
} from '../protocol-v2.ts';
import { createPlayer, createTable } from './api.ts';

export const PLAYER_KEY = 'rivermind.nl.player';
export const TABLE_KEY = 'rivermind.nl.table';
export const MAX_BACKOFF_MS = 8000;
export const LOG_LIMIT = 60;
export const CLOSED_TABLE_MESSAGE = 'That table has closed. Start a new one.';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed';

export type Player = NewPlayerResponse;

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

function isPlayer(value: unknown): value is Player {
	if (typeof value !== 'object' || value === null) return false;
	const p = value as Record<string, unknown>;
	return (
		typeof p.player_id === 'string' && typeof p.name === 'string' && typeof p.token === 'string'
	);
}

export class NlConnection {
	player = $state<Player | null>(null);
	tableId = $state<string | null>(null);
	view = $state<TableView | null>(null);
	/** Recent public events at the table, oldest first. */
	log = $state<TableEvent[]>([]);
	status = $state<ConnectionStatus>('idle');
	connected = $state(false);
	/** An action was sent and the table has not answered yet. */
	pending = $state(false);
	notice = $state<{ id: number; text: string } | null>(null);
	closedMessage = $state<string | null>(null);
	/** Local clock minus the server's, in seconds, for the turn timers. */
	clockOffset = $state(0);
	retries = 0;

	#socket: SocketLike | null = null;
	#timer: unknown = null;
	#notices = 0;
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

	/** Rejoin the table saved by an earlier page load. Returns whether there was one. */
	resume(): boolean {
		this.player = this.#load(PLAYER_KEY, isPlayer);
		const tableId = this.#load(TABLE_KEY, (v): v is string => typeof v === 'string');
		if (!this.player || !tableId) return false;
		this.#follow(tableId);
		return true;
	}

	/** Start a table with bots and sit at it, making a player first if needed. */
	async newTable(request: NewTableRequest): Promise<void> {
		if (!this.player) {
			this.player = await createPlayer(this.#fetch);
			this.#save(PLAYER_KEY, this.player);
		}
		let created;
		try {
			created = await createTable(this.player.token, request, this.#fetch);
		} catch (error) {
			if ((error as { status?: number }).status === 401) {
				// The server no longer knows this player (its secret changed): start afresh.
				this.#remove(PLAYER_KEY);
				this.player = null;
			}
			throw error;
		}
		this.#follow(created.table_id);
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
		this.closedMessage = null;
		this.#save(TABLE_KEY, tableId);
		this.#open();
	}

	#stop(): void {
		this.#closeSocket();
		this.#remove(TABLE_KEY);
		this.tableId = null;
		this.view = null;
		this.log = [];
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
		const player = this.player;
		const tableId = this.tableId;
		if (!player || !tableId) return;
		const socket = this.#connect();
		this.#socket = socket;
		this.status = 'connecting';
		socket.onopen = () => {
			if (this.#socket !== socket) return;
			this.connected = true;
			socket.send(JSON.stringify({ type: 'hello', token: player.token, protocol: 2 }));
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
				return;
			case 'table': {
				if (message.table_id !== this.tableId) return;
				this.retries = 0;
				this.status = 'open';
				this.pending = false;
				this.view = message.view;
				this.clockOffset = this.#now() - message.view.server_time;
				if (message.events.length) this.log = [...this.log, ...message.events].slice(-LOG_LIMIT);
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
					this.#remove(PLAYER_KEY);
					this.player = null;
					this.#stop();
					this.closedMessage = 'Your player is no longer known here. Start a new table.';
					return;
				}
				this.notice = { id: ++this.#notices, text: message.message };
				// The view may have moved on while the action was on its way.
				if (this.tableId) this.#send({ type: 'refresh', table_id: this.tableId }, false);
				return;
		}
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

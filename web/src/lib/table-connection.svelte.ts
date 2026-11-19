// The browser side of one seat: a WebSocket that joins with the seat's
// token, sends actions with the view's `seq`, and rejoins with backoff after
// a dropped connection or a server restart. The seat is kept in
// localStorage so a reload rejoins it. The server owns the game; this only
// holds the latest view it sent.

import type { Action, ClientMessage, JoinMessage, SeatView, ServerMessage } from './protocol.ts';

export const STORAGE_KEY = 'rivermind.seat';
export const MAX_BACKOFF_MS = 8000;
export const CLOSED_TABLE_MESSAGE = 'That table has closed. Start a new one.';

export interface Seat {
	table_id: string;
	token: string;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed';

/** The part of the WebSocket API the connection uses. */
export interface SocketLike {
	readonly readyState: number;
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: unknown) => void) | null;
	send(data: string): void;
	close(): void;
}

export type SeatStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface ConnectionOptions {
	/** Opens the socket; defaults to the same-origin `/ws`. */
	connect?: () => SocketLike;
	/** Defaults to localStorage, when the browser allows it. */
	storage?: SeatStorage | null;
	setTimer?: (callback: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

const OPEN = 1;

/** Reconnect delay after `retries` failed attempts: 1 s, 2 s, 4 s, then 8 s. */
export function backoff(retries: number): number {
	return Math.min(1000 * 2 ** retries, MAX_BACKOFF_MS);
}

function sameOriginSocket(): SocketLike {
	const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
	return new WebSocket(`${scheme}://${location.host}/ws`) as unknown as SocketLike;
}

function defaultStorage(): SeatStorage | null {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null; // e.g. storage disabled
	}
}

function isSeat(value: unknown): value is Seat {
	if (typeof value !== 'object' || value === null) return false;
	const seat = value as Record<string, unknown>;
	return typeof seat.table_id === 'string' && typeof seat.token === 'string';
}

export class TableConnection {
	/** The table this browser is seated at, or null in the lobby. */
	seat = $state<Seat | null>(null);
	view = $state<SeatView | null>(null);
	status = $state<ConnectionStatus>('idle');
	/** True while the socket is open, so actions can be sent. */
	connected = $state(false);
	/** A message was sent and its answer has not arrived. */
	pending = $state(false);
	/** The latest error to show, with an id so repeats are noticed. */
	notice = $state<{ id: number; text: string } | null>(null);
	/** Set when the server says the table or seat is gone. */
	closedMessage = $state<string | null>(null);
	retries = 0;

	#socket: SocketLike | null = null;
	#timer: unknown = null;
	#notices = 0;
	#connect: () => SocketLike;
	#storage: SeatStorage | null;
	#setTimer: (callback: () => void, ms: number) => unknown;
	#clearTimer: (handle: unknown) => void;

	constructor(options: ConnectionOptions = {}) {
		this.#connect = options.connect ?? sameOriginSocket;
		this.#storage = options.storage === undefined ? defaultStorage() : options.storage;
		this.#setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
		this.#clearTimer =
			options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	}

	/** Rejoin the seat saved by an earlier page load. Returns whether there was one. */
	resume(): boolean {
		const saved = this.#load();
		if (!saved) return false;
		this.join(saved);
		return true;
	}

	/** Sit at a table: remember the seat and connect. */
	join(seat: Seat): void {
		this.leave();
		this.seat = seat;
		this.closedMessage = null;
		this.#save(seat);
		this.#open();
	}

	/** Leave the table: forget the seat and close the socket. */
	leave(): void {
		this.#forget();
		this.seat = null;
		this.view = null;
		this.status = 'idle';
	}

	act(action: Action): boolean {
		if (!this.view) return false;
		return this.#send({ type: 'act', action, seq: this.view.seq });
	}

	nextHand(): boolean {
		if (!this.view) return false;
		return this.#send({ type: 'next_hand', seq: this.view.seq });
	}

	refresh(): boolean {
		return this.#send({ type: 'refresh' });
	}

	#send(message: ClientMessage): boolean {
		const socket = this.#socket;
		if (!socket || socket.readyState !== OPEN || this.pending) return false;
		this.pending = true;
		socket.send(JSON.stringify(message));
		return true;
	}

	#open(): void {
		const seat = this.seat;
		if (!seat) return;
		const socket = this.#connect();
		this.#socket = socket;
		this.status = 'connecting';
		socket.onopen = () => {
			if (this.#socket !== socket) return;
			this.connected = true;
			const join: JoinMessage = { type: 'join', table_id: seat.table_id, token: seat.token };
			socket.send(JSON.stringify(join));
		};
		socket.onmessage = (event) => {
			if (this.#socket !== socket) return;
			this.#receive(event.data);
		};
		socket.onclose = () => {
			if (this.#socket !== socket) return;
			this.#socket = null;
			this.connected = false;
			this.pending = false;
			if (!this.seat) return; // left the table or it closed
			this.status = 'closed';
			const delay = backoff(this.retries);
			this.retries += 1;
			this.#timer = this.#setTimer(() => {
				this.#timer = null;
				if (this.seat === seat && !this.#socket) this.#open();
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
		this.pending = false;
		if (message.type === 'view') {
			this.retries = 0;
			this.status = 'open';
			this.view = message.view;
			return;
		}
		if (message.code === 'unknown_table' || message.code === 'unknown_seat') {
			this.leave();
			this.closedMessage = CLOSED_TABLE_MESSAGE;
			return;
		}
		this.notice = { id: ++this.#notices, text: message.message };
		if (message.view) this.view = message.view;
	}

	#forget(): void {
		if (this.#timer !== null) this.#clearTimer(this.#timer);
		this.#timer = null;
		const socket = this.#socket;
		this.#socket = null;
		if (socket) socket.close();
		this.connected = false;
		this.pending = false;
		this.retries = 0;
		if (this.seat) this.#clear();
	}

	#load(): Seat | null {
		try {
			const value: unknown = JSON.parse(this.#storage?.getItem(STORAGE_KEY) ?? 'null');
			return isSeat(value) ? { table_id: value.table_id, token: value.token } : null;
		} catch {
			return null;
		}
	}

	#save(seat: Seat): void {
		try {
			this.#storage?.setItem(STORAGE_KEY, JSON.stringify(seat));
		} catch {
			// Private windows may refuse; the seat then lasts only this page.
		}
	}

	#clear(): void {
		try {
			this.#storage?.removeItem(STORAGE_KEY);
		} catch {
			// ignore
		}
	}
}

import { beforeEach, describe, expect, it } from 'vitest';
import type { SeatView, ServerMessage } from './protocol.ts';
import {
	CLOSED_TABLE_MESSAGE,
	STORAGE_KEY,
	TableConnection,
	backoff,
	type SocketLike
} from './table-connection.svelte.ts';

class MockSocket implements SocketLike {
	readyState = 0;
	sent: unknown[] = [];
	closed = false;
	onopen: SocketLike['onopen'] = null;
	onmessage: SocketLike['onmessage'] = null;
	onclose: SocketLike['onclose'] = null;

	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.closed = true;
		this.readyState = 3;
	}
	open() {
		this.readyState = 1;
		this.onopen?.({});
	}
	receive(message: ServerMessage) {
		this.onmessage?.({ data: JSON.stringify(message) });
	}
	drop() {
		this.readyState = 3;
		this.onclose?.({});
	}
}

class MemoryStorage {
	items = new Map<string, string>();
	getItem(key: string) {
		return this.items.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.items.set(key, value);
	}
	removeItem(key: string) {
		this.items.delete(key);
	}
}

function seatView(seq: number, partial: Partial<SeatView> = {}): SeatView {
	return {
		hand: 1,
		seq,
		seat: 0,
		stage: 'pre_flop',
		board: [],
		pot: 150,
		seats: [],
		your_turn: true,
		legal_actions: ['fold', 'call', 'raise'],
		action_amounts: { fold: 0, call: 50, raise: 150 },
		events: [],
		result: null,
		...partial
	};
}

const SEAT = { table_id: 'table-1', token: 'secret' };

describe('TableConnection', () => {
	let sockets: MockSocket[];
	let timers: { callback: () => void; ms: number; cleared: boolean }[];
	let storage: MemoryStorage;
	let connection: TableConnection;

	beforeEach(() => {
		sockets = [];
		timers = [];
		storage = new MemoryStorage();
		connection = new TableConnection({
			connect: () => {
				const socket = new MockSocket();
				sockets.push(socket);
				return socket;
			},
			storage,
			setTimer: (callback, ms) => {
				const timer = { callback, ms, cleared: false };
				timers.push(timer);
				return timer;
			},
			clearTimer: (timer) => {
				(timer as { cleared: boolean }).cleared = true;
			}
		});
	});

	function fire() {
		const timer = timers.shift();
		if (!timer || timer.cleared) throw new Error('no pending timer');
		timer.callback();
	}

	it('joins with the token, saves the seat and acts with the view’s seq', () => {
		connection.join(SEAT);
		expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual(SEAT);
		expect(connection.status).toBe('connecting');
		sockets[0].open();
		expect(sockets[0].sent).toEqual([{ type: 'join', ...SEAT }]);
		sockets[0].receive({ type: 'view', view: seatView(7) });
		expect(connection.status).toBe('open');
		expect(connection.view?.seq).toBe(7);

		expect(connection.act('call')).toBe(true);
		expect(sockets[0].sent.at(-1)).toEqual({ type: 'act', action: 'call', seq: 7 });
		expect(connection.pending).toBe(true);
		// One message in flight at a time, so a double click cannot act twice.
		expect(connection.act('call')).toBe(false);
		sockets[0].receive({ type: 'view', view: seatView(9, { result: null }) });
		expect(connection.pending).toBe(false);
		expect(connection.nextHand()).toBe(true);
		expect(sockets[0].sent.at(-1)).toEqual({ type: 'next_hand', seq: 9 });
	});

	it('shows a stale error and takes the current view it carries', () => {
		connection.join(SEAT);
		sockets[0].open();
		sockets[0].receive({ type: 'view', view: seatView(3) });
		connection.act('raise');
		sockets[0].receive({
			type: 'error',
			code: 'stale',
			message: 'The table has moved on (seq 5, request 3); refresh the view.',
			view: seatView(5, { your_turn: false, legal_actions: [], action_amounts: {} })
		});
		expect(connection.pending).toBe(false);
		expect(connection.notice?.text).toMatch(/moved on/);
		expect(connection.view?.seq).toBe(5);
		expect(connection.seat).toEqual(SEAT); // still seated
		const first = connection.notice?.id;
		sockets[0].receive({ type: 'error', code: 'stale', message: 'again', view: null });
		expect(connection.notice?.id).not.toBe(first);
		expect(connection.view?.seq).toBe(5);
	});

	it('reconnects with backoff and resets it once a view arrives', () => {
		connection.join(SEAT);
		sockets[0].open();
		sockets[0].receive({ type: 'view', view: seatView(1) });
		sockets[0].drop();
		expect(connection.status).toBe('closed');
		expect(connection.connected).toBe(false);
		expect(connection.act('call')).toBe(false);
		expect(timers.map((t) => t.ms)).toEqual([1000]);

		fire();
		expect(sockets).toHaveLength(2);
		sockets[1].drop(); // the server is still down
		fire();
		sockets[2].drop();
		expect(timers.map((t) => t.ms)).toEqual([4000]);
		fire();
		sockets[3].open();
		expect(sockets[3].sent).toEqual([{ type: 'join', ...SEAT }]);
		sockets[3].receive({ type: 'view', view: seatView(1) });
		expect(connection.retries).toBe(0);
		expect(connection.status).toBe('open');
		expect([0, 1, 2, 3, 4, 10].map(backoff)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
	});

	it('resumes a saved seat and ignores a malformed one', () => {
		storage.setItem(STORAGE_KEY, JSON.stringify(SEAT));
		expect(connection.resume()).toBe(true);
		expect(connection.seat).toEqual(SEAT);
		connection.leave();
		storage.setItem(STORAGE_KEY, '{"table_id": 3}');
		expect(connection.resume()).toBe(false);
		storage.setItem(STORAGE_KEY, 'not json');
		expect(connection.resume()).toBe(false);
	});

	it('returns to the lobby when the table is gone', () => {
		connection.join(SEAT);
		sockets[0].open();
		sockets[0].receive({
			type: 'error',
			code: 'unknown_table',
			message: 'That table no longer exists.',
			view: null
		});
		expect(connection.seat).toBeNull();
		expect(connection.closedMessage).toBe(CLOSED_TABLE_MESSAGE);
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
		sockets[0].drop(); // the server closes the socket; no reconnect follows
		expect(timers.filter((t) => !t.cleared)).toEqual([]);
	});

	it('leaving forgets the seat, closes the socket and cancels a reconnect', () => {
		connection.join(SEAT);
		sockets[0].open();
		sockets[0].drop();
		connection.leave();
		expect(timers[0].cleared).toBe(true);
		expect(connection.seat).toBeNull();
		expect(connection.status).toBe('idle');
		expect(storage.getItem(STORAGE_KEY)).toBeNull();
		connection.join(SEAT);
		connection.leave();
		expect(sockets[1].closed).toBe(true);
	});

	it('works without storage', () => {
		const bare = new TableConnection({ connect: () => new MockSocket(), storage: null });
		bare.join(SEAT);
		expect(bare.resume()).toBe(false);
		expect(bare.seat).toEqual(SEAT);
	});
});

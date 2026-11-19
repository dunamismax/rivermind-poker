import { describe, expect, it } from 'vitest';
import type { TableView } from '../protocol-v2.ts';
import {
	CLOSED_TABLE_MESSAGE,
	LEGACY_CLOSED_MESSAGE,
	LEGACY_SEAT_KEY,
	NlConnection,
	PLAYER_KEY,
	TABLE_KEY,
	backoff,
	type SocketLike
} from './connection.svelte.ts';

class MockSocket implements SocketLike {
	readyState = 0;
	sent: Record<string, unknown>[] = [];
	closed = false;
	onopen: ((event: unknown) => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: unknown) => void) | null = null;
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.closed = true;
	}
	open() {
		this.readyState = 1;
		this.onopen?.({});
	}
	receive(message: unknown) {
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

const PLAYER = { player_id: 'p_1', name: 'Guest 1234', token: 'p_1.sig' };

function view(seq: number, legal = true): TableView {
	return {
		table_id: 't1',
		name: 'Table',
		seq,
		server_time: 1000,
		settings: {
			seat_count: 2,
			small_blind: 50,
			big_blind: 100,
			ante: 0,
			min_buy_in: 4000,
			max_buy_in: 10000,
			action_seconds: 20,
			time_bank_seconds: 30
		},
		seats: [null, null],
		hand: null,
		turn: null,
		you: {
			player_id: 'p_1',
			seat: 0,
			legal: legal
				? {
						can_fold: true,
						can_check: false,
						call: 50,
						raise_kind: 'raise',
						min_to: 200,
						max_to: 10000
					}
				: null,
			time_bank: 30,
			pending_rebuy: 0,
			sitting_out: false,
			sitting_out_next: false
		}
	};
}

function setup(saved = true) {
	const sockets: MockSocket[] = [];
	const timers: (() => void)[] = [];
	const storage = new MemoryStorage();
	if (saved) {
		storage.setItem(PLAYER_KEY, JSON.stringify(PLAYER));
		storage.setItem(TABLE_KEY, JSON.stringify('t1'));
	}
	const requests: { url: string; init?: RequestInit }[] = [];
	const fetcher = (async (url: string, init?: RequestInit) => {
		requests.push({ url, init });
		const body = url === '/api/players' ? PLAYER : { table_id: 't2', seat: 0 };
		return new Response(JSON.stringify(body), { status: 201 });
	}) as typeof fetch;
	const connection = new NlConnection({
		connect: () => {
			const socket = new MockSocket();
			sockets.push(socket);
			return socket;
		},
		storage,
		fetcher,
		setTimer: (callback) => timers.push(callback),
		clearTimer: () => {},
		now: () => 1002.5
	});
	return { connection, sockets, timers, storage, requests };
}

describe('NlConnection', () => {
	it('says hello and joins the saved table, then keeps the newest view', () => {
		const { connection, sockets } = setup();
		expect(connection.resume()).toBe(true);
		const socket = sockets[0];
		socket.open();
		expect(socket.sent).toEqual([
			{ type: 'hello', token: 'p_1.sig', protocol: 2 },
			{ type: 'join_table', table_id: 't1' }
		]);
		socket.receive({ type: 'welcome', protocol: 2, player_id: 'p_1', name: 'Guest 1234' });
		socket.receive({
			type: 'table',
			table_id: 't1',
			view: view(5),
			events: [{ seq: 5, kind: 'turn', seat: 0 }]
		});
		expect(connection.status).toBe('open');
		expect(connection.view?.seq).toBe(5);
		expect(connection.log).toHaveLength(1);
		expect(connection.clockOffset).toBe(2.5);
		socket.receive({ type: 'table', table_id: 'other', view: view(9), events: [] });
		expect(connection.view?.seq).toBe(5); // another table's message is ignored
	});

	it('sends actions with the view seq, one at a time', () => {
		const { connection, sockets } = setup();
		connection.resume();
		const socket = sockets[0];
		socket.open();
		socket.receive({ type: 'table', table_id: 't1', view: view(7), events: [] });
		expect(connection.act('raise', 400)).toBe(true);
		expect(connection.act('fold')).toBe(false); // waiting for the answer
		expect(socket.sent.at(-1)).toEqual({
			type: 'act',
			table_id: 't1',
			seq: 7,
			action: 'raise',
			amount: 400
		});
		socket.receive({
			type: 'error',
			code: 'stale',
			message: 'that action was for an earlier turn',
			table_id: 't1'
		});
		expect(connection.pending).toBe(false);
		expect(connection.notice?.text).toMatch(/earlier turn/);
		expect(socket.sent.at(-1)).toEqual({ type: 'refresh', table_id: 't1' });
		socket.receive({ type: 'table', table_id: 't1', view: view(8, false), events: [] });
		expect(connection.act('fold')).toBe(false); // not our turn
	});

	it('reconnects with backoff and rejoins', () => {
		const { connection, sockets, timers } = setup();
		connection.resume();
		sockets[0].open();
		sockets[0].drop();
		expect(connection.status).toBe('closed');
		expect(timers).toHaveLength(1);
		timers[0]();
		expect(sockets).toHaveLength(2);
		sockets[1].open();
		expect(sockets[1].sent.map((m) => m.type)).toEqual(['hello', 'join_table']);
		expect(backoff(0)).toBe(1000);
		expect(backoff(5)).toBe(8000);
	});

	it('forgets a closed table but keeps the player', () => {
		const { connection, sockets, storage } = setup();
		connection.resume();
		sockets[0].open();
		sockets[0].receive({ type: 'error', code: 'unknown_table', message: 'gone', table_id: 't1' });
		expect(connection.tableId).toBeNull();
		expect(connection.closedMessage).toBe(CLOSED_TABLE_MESSAGE);
		expect(storage.getItem(TABLE_KEY)).toBeNull();
		expect(storage.getItem(PLAYER_KEY)).not.toBeNull();
	});

	it('makes a player once, then starts tables with its token', async () => {
		const { connection, sockets, requests, storage } = setup(false);
		expect(connection.resume()).toBe(false);
		await connection.newTable({ seats: 6, bots: 'heuristic' });
		expect(requests.map((r) => r.url)).toEqual(['/api/players', '/api/tables']);
		expect(new Headers(requests[1].init?.headers).get('Authorization')).toBe('Bearer p_1.sig');
		expect(JSON.parse(String(requests[1].init?.body))).toEqual({ seats: 6, bots: 'heuristic' });
		expect(connection.tableId).toBe('t2');
		expect(JSON.parse(storage.getItem(TABLE_KEY) ?? 'null')).toBe('t2');
		await connection.newTable({ seats: 2 });
		expect(requests.filter((r) => r.url === '/api/players')).toHaveLength(1);
		expect(sockets.at(-2)?.closed).toBe(true); // the old socket was closed
	});

	it('tells a returning short-deck player that their table closed', () => {
		const { connection, storage, sockets } = setup(false);
		storage.setItem(LEGACY_SEAT_KEY, JSON.stringify({ table_id: 'old', token: 'x' }));
		expect(connection.resume()).toBe(false);
		expect(connection.closedMessage).toBe(LEGACY_CLOSED_MESSAGE);
		expect(storage.getItem(LEGACY_SEAT_KEY)).toBeNull();
		expect(sockets).toHaveLength(0);
	});

	it('leaves the table on request', () => {
		const { connection, sockets, storage } = setup();
		connection.resume();
		sockets[0].open();
		connection.leave();
		expect(sockets[0].sent.at(-1)).toEqual({ type: 'leave_table', table_id: 't1' });
		expect(sockets[0].closed).toBe(true);
		expect(storage.getItem(TABLE_KEY)).toBeNull();
		expect(connection.tableId).toBeNull();
	});
});

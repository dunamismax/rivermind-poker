import { describe, expect, it } from 'vitest';
import type { TableView } from '../protocol-v2.ts';
import {
	CLOSED_TABLE_MESSAGE,
	LEGACY_CLOSED_MESSAGE,
	LEGACY_SEAT_KEY,
	NlConnection,
	LEGACY_PLAYER_KEY,
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

const SESSION = { player_id: 'p_1', name: 'Quiet Heron 42', created: false, balance: 20000 };

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
			sitting_out_next: false,
			hold: null,
			waitlist_position: null
		},
		private: false,
		invite: null,
		holds: [],
		waitlist: 0
	};
}

function setup(saved = true, tableStatus = 201) {
	const sockets: MockSocket[] = [];
	const timers: (() => void)[] = [];
	const storage = new MemoryStorage();
	if (saved) storage.setItem(TABLE_KEY, JSON.stringify('t1'));
	const requests: { url: string; init?: RequestInit }[] = [];
	const fetcher = (async (url: string, init?: RequestInit) => {
		requests.push({ url, init });
		if (url === '/api/session') return new Response(JSON.stringify(SESSION), { status: 200 });
		if (url === '/api/wallet') {
			return new Response(JSON.stringify({ balance: 12000, notice: 'Play money', entries: [] }));
		}
		if (url === '/api/quick-seat') {
			const hold = { seat: 1, name: 'Quiet Heron 42', ready: false, until: null };
			return new Response(JSON.stringify({ table_id: 't3', seat: 1, seated: false, hold }));
		}
		if (tableStatus === 401) {
			tableStatus = 201; // the retry after a new session succeeds
			return new Response(JSON.stringify({ detail: 'Your session has ended.' }), { status: 401 });
		}
		return new Response(JSON.stringify({ table_id: 't2', seat: 0 }), { status: 201 });
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
	it('quick-seats, and sits as soon as the held seat is ready', async () => {
		const { connection, sockets, requests } = setup(false);
		await connection.start();
		await connection.quickSeat({ seats: 6, big_blind: null, buy_in: null });
		const quick = requests.find((r) => r.url === '/api/quick-seat');
		expect(JSON.parse(String(quick?.init?.body))).toEqual({
			seats: 6,
			big_blind: null,
			buy_in: null
		});
		expect(connection.tableId).toBe('t3');
		const socket = sockets[0];
		socket.open();
		const watching = (ready: boolean, seat: number | null = null): TableView => {
			const v = { ...view(3, false), table_id: 't3' };
			v.you = {
				...v.you,
				seat,
				hold: seat === null ? { seat: 1, name: 'Q', ready, until: ready ? 1060 : null } : null
			};
			return v;
		};
		// A bot finishes its hand first: nothing is sent yet.
		socket.receive({ type: 'table', table_id: 't3', view: watching(false), events: [] });
		expect(socket.sent.map((m) => m.type)).toEqual(['hello', 'join_table']);
		// Ready: the page buys in for as much as fits (the 10,000 maximum here) and sits.
		socket.receive({ type: 'table', table_id: 't3', view: watching(true), events: [] });
		expect(socket.sent.at(-1)).toEqual({ type: 'sit', table_id: 't3', seat: 1, buy_in: 10000 });
		socket.receive({ type: 'table', table_id: 't3', view: watching(false, 1), events: [] });
		socket.receive({ type: 'table', table_id: 't3', view: watching(true), events: [] });
		expect(socket.sent.filter((m) => m.type === 'sit')).toHaveLength(1); // only once
	});

	it('starts a session, says hello and joins the saved table, then keeps the newest view', async () => {
		const { connection, sockets, requests } = setup();
		expect(await connection.start()).toBe(true);
		expect(requests.map((r) => r.url)).toEqual(['/api/session']);
		expect(requests[0].init?.method).toBe('POST');
		expect(requests[0].init?.credentials).toBe('same-origin');
		expect(JSON.parse(String(requests[0].init?.body))).toEqual({});
		expect(connection.player).toEqual({ player_id: 'p_1', name: 'Quiet Heron 42' });
		expect(connection.balance).toBe(20000);
		const socket = sockets[0];
		socket.open();
		// The cookie authenticates the socket: no token is ever sent.
		expect(socket.sent).toEqual([
			{ type: 'hello', protocol: 2 },
			{ type: 'join_table', table_id: 't1' }
		]);
		socket.receive({ type: 'welcome', protocol: 2, player_id: 'p_1', name: 'Quiet Heron 42' });
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

	it('logs each event with the name in its seat at the time', async () => {
		const { connection, sockets } = setup();
		await connection.start();
		const socket = sockets[0];
		socket.open();
		const seat = (name: string, kind: 'human' | 'bot') => ({
			...{ seat: 1, name, kind, bot: kind === 'bot' ? 'random' : null, stack: 5000, bet: 0 },
			...{ in_hand: false, folded: false, all_in: false, sitting_out: false, leaving: false },
			...{ connected: true, has_cards: false, cards: null }
		});
		const withSeat = (seq: number, info: ReturnType<typeof seat>): TableView => ({
			...view(seq, false),
			seats: [null, info]
		});
		socket.receive({
			type: 'table',
			table_id: 't1',
			view: withSeat(4, seat('Bot 2', 'bot')),
			events: []
		});
		// The bot gives up its seat and a person sits down in it.
		socket.receive({
			type: 'table',
			table_id: 't1',
			view: withSeat(6, seat('Quiet Heron 42', 'human')),
			events: [
				{ seq: 5, kind: 'left', seat: 1, amount: 5000 },
				{ seq: 6, kind: 'seated', seat: 1, name: 'Quiet Heron 42', amount: 5000 }
			]
		});
		expect(connection.log.map((e) => [e.kind, e.who])).toEqual([
			['left', 'Bot 2'],
			['seated', 'Quiet Heron 42']
		]);
	});

	it('sends actions with the view seq, one at a time', async () => {
		const { connection, sockets } = setup();
		await connection.start();
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

	it('reconnects with backoff and rejoins', async () => {
		const { connection, sockets, timers } = setup();
		await connection.start();
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

	it('forgets a closed table but keeps the player', async () => {
		const { connection, sockets, storage } = setup();
		await connection.start();
		sockets[0].open();
		sockets[0].receive({ type: 'error', code: 'unknown_table', message: 'gone', table_id: 't1' });
		expect(connection.tableId).toBeNull();
		expect(connection.closedMessage).toBe(CLOSED_TABLE_MESSAGE);
		expect(storage.getItem(TABLE_KEY)).toBeNull();
		expect(connection.player?.player_id).toBe('p_1');
	});

	it('returns to the lobby with the server’s message when the session has ended', async () => {
		const { connection, sockets, storage } = setup();
		await connection.start();
		sockets[0].open();
		const message = 'Your session has ended. Reload the page to start a new one.';
		sockets[0].receive({ type: 'error', code: 'unauthorized', message, table_id: null });
		expect(connection.tableId).toBeNull();
		expect(connection.player).toBeNull();
		expect(connection.closedMessage).toBe(message);
		expect(storage.getItem(TABLE_KEY)).toBeNull();
	});

	it('moves a Phase 3 player onto a session cookie once', async () => {
		const { connection, storage, requests } = setup();
		storage.setItem(
			LEGACY_PLAYER_KEY,
			JSON.stringify({ player_id: 'p_1', name: 'Guest 1234', token: 'p_1.sig' })
		);
		await connection.start();
		expect(JSON.parse(String(requests[0].init?.body))).toEqual({ legacy_token: 'p_1.sig' });
		expect(storage.getItem(LEGACY_PLAYER_KEY)).toBeNull();
		expect(connection.tableId).toBe('t1');
	});

	it('still rejoins the saved table when the session request fails', async () => {
		const sockets: MockSocket[] = [];
		const storage = new MemoryStorage();
		storage.setItem(TABLE_KEY, JSON.stringify('t1'));
		const connection = new NlConnection({
			connect: () => {
				const socket = new MockSocket();
				sockets.push(socket);
				return socket;
			},
			storage,
			fetcher: (async () => new Response('', { status: 503 })) as typeof fetch
		});
		expect(await connection.start()).toBe(true);
		expect(connection.player).toBeNull();
		sockets[0].open();
		sockets[0].receive({ type: 'welcome', protocol: 2, player_id: 'p_1', name: 'Quiet Heron 42' });
		expect(connection.player).toEqual({ player_id: 'p_1', name: 'Quiet Heron 42' });
	});

	it('starts a session once, then starts tables with its cookie', async () => {
		const { connection, sockets, requests, storage } = setup(false);
		expect(await connection.start()).toBe(false);
		await connection.newTable({ seats: 6, bots: 'heuristic' });
		expect(requests.map((r) => r.url)).toEqual(['/api/session', '/api/tables', '/api/wallet']);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(connection.balance).toBe(12000); // the buy-in left the wallet
		expect(new Headers(requests[1].init?.headers).get('Authorization')).toBeNull();
		expect(requests[1].init?.credentials).toBe('same-origin');
		expect(JSON.parse(String(requests[1].init?.body))).toEqual({ seats: 6, bots: 'heuristic' });
		expect(connection.tableId).toBe('t2');
		expect(JSON.parse(storage.getItem(TABLE_KEY) ?? 'null')).toBe('t2');
		await connection.newTable({ seats: 2 });
		expect(requests.filter((r) => r.url === '/api/session')).toHaveLength(1);
		expect(sockets.at(-2)?.closed).toBe(true); // the old socket was closed
	});

	it('starts a new session and retries when the old one has ended', async () => {
		const { connection, requests } = setup(false, 401);
		await connection.start();
		await connection.newTable({ seats: 2 });
		expect(requests.map((r) => r.url).filter((url) => url !== '/api/wallet')).toEqual([
			'/api/session',
			'/api/tables',
			'/api/session',
			'/api/tables'
		]);
		expect(connection.tableId).toBe('t2');
	});

	it('tells a returning short-deck player that their table closed', async () => {
		const { connection, storage, sockets } = setup(false);
		storage.setItem(LEGACY_SEAT_KEY, JSON.stringify({ table_id: 'old', token: 'x' }));
		expect(await connection.start()).toBe(false);
		expect(connection.closedMessage).toBe(LEGACY_CLOSED_MESSAGE);
		expect(storage.getItem(LEGACY_SEAT_KEY)).toBeNull();
		expect(sockets).toHaveLength(0);
	});

	it('leaves the table on request', async () => {
		const { connection, sockets, storage } = setup();
		await connection.start();
		sockets[0].open();
		connection.leave();
		expect(sockets[0].sent.at(-1)).toEqual({ type: 'leave_table', table_id: 't1' });
		expect(sockets[0].closed).toBe(true);
		expect(storage.getItem(TABLE_KEY)).toBeNull();
		expect(connection.tableId).toBeNull();
	});
});

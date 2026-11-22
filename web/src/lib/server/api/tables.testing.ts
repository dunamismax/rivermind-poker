// A whole table server in one process for Vitest: the Site, the tables, the
// HTTP API and sockets over a fake transport, with seeded decks and a clock
// that only moves when a test says so. The counterpart of the helpers in
// test/server/test_protocol_v2.py.
import { expect } from 'vitest';
import type * as p from '../../protocol-v2.ts';
import { ManualClock } from '../table/clock.ts';
import { seededDealer, type Log, type RunnerOptions, type TableRunner } from '../table/runner.ts';
import type { TableStorage } from '../table/store.ts';
import { createApi, type ApiHandler } from './api.ts';
import { COOKIE_NAME } from './auth.ts';
import { UNLIMITED, type Limits } from './safety.ts';
import { Site, type SiteOptions } from './site.ts';
import { createSocketServer, type SocketServer, type SocketSession } from './socket.ts';
import { Tables, type TablesOptions } from './tables.ts';

export const SECRET = Buffer.from('test-secret-test-secret-test-sec');
export const ORIGIN = 'http://testserver';

export type Message = Record<string, never> & { type: string };
export type TableMessage = p.TableMessage;

/** Let timers, sockets and every table's loop run. */
export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A wait's patience: true for at least `turns` turns of the event loop and at
 * least ten seconds. Turns alone are not enough: a server saving to PostgreSQL
 * spends the wait idle, where a turn takes microseconds, and in CI 20,000 of
 * them passed before a few dozen saves had.
 */
function patience(turns: number): () => boolean {
	const deadline = Date.now() + 10_000;
	let taken = 0;
	return () => taken++ < turns || Date.now() < deadline;
}

/** Wait for something the server does on its own, such as closing a table. */
export async function waitFor(condition: () => boolean, describe = ''): Promise<void> {
	for (const patient = patience(20_000); patient();) {
		if (condition()) return;
		await tick();
	}
	throw new Error(`the server never got there ${describe}`.trim());
}

/** A log that keeps what was reported, so tests stay quiet and can read it. */
export function quietLog(): Log & { lines: string[] } {
	const lines: string[] = [];
	return {
		lines,
		info: (message) => void lines.push(`info: ${message}`),
		warn: (message) => void lines.push(`warn: ${message}`),
		error: (message, error) => void lines.push(`error: ${message} ${String(error ?? '')}`)
	};
}

export interface ServerOptions {
	/** Each table's deck comes from `seed * 1000`, `seed * 1000 + 1`, and so on. */
	seed?: number;
	limits?: Readonly<Limits>;
	runner?: Partial<RunnerOptions>;
	site?: Partial<SiteOptions>;
	tables?: Partial<TablesOptions>;
	store?: TableStorage | null;
	/** The wall clock, for sessions, wallets and reports. */
	now?: () => number;
	/** Whether pages offer table voice (`GET /api/voice`, P4C.6). */
	voiceOffered?: boolean;
}

export class TestServer {
	readonly clock: ManualClock;
	readonly site: Site;
	readonly tables: Tables;
	readonly api: ApiHandler;
	readonly sockets: SocketServer;
	readonly log = quietLog();
	/** Called with each table as it is made or restored, before its first change. */
	readonly onTable: ((runner: TableRunner) => void)[] = [];
	private readonly open = new Set<Socket>();

	constructor(options: ServerOptions = {}) {
		const seed = options.seed ?? 0;
		let next = seed * 1000;
		this.clock = (options.runner?.clock as ManualClock | undefined) ?? new ManualClock();
		this.site = new Site({
			secret: SECRET,
			limits: options.limits ?? UNLIMITED,
			clock: options.now,
			...options.site
		});
		this.tables = new Tables(this.site, {
			store: options.store ?? null,
			log: this.log,
			onTable: (runner) => this.onTable.forEach((hook) => hook(runner)),
			...options.tables,
			runner: {
				handPause: 0,
				botDelay: 0,
				requirePerson: true,
				// Yield to timers and sockets between steps instead of spinning in microtasks.
				sleep: tick,
				clock: this.clock,
				dealer: () => seededDealer(next++),
				log: this.log,
				...options.runner
			}
		});
		this.api = createApi(this.site, {
			tables: this.tables,
			voiceOffered: options.voiceOffered ?? false
		});
		this.sockets = createSocketServer(this.tables);
	}

	async start(): Promise<this> {
		await this.tables.start();
		return this;
	}

	async stop(): Promise<void> {
		for (const socket of [...this.open]) socket.close();
		await this.tables.stop();
	}

	runner(tableId: string): TableRunner {
		const runner = this.tables.manager.get(tableId);
		if (runner === null) throw new Error(`no table ${tableId}`);
		return runner;
	}

	async request(
		method: string,
		path: string,
		options: { body?: unknown; headers?: Record<string, string>; peer?: string } = {}
	): Promise<Response> {
		const headers = new Headers(options.headers ?? {});
		if (!headers.has('host')) headers.set('host', new URL(ORIGIN).host);
		let body: string | null = null;
		if (options.body !== undefined) {
			body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
			if (!headers.has('content-type')) headers.set('content-type', 'application/json');
		}
		return this.api(new Request(ORIGIN + path, { method, headers, body }), {
			peer: options.peer ?? 'testclient'
		});
	}

	/** A socket as a browser opens one; `cookie` is the whole `Cookie` header. */
	socket(
		cookie: string | null = null,
		peer = 'testclient',
		forwardedFor: string | null = null
	): Socket {
		const socket = new Socket(this.sockets, cookie, peer, forwardedFor, () =>
			this.open.delete(socket)
		);
		this.open.add(socket);
		return socket;
	}

	/** Wait until every socket's messages are handled and every table waits on a person or the clock. */
	async settle(): Promise<void> {
		let quiet = 0;
		for (const patient = patience(100_000); quiet < 3 && patient();) {
			await Promise.all([...this.open].map((socket) => socket.idle()));
			await this.tables.settled();
			await tick();
			const busy = [...this.tables.manager.tables.values()].some((runner) => {
				const table = runner.table;
				if (runner.lock.busy || runner.mayDeal()) return true;
				const seat = table.toAct;
				return seat !== null && table.seats[seat]?.bot !== null;
			});
			quiet = busy ? 0 : quiet + 1;
		}
		if (quiet < 3) throw new Error('the server never settled');
	}
}

/** One browser: a player made by `POST /api/session`, holding its own session cookie. */
export class Player {
	readonly server: TestServer;
	readonly playerId: string;
	readonly name: string;
	readonly session: string;

	private constructor(server: TestServer, playerId: string, name: string, session: string) {
		this.server = server;
		this.playerId = playerId;
		this.name = name;
		this.session = session;
	}

	static async create(server: TestServer, peer?: string): Promise<Player> {
		const response = await server.request('POST', '/api/session', { peer });
		expect(response.status).toBe(200);
		const body = (await response.json()) as p.SessionResponse;
		expect(body.created).toBe(true);
		const cookie = /rm_session=([^;]+)/.exec(response.headers.get('set-cookie') ?? '');
		if (!cookie) throw new Error('no session cookie was set');
		return new Player(server, body.player_id, body.name, cookie[1]);
	}

	/** The same player and session on another server, as after a restart. */
	static from(server: TestServer, player: Player): Player {
		return new Player(server, player.playerId, player.name, player.session);
	}

	get cookie(): string {
		return `${COOKIE_NAME}=${this.session}`;
	}

	headers(): Record<string, string> {
		return { cookie: this.cookie };
	}

	request(method: string, path: string, body?: unknown): Promise<Response> {
		return this.server.request(method, path, { body, headers: this.headers() });
	}

	async json<T = Record<string, never>>(method: string, path: string, body?: unknown): Promise<T> {
		return (await (await this.request(method, path, body)).json()) as T;
	}

	async newTable(
		seats: number,
		bots: string | null = 'random',
		extra: Record<string, unknown> = {}
	): Promise<string> {
		const response = await this.request('POST', '/api/tables', { seats, bots, ...extra });
		const text = await response.text();
		expect(response.status, text).toBe(201);
		const body = JSON.parse(text) as p.NewTableResponse;
		expect(body.seat).toBe(0);
		return body.table_id;
	}

	async balance(): Promise<number> {
		return (await this.json<p.WalletResponse>('GET', '/api/wallet')).balance;
	}

	/** An open socket that has said hello and been welcomed. */
	async socket(): Promise<Socket> {
		const socket = this.server.socket(this.cookie);
		socket.send({ type: 'hello', protocol: 2 });
		const welcome = await socket.receive();
		expect(welcome).toMatchObject({ type: 'welcome', player_id: this.playerId, name: this.name });
		return socket;
	}
}

export class Socket {
	readonly messages: Message[] = [];
	/** Table id -> the last table message received for it. */
	readonly latest = new Map<string, TableMessage>();
	/** Table id -> the seq of the last turn this socket acted on. */
	readonly answered = new Map<string, number>();
	/** The code the server closed the socket with, once it has. */
	closeCode: number | null = null;
	private readonly session: SocketSession;
	private readonly inbox: Message[] = [];
	private waiting: (() => void) | null = null;
	private gone = false;
	private readonly forget: () => void;

	constructor(
		sockets: SocketServer,
		cookie: string | null,
		peer: string,
		forwardedFor: string | null,
		forget: () => void
	) {
		this.forget = forget;
		this.session = sockets.open(
			{
				send: (text, sent) => {
					if (this.closeCode === null) this.inbox.push(JSON.parse(text) as Message);
					sent();
					this.wake();
				},
				close: (code) => {
					if (this.closeCode === null) this.closeCode = code;
					this.wake();
					// The server closing a socket ends it at both ends.
					this.close();
				}
			},
			{ cookie, peer, forwardedFor }
		);
	}

	private wake(): void {
		const waiting = this.waiting;
		this.waiting = null;
		waiting?.();
	}

	send(message: Record<string, unknown> | string): void {
		this.session.receive(typeof message === 'string' ? message : JSON.stringify(message));
	}

	/** The client goes away. */
	close(): void {
		if (this.gone) return;
		this.gone = true;
		this.forget();
		this.session.closed();
	}

	idle(): Promise<void> {
		return this.session.idle();
	}

	/** Messages that have arrived and not been received yet. */
	get pending(): number {
		return this.inbox.length;
	}

	/** The next message, waiting for it if need be. */
	async receive(): Promise<Message> {
		for (const patient = patience(200_000); !this.inbox.length && patient();) {
			if (this.closeCode !== null) throw new Error(`the socket closed (${this.closeCode})`);
			await new Promise<void>((resolve) => {
				this.waiting = resolve;
				// Nothing wakes a socket no message is coming for: look again soon.
				setImmediate(resolve);
			});
		}
		const message = this.inbox.shift();
		if (message === undefined) throw new Error('no message came');
		this.messages.push(message);
		if (message.type === 'table') {
			const table = message as unknown as TableMessage;
			this.latest.set(table.table_id, table);
		}
		return message;
	}

	/** Every message that has already arrived. */
	drain(): Message[] {
		const found: Message[] = [];
		while (this.inbox.length) {
			const message = this.inbox.shift() as Message;
			this.messages.push(message);
			if (message.type === 'table') {
				const table = message as unknown as TableMessage;
				this.latest.set(table.table_id, table);
			}
			found.push(message);
		}
		return found;
	}

	async until<T = Message>(predicate: (message: Message) => boolean, limit = 2_000): Promise<T> {
		for (let i = 0; i < limit; i++) {
			const message = await this.receive();
			if (predicate(message)) return message as unknown as T;
		}
		throw new Error('the expected message never came');
	}

	async error(): Promise<p.ErrorMessage> {
		return this.until<p.ErrorMessage>((m) => m.type === 'error');
	}

	async table(predicate: (message: TableMessage) => boolean = () => true): Promise<TableMessage> {
		return this.until<TableMessage>(
			(m) => m.type === 'table' && predicate(m as unknown as TableMessage)
		);
	}

	isNewTurn(message: Message | TableMessage | undefined, tableId: string): boolean {
		if (message === undefined || message.type !== 'table') return false;
		const table = message as unknown as TableMessage;
		if (table.table_id !== tableId || table.view.you.legal === null) return false;
		return (table.view.turn?.seq ?? 0) > (this.answered.get(tableId) ?? 0);
	}

	/**
	 * The view of the viewer's next turn not yet acted on. The last message
	 * already received may be that turn (the snapshot after joining often is),
	 * so it is checked before waiting for more.
	 */
	async myTurn(tableId: string): Promise<TableMessage> {
		const latest = this.latest.get(tableId);
		if (this.isNewTurn(latest, tableId)) return latest as TableMessage;
		return this.until<TableMessage>((m) => this.isNewTurn(m, tableId));
	}

	act(tableId: string, turn: TableMessage, action: string, amount: number | null = null): void {
		this.answered.set(tableId, turn.view.turn?.seq ?? 0);
		const message: Record<string, unknown> = {
			type: 'act',
			table_id: tableId,
			seq: turn.view.seq,
			action
		};
		if (amount !== null) message.amount = amount;
		this.send(message);
	}

	/** Check, call up to ten big blinds, or fold, so the player rarely busts. */
	play(tableId: string, turn: TableMessage): void {
		const view = turn.view;
		const legal = view.you.legal as p.Legal;
		let action = 'fold';
		if (legal.can_check) action = 'check';
		else if (legal.call <= 10 * view.settings.big_blind || !legal.can_fold) action = 'call';
		this.act(tableId, turn, action);
	}

	/** Play every turn at the table until a message for it matches `predicate`. */
	async playUntil(
		tableId: string,
		predicate: (message: TableMessage) => boolean,
		limit = 5_000
	): Promise<TableMessage> {
		for (let i = 0; i < limit; i++) {
			const latest = this.latest.get(tableId);
			if (latest !== undefined && predicate(latest)) return latest;
			if (this.isNewTurn(latest, tableId)) this.play(tableId, latest as TableMessage);
			await this.receive();
		}
		throw new Error('the expected message never came');
	}

	/** Join a table and return its first view. */
	async join(tableId: string): Promise<TableMessage> {
		this.send({ type: 'join_table', table_id: tableId });
		return this.table((m) => m.table_id === tableId);
	}
}

/** Records every seat's hole cards per hand, from inside the server. */
export class Spy {
	readonly holes = new Map<number, Map<number, string[]>>();

	constructor(runner: TableRunner) {
		runner.listeners.unshift((r) => {
			const hand = r.table.hand;
			if (hand === null) return;
			const seen = new Map<number, string[]>();
			hand.holeCards.forEach((hole, seat) => {
				if (hole !== null) seen.set(seat, hole.map(cardText));
			});
			this.holes.set(r.table.handNo, seen);
		});
	}
}

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';

function cardText(c: number): string {
	return RANKS[c >> 2] + SUITS[c & 3];
}

function cardsIn(value: unknown, found = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) cardsIn(item, found);
	} else if (typeof value === 'object' && value !== null) {
		const object = value as Record<string, unknown>;
		const keys = Object.keys(object);
		if (keys.length === 2 && 'rank' in object && 'suit' in object) {
			found.add(RANKS[(object.rank as number) - 2] + (object.suit as string)[0]);
		}
		for (const item of Object.values(object)) cardsIn(item, found);
	}
	return found;
}

/** No card of another seat appears unless that seat showed it. */
export function checkPrivacy(message: Message, spy: Spy): void {
	if (message.type !== 'table') return;
	const { view } = message as unknown as TableMessage;
	const hand = view.hand;
	if (hand === null) return;
	const holes = spy.holes.get(hand.hand_no);
	if (holes === undefined) throw new Error(`the spy never saw hand ${hand.hand_no}`);
	const shown = new Set(hand.result?.shown ?? []);
	const visible = cardsIn(message);
	for (const [seat, hole] of holes) {
		if (seat === view.you.seat || shown.has(seat)) continue;
		for (const c of hole) {
			if (visible.has(c)) {
				throw new Error(`S${seat}'s hidden cards leaked to ${String(view.you.seat)}`);
			}
		}
	}
	for (const info of view.seats) {
		if (info && info.cards !== null && info.seat !== view.you.seat) {
			expect(hand.result !== null && shown.has(info.seat)).toBe(true);
		}
	}
}

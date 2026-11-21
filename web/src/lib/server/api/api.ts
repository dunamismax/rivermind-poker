/**
 * The HTTP API of protocol v2, ported from `create_app` in
 * `rivermind/server/app.py` (P4B.5a): a fetch-style handler that takes a
 * `Request` and gives a `Response`, so Vitest drives it directly and
 * `src/routes/api/[...path]/+server.ts` serves it.
 *
 * Before any route, unsafe requests from pages on other origins are refused
 * and unsafe `/api/` requests are rate-limited, per player or, without a
 * session, per address. Errors are `{"detail": …}` with the Python server's
 * status codes and wording.
 *
 * Without `tables` it serves the routes that need no running table: the
 * config, the session, the wallet, the hand history and the mute and block
 * list. With them (P4B.5b) it also serves the lobby, seating, practice,
 * reports and new mutes or blocks, which name a seat at a running table.
 */
import type * as p from '../../protocol-v2.ts';
import {
	COOKIE_NAME,
	issueSession,
	isLoopback,
	originAllowed,
	publicRef,
	readSession,
	RENEW_AFTER_SECONDS,
	SESSION_SECONDS,
	verify
} from './auth.ts';
import { HttpError } from './errors.ts';
import { seatOf } from './hands.ts';
import {
	NewTableRequest,
	PROTOCOL_VERSION,
	PracticeRequest,
	QuickSeatRequest,
	RelationRequest,
	ReportRequest,
	SeatRequest,
	SessionRequest,
	WaitlistRequest
} from './protocol.ts';
import { clientAddress, REACTIONS } from './safety.ts';
import { STAKES, type Site } from './site.ts';
import { parseCookies } from './socket.ts';
import type { Tables } from './tables.ts';
import { Invalid, parseJson, type Schema } from './validate.ts';
import { handDetail, handSummary, tableSummary } from './views.ts';
import { PLAY_MONEY_NOTICE } from './wallet.ts';
import type { PlayerRecord } from './players.ts';

export const NO_SESSION_MESSAGE = 'Your session has ended. Reload the page to start a new one.';
const OTHER_SITE = 'Requests from other sites are not allowed.';
const TOO_MANY = 'Too many requests: wait a moment and try again.';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const HAND_PAGE = { default: 20, min: 1, max: 50 };

/** What the server knows about a request besides the request itself. */
export interface RequestInfo {
	/** The socket's remote address, before any `X-Forwarded-For`. */
	peer: string | null;
}

export type ApiHandler = (request: Request, info: RequestInfo) => Promise<Response>;

export interface ApiOptions {
	/** Origins besides the server's own whose pages may use the API, such as `https://example.com`. */
	allowedOrigins?: Iterable<string>;
	/** The running tables, for the lobby, seating, practice and safety routes (P4B.5b). */
	tables?: Tables | null;
}

export { HttpError };

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});
}

function errorResponse(error: HttpError): Response {
	const body: p.HttpError = { detail: error.message };
	return json(body, error.status, error.headers);
}

/** The cookies of a request, as Starlette reads them. */
export function cookies(request: Request): Map<string, string> {
	return parseCookies(request.headers.get('cookie'));
}

/** Secure everywhere except plain HTTP on this machine, where browsers would drop it. */
export function cookieIsSecure(url: URL, host: string | null): boolean {
	return !(['http:', 'ws:'].includes(url.protocol) && isLoopback(host ?? ''));
}

/** The `Set-Cookie` value Starlette writes for a session. */
export function sessionCookie(value: string, secure: boolean): string {
	return `${COOKIE_NAME}=${value}; HttpOnly; Max-Age=${SESSION_SECONDS}; Path=/; SameSite=lax${secure ? '; Secure' : ''}`;
}

/** Pydantic's lax integer from a query string: optional whitespace and sign, then digits. */
function queryInt(params: URLSearchParams, name: string, fallback: number): number {
	const text = params.get(name);
	if (text === null) return fallback;
	const trimmed = text.trim().replaceAll('_', '');
	if (!/^[+-]?[0-9]+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
		throw new HttpError(
			400,
			`Invalid request body: query.${name}: Input should be a valid integer, unable to parse string as an integer`
		);
	}
	return Number(trimmed);
}

/** An optional whole number from a query string. */
function queryIntOrNull(params: URLSearchParams, name: string): number | null {
	return params.has(name) ? queryInt(params, name, 0) : null;
}

const QUERY_TRUE = new Set(['1', 'on', 't', 'true', 'y', 'yes']);
const QUERY_FALSE = new Set(['0', 'off', 'f', 'false', 'n', 'no']);

/** Pydantic's lax boolean from a query string. */
function queryBool(params: URLSearchParams, name: string, fallback: boolean): boolean {
	const text = params.get(name);
	if (text === null) return fallback;
	const word = text.toLowerCase();
	if (QUERY_TRUE.has(word)) return true;
	if (QUERY_FALSE.has(word)) return false;
	throw new HttpError(
		400,
		`Invalid request body: query.${name}: Input should be a valid boolean, unable to interpret input`
	);
}

async function body<T>(request: Request, schema: Schema<T>, optional: true): Promise<T | null>;
async function body<T>(request: Request, schema: Schema<T>, optional?: false): Promise<T>;
async function body<T>(request: Request, schema: Schema<T>, optional = false): Promise<T | null> {
	const text = await request.text();
	if (!text) {
		if (optional) return null;
		throw new HttpError(400, 'Invalid request body: body: Field required');
	}
	try {
		if (optional && text.trim() === 'null') return null;
		return parseJson(schema, text);
	} catch (error) {
		if (!(error instanceof Invalid)) throw error;
		const first = error.issues[0];
		throw new HttpError(
			400,
			`Invalid request body: ${first.loc.join('.') || 'body'}: ${first.msg}`
		);
	}
}

type Route = (request: Request, params: string[], info: RequestInfo) => Promise<Response>;

/** A path and its routes by method, in the order `serve-nl` registers them. */
interface Entry {
	pattern: RegExp;
	methods: Partial<Record<string, Route>>;
}

export function createApi(site: Site, options: ApiOptions = {}): ApiHandler {
	const origins = new Set([...(options.allowedOrigins ?? [])].map((o) => o.replace(/\/+$/, '')));
	const limiters = site.limiters;
	const tables = options.tables ?? null;

	function address(request: Request, info: RequestInfo): string {
		return clientAddress(info.peer, request.headers.get('x-forwarded-for'));
	}

	/** A 429 when the player (or, without a session, the address) sends too many requests. */
	function overLimit(request: Request, path: string, info: RequestInfo): HttpError | null {
		const from = address(request, info);
		const session = readSession(site.secret, cookies(request).get(COOKIE_NAME), site.clock());
		const key = session ? `player:${session.playerId}` : `address:${from}`;
		let wait: number;
		if (!limiters.http.allow(key)) {
			wait = limiters.http.retryAfter(key);
		} else if (!session && path === '/api/session' && !limiters.newPlayer.allow(from)) {
			wait = limiters.newPlayer.retryAfter(from);
		} else {
			return null;
		}
		return new HttpError(429, TOO_MANY, { 'retry-after': String(Math.max(1, Math.round(wait))) });
	}

	async function playerOf(request: Request): Promise<PlayerRecord> {
		const session = await site.sessionPlayer(cookies(request).get(COOKIE_NAME));
		if (!session) throw new HttpError(401, NO_SESSION_MESSAGE);
		return session.player;
	}

	async function relationsResponse(playerId: string): Promise<Response> {
		const mine = await site.relationsOf(playerId);
		const response: p.RelationsResponse = {
			players: [...mine.values()].map((r) => ({
				ref: publicRef(r.targetId),
				name: r.handle,
				kind: r.kind
			}))
		};
		return json(response);
	}

	const config: Route = async () => {
		const response: p.ConfigResponse = {
			protocol: PROTOCOL_VERSION,
			bots: site.botOptions(),
			seat_counts: [2, 3, 4, 5, 6, 7, 8, 9],
			stakes: STAKES.map(([small, big]) => ({ small_blind: small, big_blind: big })),
			reactions: Object.entries(REACTIONS).map(([kind, text]) => ({
				kind: kind as p.Reaction,
				text
			})),
			practice_stack: site.practiceStack
		};
		return json(response);
	};

	/** The player this browser is, made on the first visit, with a fresh session cookie. */
	const session: Route = async (request, _params, info) => {
		const request_ = await body(request, SessionRequest, true);
		const now = site.clock();
		const current = await site.sessionPlayer(cookies(request).get(COOKIE_NAME));
		let record = current?.player ?? null;
		let created = false;
		if (!record && request_?.legacy_token) {
			const legacyId = verify(site.secret, request_.legacy_token);
			if (legacyId) record = await site.players.claim(legacyId);
		}
		if (!record) {
			record = await site.players.create();
			created = true;
		}
		const headers: Record<string, string> = {};
		if (!current || now - current.issued > RENEW_AFTER_SECONDS) {
			const secure = cookieIsSecure(new URL(request.url), request.headers.get('host'));
			headers['set-cookie'] = sessionCookie(
				issueSession(site.secret, record.playerId, now),
				secure
			);
		}
		site.noteAddress(record.playerId, address(request, info));
		await site.players.seen(record.playerId);
		const balance = await site.wallet.visit(record.playerId, now);
		const response: p.SessionResponse = {
			player_id: record.playerId,
			name: record.handle,
			created,
			balance
		};
		return json(response, 200, headers);
	};

	const wallet: Route = async (request) => {
		const player = await playerOf(request);
		const balance = await site.wallet.balance(player.playerId);
		const entries = await site.wallet.entries(player.playerId, 50);
		const response: p.WalletResponse = {
			balance,
			notice: PLAY_MONEY_NOTICE,
			entries: entries.map((e) => ({
				kind: e.kind,
				amount: e.amount,
				balance_after: e.balanceAfter,
				table_id: e.tableId,
				at: e.at
			}))
		};
		return json(response);
	};

	/** The finished hands the player was dealt into, newest first (P4.6). */
	const handList: Route = async (request) => {
		const params = new URL(request.url).searchParams;
		const asked = queryInt(params, 'limit', HAND_PAGE.default);
		const player = await playerOf(request);
		const limit = Math.max(HAND_PAGE.min, Math.min(asked, HAND_PAGE.max));
		const played = await site.hands.played(player.playerId, limit + 1, params.get('before'));
		const hands: p.HandSummary[] = [];
		for (const hand of played.slice(0, limit)) {
			const seat = seatOf(hand, player.playerId);
			if (seat !== null) hands.push(handSummary(hand, seat));
		}
		const response: p.HandListResponse = { hands, more: played.length > limit };
		return json(response);
	};

	/** A hand the player was dealt into, with every card they may see. */
	const hand: Route = async (request, [handId]) => {
		const player = await playerOf(request);
		const played = await site.hands.get(handId);
		const seat = played === null ? null : seatOf(played, player.playerId);
		if (played === null || seat === null) {
			throw new HttpError(404, 'No hand of yours has that number.');
		}
		return json(handDetail(played, seat));
	};

	const relations: Route = async (request) => {
		const player = await playerOf(request);
		return relationsResponse(player.playerId);
	};

	/** Unmute or unblock someone. */
	const removeRelation: Route = async (request, [ref]) => {
		const player = await playerOf(request);
		if (!(await site.removeRelation(player.playerId, ref))) {
			throw new HttpError(404, 'You have not muted or blocked that player.');
		}
		return relationsResponse(player.playerId);
	};

	const routes: Entry[] = [
		{ pattern: /^\/api\/config$/, methods: { GET: config } },
		{ pattern: /^\/api\/session$/, methods: { POST: session } },
		{ pattern: /^\/api\/wallet$/, methods: { GET: wallet } },
		{ pattern: /^\/api\/hands$/, methods: { GET: handList } },
		{ pattern: /^\/api\/hands\/([^/]+)$/, methods: { GET: hand } },
		{ pattern: /^\/api\/relations$/, methods: { GET: relations } },
		{ pattern: /^\/api\/relations\/([^/]+)$/, methods: { DELETE: removeRelation } }
	];
	if (tables !== null) addTableRoutes(tables);

	/** The routes that act on a running table (P4B.5b). */
	function addTableRoutes(tables: Tables): void {
		const newTable: Route = async (request) => {
			const asked = await body(request, NewTableRequest);
			const player = await playerOf(request);
			const made = await tables.createTable(player, asked);
			const response: p.NewTableResponse = {
				table_id: made.tableId,
				seat: made.seat,
				invite: made.invite
			};
			return json(response, 201);
		};

		const listTables: Route = async (request) => {
			const params = new URL(request.url).searchParams;
			const seats = queryIntOrNull(params, 'seats');
			const bigBlind = queryIntOrNull(params, 'big_blind');
			const open = queryBool(params, 'open', false);
			const player = await playerOf(request);
			const blocks = await site.safety.blocksInvolving(player.playerId);
			const response: p.TableListResponse = {
				tables: tables.listTables(player.playerId, seats, bigBlind, open, blocks)
			};
			return json(response);
		};

		const invite: Route = async (request, [code]) => {
			const player = await playerOf(request);
			const runner = tables.findInvite(code);
			if (runner === null) {
				throw new HttpError(404, 'That invite has expired: its table has closed.');
			}
			return json(tableSummary(runner, player.playerId));
		};

		const takeSeat: Route = async (request, [tableId]) => {
			const asked = await body(request, SeatRequest);
			const player = await playerOf(request);
			const runner = tables.seatingRunner(tableId, player.playerId, asked.invite);
			return json(await tables.takeSeat(player, runner, asked.seat, asked.buy_in, asked.hold_only));
		};

		/** Give up a held seat (not a seat already sat in: leave the table for that). */
		const giveUpSeat: Route = async (request, [tableId]) => {
			const player = await playerOf(request);
			const runner = tables.lobbyRunner(tableId, player.playerId);
			await runner.cancelReservation(player.playerId);
			return new Response(null, { status: 204 });
		};

		const joinWaitlist: Route = async (request, [tableId]) => {
			const asked = await body(request, WaitlistRequest);
			const player = await playerOf(request);
			const runner = tables.seatingRunner(tableId, player.playerId, asked.invite);
			const position = await tables.joinWaitlist(player, runner);
			const response: p.WaitlistResponse = { table_id: tableId, position };
			return json(response);
		};

		const leaveWaitlist: Route = async (request, [tableId]) => {
			const player = await playerOf(request);
			const runner = tables.lobbyRunner(tableId, player.playerId);
			await runner.leaveWaitlist(player.playerId);
			return new Response(null, { status: 204 });
		};

		const quickSeat: Route = async (request) => {
			const asked = await body(request, QuickSeatRequest);
			const player = await playerOf(request);
			return json(await tables.quickSeat(player, asked));
		};

		/** Start the guest's practice table, or return the one they have (P6.0b). */
		const practice: Route = async (request) => {
			const asked = await body(request, PracticeRequest, true);
			const player = await playerOf(request);
			return json(await tables.startPractice(player, asked?.bot ?? null));
		};

		/** Report the person in a seat for review (P4.5). */
		const report: Route = async (request) => {
			const asked = await body(request, ReportRequest);
			const player = await playerOf(request);
			const runner = tables.lobbyRunner(asked.table_id, player.playerId);
			const target = tables.personAt(runner, asked.seat, player.playerId);
			if (!limiters.report.allow(player.playerId)) {
				throw new HttpError(
					429,
					'You have sent several reports; wait a while before sending another.'
				);
			}
			const recorded = await site.safety.report({
				reporterId: player.playerId,
				targetId: target.playerId,
				targetHandle: target.handle,
				reason: asked.reason,
				tableId: runner.tableId,
				handNo: runner.table.handNo || null,
				at: site.clock()
			});
			if (recorded) {
				console.log(
					`${player.playerId} reported ${target.playerId} at table ${runner.tableId}: ${asked.reason}`
				);
			}
			const response: p.ReportResponse = { recorded };
			return json(response, 201);
		};

		/** Mute or block the person in a seat. */
		const setRelation: Route = async (request) => {
			const asked = await body(request, RelationRequest);
			const player = await playerOf(request);
			const runner = tables.lobbyRunner(asked.table_id, player.playerId);
			const target = tables.personAt(runner, asked.seat, player.playerId);
			await site.setRelation(player.playerId, target, asked.kind);
			return relationsResponse(player.playerId);
		};

		routes.find((r) => r.pattern.source === '^\\/api\\/relations$')!.methods.PUT = setRelation;
		routes.push(
			{ pattern: /^\/api\/tables$/, methods: { POST: newTable, GET: listTables } },
			{ pattern: /^\/api\/invites\/([^/]+)$/, methods: { GET: invite } },
			{
				pattern: /^\/api\/tables\/([^/]+)\/seat$/,
				methods: { POST: takeSeat, DELETE: giveUpSeat }
			},
			{
				pattern: /^\/api\/tables\/([^/]+)\/waitlist$/,
				methods: { POST: joinWaitlist, DELETE: leaveWaitlist }
			},
			{ pattern: /^\/api\/quick-seat$/, methods: { POST: quickSeat } },
			{ pattern: /^\/api\/practice$/, methods: { POST: practice } },
			{ pattern: /^\/api\/reports$/, methods: { POST: report } }
		);
	}

	return async function handle(request, info) {
		const url = new URL(request.url);
		const path = url.pathname;
		try {
			const unsafe = !SAFE_METHODS.has(request.method);
			if (
				unsafe &&
				!originAllowed(request.headers.get('origin'), request.headers.get('host'), origins)
			) {
				throw new HttpError(403, OTHER_SITE);
			}
			if (unsafe && path.startsWith('/api/')) {
				const refused = overLimit(request, path, info);
				if (refused) throw refused;
			}
			for (const { pattern, methods } of routes) {
				const match = pattern.exec(path);
				if (!match) continue;
				const route = methods[request.method];
				if (!route) {
					// Starlette names only the first route registered for the path.
					throw new HttpError(405, 'Method Not Allowed', { allow: Object.keys(methods)[0] });
				}
				const params = match.slice(1).map((part) => decodeURIComponent(part));
				return await route(request, params, info);
			}
			throw new HttpError(404, 'Not Found');
		} catch (error) {
			if (error instanceof HttpError) return errorResponse(error);
			throw error;
		}
	};
}

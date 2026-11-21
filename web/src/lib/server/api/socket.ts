/**
 * Protocol v2 over one WebSocket, ported from the `/ws` endpoint of
 * `rivermind/server/app.py` (P4B.5b). It knows nothing of the `ws` package:
 * the Node server (`web/server/app.ts`) hands it a {@link Transport} and the
 * frames that arrive, and Vitest drives it the same way.
 *
 * Every socket opens with a `hello`. The session cookie sent with the
 * handshake says who the player is. Messages are handled one at a time, in
 * the order they arrive; a refused one is answered with an `error` message
 * and changes nothing.
 */
import type * as p from '../../protocol-v2.ts';
import { TableError } from '../table/table.ts';
import { COOKIE_NAME, originAllowed } from './auth.ts';
import { RequestError } from './errors.ts';
import { ClientMessage, HelloMessage } from './protocol.ts';
import { clientAddress } from './safety.ts';
import type { Connection, Tables, Transport } from './tables.ts';
import { Invalid, parseJson } from './validate.ts';

export const RELOAD_MESSAGE = 'RiverMind Poker was updated. Reload the page to keep playing.';
export const NO_SESSION_MESSAGE = 'Your session has ended. Reload the page to start a new one.';
export const LEGACY_CLOSED =
	"The short-deck tables have closed: RiverMind Poker now plays no-limit hold'em. Reload the page to play.";
/** How long a new socket may take to say hello. */
export const HELLO_SECONDS = 30;
/** Close code for a socket refused for what it sent or who it is. */
export const CLOSE_POLICY = 1008;
/** Close code after the server failed while handling a message. */
export const CLOSE_INTERNAL = 1011;
/** The largest frame a client may send, as uvicorn's `ws_max_size` was for serve-nl. */
export const MAX_FRAME_BYTES = 64 * 1024;

/** What the server knows about a handshake. */
export interface Handshake {
	/** The `Cookie` header. */
	cookie: string | null | undefined;
	/** The socket's remote address, before any `X-Forwarded-For`. */
	peer: string | null | undefined;
	forwardedFor: string | null | undefined;
}

/** One open socket, as the Node server feeds it. */
export interface SocketSession {
	/** A text frame arrived. */
	receive(text: string): void;
	/** The client went away, or the socket was closed. */
	closed(): void;
	/** Resolves once everything received so far has been handled (for tests). */
	idle(): Promise<void>;
}

export interface SocketServer {
	/** Whether a handshake from a page on `origin` may open a socket to `host`. */
	allowed(origin: string | null | undefined, host: string | null | undefined): boolean;
	open(transport: Transport, handshake: Handshake): SocketSession;
}

export interface SocketOptions {
	allowedOrigins?: Iterable<string>;
	helloSeconds?: number;
}

function error(code: p.ErrorCode, message: string, tableId: string | null = null): p.ErrorMessage {
	return { type: 'error', code, message, table_id: tableId };
}

function parsed(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

function describeInvalid(text: string): string {
	const message = parsed(text);
	if (!isObject(message) || !('type' in message)) return 'Messages are JSON objects with a type.';
	const type = message.type;
	return `Invalid ${typeof type === 'string' ? type : JSON.stringify(type)} message.`;
}

/** The cookies of a `Cookie` header, as Starlette reads them. */
export function parseCookies(header: string | null | undefined): Map<string, string> {
	const found = new Map<string, string>();
	for (const chunk of (header ?? '').split(';')) {
		const eq = chunk.indexOf('=');
		const [name, value] = eq === -1 ? ['', chunk] : [chunk.slice(0, eq), chunk.slice(eq + 1)];
		const key = name.trim();
		if (key || value.trim()) found.set(key, value.trim());
	}
	return found;
}

export function createSocketServer(tables: Tables, options: SocketOptions = {}): SocketServer {
	const site = tables.site;
	const origins = new Set([...(options.allowedOrigins ?? [])].map((o) => o.replace(/\/+$/, '')));
	const helloSeconds = options.helloSeconds ?? HELLO_SECONDS;

	function open(transport: Transport, handshake: Handshake): SocketSession {
		const sendRaw = (message: p.ErrorMessage) => transport.send(JSON.stringify(message), () => {});
		let connection: Connection | null = null;
		let over = false;
		let greeted = false;
		let strikes = 0;
		const bucket = site.limiters.socket();
		// Everything is handled in arrival order, one message at a time.
		let chain: Promise<void> = Promise.resolve();
		const queue = (work: () => Promise<void> | void) => {
			chain = chain.then(work).catch((failure: unknown) => {
				console.error('A socket failed while handling a message:', failure);
				refuse(null, CLOSE_INTERNAL);
			});
		};

		/** Say why, if there is something to say, and close the socket. */
		function refuse(message: p.ErrorMessage | null, code = CLOSE_POLICY): void {
			if (over) return;
			over = true;
			clearTimeout(helloTimer);
			if (message !== null) sendRaw(message);
			transport.close(code);
		}

		const helloTimer = setTimeout(
			() => queue(() => refuse(error('bad_request', 'Send a hello message first.'))),
			helloSeconds * 1000
		);
		helloTimer.unref?.();

		async function hello(text: string): Promise<void> {
			clearTimeout(helloTimer);
			const message = parsed(text);
			if (isObject(message) && message.type === 'hello' && 'token' in message) {
				// A page loaded before P4.1: its token no longer opens a socket.
				refuse(error('unauthorized', RELOAD_MESSAGE));
				return;
			}
			try {
				parseJson(HelloMessage, text);
			} catch (failure) {
				if (!(failure instanceof Invalid)) throw failure;
				// A page of the short-deck prototype still open since the cutover
				// (P3.7) joins with v1's `join`; its client shows unknown_table as a
				// closed table and returns to its lobby.
				const legacy = isObject(message) && message.type === 'join';
				refuse(
					legacy
						? error('unknown_table', LEGACY_CLOSED)
						: error('bad_request', 'Send a hello message first.')
				);
				return;
			}
			const session = await site.sessionPlayer(parseCookies(handshake.cookie).get(COOKIE_NAME));
			if (over) return;
			if (session === null) {
				refuse(error('unauthorized', NO_SESSION_MESSAGE));
				return;
			}
			const player = session.player;
			site.noteAddress(player.playerId, clientAddress(handshake.peer, handshake.forwardedFor));
			await site.relationsOf(player.playerId);
			if (over) return;
			connection = tables.connect(transport, player);
		}

		async function message(connection: Connection, text: string): Promise<void> {
			if (!bucket.allow('messages')) {
				strikes += 1;
				if (strikes >= site.limiters.limits.socketStrikes) {
					console.warn(`Closing a socket of ${connection.playerId} that kept sending too fast`);
					connection.send(
						error('rate_limited', 'Too many messages: reload the page to keep playing.')
					);
					connection.end();
					return;
				}
				connection.send(error('rate_limited', 'Too many messages: slow down.'));
				return;
			}
			strikes = 0;
			let request: ReturnType<typeof ClientMessage> & object;
			try {
				request = parseJson(ClientMessage, text);
			} catch (failure) {
				if (!(failure instanceof Invalid)) throw failure;
				connection.send(error('bad_request', describeInvalid(text)));
				return;
			}
			try {
				await tables.handle(connection, request);
			} catch (failure) {
				if (failure instanceof TableError || failure instanceof RequestError) {
					connection.send(error(failure.code, failure.message, request.table_id));
					return;
				}
				throw failure;
			}
		}

		return {
			receive(text) {
				queue(async () => {
					if (over) return;
					if (!greeted) {
						greeted = true;
						await hello(text);
					} else if (connection !== null) {
						await message(connection, text);
					}
				});
			},
			closed() {
				queue(async () => {
					over = true;
					clearTimeout(helloTimer);
					if (connection !== null) await tables.closeConnection(connection);
				});
			},
			idle: () => chain
		};
	}

	return {
		allowed: (origin, host) => originAllowed(origin ?? null, host ?? null, origins),
		open
	};
}

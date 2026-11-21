// The RiverMind Poker web server: SvelteKit's Node handler and the /ws
// WebSocket on one HTTP server (D-2). Until the P4B.7 cutover the live tables
// are in the Python server, so with a legacy target /api/* and /ws are
// forwarded there (legacy.ts). Without one, /api/* is answered by the
// TypeScript API (api.ts, P4B.5a) and /ws by the TypeScript table server
// (`sockets`, P4B.5b). With neither, /ws accepts sockets and closes them.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { serveApi, type ApiHandler } from './api.ts';
import { forwardRequest, forwardUpgrade, isLegacyPath } from './legacy.ts';

export type Handler = (req: IncomingMessage, res: ServerResponse, next?: () => void) => void;

export interface Options {
	/** SvelteKit's request handler, from the build's handler.js. */
	handler: Handler;
	/** The Python table server to forward /api/* and /ws to, until the cutover. */
	legacyApi?: URL | null;
	/** How long a shutdown waits for open requests before closing them, in milliseconds. */
	shutdownTimeoutMs?: number;
	/** Protocol v2's HTTP API (P4B.5a), for /api/* when nothing is forwarded to serve-nl. */
	api?: ApiHandler | null;
	/** The site's public origin (adapter-node's ORIGIN), whose scheme the API sees. */
	origin?: URL | null;
	/** Protocol v2's sockets (src/lib/server/api/socket.ts, P4B.5b), for /ws. */
	sockets?: SocketServer | null;
}

/** One open socket, fed the frames that arrive. */
export interface SocketSession {
	receive(text: string): void;
	closed(): void;
}

/** The table server's end of /ws, as src/lib/server/api/socket.ts provides it. */
export interface SocketServer {
	allowed(origin: string | undefined, host: string | undefined): boolean;
	open(
		transport: { send(text: string, sent: () => void): void; close(code: number): void },
		handshake: {
			cookie: string | undefined;
			peer: string | undefined;
			forwardedFor: string | undefined;
		}
	): SocketSession;
}

/** The largest frame a client may send, as uvicorn's ws_max_size was for serve-nl. */
export const MAX_FRAME_BYTES = 64 * 1024;
/** Close code for a frame the server cannot take (a binary one). */
export const UNSUPPORTED_DATA = 1003;

/** Headers every page and asset carries, as serve-nl and Caddy send them. */
export const SECURITY_HEADERS: Record<string, string> = {
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	'referrer-policy': 'strict-origin-when-cross-origin'
};

/** Close code for a socket the server is not ready to serve (RFC 6455 "try again later"). */
export const TRY_AGAIN_LATER = 1013;
/** Close code for sockets cut by a restart or deploy ("service restart"). */
export const SERVICE_RESTART = 1012;

export interface App {
	server: Server;
	/** Stop taking requests and sockets, let open requests finish, then close everything. */
	close(): Promise<void>;
}

function pathOf(req: IncomingMessage): string {
	const url = req.url ?? '/';
	const end = url.search(/[?#]/);
	return end === -1 ? url : url.slice(0, end);
}

export function createApp({
	handler,
	legacyApi = null,
	shutdownTimeoutMs = 10_000,
	api = null,
	origin = null,
	sockets: tables = null
}: Options): App {
	const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
	const forwarded = new Set<Socket>();
	let closing = false;

	const server = createServer((req, res) => {
		const path = pathOf(req);
		if (closing) res.setHeader('connection', 'close');
		if (path === '/healthz') {
			res.writeHead(closing ? 503 : 200, {
				'content-type': 'text/plain; charset=utf-8',
				'cache-control': 'no-store'
			});
			res.end(closing ? 'stopping\n' : 'ok\n');
			return;
		}
		if (legacyApi && isLegacyPath(path)) {
			forwardRequest(legacyApi, req, res);
			return;
		}
		if (api && isLegacyPath(path)) {
			void serveApi(api, req, res, origin);
			return;
		}
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
		// Hashed assets are cached for a year by the handler; everything else revalidates,
		// so a deploy reaches browsers on their next load.
		if (!path.startsWith('/_app/immutable/')) res.setHeader('cache-control', 'no-cache');
		handler(req, res);
	});

	server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		if (closing || pathOf(req) !== '/ws') {
			socket.destroy();
			return;
		}
		if (legacyApi) {
			const upstream = forwardUpgrade(legacyApi, req, socket, head);
			forwarded.add(upstream);
			upstream.on('close', () => forwarded.delete(upstream));
			return;
		}
		if (tables === null) {
			sockets.handleUpgrade(req, socket, head, (ws) => {
				ws.close(TRY_AGAIN_LATER, 'Tables are not served here yet.');
			});
			return;
		}
		// Browsers always send Origin on a handshake; refusing before accepting answers 403.
		if (!tables.allowed(req.headers.origin, req.headers.host)) {
			socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
			return;
		}
		sockets.handleUpgrade(req, socket, head, (ws) => {
			const forwardedFor = req.headers['x-forwarded-for'];
			const session = tables.open(
				{
					send: (text, sent) => ws.send(text, () => sent()),
					close: (code) => ws.close(code)
				},
				{
					cookie: req.headers.cookie,
					peer: req.socket.remoteAddress,
					forwardedFor: Array.isArray(forwardedFor) ? forwardedFor.join(', ') : forwardedFor
				}
			);
			ws.on('message', (data, isBinary) => {
				if (isBinary) ws.close(UNSUPPORTED_DATA);
				else session.receive(data.toString());
			});
			ws.on('close', () => session.closed());
			// A frame over the limit or a broken connection: ws closes the socket itself.
			ws.on('error', () => {});
		});
	});

	async function close(): Promise<void> {
		if (closing) return;
		closing = true;
		const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
		server.closeIdleConnections();
		for (const ws of sockets.clients) ws.close(SERVICE_RESTART, 'The server is restarting.');
		// A forwarded socket is closed at the Python end, which ends the browser's side too;
		// the client reconnects to whichever server answers next.
		for (const upstream of forwarded) upstream.end();
		const timer = setTimeout(() => {
			server.closeAllConnections();
			for (const ws of sockets.clients) ws.terminate();
			for (const upstream of forwarded) upstream.destroy();
		}, shutdownTimeoutMs);
		timer.unref();
		await stopped;
		clearTimeout(timer);
		await new Promise<void>((resolve) => sockets.close(() => resolve()));
	}

	return { server, close };
}

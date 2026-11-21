// The RiverMind Poker web server: SvelteKit's Node handler and the /ws
// WebSocket on one HTTP server (D-2). Until the P4B.7 cutover the tables live
// in the Python server, so with a legacy target /api/* and /ws are forwarded
// there (legacy.ts). Without one, /api/* is answered by the TypeScript API
// (api.ts, P4B.5a) and /ws accepts sockets and closes them, because no table
// is served here yet.

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
}

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
	origin = null
}: Options): App {
	const sockets = new WebSocketServer({ noServer: true });
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
		sockets.handleUpgrade(req, socket, head, (ws) => {
			ws.close(TRY_AGAIN_LATER, 'Tables are not served here yet.');
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

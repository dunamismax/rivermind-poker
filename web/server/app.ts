// The RiverMind Poker web server: SvelteKit's Node handler and the /ws
// WebSocket on one HTTP server (D-2). /api/* is answered by the TypeScript API
// (api.ts, P4B.5a) and /ws by the TypeScript table server (`sockets`, P4B.5b),
// as the live site runs since the P4B.7 cutover. Without them, /api/* goes to
// the handler and /ws accepts sockets and closes them.
//
// /healthz answers {"status":"ok","revision":"<commit>","database":"ok"}
// (docs/web-platform.md in ubuntu-vm-backup): `revision` is the release's
// REVISION, and each of `checks` adds a field that is "ok" or "error". Any
// error, or a server shutting down, answers 503.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { serveApi, type ApiHandler } from './api.ts';

export type Handler = (req: IncomingMessage, res: ServerResponse, next?: () => void) => void;

/** A /healthz check: resolves true when healthy. A rejection counts as unhealthy. */
export type HealthCheck = () => Promise<boolean>;

export interface Options {
	/** SvelteKit's request handler, from the build's handler.js. */
	handler: Handler;
	/** How long a shutdown waits for open requests before closing them, in milliseconds. */
	shutdownTimeoutMs?: number;
	/** The release's commit, from its REVISION file; null when not run from a release. */
	revision?: string | null;
	/** /healthz's checks by name, such as `database`. */
	checks?: Record<string, HealthCheck>;
	/** Protocol v2's HTTP API (P4B.5a), for /api/*. */
	api?: ApiHandler | null;
	/** The site's public origin (adapter-node's ORIGIN), whose scheme the API sees. */
	origin?: URL | null;
	/** Protocol v2's sockets (src/lib/server/api/socket.ts, P4B.5b), for /ws. */
	sockets?: SocketServer | null;
	/**
	 * The voice service, to pass /voice handshakes on to unchanged, in development and
	 * the browser tests only (P4C.6). The live site routes /voice in Caddy (P4C.9), so a
	 * deploy of this server never cuts a conversation.
	 */
	voiceProxy?: URL | null;
	/**
	 * The release's /voice-files.json (scripts/voice-files.js, P4C.8): the SHA-256 of
	 * every file its pages run. Written after the client is built, so the adapter's
	 * own list of static files does not hold it.
	 */
	voiceFiles?: string | null;
	/**
	 * The iPhone app's ids (`<team>.com.rivermindpoker.app`), for the site association file
	 * that makes the site's invite links open the app where it is installed (P5D.8). None
	 * until the app has a team (Q-13), and then no file is served.
	 */
	appIds?: readonly string[];
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
			client?: string | undefined;
		}
	): SocketSession;
}

/** The largest frame a client may send, as uvicorn's ws_max_size was for serve-nl. */
export const MAX_FRAME_BYTES = 64 * 1024;
/** Close code for a frame the server cannot take (a binary one). */
export const UNSUPPORTED_DATA = 1003;

/**
 * Headers every page and asset carries, as Caddy sends them. The page may ask for
 * the microphone, for table voice, and never the camera or the location (P4C.6).
 */
export const SECURITY_HEADERS: Record<string, string> = {
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'permissions-policy': 'camera=(), microphone=(self), geolocation=()'
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

/** Where the release publishes the hashes of the files its pages run (P4C.8). */
export const VOICE_FILES_PATH = '/voice-files.json';

/** Where iOS asks a site which of its links an app opens (Apple's universal links). */
export const APP_SITE_ASSOCIATION_PATH = '/.well-known/apple-app-site-association';

/** The id an app id must look like: a ten-character team, then the bundle id. */
const APP_ID = /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/;

/**
 * The site association file (P5D.8): the app opens a private table's invite (`/?invite=`)
 * and nothing else, so every other link stays the site's. Shared replays join it at P6.1a.
 */
export function appSiteAssociation(appIds: readonly string[]): string {
	for (const id of appIds) {
		if (!APP_ID.test(id)) throw new RangeError(`not an app id: ${id}`);
	}
	return (
		JSON.stringify({
			applinks: {
				details: [
					{
						appIDs: [...appIds],
						components: [{ '/': '/', '?': { invite: '?*' }, comment: 'A private table’s invite' }]
					}
				]
			}
		}) + '\n'
	);
}

/** The app ids `RIVERMIND_APPLE_APP_IDS` names, separated by commas. */
export function appIdsFrom(text: string | undefined): string[] {
	return (text ?? '')
		.split(',')
		.map((id) => id.trim())
		.filter((id) => id !== '');
}

/** Paths the HTTP API answers. */
export function isApiPath(path: string): boolean {
	return path === '/api' || path.startsWith('/api/');
}

export function createApp({
	handler,
	shutdownTimeoutMs = 10_000,
	revision = null,
	checks = {},
	api = null,
	origin = null,
	sockets: tables = null,
	voiceProxy = null,
	voiceFiles = null,
	appIds = []
}: Options): App {
	const association = appIds.length ? appSiteAssociation(appIds) : null;
	const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
	let closing = false;

	async function health(res: ServerResponse): Promise<void> {
		const body: Record<string, string | null> = { status: 'ok', revision };
		let healthy = !closing;
		if (closing) {
			body.status = 'stopping';
		} else {
			for (const [name, check] of Object.entries(checks)) {
				const ok = await check().catch(() => false);
				body[name] = ok ? 'ok' : 'error';
				if (!ok) healthy = false;
			}
			if (!healthy) body.status = 'error';
		}
		res.writeHead(healthy ? 200 : 503, {
			'content-type': 'application/json',
			'cache-control': 'no-store'
		});
		res.end(JSON.stringify(body) + '\n');
	}

	const server = createServer((req, res) => {
		const path = pathOf(req);
		if (closing) res.setHeader('connection', 'close');
		if (path === '/healthz') {
			void health(res);
			return;
		}
		if (api && isApiPath(path)) {
			void serveApi(api, req, res, origin);
			return;
		}
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
		if (path === VOICE_FILES_PATH && voiceFiles !== null && /^(GET|HEAD)$/.test(req.method ?? '')) {
			res.writeHead(200, {
				'content-type': 'application/json',
				'cache-control': 'no-cache',
				'content-length': Buffer.byteLength(voiceFiles)
			});
			res.end(req.method === 'HEAD' ? undefined : voiceFiles);
			return;
		}
		// Served as JSON with no redirect, as iOS requires; iOS fetches it through Apple's
		// content network, which caches it for itself.
		if (
			path === APP_SITE_ASSOCIATION_PATH &&
			association !== null &&
			/^(GET|HEAD)$/.test(req.method ?? '')
		) {
			res.writeHead(200, {
				'content-type': 'application/json',
				'cache-control': 'max-age=3600',
				'content-length': Buffer.byteLength(association)
			});
			res.end(req.method === 'HEAD' ? undefined : association);
			return;
		}
		// Hashed assets are cached for a year by the handler; everything else revalidates,
		// so a deploy reaches browsers on their next load.
		if (!path.startsWith('/_app/immutable/')) res.setHeader('cache-control', 'no-cache');
		handler(req, res);
	});

	server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
		if (!closing && voiceProxy && pathOf(req) === '/voice') {
			relay(req, socket, head, voiceProxy);
			return;
		}
		if (closing || pathOf(req) !== '/ws') {
			socket.destroy();
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
					forwardedFor: Array.isArray(forwardedFor) ? forwardedFor.join(', ') : forwardedFor,
					client: [req.headers['rivermind-client']].flat()[0]
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
		const timer = setTimeout(() => {
			server.closeAllConnections();
			for (const ws of sockets.clients) ws.terminate();
		}, shutdownTimeoutMs);
		timer.unref();
		await stopped;
		clearTimeout(timer);
		await new Promise<void>((resolve) => sockets.close(() => resolve()));
	}

	return { server, close };
}

/** Pass a handshake and everything after it on to `target` byte for byte, both ways. */
function relay(req: IncomingMessage, socket: Duplex, head: Buffer, target: URL): void {
	const upstream = connect(Number(target.port || 80), target.hostname);
	const end = () => {
		socket.destroy();
		upstream.destroy();
	};
	upstream.on('error', end);
	socket.on('error', end);
	upstream.on('close', end);
	socket.on('close', end);
	upstream.on('connect', () => {
		const lines = [`${req.method} ${req.url} HTTP/1.1`];
		for (let at = 0; at < req.rawHeaders.length; at += 2) {
			lines.push(`${req.rawHeaders[at]}: ${req.rawHeaders[at + 1]}`);
		}
		upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
		if (head.length) upstream.write(head);
		socket.pipe(upstream).pipe(socket);
	});
}

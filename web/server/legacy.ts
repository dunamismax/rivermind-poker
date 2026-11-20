// Forwarding to the Python table server (`rivermind-poker serve-nl`) until the
// P4B.7 cutover: with RIVERMIND_LEGACY_API set, the Node server passes /api/*
// and the /ws WebSocket through unchanged, so the client, the browser tests and
// CI run against the Node server while the tables still live in Python.
//
// The Host and Origin headers go through as the browser sent them, so
// serve-nl's same-origin checks see the page's own origin. serve-nl trusts
// X-Forwarded-For only from a loopback peer and reads its last entry, as it
// does behind Caddy: a request that came through a loopback proxy keeps that
// proxy's header, and any other gets the peer's own address.

import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/** Headers that belong to one connection and must not be passed on. */
const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade'
]);

export const RESTARTING = 'RiverMind Poker is restarting. Try again in a minute.';

/** Whether `path` (a request URL's path) is one the legacy server answers. */
export function isLegacyPath(path: string): boolean {
	return path === '/api' || path.startsWith('/api/');
}

function isLoopback(address: string | undefined): boolean {
	if (!address) return false;
	const plain = address.startsWith('::ffff:') ? address.slice(7) : address;
	if (isIP(plain) === 4) return plain.startsWith('127.');
	return plain === '::1';
}

/** The X-Forwarded-For value to send upstream for `req`. */
export function forwardedFor(req: IncomingMessage): string {
	const peer = req.socket.remoteAddress ?? 'unknown';
	const incoming = req.headers['x-forwarded-for'];
	const value = Array.isArray(incoming) ? incoming.join(', ') : incoming;
	return value && isLoopback(peer) ? value : peer;
}

function upstreamHeaders(req: IncomingMessage): Record<string, string | string[]> {
	const headers: Record<string, string | string[]> = {};
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined || HOP_BY_HOP.has(name) || name === 'x-forwarded-for') continue;
		headers[name] = value;
	}
	headers['x-forwarded-for'] = forwardedFor(req);
	return headers;
}

function restarting(res: ServerResponse): void {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	res.writeHead(503, {
		'content-type': 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		'retry-after': '5'
	});
	res.end(RESTARTING);
}

/** Pass an HTTP request to `target` and stream the answer back. */
export function forwardRequest(target: URL, req: IncomingMessage, res: ServerResponse): void {
	const upstream = request(
		{
			host: target.hostname,
			port: target.port,
			method: req.method,
			path: req.url,
			headers: upstreamHeaders(req)
		},
		(answer) => {
			const headers: Record<string, string | string[]> = {};
			for (const [name, value] of Object.entries(answer.headers)) {
				if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
			}
			res.writeHead(answer.statusCode ?? 502, answer.statusMessage, headers);
			answer.pipe(res);
			answer.on('error', () => res.destroy());
		}
	);
	// serve-nl down (a restart or a deploy): the same answer Caddy gives.
	upstream.on('error', () => restarting(res));
	res.on('close', () => {
		if (!res.writableFinished) upstream.destroy();
	});
	req.pipe(upstream);
}

/**
 * Pass a WebSocket handshake to `target` and then splice the two sockets.
 * Returns the upstream socket, so a shutdown can close both ends.
 */
export function forwardUpgrade(
	target: URL,
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer
): Socket {
	const upstream = connect(Number(target.port || 80), target.hostname);
	let open = false;
	upstream.on('connect', () => {
		open = true;
		let handshake = `${req.method} ${req.url} HTTP/1.1\r\n`;
		for (let i = 0; i < req.rawHeaders.length; i += 2) {
			if (req.rawHeaders[i].toLowerCase() === 'x-forwarded-for') continue;
			handshake += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
		}
		handshake += `X-Forwarded-For: ${forwardedFor(req)}\r\n\r\n`;
		upstream.write(handshake);
		if (head.length) upstream.write(head);
		upstream.pipe(socket);
		socket.pipe(upstream);
	});
	upstream.on('error', () => {
		if (!open && socket.writable) {
			socket.end(
				`HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\n` +
					`Cache-Control: no-store\r\nConnection: close\r\n\r\n${RESTARTING}`
			);
		} else {
			socket.destroy();
		}
	});
	upstream.on('close', () => socket.destroy());
	socket.on('error', () => upstream.destroy());
	socket.on('close', () => upstream.destroy());
	return upstream;
}

// Serving protocol v2's HTTP API (src/lib/server/api, P4B.5a) from the Node
// server, ahead of SvelteKit's handler. SvelteKit 3's CSRF check, which
// cannot be turned off, refuses unsafe requests without a body type whose
// Origin is not the site's own: requests from non-browser clients, which send
// no Origin, and from a loopback dev page calling a loopback server. serve-nl
// accepts both, and the API makes its own origin checks (auth.originAllowed),
// so /api/* never reaches SvelteKit.

import type { IncomingMessage, ServerResponse } from 'node:http';

/** The fetch-style handler of src/lib/server/api/api.ts. */
export type ApiHandler = (request: Request, info: { peer: string | null }) => Promise<Response>;

/** Bodies larger than this are refused; Caddy allows 16 KB in front of the app. */
export const MAX_BODY_BYTES = 1 << 20;

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) return null;
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

/**
 * The request as the API sees it. Its URL takes the scheme from `origin`
 * (adapter-node's ORIGIN, https behind Caddy) and otherwise is plain http;
 * the Host header stays as sent, for the API's loopback and origin checks.
 */
function toRequest(req: IncomingMessage, body: Buffer, origin: URL | null): Request {
	const headers = new Headers();
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
	}
	const host = req.headers.host ?? origin?.host ?? 'localhost';
	const scheme = origin?.protocol ?? 'http:';
	const method = req.method ?? 'GET';
	return new Request(`${scheme}//${host}${req.url ?? '/'}`, {
		method,
		headers,
		body: method === 'GET' || method === 'HEAD' || !body.length ? null : new Uint8Array(body)
	});
}

/** Answer one /api/* request with `api`. */
export async function serveApi(
	api: ApiHandler,
	req: IncomingMessage,
	res: ServerResponse,
	origin: URL | null = null
): Promise<void> {
	try {
		const body = await readBody(req);
		if (body === null) {
			res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
			res.end(JSON.stringify({ detail: 'Request body too large.' }));
			return;
		}
		const response = await api(toRequest(req, body, origin), {
			peer: req.socket.remoteAddress ?? null
		});
		const headers: Record<string, string | string[]> = {};
		response.headers.forEach((value, name) => {
			if (name !== 'set-cookie') headers[name] = value;
		});
		const cookies = response.headers.getSetCookie();
		if (cookies.length) headers['set-cookie'] = cookies;
		const payload = Buffer.from(await response.arrayBuffer());
		headers['content-length'] = String(payload.length);
		res.writeHead(response.status, headers);
		res.end(payload);
	} catch (error) {
		console.error('API request failed:', error);
		if (!res.headersSent) {
			res.writeHead(500, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ detail: 'Internal Server Error' }));
		} else {
			res.destroy();
		}
	}
}

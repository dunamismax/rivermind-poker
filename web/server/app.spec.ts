import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createApi } from '../src/lib/server/api/api.ts';
import { UNLIMITED } from '../src/lib/server/api/safety.ts';
import { Site } from '../src/lib/server/api/site.ts';
import { MAX_BODY_BYTES } from './api.ts';
import { createApp, TRY_AGAIN_LATER, type App, type Handler } from './app.ts';
import { RESTARTING } from './legacy.ts';

const running: (() => Promise<void>)[] = [];

afterEach(async () => {
	while (running.length) await running.pop()!();
});

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A stand-in for SvelteKit's handler that names the path it was given. */
const pages: Handler = (req, res) => {
	res.setHeader('content-type', 'text/plain');
	res.end(`page ${req.url}`);
};

async function start(
	legacy: string | null = null,
	extra: Partial<Parameters<typeof createApp>[0]> = {}
): Promise<{ app: App; host: string }> {
	const app = createApp({
		handler: pages,
		legacyApi: legacy ? new URL(`http://${legacy}`) : null,
		shutdownTimeoutMs: 500,
		...extra
	});
	const host = await listen(app.server);
	running.push(() => app.close());
	return { app, host };
}

/** A stand-in for serve-nl: echoes requests as JSON and socket messages back. */
async function legacyServer(): Promise<{ host: string; seen: IncomingMessage[] }> {
	const seen: IncomingMessage[] = [];
	const server = createServer((req, res) => {
		seen.push(req);
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			res.writeHead(201, {
				'content-type': 'application/json',
				'set-cookie': ['a=1; Path=/', 'b=2; Path=/']
			});
			res.end(JSON.stringify({ path: req.url, method: req.method, body, headers: req.headers }));
		});
	});
	const sockets = new WebSocketServer({ server });
	sockets.on('connection', (ws, req) => {
		seen.push(req);
		ws.on('message', (data) => ws.send(`echo ${data}`));
	});
	const host = await listen(server);
	running.push(async () => {
		for (const ws of sockets.clients) ws.terminate();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	});
	return { host, seen };
}

function opened(ws: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		ws.once('open', () => resolve());
		ws.once('error', reject);
	});
}

function closed(ws: WebSocket): Promise<number> {
	return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

describe('the web server', () => {
	it('answers /healthz', async () => {
		const { host } = await start();
		const response = await fetch(`http://${host}/healthz`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('ok\n');
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('serves pages through the handler with the site headers', async () => {
		const { host } = await start();
		const page = await fetch(`http://${host}/hands?x=1`);
		expect(await page.text()).toBe('page /hands?x=1');
		expect(page.headers.get('x-frame-options')).toBe('DENY');
		expect(page.headers.get('x-content-type-options')).toBe('nosniff');
		expect(page.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
		expect(page.headers.get('cache-control')).toBe('no-cache');
		const asset = await fetch(`http://${host}/_app/immutable/entry/start.js`);
		expect(asset.headers.get('cache-control')).toBeNull();
	});

	it('without a legacy server, gives /api to the handler and turns sockets away', async () => {
		const { host } = await start();
		expect(await (await fetch(`http://${host}/api/config`)).text()).toBe('page /api/config');
		const ws = new WebSocket(`ws://${host}/ws`);
		expect(await closed(ws)).toBe(TRY_AGAIN_LATER);
	});

	it('refuses upgrades on other paths', async () => {
		const { host } = await start();
		const ws = new WebSocket(`ws://${host}/elsewhere`);
		const failed = new Promise((resolve) => ws.once('error', resolve));
		await expect(failed).resolves.toBeInstanceOf(Error);
	});
});

describe('forwarding to the legacy server', () => {
	it('passes /api requests through with their host, origin, body and cookies', async () => {
		const legacy = await legacyServer();
		const { host } = await start(legacy.host);
		const response = await fetch(`http://${host}/api/tables?seats=2`, {
			method: 'POST',
			headers: { origin: `http://${host}`, 'content-type': 'application/json' },
			body: '{"seats":2}'
		});
		expect(response.status).toBe(201);
		expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
		const echoed = await response.json();
		expect(echoed).toMatchObject({
			path: '/api/tables?seats=2',
			method: 'POST',
			body: '{"seats":2}'
		});
		expect(echoed.headers.host).toBe(host);
		expect(echoed.headers.origin).toBe(`http://${host}`);
		expect(echoed.headers['x-forwarded-for']).toBe('127.0.0.1');
		// Pages are still the handler's, without the forwarding.
		expect(await (await fetch(`http://${host}/apiary`)).text()).toBe('page /apiary');
	});

	it('keeps a loopback proxy’s X-Forwarded-For, as Caddy sends it', async () => {
		const legacy = await legacyServer();
		const { host } = await start(legacy.host);
		const response = await fetch(`http://${host}/api/config`, {
			headers: { 'x-forwarded-for': '203.0.113.7' }
		});
		expect((await response.json()).headers['x-forwarded-for']).toBe('203.0.113.7');
	});

	it('answers 503 while the legacy server is down', async () => {
		const probe = createServer();
		const address = await listen(probe);
		await new Promise((resolve) => probe.close(resolve));
		const { host } = await start(address);
		const response = await fetch(`http://${host}/api/config`);
		expect(response.status).toBe(503);
		expect(await response.text()).toBe(RESTARTING);
		const ws = new WebSocket(`ws://${host}/ws`);
		const failed = new Promise<Error>((resolve) => ws.once('error', resolve));
		expect((await failed).message).toMatch(/503/);
	});

	it('splices the /ws socket through with the browser’s origin', async () => {
		const legacy = await legacyServer();
		const { host } = await start(legacy.host);
		const ws = new WebSocket(`ws://${host}/ws?table=t1`, { origin: `http://${host}` });
		await opened(ws);
		const reply = new Promise((resolve) => ws.once('message', (data) => resolve(String(data))));
		ws.send('hello');
		expect(await reply).toBe('echo hello');
		const handshake = legacy.seen.at(-1)!;
		expect(handshake.url).toBe('/ws?table=t1');
		expect(handshake.headers.host).toBe(host);
		expect(handshake.headers.origin).toBe(`http://${host}`);
		expect(handshake.headers['x-forwarded-for']).toBe('127.0.0.1');
		ws.close();
	});
});

describe('shutting down', () => {
	it('lets an open request finish, then stops listening', async () => {
		const slow: Handler = (req, res) => setTimeout(() => res.end(`late ${req.url}`), 200);
		const app = createApp({ handler: slow, shutdownTimeoutMs: 2000 });
		const host = await listen(app.server);
		const pending = fetch(`http://${host}/hands`);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await Promise.all([app.close(), expect((await pending).text()).resolves.toBe('late /hands')]);
		await expect(fetch(`http://${host}/healthz`)).rejects.toThrow();
	});

	it('cuts forwarded sockets so the browser reconnects', async () => {
		const legacy = await legacyServer();
		const app = createApp({
			handler: pages,
			legacyApi: new URL(`http://${legacy.host}`),
			shutdownTimeoutMs: 500
		});
		const host = await listen(app.server);
		const ws = new WebSocket(`ws://${host}/ws`);
		await opened(ws);
		const code = closed(ws);
		await app.close();
		expect(await code).not.toBe(1000);
		await expect(fetch(`http://${host}/healthz`)).rejects.toThrow();
	});
});

describe('the TypeScript API (P4B.5a)', () => {
	const site = () => new Site({ secret: Buffer.from('test-secret'), limits: UNLIMITED });

	it('answers /api/* ahead of the handler, without SvelteKit refusing Origin-less requests', async () => {
		const { host } = await start(null, { api: createApi(site()) });
		const made = await fetch(`http://${host}/api/session`, { method: 'POST' });
		expect(made.status).toBe(200);
		const cookie = made.headers.getSetCookie();
		expect(cookie).toHaveLength(1);
		expect(cookie[0]).toMatch(/^rm_session=s1\.p_.*; SameSite=lax$/); // plain http to this machine
		const headers = { cookie: cookie[0].split(';')[0] };
		const wallet = await fetch(`http://${host}/api/wallet`, { headers });
		expect((await wallet.json()).balance).toBe(20_000);
		// A loopback dev page may call a loopback server, as serve-nl allows.
		const dev = await fetch(`http://${host}/api/session`, {
			method: 'POST',
			headers: { ...headers, origin: 'http://localhost:5173' }
		});
		expect(dev.status).toBe(200);
		const evil = await fetch(`http://${host}/api/session`, {
			method: 'POST',
			headers: { origin: 'https://evil.example' }
		});
		expect(evil.status).toBe(403);
		expect(await (await fetch(`http://${host}/`)).text()).toBe('page /');
	});

	it('sees the public scheme, and refuses bodies that are too large', async () => {
		const { host } = await start(null, {
			api: createApi(site()),
			origin: new URL('https://rivermindpoker.com')
		});
		const made = await fetch(`http://${host}/api/session`, { method: 'POST' });
		expect(made.headers.getSetCookie()[0]).toMatch(/; Secure$/);
		const big = await fetch(`http://${host}/api/session`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ legacy_token: 'x'.repeat(MAX_BODY_BYTES) })
		});
		expect(big.status).toBe(413);
	});

	it('forwards to the legacy server instead when there is one', async () => {
		const legacy = await legacyServer();
		const { host } = await start(legacy.host, { api: createApi(site()) });
		const response = await fetch(`http://${host}/api/session`, { method: 'POST' });
		expect(response.status).toBe(201);
		expect(legacy.seen).toHaveLength(1);
	});
});

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createApi } from '../src/lib/server/api/api.ts';
import { UNLIMITED } from '../src/lib/server/api/safety.ts';
import { Site } from '../src/lib/server/api/site.ts';
import { createSocketServer } from '../src/lib/server/api/socket.ts';
import { Tables } from '../src/lib/server/api/tables.ts';
import { ManualClock } from '../src/lib/server/table/clock.ts';
import { seededDealer } from '../src/lib/server/table/runner.ts';
import type * as p from '../src/lib/protocol-v2.ts';
import { MAX_BODY_BYTES } from './api.ts';
import {
	createApp,
	MAX_FRAME_BYTES,
	SERVICE_RESTART,
	TRY_AGAIN_LATER,
	UNSUPPORTED_DATA,
	type App,
	type Handler
} from './app.ts';

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
	extra: Partial<Parameters<typeof createApp>[0]> = {}
): Promise<{ app: App; host: string }> {
	const app = createApp({
		handler: pages,
		shutdownTimeoutMs: 500,
		...extra
	});
	const host = await listen(app.server);
	running.push(() => app.close());
	return { app, host };
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
	it('answers /healthz with the revision and each check', async () => {
		const { host } = await start();
		const response = await fetch(`http://${host}/healthz`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: 'ok', revision: null });
		expect(response.headers.get('cache-control')).toBe('no-store');

		const revision = 'a'.repeat(40);
		let database = true;
		const checked = await start({ revision, checks: { database: async () => database } });
		const ok = await fetch(`http://${checked.host}/healthz`);
		expect(ok.status).toBe(200);
		expect(await ok.json()).toEqual({ status: 'ok', revision, database: 'ok' });
		database = false;
		const down = await fetch(`http://${checked.host}/healthz`);
		expect(down.status).toBe(503);
		expect(await down.json()).toEqual({ status: 'error', revision, database: 'error' });
		const failing = await start({
			checks: { database: () => Promise.reject(new Error('no connection')) }
		});
		expect((await fetch(`http://${failing.host}/healthz`)).status).toBe(503);
	});

	it('serves pages through the handler with the site headers', async () => {
		const { host } = await start();
		const page = await fetch(`http://${host}/hands?x=1`);
		expect(await page.text()).toBe('page /hands?x=1');
		expect(page.headers.get('x-frame-options')).toBe('DENY');
		expect(page.headers.get('x-content-type-options')).toBe('nosniff');
		expect(page.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
		// Table voice may ask for the microphone; nothing may ask for the camera or the location.
		expect(page.headers.get('permissions-policy')).toBe(
			'camera=(), microphone=(self), geolocation=()'
		);
		expect(page.headers.get('cache-control')).toBe('no-cache');
		const asset = await fetch(`http://${host}/_app/immutable/entry/start.js`);
		expect(asset.headers.get('cache-control')).toBeNull();
	});

	it('serves the release’s hashes of the files its pages run, when it has them (P4C.8)', async () => {
		const voiceFiles = '{"format":1,"voice":{},"page":{}}\n';
		const { host } = await start({ voiceFiles });
		const listed = await fetch(`http://${host}/voice-files.json`);
		expect(listed.status).toBe(200);
		expect(await listed.text()).toBe(voiceFiles);
		expect(listed.headers.get('content-type')).toBe('application/json');
		expect(listed.headers.get('cache-control')).toBe('no-cache');
		expect(listed.headers.get('x-content-type-options')).toBe('nosniff');
		// Anything but a read goes to the handler, as any other path does.
		const posted = await fetch(`http://${host}/voice-files.json`, { method: 'POST' });
		expect(await posted.text()).toBe('page /voice-files.json');
		const without = await start();
		expect(await (await fetch(`http://${without.host}/voice-files.json`)).text()).toBe(
			'page /voice-files.json'
		);
	});

	it('without the API, gives /api to the handler and turns sockets away', async () => {
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
		// /voice too, unless a voice service is named to pass it on to.
		const voice = new WebSocket(`ws://${host}/voice`);
		await expect(new Promise((resolve) => voice.once('error', resolve))).resolves.toBeInstanceOf(
			Error
		);
	});

	it('passes /voice on to the voice service it is given, handshake and frames unchanged', async () => {
		const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
		running.push(() => new Promise((resolve) => upstream.close(() => resolve())));
		await new Promise((resolve) => upstream.once('listening', resolve));
		const seen: { path: string | undefined; origin: string | undefined }[] = [];
		upstream.on('connection', (socket, req) => {
			seen.push({ path: req.url, origin: req.headers.origin });
			socket.on('message', (data) => socket.send(`echo ${data}`));
		});
		const port = (upstream.address() as AddressInfo).port;
		const { host } = await start({ voiceProxy: new URL(`http://127.0.0.1:${port}`) });
		const ws = new WebSocket(`ws://${host}/voice`, { origin: 'http://example.test' });
		await opened(ws);
		const reply = new Promise((resolve) => ws.once('message', (data) => resolve(String(data))));
		ws.send('hello');
		expect(await reply).toBe('echo hello');
		expect(seen).toEqual([{ path: '/voice', origin: 'http://example.test' }]);
		ws.close();
		// Everything else is still the server's own.
		const other = new WebSocket(`ws://${host}/ws`);
		expect(await closed(other)).toBe(TRY_AGAIN_LATER);
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
});

describe('the TypeScript API (P4B.5a)', () => {
	const site = () => new Site({ secret: Buffer.from('test-secret'), limits: UNLIMITED });

	it('answers /api/* ahead of the handler, without SvelteKit refusing Origin-less requests', async () => {
		const { host } = await start({ api: createApi(site()) });
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
		const { host } = await start({
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
});

describe('the table server over real sockets (P4B.5b)', () => {
	async function tableServer() {
		const quiet = { info: () => {}, warn: () => {}, error: () => {} };
		const site = new Site({ secret: Buffer.from('s'.repeat(32)), limits: UNLIMITED });
		let seed = 0;
		const tables = new Tables(site, {
			log: quiet,
			runner: {
				handPause: 0,
				botDelay: 0,
				clock: new ManualClock(),
				dealer: () => seededDealer(seed++),
				log: quiet
			}
		});
		const { app, host } = await start({
			api: createApi(site, { tables }),
			sockets: createSocketServer(tables)
		});
		running.push(() => tables.stop());
		const visit = await fetch(`http://${host}/api/session`, { method: 'POST' });
		const cookie = (visit.headers.get('set-cookie') ?? '').split(';')[0];
		const player = (await visit.json()) as p.SessionResponse;
		return { app, host, tables, cookie, player };
	}

	/** A socket whose messages can be awaited one at a time. */
	function client(host: string, headers: Record<string, string> = {}) {
		const ws = new WebSocket(`ws://${host}/ws`, { headers });
		const inbox: Record<string, never>[] = [];
		let wake: (() => void) | null = null;
		ws.on('message', (data) => {
			inbox.push(JSON.parse(String(data)));
			wake?.();
		});
		const next = async (matches: (m: Record<string, never>) => boolean = () => true) => {
			for (;;) {
				while (inbox.length) {
					const message = inbox.shift()!;
					if (matches(message)) return message;
				}
				await new Promise<void>((resolve) => (wake = resolve));
			}
		};
		const send = (message: unknown) => ws.send(JSON.stringify(message));
		return { ws, next, send };
	}

	it('plays a hand over a WebSocket, with the cookie from the handshake', async () => {
		const { host, cookie, player } = await tableServer();
		const made = await fetch(`http://${host}/api/tables`, {
			method: 'POST',
			headers: { cookie, 'content-type': 'application/json', origin: `http://${host}` },
			body: JSON.stringify({ seats: 2, bots: 'calling_station' })
		});
		expect(made.status).toBe(201);
		const { table_id: tableId } = (await made.json()) as p.NewTableResponse;
		const { ws, next, send } = client(host, { cookie, origin: `http://${host}` });
		await opened(ws);
		send({ type: 'hello', protocol: 2 });
		expect(await next()).toEqual({
			type: 'welcome',
			protocol: 2,
			player_id: player.player_id,
			name: player.name
		});
		send({ type: 'join_table', table_id: tableId });
		const turn = (await next(
			(m) => m.type === 'table' && (m.view as p.TableView).you.legal !== null
		)) as unknown as p.TableMessage;
		expect(turn.view.seats[0]).toMatchObject({ name: player.name, kind: 'human' });
		expect(turn.view.seats[0]!.cards).toHaveLength(2);
		expect(turn.view.seats[1]!.cards).toBeNull(); // the bot's cards stay hidden
		// Check or call every turn until the second hand is dealt.
		let latest = turn;
		let answered = 0;
		while (latest.view.hand!.hand_no < 2) {
			const { view } = latest;
			if (view.you.legal !== null && view.turn!.seq > answered) {
				answered = view.turn!.seq;
				const action = view.you.legal.can_check ? 'check' : 'call';
				send({ type: 'act', table_id: tableId, seq: view.seq, action });
			}
			latest = (await next((m) => m.type === 'table')) as unknown as p.TableMessage;
		}
		expect(latest.view.hand!.posts.length).toBe(2); // blinds posted for the new hand
		send({ type: 'nonsense' });
		expect(await next((m) => m.type === 'error')).toMatchObject({ code: 'bad_request' });
		ws.close();
	});

	it('refuses a handshake from another site, and one without a session', async () => {
		const { host, cookie } = await tableServer();
		const foreign = new WebSocket(`ws://${host}/ws`, {
			headers: { cookie, origin: 'https://evil.example' }
		});
		const status = await new Promise<number>((resolve) => {
			foreign.once('unexpected-response', (_request, response) => {
				resolve(response.statusCode ?? 0);
				response.resume();
			});
			foreign.once('error', () => {});
		});
		expect(status).toBe(403);
		const anonymous = client(host);
		await opened(anonymous.ws);
		anonymous.send({ type: 'hello', protocol: 2 });
		expect(await anonymous.next()).toMatchObject({ type: 'error', code: 'unauthorized' });
		expect(await closed(anonymous.ws)).toBe(1008);
	});

	it('closes a socket that sends binary or oversized frames', async () => {
		const { host, cookie } = await tableServer();
		const binary = client(host, { cookie });
		await opened(binary.ws);
		binary.ws.send(Buffer.from([1, 2, 3]));
		expect(await closed(binary.ws)).toBe(UNSUPPORTED_DATA);
		const big = client(host, { cookie });
		await opened(big.ws);
		big.send({ type: 'hello', protocol: 2 });
		await big.next();
		big.ws.send(JSON.stringify({ type: 'join_table', table_id: 'x'.repeat(MAX_FRAME_BYTES) }));
		expect(await closed(big.ws)).toBe(1009);
	});

	it('marks a player disconnected when their socket drops, and tells sockets of a restart', async () => {
		const { app, host, cookie, tables, player } = await tableServer();
		const made = await fetch(`http://${host}/api/tables`, {
			method: 'POST',
			headers: { cookie, 'content-type': 'application/json' },
			body: JSON.stringify({ seats: 2, bots: 'calling_station' })
		});
		const { table_id: tableId } = (await made.json()) as p.NewTableResponse;
		const table = tables.manager.get(tableId)!.table;
		const first = client(host, { cookie });
		await opened(first.ws);
		first.send({ type: 'hello', protocol: 2 });
		first.send({ type: 'join_table', table_id: tableId });
		await first.next((m) => m.type === 'table');
		first.ws.terminate(); // the connection drops without a goodbye
		for (let i = 0; i < 200 && table.seats[0]!.connected; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(table.seats[0]).toMatchObject({ playerId: player.player_id, connected: false });
		const second = client(host, { cookie });
		await opened(second.ws);
		second.send({ type: 'hello', protocol: 2 });
		second.send({ type: 'join_table', table_id: tableId });
		await second.next((m) => m.type === 'table');
		expect(table.seats[0]!.connected).toBe(true);
		const restarted = closed(second.ws);
		await app.close();
		expect(await restarted).toBe(SERVICE_RESTART);
	});
});

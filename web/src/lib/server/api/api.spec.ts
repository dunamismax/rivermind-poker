// The HTTP API's behaviour beyond the recorded contract (P4B.5a), ported from
// test/server/test_identity.py and test/server/test_safety.py: rate limits,
// cookie flags, renewal, origins, addresses and the mute and block list.
import { describe, expect, it } from 'vitest';
import { COOKIE_NAME, issueSession, publicRef, readSession, SESSION_SECONDS } from './auth.ts';
import { createApi, NO_SESSION_MESSAGE, type ApiOptions } from './api.ts';
import { addressTag, DEFAULT_LIMITS, UNLIMITED, type Limits } from './safety.ts';
import { Site, type SiteOptions } from './site.ts';
import { STARTING_GRANT } from './wallet.ts';

const SECRET = Buffer.from('test-secret-test-secret-test-sec');
const HANDLE = /^([A-Z][a-z]+) ([A-Z][a-z]+) (\d{1,2})$/;

function setup(
	options: Partial<SiteOptions> = {},
	api: ApiOptions = {},
	base = 'http://testserver'
) {
	const site = new Site({ secret: SECRET, limits: UNLIMITED, ...options });
	const handle = createApi(site, api);
	let peer = 'testclient';
	async function send(
		method: string,
		path: string,
		init: { headers?: Record<string, string>; body?: string } = {}
	) {
		const headers = new Headers(init.headers ?? {});
		if (!headers.has('host')) headers.set('host', new URL(base).host);
		return handle(new Request(base + path, { method, headers, body: init.body ?? null }), { peer });
	}
	/** A new browser: its session and the cookie header to send. */
	async function visit(headers: Record<string, string> = {}) {
		const response = await send('POST', '/api/session', { headers });
		const body = await response.json();
		const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0];
		return { response, body, headers: { cookie } };
	}
	return { site, send, visit, setPeer: (p: string) => (peer = p) };
}

describe('sessions', () => {
	it('makes a player with a random handle and a strict cookie on a first visit', async () => {
		const { visit, send } = setup();
		const { response, body, headers } = await visit();
		expect(response.status).toBe(200);
		expect(body.created).toBe(true);
		expect(body.player_id).toMatch(/^p_/);
		expect(body.name).toMatch(HANDLE);
		expect(body.balance).toBe(STARTING_GRANT);
		const cookie = response.headers.get('set-cookie')!;
		expect(cookie).toMatch(
			new RegExp(
				`^${COOKIE_NAME}=[^;]+; HttpOnly; Max-Age=${SESSION_SECONDS}; Path=/; SameSite=lax; Secure$`
			)
		);
		const value = headers.cookie.slice(COOKIE_NAME.length + 1);
		expect(readSession(SECRET, value, Date.now() / 1000)?.playerId).toBe(body.player_id);

		// The same browser comes back: the same player, and a fresh cookie needs no renewal.
		const again = await send('POST', '/api/session', { headers });
		expect(await again.json()).toEqual({ ...body, created: false });
		expect(again.headers.get('set-cookie')).toBeNull();

		const other = await visit();
		expect(other.body.player_id).not.toBe(body.player_id);
		expect(other.body.name).not.toBe(body.name);
	});

	it('sets a cookie without Secure only on plain HTTP to this machine', async () => {
		for (const [base, secure] of [
			['http://127.0.0.1:8000', false],
			['http://localhost:5173', false],
			['https://localhost', true],
			['http://rivermindpoker.com', true],
			['https://rivermindpoker.com', true]
		] as const) {
			const { visit } = setup({}, {}, base);
			const cookie = (await visit()).response.headers.get('set-cookie')!;
			expect(cookie.endsWith('; Secure'), base).toBe(secure);
		}
	});

	it('renews an old session and refuses bad ones', async () => {
		const { visit, send } = setup();
		const { body } = await visit();
		const now = Date.now() / 1000;
		const old = issueSession(SECRET, body.player_id, now - 2 * 24 * 3600);
		const renewed = await send('POST', '/api/session', {
			headers: { cookie: `${COOKIE_NAME}=${old}` }
		});
		expect((await renewed.json()).player_id).toBe(body.player_id);
		const value = renewed.headers
			.get('set-cookie')!
			.split(';')[0]
			.slice(COOKIE_NAME.length + 1);
		const session = readSession(SECRET, value, now);
		expect(session?.playerId).toBe(body.player_id);
		expect(now - session!.issued).toBeLessThan(60);

		for (const bad of [
			issueSession(Buffer.from('other'), body.player_id, now),
			issueSession(SECRET, body.player_id, now - SESSION_SECONDS - 60),
			issueSession(SECRET, 'p_neverstored00', now),
			'garbage'
		]) {
			const refused = await send('GET', '/api/wallet', {
				headers: { cookie: `${COOKIE_NAME}=${bad}` }
			});
			expect(refused.status).toBe(401);
			expect(await refused.json()).toEqual({ detail: NO_SESSION_MESSAGE });
			// A visit with a bad session makes a new player.
			const fresh = await send('POST', '/api/session', {
				headers: { cookie: `${COOKIE_NAME}=${bad}` }
			});
			const made = await fresh.json();
			expect(made.created).toBe(true);
			expect(made.player_id).not.toBe(body.player_id);
		}
	});
});

describe('origins', () => {
	it('refuses unsafe requests from other sites, and allows reads', async () => {
		const { send, visit } = setup({}, {}, 'https://rivermindpoker.com');
		const player = await visit();
		for (const origin of [
			'https://evil.example',
			'https://rivermindpoker.com.evil.example',
			'null',
			'http://localhost:5173'
		]) {
			const refused = await send('POST', '/api/session', {
				headers: { origin, ...player.headers }
			});
			expect(refused.status, origin).toBe(403);
			expect(await refused.json()).toEqual({
				detail: 'Requests from other sites are not allowed.'
			});
			expect((await send('DELETE', '/api/relations/x', { headers: { origin } })).status).toBe(403);
		}
		const same = { origin: 'https://rivermindpoker.com', ...player.headers };
		expect((await send('POST', '/api/session', { headers: same })).status).toBe(200);
		expect(
			(await send('GET', '/api/config', { headers: { origin: 'https://evil.example' } })).status
		).toBe(200);
	});

	it('lets loopback pages and allowed origins call the server', async () => {
		const local = setup({}, {}, 'http://127.0.0.1:8000');
		expect(
			(await local.send('POST', '/api/session', { headers: { origin: 'http://localhost:5173' } }))
				.status
		).toBe(200);
		expect(
			(await local.send('POST', '/api/session', { headers: { origin: 'https://evil.example' } }))
				.status
		).toBe(403);
		const remote = setup({}, { allowedOrigins: ['https://play.example/'] }, 'https://api.example');
		expect(
			(await remote.send('POST', '/api/session', { headers: { origin: 'https://play.example' } }))
				.status
		).toBe(200);
		expect(
			(await remote.send('POST', '/api/session', { headers: { origin: 'https://evil.example' } }))
				.status
		).toBe(403);
	});
});

describe('rate limits', () => {
	it('limit unsafe requests per player and new players per address', async () => {
		let now = 1000;
		const limits: Limits = {
			...DEFAULT_LIMITS,
			httpRate: 1,
			httpBurst: 4,
			newPlayerRate: 0.1,
			newPlayerBurst: 3,
			clock: () => now
		};
		const { send, visit } = setup({ limits });
		const alice = await visit(); // one new player and one request from this address
		for (let i = 0; i < 4; i++) {
			expect((await send('POST', '/api/session', { headers: alice.headers })).status).toBe(200);
		}
		const refused = await send('POST', '/api/session', { headers: alice.headers });
		expect(refused.status).toBe(429);
		expect(refused.headers.get('retry-after')).toBe('1');
		expect(await refused.json()).toEqual({
			detail: 'Too many requests: wait a moment and try again.'
		});
		expect((await send('GET', '/api/wallet', { headers: alice.headers })).status).toBe(200); // reads are not limited
		now += 1;
		expect((await send('POST', '/api/session', { headers: alice.headers })).status).toBe(200);
		// Two more new players from this address, then the third is refused.
		await visit();
		await visit();
		const made = await send('POST', '/api/session');
		expect(made.status).toBe(429);
		expect(made.headers.get('retry-after')).toBe('9'); // a second has passed since the first
		now += 10;
		expect((await visit()).response.status).toBe(200);
	});

	it('count a forwarded address only from this machine', async () => {
		let now = 0;
		const limits: Limits = {
			...DEFAULT_LIMITS,
			newPlayerRate: 0.001,
			newPlayerBurst: 1,
			clock: () => now
		};
		const { send, setPeer, site } = setup({ limits });
		setPeer('127.0.0.1');
		const first = await send('POST', '/api/session', {
			headers: { 'x-forwarded-for': '203.0.113.9' }
		});
		expect(first.status).toBe(200);
		const id = (await first.json()).player_id;
		expect(site.addresses.get(id)).toBe(addressTag(SECRET, '203.0.113.9'));
		// Another client behind Caddy is another address.
		expect(
			(await send('POST', '/api/session', { headers: { 'x-forwarded-for': '203.0.113.10' } }))
				.status
		).toBe(200);
		expect(
			(await send('POST', '/api/session', { headers: { 'x-forwarded-for': '203.0.113.9' } })).status
		).toBe(429);
		// A client reaching the app directly cannot choose its address.
		setPeer('198.51.100.7');
		expect(
			(await send('POST', '/api/session', { headers: { 'x-forwarded-for': '192.0.2.1' } })).status
		).toBe(200);
		expect(
			(await send('POST', '/api/session', { headers: { 'x-forwarded-for': '192.0.2.2' } })).status
		).toBe(429);
		now += 1;
	});
});

describe('the mute and block list', () => {
	it('lists, keeps the order of and removes mutes and blocks by public reference', async () => {
		const { send, visit, site } = setup();
		const alice = await visit();
		const bob = await visit();
		const carol = await visit();
		const bobRecord = { playerId: bob.body.player_id, handle: bob.body.name };
		const carolRecord = { playerId: carol.body.player_id, handle: carol.body.name };
		await site.setRelation(alice.body.player_id, bobRecord, 'mute');
		await site.setRelation(alice.body.player_id, carolRecord, 'block');
		await site.setRelation(alice.body.player_id, bobRecord, 'block');
		const listed = await (await send('GET', '/api/relations', { headers: alice.headers })).json();
		expect(listed).toEqual({
			players: [
				{ ref: publicRef(bob.body.player_id), name: bob.body.name, kind: 'block' },
				{ ref: publicRef(carol.body.player_id), name: carol.body.name, kind: 'block' }
			]
		});
		expect(await site.safety.blocksInvolving(bob.body.player_id)).toEqual(
			new Set([alice.body.player_id])
		);
		const removed = await send('DELETE', `/api/relations/${publicRef(bob.body.player_id)}`, {
			headers: alice.headers
		});
		expect((await removed.json()).players.map((r: { name: string }) => r.name)).toEqual([
			carol.body.name
		]);
		const again = await send('DELETE', `/api/relations/${publicRef(bob.body.player_id)}`, {
			headers: alice.headers
		});
		expect(again.status).toBe(404);
		expect((await send('GET', '/api/relations')).status).toBe(401);
		expect((await send('GET', '/api/relations', { headers: bob.headers })).status).toBe(200);
	});
});

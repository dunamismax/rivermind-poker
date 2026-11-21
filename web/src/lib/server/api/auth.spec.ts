// Identity, handles and addresses agree with the Python server (P4B.5a):
// contract.json holds values computed by rivermind/server, and test_identity.py
// and test_safety.py's checks of the pure functions are ported here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	guestName,
	isLoopback,
	issue,
	issueSession,
	newPlayerId,
	originAllowed,
	publicRef,
	readSession,
	verify
} from './auth.ts';
import { ADJECTIVES, ANIMALS, MemoryPlayers, randomHandle } from './players.ts';
import { addressTag, clientAddress, handleAllowed, pairs, RateLimiter } from './safety.ts';

interface Values {
	sessions: Record<string, { value: string; read: [string, number] | null }>;
	tokens: Record<string, { value: string; verified: string | null }>;
	refs: Record<string, string>;
	guest_names: Record<string, string>;
	address_tags: Record<string, string>;
	handles: Record<string, boolean>;
	origins: [string | null, string | null, boolean][];
	addresses: [string | null, string | null, string][];
}

const contract = JSON.parse(readFileSync(new URL('./contract.json', import.meta.url), 'utf8')) as {
	secret: string;
	now: number;
	values: Values;
};
const SECRET = Buffer.from(contract.secret);
const NOW = contract.now;
const values = contract.values;
const HANDLE = /^([A-Z][a-z]+) ([A-Z][a-z]+) (\d{1,2})$/;

describe('sessions', () => {
	it('issues the cookie Python issues', () => {
		const genuine = values.sessions.genuine;
		expect(issueSession(SECRET, genuine.read![0], NOW)).toBe(genuine.value);
	});

	for (const [name, { value, read }] of Object.entries(values.sessions)) {
		it(`reads ${name} as Python does`, () => {
			const session = readSession(SECRET, value, NOW);
			expect(session && [session.playerId, session.issued]).toEqual(read);
		});
	}

	it('refuses values that are not strings', () => {
		for (const value of [null, undefined, 5, {}, ['s1']]) {
			expect(readSession(SECRET, value, NOW)).toBeNull();
		}
	});

	it('refuses a cookie signed with another secret', () => {
		const value = issueSession(Buffer.from('another-secret'), 'p_someone', NOW);
		expect(readSession(SECRET, value, NOW)).toBeNull();
		expect(readSession(Buffer.from('another-secret'), value, NOW)?.playerId).toBe('p_someone');
	});
});

describe('legacy tokens, refs and guest names', () => {
	for (const [name, { value, verified }] of Object.entries(values.tokens)) {
		it(`verifies ${name} as Python does`, () => {
			expect(verify(SECRET, value)).toBe(verified);
		});
	}

	it('issues the token Python issues', () => {
		expect(issue(SECRET, values.tokens.genuine.verified!)).toBe(values.tokens.genuine.value);
	});

	it('names players as Python does', () => {
		for (const [id, ref] of Object.entries(values.refs)) expect(publicRef(id)).toBe(ref);
		for (const [id, name] of Object.entries(values.guest_names)) expect(guestName(id)).toBe(name);
	});

	it('makes player ids like p_ and 16 URL-safe characters', () => {
		const ids = new Set(Array.from({ length: 500 }, newPlayerId));
		expect(ids.size).toBe(500);
		for (const id of ids) expect(id).toMatch(/^p_[A-Za-z0-9_-]{16}$/);
	});
});

describe('origins and addresses', () => {
	for (const [origin, host, allowed] of values.origins) {
		it(`${origin} calling ${host} is ${allowed ? 'allowed' : 'refused'}`, () => {
			expect(originAllowed(origin, host)).toBe(allowed);
		});
	}

	it('allows the origins it is told to', () => {
		expect(
			originAllowed('https://play.example', 'api.example', new Set(['https://play.example']))
		).toBe(true);
		expect(
			originAllowed('https://evil.example', 'api.example', new Set(['https://play.example']))
		).toBe(false);
	});

	it('knows this machine by name and address', () => {
		for (const host of [
			'localhost',
			'app.localhost:5173',
			'127.0.0.1:8000',
			'[::1]:5173',
			'127.9.9.9'
		]) {
			expect(isLoopback(host), host).toBe(true);
		}
		for (const host of ['rivermindpoker.com', '10.0.0.1', '[::2]', 'localhost.example', '127.1']) {
			expect(isLoopback(host), host).toBe(false);
		}
	});

	it('trusts a forwarded address only from this machine', () => {
		for (const [peer, forwarded, address] of values.addresses) {
			expect(clientAddress(peer, forwarded)).toBe(address);
		}
		// Node reports an IPv4 peer on a dual-stack socket in its mapped form.
		expect(clientAddress('::ffff:127.0.0.1', '203.0.113.9')).toBe('203.0.113.9');
	});

	it('hashes addresses as Python does', () => {
		for (const [address, tag] of Object.entries(values.address_tags)) {
			expect(addressTag(SECRET, address)).toBe(tag);
		}
		expect(addressTag(Buffer.from('other'), '203.0.113.9')).not.toBe(
			values.address_tags['203.0.113.9']
		);
	});
});

describe('handles', () => {
	for (const [handle, allowed] of Object.entries(values.handles)) {
		it(`${JSON.stringify(handle)} is ${allowed ? 'allowed' : 'refused'}`, () => {
			expect(handleAllowed(handle)).toBe(allowed);
		});
	}

	it('allows every handle it makes', () => {
		for (const adjective of ADJECTIVES) {
			for (const animal of ANIMALS) expect(handleAllowed(`${adjective} ${animal} 42`)).toBe(true);
		}
		const handles = Array.from({ length: 2_000 }, randomHandle);
		for (const handle of handles) {
			const match = HANDLE.exec(handle);
			expect(
				match && ADJECTIVES.includes(match[1] as never) && ANIMALS.includes(match[2] as never)
			).toBe(true);
			expect(handle.length).toBeLessThanOrEqual(32);
		}
		expect(new Set(handles).size).toBeGreaterThan(1_900);
	});

	it('never gives two players one handle', async () => {
		const store = new MemoryPlayers();
		const made = await Promise.all(Array.from({ length: 3_000 }, () => store.create()));
		expect(new Set(made.map((p) => p.handle)).size).toBe(3_000);
		expect(new Set(made.map((p) => p.playerId)).size).toBe(3_000);
		for (const p of made.slice(0, 50)) expect(await store.get(p.playerId)).toEqual(p);
		expect(await store.get('p_missing')).toBeNull();
	});

	it('renames to a new allowed handle', async () => {
		const store = new MemoryPlayers();
		const record = await store.create();
		const renamed = await store.rename(record.playerId);
		expect(renamed.playerId).toBe(record.playerId);
		expect(renamed.handle).not.toBe(record.handle);
		expect(handleAllowed(renamed.handle)).toBe(true);
		expect(await store.get(record.playerId)).toEqual(renamed);
	});

	it('claims a Phase 3 player with their guest name, once', async () => {
		const store = new MemoryPlayers();
		const id = newPlayerId();
		const claimed = await store.claim(id);
		expect(claimed).toEqual({ playerId: id, handle: guestName(id) });
		expect(await store.claim(id)).toEqual(claimed);
	});
});

describe('rate limits', () => {
	it('spends its burst, then refills', () => {
		let now = 1000;
		const limiter = new RateLimiter(2, 3, () => now);
		expect([1, 2, 3, 4].map(() => limiter.allow('a'))).toEqual([true, true, true, false]);
		expect(limiter.allow('b')).toBe(true);
		expect(limiter.retryAfter('a')).toBeCloseTo(0.5);
		now += 0.5;
		expect(limiter.allow('a')).toBe(true);
		expect(limiter.allow('a')).toBe(false);
		now += 100;
		expect([1, 2, 3, 4].map(() => limiter.allow('a'))).toEqual([true, true, true, false]);
		now += 61; // full buckets are forgotten
		limiter.allow('c');
		expect([...(limiter as unknown as { buckets: Map<string, unknown> }).buckets.keys()]).toEqual([
			'c'
		]);
		expect(() => new RateLimiter(0, 1)).toThrow();
	});

	it('pairs ids', () => {
		expect(pairs(['b', 'a', 'c', 'a'])).toEqual([
			['a', 'b'],
			['a', 'c'],
			['b', 'c']
		]);
	});
});

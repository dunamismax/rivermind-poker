// The runtime `server/index.ts` starts with (P4B.5b): made from the
// environment alone, as `node build/start.js` makes it, it deals every live
// table from the operating system's cryptographic randomness (D-8), never a
// seeded generator.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as p from '../../protocol-v2.ts';
import { cryptoDealer } from '../table/runner.ts';
import { createRuntime, loadSecret, type Runtime } from './runtime.ts';

const drawn = vi.hoisted(() => [] as number[]);

// Every bound asked of `crypto.randomInt` is noted, then answered by the real one.
vi.mock('node:crypto', async (original) => {
	const actual = await original<typeof import('node:crypto')>();
	return {
		...actual,
		randomInt: (bound: number) => {
			drawn.push(bound);
			return actual.randomInt(bound);
		}
	};
});

const runtimes: Runtime[] = [];
const scratch: string[] = [];

afterEach(async () => {
	while (runtimes.length) await runtimes.pop()!.close();
	while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function start(env: Record<string, string> = {}): Runtime {
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	const runtime = createRuntime({ RIVERMIND_HAND_PAUSE: '0', RIVERMIND_BOT_DELAY: '0', ...env });
	runtimes.push(runtime);
	return runtime;
}

async function call(runtime: Runtime, method: string, path: string, cookie = '') {
	const headers: Record<string, string> = { host: '127.0.0.1:4320' };
	if (cookie) headers.cookie = cookie;
	return runtime.api(new Request(`http://127.0.0.1:4320${path}`, { method, headers }), {
		peer: '127.0.0.1'
	});
}

describe('the runtime of a started server', () => {
	it('deals from crypto.randomInt (D-8)', async () => {
		const runtime = start();
		await runtime.start();
		expect(runtime.tables.options.dealer()).toBe(cryptoDealer);
		expect(runtime.tables.options.requirePerson).toBe(true);
		const visit = await call(runtime, 'POST', '/api/session');
		const cookie = (visit.headers.get('set-cookie') ?? '').split(';')[0];
		drawn.length = 0;
		const practice = await call(runtime, 'POST', '/api/practice', cookie);
		const { table_id: tableId } = (await practice.json()) as p.PracticeResponse;
		const runner = runtime.tables.manager.get(tableId)!;
		expect(runner.rng).toBe(cryptoDealer);
		await runner.waitUntil((table) => table.handNo >= 1);
		// The first hand: the button among the two players, then a whole Fisher-Yates
		// shuffle of 52 cards, each draw from the operating system.
		const shuffle = Array.from({ length: 51 }, (_, i) => 52 - i);
		const at = drawn.indexOf(52);
		expect(drawn[at - 1]).toBe(2);
		expect(drawn.slice(at, at + 51)).toEqual(shuffle);
		const deck = runner.table.hand!.deck;
		expect(new Set(deck).size).toBe(52);
	});

	it('reads its settings from the environment and refuses bad ones', async () => {
		const runtime = start({
			RIVERMIND_PRACTICE_STACK: '300',
			RIVERMIND_MAX_TABLES: '7',
			RIVERMIND_HAND_PAUSE: '0.4',
			RIVERMIND_BOT_DELAY: '0.05'
		});
		expect(runtime.site.practiceStack).toBe(300);
		expect(runtime.tables.maxTables).toBe(7);
		expect(runtime.tables.options.handPause).toBe(0.4);
		expect(runtime.tables.options.botDelay).toBe(0.05);
		expect(runtime.tables.store).toBeNull(); // no DATABASE_URL: everything in memory
		const defaults = start({ RIVERMIND_HAND_PAUSE: '', RIVERMIND_BOT_DELAY: '' });
		expect([defaults.tables.options.handPause, defaults.tables.options.botDelay]).toEqual([3, 0.6]);
		expect(defaults.tables.maxTables).toBe(200);
		for (const bad of [
			{ RIVERMIND_HAND_PAUSE: '-1' },
			{ RIVERMIND_BOT_DELAY: 'soon' },
			{ RIVERMIND_MAX_TABLES: '0' }
		]) {
			expect(() => createRuntime(bad), JSON.stringify(bad)).toThrow(RangeError);
		}
	});

	it('makes its secret file once, private to the server, and reads it back', () => {
		const dir = mkdtempSync(join(tmpdir(), 'rivermind-secret-'));
		scratch.push(dir);
		const file = join(dir, 'state', 'secret');
		const made = loadSecret({ RIVERMIND_SECRET_FILE: file });
		expect(made).toHaveLength(64);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readFileSync(file, 'utf8').trim()).toBe(Buffer.from(made!).toString('utf8'));
		expect(loadSecret({ RIVERMIND_SECRET_FILE: file })).toEqual(made);
		// The variable wins over the file, as serve-nl's does.
		const named = loadSecret({ RIVERMIND_SECRET: 'from-env', RIVERMIND_SECRET_FILE: file });
		expect(Buffer.from(named!).toString('utf8')).toBe('from-env');
		expect(loadSecret({})).toBeNull();
	});
});

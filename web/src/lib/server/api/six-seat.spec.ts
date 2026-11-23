// Six seats (P5.7): the server loads the registry's six-seat champion beside
// the heads-up one, and RiverMind Hard and Medium then play tables of two to
// six seats. A hand with two players dealt in is the heads-up champion's at
// any table, since heads-up is a different game (the button posts the small
// blind); a hand of three to six is the six-seat champion's. Medium plays six
// seats only where the six-seat champion's Medium is recorded too, and a
// six-seat bundle that fails its check leaves both bots at two seats.
//
// The champions are small bundles written by the test: the hu-m1 trees, and
// the 6max-s1 graph at 50 big blinds alone, each with a registry extract.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as p from '../../protocol-v2.ts';
import { SIX_MAX_S1 } from '../bots/abstraction.ts';
import {
	bundlePath,
	ChampionPolicy,
	HARD,
	loadChampion,
	MEDIUM,
	MediumPolicy,
	TablePolicy,
	type Champion
} from '../bots/champions.ts';
import type { MixedPolicy } from '../bots/levels.ts';
import { PythonRandom } from '../bots/mt.ts';
import { defaultBots } from '../bots/policies.ts';
import { randomStrategy, strategySize, writeChampion } from '../bots/testing.ts';
import { compileGraph, compileTree } from '../bots/tree.ts';
import { handConfig, startHand } from '../engine/state.ts';
import { seatView } from '../engine/view.ts';
import {
	createRuntime,
	describeChampion,
	describeMedium,
	loadTrained,
	type Runtime
} from './runtime.ts';
import { Player, quietLog, TestServer, type TableMessage } from './tables.testing.ts';

const trees = [compileTree(50), compileTree(100)];
const graphs = [compileGraph(50, SIX_MAX_S1)];
/** Both champions, each with a recorded Medium. */
let models: string;
/** Both champions, the six-seat one without a Medium. */
let plainSix: string;
let heads: Champion;
let six: Champion;

beforeAll(() => {
	models = mkdtempSync(join(tmpdir(), 'rivermind-six-'));
	({ champion: heads } = writeChampion(models, trees, { medium: true }));
	({ champion: six } = writeChampion(models, graphs, {
		name: 'test-six',
		medium: true,
		others: [heads]
	}));
	plainSix = mkdtempSync(join(tmpdir(), 'rivermind-six-'));
	writeChampion(plainSix, trees, { medium: true });
	writeChampion(plainSix, graphs, { name: 'test-six', others: [heads] });
}, 60_000);
afterAll(() => {
	rmSync(models, { recursive: true, force: true });
	rmSync(plainSix, { recursive: true, force: true });
});

const servers: TestServer[] = [];
const runtimes: Runtime[] = [];
const scratch: string[] = [];
afterEach(async () => {
	while (servers.length) await servers.pop()!.stop();
	while (runtimes.length) await runtimes.pop()!.close();
	while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
	vi.restoreAllMocks();
});

const env = (dir: string) => ({
	RIVERMIND_HAND_PAUSE: '0',
	RIVERMIND_BOT_DELAY: '0',
	RIVERMIND_MODELS: dir,
	RIVERMIND_CHAMPIONS: join(dir, 'champions.json')
});

/** A hand at a six-seat table with players in `seated`, the first of them on the button. */
function view(seated: readonly number[], deal = 0) {
	const stacks: (number | null)[] = Array.from({ length: 6 }, (_, s) =>
		seated.includes(s) ? 10_000 : null
	);
	const state = startHand(handConfig(50, 100), stacks, seated[0], {
		rng: new PythonRandom(deal)
	});
	return seatView(state, state.toAct!);
}

describe('the policy at a table', () => {
	it('gives a hand of two to the heads-up champion and three to six to the six-seat one', () => {
		const policy = new TablePolicy(HARD, loadChampion(models, heads), loadChampion(models, six));
		const rng = new PythonRandom(3);
		policy.act(view([0, 3]), rng);
		expect(policy.heads.stats.decisions).toBe(1);
		expect(policy.multi!.stats.decisions ?? 0).toBe(0);
		for (const seated of [
			[0, 1, 2],
			[1, 2, 4, 5],
			[0, 1, 2, 3, 4],
			[0, 1, 2, 3, 4, 5]
		]) {
			policy.act(view(seated), rng);
		}
		expect(policy.heads.stats.decisions).toBe(1);
		expect(policy.multi!.stats.decisions).toBe(4);
		expect(policy.stats.decisions).toBe(5);
		expect([2, 3, 4, 5, 6].map((n) => policy.plays(n))).toEqual([true, true, true, true, true]);
		expect([1, 7].map((n) => policy.plays(n))).toEqual([false, false]);
	});

	it('refuses three or more without a six-seat champion', () => {
		const policy = new TablePolicy(HARD, loadChampion(models, heads));
		expect(() => policy.act(view([0, 1, 2]), new PythonRandom(1))).toThrow(
			/hard has no model for 3 players/
		);
		expect(new ChampionPolicy(heads, loadChampion(models, heads)).seats).toEqual([2]);
	});
});

describe('the runtime', () => {
	const config = async (runtime: Runtime) =>
		(await (
			await runtime.api(new Request('http://127.0.0.1:4320/api/config'), { peer: '127.0.0.1' })
		).json()) as p.ConfigResponse;

	function start(settings: Record<string, string>): { runtime: Runtime; said: string } {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const said = vi.spyOn(console, 'log').mockImplementation(() => {});
		const runtime = createRuntime(settings);
		runtimes.push(runtime);
		return { runtime, said: said.mock.calls.flat().join('\n') };
	}

	it('serves both champions as Hard and Medium at two to six seats', async () => {
		const { runtime, said } = start(env(models));
		expect(said).toMatch(/RiverMind Hard plays test-six: bundle .* checked against the registry/);
		expect(said).toMatch(
			/RiverMind Hard plays tables of 2 to 6 seats: test-champion with two dealt in, test-six with three or more/
		);
		expect(said).toMatch(
			/RiverMind Medium plays half its hands as test-champion \(or test-six with three or more dealt in\)/
		);
		const bots = (await config(runtime)).bots;
		const [medium, hard] = bots.slice(3);
		expect(hard).toEqual({
			kind: 'hard',
			label: 'RiverMind Hard',
			seats: [2, 3, 4, 5, 6],
			// Pages from before six seats read `champion`: the heads-up model, as it was.
			champion: describeChampion(heads),
			champions: [describeChampion(heads, [2]), describeChampion(six, [3, 4, 5, 6])]
		});
		expect(hard.champions![1].results.map((r) => r.opponent)).toEqual([
			'heuristic',
			'calling_station',
			'champion'
		]);
		expect(medium).toEqual({
			kind: 'medium',
			label: 'RiverMind Medium',
			seats: [2, 3, 4, 5, 6],
			champion: describeMedium(heads),
			champions: [describeMedium(heads, [2]), describeMedium(six, [3, 4, 5, 6])]
		});
		expect((runtime.tables.bots[HARD] as ChampionPolicy).multi?.champion.name).toBe('test-six');
		expect(await runtime.candidateChecks.champions()).toBe(true);
	});

	it('keeps Medium at two seats when the six-seat champion has no recorded Medium', async () => {
		const { runtime, said } = start(env(plainSix));
		expect(said).toMatch(
			/RiverMind Medium plays two seats only: the registry records no evaluation of it for test-six/
		);
		const bots = (await config(runtime)).bots;
		expect(bots.find((b) => b.kind === MEDIUM)).toEqual({
			kind: 'medium',
			label: 'RiverMind Medium',
			seats: [2],
			champion: describeMedium(heads)
		});
		expect(bots.find((b) => b.kind === HARD)?.seats).toEqual([2, 3, 4, 5, 6]);
		expect((runtime.tables.bots[MEDIUM] as MediumPolicy).multi).toBeNull();
	});

	it('plays two seats only when the six-seat bundle fails its check, and the candidate check says so', async () => {
		const damaged = mkdtempSync(join(tmpdir(), 'rivermind-six-'));
		scratch.push(damaged);
		cpSync(models, damaged, { recursive: true });
		writeFileSync(
			join(bundlePath(damaged, six), 'strategy.u8'),
			randomStrategy(strategySize(graphs), 9)
		);
		const failed = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { runtime } = start(env(damaged));
		expect(failed.mock.calls.flat().join('\n')).toMatch(
			/Could not load the 6-max champion test-six .*the trained bots play two seats only/
		);
		const bots = (await config(runtime)).bots;
		expect(bots.filter((b) => b.champion).map((b) => [b.kind, b.seats, 'champions' in b])).toEqual([
			['medium', [2], false],
			['hard', [2], false]
		]);
		expect(await runtime.candidateChecks.champions()).toBe(false);
		// Loaded alone, the heads-up champion is still served.
		expect(loadTrained(env(damaged), quietLog()).failed).toEqual(['test-six']);
	});
});

describe('Hard and Medium at a six-seat table', () => {
	async function serve(): Promise<TestServer> {
		const log = quietLog();
		const trained = loadTrained(env(models), log);
		const server = await new TestServer({
			site: { trained: trained.trained },
			tables: { bots: { ...defaultBots(), ...trained.bots } }
		}).start();
		servers.push(server);
		return server;
	}
	const handNo = (message: TableMessage): number => message.view.hand?.hand_no ?? 0;

	it('fills tables of three to six seats and refuses seven', async () => {
		const server = await serve();
		const alice = await Player.create(server);
		const seven = await alice.request('POST', '/api/tables', { seats: 7, bots: 'hard' });
		expect(seven.status).toBe(400);
		expect(((await seven.json()) as p.HttpError).detail).toBe(
			'RiverMind Hard plays only at tables of 2 to 6 seats'
		);
		const tableId = await alice.newTable(6, 'hard');
		await server.settle();
		const a = await alice.socket();
		const joined = (await a.join(tableId)).view;
		expect(joined.name).toBe('6-seat table with RiverMind Hards');
		expect(joined.seats.slice(1).map((s) => s?.name)).toEqual([
			'RiverMind Hard 2',
			'RiverMind Hard 3',
			'RiverMind Hard 4',
			'RiverMind Hard 5',
			'RiverMind Hard 6'
		]);
		await a.playUntil(tableId, (m) => handNo(m) > 4);
		// The table's own policy decided, and with six dealt in it was the six-seat champion.
		const runner = server.runner(tableId) as unknown as { policies: Map<string, TablePolicy> };
		const table = runner.policies.get(HARD)!;
		expect(table.multi!.stats.decisions).toBeGreaterThan(10);
		expect(table.heads.stats.decisions ?? 0).toBe(0);
		const bob = await Player.create(server);
		const four = await bob.newTable(4, 'medium');
		await server.settle();
		const b = await bob.socket();
		await b.join(four);
		await b.playUntil(four, (m) => handNo(m) > 4);
		const mixed = (
			server.runner(four) as unknown as { policies: Map<string, MixedPolicy> }
		).policies.get(MEDIUM)!;
		const strong = mixed.strong as TablePolicy;
		// Medium chose per hand; the hands it played as Hard, with four dealt in, were the six-seat champion's.
		expect((mixed.hands.strong ?? 0) + (mixed.hands.weak ?? 0)).toBeGreaterThan(4);
		expect(strong.heads.stats.decisions ?? 0).toBe(0);
		if (mixed.hands.strong) expect(strong.multi!.stats.decisions).toBeGreaterThan(0);
	});
});

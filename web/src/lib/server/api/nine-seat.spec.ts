// Nine seats (P5.6, option 1): the server loads the registry's nine-seat model
// beside the six-seat champion it builds on, and RiverMind Hard then plays
// tables of two to nine. A hand of seven to nine dealt in is the nine-seat
// model's; three to six stay the six-seat champion's and two the heads-up
// one's. Medium plays seven to nine only where the nine-seat model's Medium is
// recorded, and a nine-seat model that fails its check, or builds on another
// six-seat champion, leaves the bots at six seats.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as p from '../../protocol-v2.ts';
import { SIX_MAX_S1 } from '../bots/abstraction.ts';
import {
	bundlePath,
	HARD,
	loadChampion,
	loadNineChampion,
	MEDIUM,
	TablePolicy,
	type Champion
} from '../bots/champions.ts';
import { PythonRandom } from '../bots/mt.ts';
import { defaultBots } from '../bots/policies.ts';
import { writeChampion, writeNineChampion } from '../bots/testing.ts';
import { compileGraph, compileTree } from '../bots/tree.ts';
import { handConfig, startHand } from '../engine/state.ts';
import { seatView } from '../engine/view.ts';
import { createRuntime, describeChampion, loadTrained, type Runtime } from './runtime.ts';
import { Player, quietLog, TestServer, type TableMessage } from './tables.testing.ts';

const trees = [compileTree(50), compileTree(100)];
const graphs = [compileGraph(50, SIX_MAX_S1)];
/** Three champions, each with a recorded Medium. */
let models: string;
/** The same, the nine-seat one without a Medium. */
let plainNine: string;
let heads: Champion;
let six: Champion;
let nine: Champion;

beforeAll(() => {
	models = mkdtempSync(join(tmpdir(), 'rivermind-nine-'));
	({ champion: heads } = writeChampion(models, trees, { medium: true }));
	({ champion: six } = writeChampion(models, graphs, {
		name: 'test-six',
		medium: true,
		others: [heads]
	}));
	({ champion: nine } = writeNineChampion(models, six, { medium: true, others: [heads, six] }));
	plainNine = mkdtempSync(join(tmpdir(), 'rivermind-nine-'));
	cpSync(models, plainNine, { recursive: true });
	writeNineChampion(plainNine, six, { others: [heads, six] });
}, 60_000);
afterAll(() => {
	rmSync(models, { recursive: true, force: true });
	rmSync(plainNine, { recursive: true, force: true });
});

const servers: TestServer[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
	while (servers.length) await servers.pop()!.stop();
	while (runtimes.length) await runtimes.pop()!.close();
	vi.restoreAllMocks();
});

const env = (dir: string) => ({
	RIVERMIND_HAND_PAUSE: '0',
	RIVERMIND_BOT_DELAY: '0',
	RIVERMIND_MODELS: dir,
	RIVERMIND_CHAMPIONS: join(dir, 'champions.json')
});

/** A hand at a nine-seat table with players in `seated`, the first of them on the button. */
function view(seated: readonly number[], deal = 0) {
	const stacks: (number | null)[] = Array.from({ length: 9 }, (_, s) =>
		seated.includes(s) ? 10_000 : null
	);
	const state = startHand(handConfig(50, 100), stacks, seated[0], { rng: new PythonRandom(deal) });
	return seatView(state, state.toAct!);
}

describe('the policy at a table', () => {
	it('gives a hand of seven to nine to the nine-seat model, and smaller hands to the others', () => {
		const sixBundle = loadChampion(models, six);
		const policy = new TablePolicy(
			HARD,
			loadChampion(models, heads),
			sixBundle,
			loadNineChampion(models, nine, { champion: six, bundle: sixBundle })
		);
		const rng = new PythonRandom(3);
		policy.act(view([0, 3]), rng);
		policy.act(view([0, 1, 2, 3, 4, 5]), rng);
		for (const seated of [
			[0, 1, 2, 3, 4, 5, 6],
			[0, 2, 3, 4, 5, 6, 7, 8],
			[0, 1, 2, 3, 4, 5, 6, 7, 8]
		]) {
			policy.act(view(seated), rng);
		}
		expect(policy.heads.stats.decisions).toBe(1);
		expect(policy.multi!.stats.decisions).toBe(1);
		expect(policy.nine!.stats.decisions).toBe(3);
		// The first to act at seven or more is an early seat, which the early table plays.
		expect(policy.nine!.stats.early).toBe(3);
		expect([2, 3, 6, 7, 9].map((n) => policy.plays(n))).toEqual([true, true, true, true, true]);
		expect(policy.plays(10)).toBe(false);
	});

	it('refuses a nine-seat model on another six-seat champion', () => {
		const sixBundle = loadChampion(models, six);
		expect(() =>
			loadNineChampion(
				models,
				{ ...nine, builds_on: 'other-six' },
				{ champion: six, bundle: sixBundle }
			)
		).toThrow(/builds on other-six, not test-six/);
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

	it('serves Hard and Medium at two to nine seats', async () => {
		const { runtime, said } = start(env(models));
		expect(said).toMatch(
			/RiverMind Hard plays test-nine: early table .* checked against the registry/
		);
		expect(said).toMatch(
			/RiverMind Hard plays tables of 2 to 9 seats: test-champion with two dealt in, test-six with three or more, test-nine with seven or more/
		);
		const bots = (await config(runtime)).bots;
		const hard = bots.find((b) => b.kind === HARD)!;
		expect(hard.seats).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
		expect(hard.champion).toEqual(describeChampion(heads));
		expect(hard.champions!.map((c) => [c.name, c.seats])).toEqual([
			['test-champion', [2]],
			['test-six', [3, 4, 5, 6]],
			['test-nine', [7, 8, 9]]
		]);
		expect(bots.find((b) => b.kind === MEDIUM)!.seats).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
		expect(await runtime.candidateChecks.champions()).toBe(true);
	});

	it('keeps Medium at six seats when the nine-seat model has no recorded Medium', async () => {
		const { runtime, said } = start(env(plainNine));
		expect(said).toMatch(
			/RiverMind Medium plays at most six seats: the registry records no evaluation of it for test-nine/
		);
		const bots = (await config(runtime)).bots;
		expect(bots.find((b) => b.kind === MEDIUM)!.seats).toEqual([2, 3, 4, 5, 6]);
		expect(bots.find((b) => b.kind === HARD)!.seats).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it('plays at most six seats when the nine-seat model fails its check, and the candidate check says so', async () => {
		const damaged = mkdtempSync(join(tmpdir(), 'rivermind-nine-'));
		try {
			cpSync(models, damaged, { recursive: true });
			const early = join(bundlePath(damaged, nine), 'early.u8');
			const bytes = readFileSync(early);
			bytes[0] ^= 1;
			writeFileSync(early, bytes);
			const failed = vi.spyOn(console, 'error').mockImplementation(() => {});
			const { runtime } = start(env(damaged));
			expect(failed.mock.calls.flat().join('\n')).toMatch(
				/Could not load the 9-max model test-nine .*the trained bots play at most 6 seats/
			);
			const bots = (await config(runtime)).bots;
			expect(bots.find((b) => b.kind === HARD)!.seats).toEqual([2, 3, 4, 5, 6]);
			expect(await runtime.candidateChecks.champions()).toBe(false);
			expect(loadTrained(env(damaged), quietLog()).failed).toEqual(['test-nine']);
		} finally {
			rmSync(damaged, { recursive: true, force: true });
		}
	});
});

describe('Hard at a nine-seat table', () => {
	it('fills a table of nine and plays its hands', async () => {
		const trained = loadTrained(env(models), quietLog());
		const server = await new TestServer({
			site: { trained: trained.trained },
			tables: { bots: { ...defaultBots(), ...trained.bots } }
		}).start();
		servers.push(server);
		const alice = await Player.create(server);
		const tableId = await alice.newTable(9, 'hard');
		await server.settle();
		const a = await alice.socket();
		const joined = (await a.join(tableId)).view;
		expect(joined.seats.filter((s) => s?.name.startsWith('RiverMind Hard')).length).toBe(8);
		const handNo = (message: TableMessage): number => message.view.hand?.hand_no ?? 0;
		await a.playUntil(tableId, (m) => handNo(m) > 4);
		const runner = server.runner(tableId) as unknown as { policies: Map<string, TablePolicy> };
		const table = runner.policies.get(HARD)!;
		expect(table.nine!.stats.decisions).toBeGreaterThan(10);
		expect(table.nine!.stats.early).toBeGreaterThan(0);
		expect(table.multi!.stats.decisions ?? 0).toBe(0);
	});
});

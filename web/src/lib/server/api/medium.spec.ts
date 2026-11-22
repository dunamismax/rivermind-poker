// RiverMind Medium (P5.7): the heads-up champion mixed with RiverMind Easy, a
// hand at a time. The server offers it only for a champion whose Medium has a
// recorded evaluation in the registry, at two seats, in practice too, and
// labels it with that evaluation. The champion is a small bundle written by
// the test, as in champion.spec.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as p from '../../protocol-v2.ts';
import { BlueprintPolicy } from '../bots/blueprint.ts';
import {
	ChampionPolicy,
	HARD,
	loadChampion,
	MEDIUM,
	MediumPolicy,
	type Champion
} from '../bots/champions.ts';
import { medium, MEDIUM_SHARE, MixedPolicy } from '../bots/levels.ts';
import { PythonRandom } from '../bots/mt.ts';
import {
	CallingStationPolicy,
	defaultBots,
	HeuristicPolicy,
	type Policy
} from '../bots/policies.ts';
import { writeChampion } from '../bots/testing.ts';
import { compileTree } from '../bots/tree.ts';
import { Action, apply, handConfig, isOver, startHand, type HandState } from '../engine/state.ts';
import { seatView, type SeatView } from '../engine/view.ts';
import { createRuntime, describeChampion, describeMedium, type Runtime } from './runtime.ts';
import { Player, TestServer, type ServerOptions, type TableMessage } from './tables.testing.ts';

const trees = [compileTree(50), compileTree(100)];
let models: string;
let plainModels: string;
let champion: Champion;
let plain: Champion;

beforeAll(() => {
	models = mkdtempSync(join(tmpdir(), 'rivermind-medium-'));
	plainModels = mkdtempSync(join(tmpdir(), 'rivermind-medium-'));
	({ champion } = writeChampion(models, trees, { medium: true }));
	({ champion: plain } = writeChampion(plainModels, trees));
});
afterAll(() => {
	rmSync(models, { recursive: true, force: true });
	rmSync(plainModels, { recursive: true, force: true });
});

const servers: TestServer[] = [];
const runtimes: Runtime[] = [];
afterEach(async () => {
	while (servers.length) await servers.pop()!.stop();
	while (runtimes.length) await runtimes.pop()!.close();
	vi.restoreAllMocks();
});

class Recorder implements Policy {
	readonly name: string;
	asked = 0;
	constructor(name: string) {
		this.name = name;
	}
	act(view: SeatView): Action {
		this.asked++;
		return view.legal!.canCheck ? Action.check() : Action.call();
	}
}

function deal(n: number): HandState {
	return startHand(handConfig(50, 100), [10_000, 10_000], n % 2, { rng: new PythonRandom(n) });
}

describe('the mix', () => {
	it('plays each hand as one bot from its first decision to its last', () => {
		const strong = new Recorder('strong');
		const weak = new Recorder('weak');
		const mixed = new MixedPolicy(strong, weak, 0.5);
		const other = new CallingStationPolicy();
		const rng = new PythonRandom(7);
		for (let n = 0; n < 200; n++) {
			let state = deal(n);
			const before = [strong.asked, weak.asked];
			const mine = n % 2;
			while (!isOver(state)) {
				const seat = state.toAct!;
				state = apply(state, (seat === mine ? mixed : other).act(seatView(state, seat), rng));
			}
			const grew = [strong.asked > before[0], weak.asked > before[1]];
			expect(grew[0] !== grew[1]).toBe(true);
			expect(mixed.lastStrong).toBe(grew[0]);
		}
		expect((mixed.hands.strong ?? 0) + (mixed.hands.weak ?? 0)).toBe(200);
		expect(mixed.hands.strong).toBeGreaterThan(70);
		expect(mixed.hands.strong).toBeLessThan(130);
	});

	it('draws one number at its first decision in a hand and none after', () => {
		let state = deal(0);
		const mixed = new MixedPolicy(new Recorder('strong'), new Recorder('weak'), 0.5);
		const rng = new PythonRandom(11);
		const expected = new PythonRandom(11).random() < 0.5;
		state = apply(state, mixed.act(seatView(state, 0), rng));
		expect(mixed.lastStrong).toBe(expected);
		const next = new PythonRandom(11);
		next.random();
		state = apply(apply(state, Action.check()), Action.check());
		mixed.act(seatView(state, 0), rng);
		expect(rng.random()).toBe(next.random());
	});

	it('is half the champion and half RiverMind Easy, and refuses another share', () => {
		const m = medium(new CallingStationPolicy());
		expect(m.name).toBe(MEDIUM);
		expect(m.share).toBe(MEDIUM_SHARE);
		expect(MEDIUM_SHARE).toBe(0.5);
		expect(m.weak).toBeInstanceOf(HeuristicPolicy);
		expect(() => new MixedPolicy(new CallingStationPolicy(), undefined, 2)).toThrow(RangeError);
	});
});

describe('serving Medium', () => {
	it('gives each table its own memory, the champion’s included', () => {
		const bundle = loadChampion(models, champion);
		const policy = new MediumPolicy(champion, bundle);
		const [one, two] = [policy.forTable(), policy.forTable()];
		expect(one).not.toBe(two);
		expect(one.strong).toBeInstanceOf(BlueprintPolicy);
		expect(one.strong).not.toBe(two.strong);
		const rng = new PythonRandom(3);
		for (let n = 0; n < 20; n++) {
			let state = deal(n);
			while (!isOver(state)) state = apply(state, one.act(seatView(state, state.toAct!), rng));
		}
		expect((one.hands.strong ?? 0) + (one.hands.weak ?? 0)).toBeGreaterThan(0);
		expect(two.hands).toEqual({});
		expect(MediumPolicy.recorded(champion)).toBe(true);
		expect(MediumPolicy.recorded(plain)).toBe(false);
		expect(
			MediumPolicy.recorded({
				...champion,
				levels: { medium: { ...champion.levels!.medium!, share: 0.25 } }
			})
		).toBe(false);
	});

	it('describes Medium by its own evaluation against Easy, the calling station and Hard', () => {
		expect(describeMedium(champion)).toEqual({
			name: 'test-champion',
			promoted: '2026-11-21',
			iterations: 1_000,
			stack_bb: 100,
			results: [
				{
					opponent: 'heuristic',
					label: 'RiverMind Easy',
					hands: 40_000,
					bb_per_100: 29.4,
					ci95: [20.1, 38.7]
				},
				{
					opponent: 'calling_station',
					label: 'Calling bot',
					hands: 40_000,
					bb_per_100: 190.2,
					ci95: [172.5, 207.9]
				},
				{
					opponent: 'hard',
					label: 'RiverMind Hard',
					hands: 40_000,
					bb_per_100: -30.5,
					ci95: [-41.2, -19.8]
				}
			]
		});
	});
});

describe('the runtime', () => {
	const env = (dir: string) => ({
		RIVERMIND_HAND_PAUSE: '0',
		RIVERMIND_BOT_DELAY: '0',
		RIVERMIND_MODELS: dir,
		RIVERMIND_CHAMPIONS: join(dir, 'champions.json')
	});
	const config = async (runtime: Runtime) =>
		(await (
			await runtime.api(new Request('http://127.0.0.1:4320/api/config'), { peer: '127.0.0.1' })
		).json()) as p.ConfigResponse;
	function start(settings: Record<string, string>): { runtime: Runtime; said: string } {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const runtime = createRuntime(settings);
		runtimes.push(runtime);
		const said = log.mock.calls.flat().join('\n');
		log.mockRestore();
		return { runtime, said };
	}

	it('offers RiverMind Medium before Hard when the registry records its evaluation', async () => {
		const { runtime, said } = start(env(models));
		expect(said).toMatch(
			/RiverMind Medium plays half its hands as test-champion and half as RiverMind Easy/
		);
		const { bots } = await config(runtime);
		expect(bots.map((b) => b.kind)).toEqual([
			'random',
			'calling_station',
			'heuristic',
			'medium',
			'hard'
		]);
		expect(bots[3]).toEqual({
			kind: 'medium',
			label: 'RiverMind Medium',
			seats: [2],
			champion: describeMedium(champion)
		});
		expect(bots[4].champion).toEqual(describeChampion(champion));
		expect(runtime.tables.bots[MEDIUM]).toBeInstanceOf(MediumPolicy);
		expect(runtime.tables.bots[HARD]).toBeInstanceOf(ChampionPolicy);
	});

	it('leaves Medium out for a champion with no recorded Medium', async () => {
		const { runtime, said } = start(env(plainModels));
		expect(said).toMatch(
			/RiverMind Medium is not offered: the registry records no evaluation of it/
		);
		expect((await config(runtime)).bots.map((b) => b.kind)).toEqual([
			'random',
			'calling_station',
			'heuristic',
			'hard'
		]);
	});
});

describe('RiverMind Medium at the tables', () => {
	async function serve(options: ServerOptions = {}): Promise<TestServer> {
		const bundle = loadChampion(models, champion);
		const server = await new TestServer({
			...options,
			site: {
				trained: {
					[MEDIUM]: { seats: [2], champion: describeMedium(champion) },
					[HARD]: { seats: [2], champion: describeChampion(champion) }
				},
				...options.site
			},
			tables: {
				bots: {
					...defaultBots(),
					[MEDIUM]: new MediumPolicy(champion, bundle),
					[HARD]: new ChampionPolicy(champion, bundle)
				},
				...options.tables
			}
		}).start();
		servers.push(server);
		return server;
	}
	const handNo = (message: TableMessage): number => message.view.hand?.hand_no ?? 0;

	it('is offered for two seats only, and plays whole hands there', async () => {
		const server = await serve();
		const alice = await Player.create(server);
		const six = await alice.request('POST', '/api/tables', { seats: 6, bots: 'medium' });
		expect(six.status).toBe(400);
		expect(((await six.json()) as p.HttpError).detail).toBe(
			'RiverMind Medium plays only at tables of 2 seats'
		);
		const tableId = await alice.newTable(2, 'medium');
		await server.settle();
		const a = await alice.socket();
		const view = (await a.join(tableId)).view;
		expect(view.seats[1]).toMatchObject({ kind: 'bot', bot: 'medium', name: 'RiverMind Medium 2' });
		await a.playUntil(tableId, (m) => handNo(m) > 4);
	});

	it('is a practice opponent, and gives way to Hard between hands', async () => {
		const server = await serve({ seed: 5 });
		const alice = await Player.create(server);
		const response = await alice.request('POST', '/api/practice', { bot: 'medium' });
		expect(response.status).toBe(200);
		const started = (await response.json()) as p.PracticeResponse;
		expect(started).toMatchObject({ created: true, bot: 'medium' });
		await server.settle();
		const a = await alice.socket();
		const view = (await a.join(started.table_id)).view;
		expect(view.name).toBe('Practice vs RiverMind Medium');
		await a.playUntil(started.table_id, (m) => handNo(m) > 3);
		const runner = server.runner(started.table_id);
		const decided = (runner as unknown as { policies: Map<string, MixedPolicy> }).policies.get(
			MEDIUM
		)!;
		expect((decided.hands.strong ?? 0) + (decided.hands.weak ?? 0)).toBeGreaterThan(0);
		const asked = await alice.request('POST', '/api/practice', { bot: 'hard' });
		expect(asked.status).toBe(200);
		const now = handNo(a.latest.get(started.table_id)!);
		const next = await a.playUntil(started.table_id, (m) => handNo(m) > now + 1);
		expect(next.view.seats[1]).toMatchObject({ bot: 'hard' });
	});
});

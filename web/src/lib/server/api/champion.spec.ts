// Serving the evaluated heads-up opponent (P5.7a). The server loads a
// champion's bundle only when every file is the one the registry names, then
// offers it as RiverMind Hard at two-seat tables and in practice, with the
// evaluation its label links to. A guest can change opponents between
// practice hands, and a saved table whose bot the server no longer runs plays
// on against RiverMind Easy.
//
// The champions here are small bundles written by the test, with a registry
// extract to match. The last test loads the registered champion itself when
// its bundle is on this machine.
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as p from '../../protocol-v2.ts';
import { BlueprintPolicy } from '../bots/blueprint.ts';
import { BundleError } from '../bots/bundle.ts';
import {
	bundlePath,
	championFor,
	ChampionPolicy,
	HARD,
	loadChampion,
	readRegistry,
	REGISTRY,
	type Champion
} from '../bots/champions.ts';
import { PythonRandom } from '../bots/mt.ts';
import { defaultBots } from '../bots/policies.ts';
import { randomStrategy, strategySize, writeChampion } from '../bots/testing.ts';
import { compileTree } from '../bots/tree.ts';
import { handConfig, startHand } from '../engine/state.ts';
import { seatView } from '../engine/view.ts';
import { runnerOptions, TableManager } from '../table/runner.ts';
import { tableFromDict, tableToDict } from '../table/snapshot.ts';
import { createRuntime, describeChampion, loadTrained, type Runtime } from './runtime.ts';
import {
	Player,
	quietLog,
	TestServer,
	waitFor,
	type ServerOptions,
	type TableMessage
} from './tables.testing.ts';

const trees = [compileTree(50), compileTree(100)];
let models: string;
let champion: Champion;

beforeAll(() => {
	models = mkdtempSync(join(tmpdir(), 'rivermind-champion-'));
	({ champion } = writeChampion(models, trees));
});
afterAll(() => rmSync(models, { recursive: true, force: true }));

const servers: TestServer[] = [];
const runtimes: Runtime[] = [];
const scratch: string[] = [];

afterEach(async () => {
	while (servers.length) await servers.pop()!.stop();
	while (runtimes.length) await runtimes.pop()!.close();
	while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
	vi.restoreAllMocks();
});

/** A test server that runs the champion as RiverMind Hard beside the simple bots. */
async function serve(options: ServerOptions = {}): Promise<TestServer> {
	const policy = new ChampionPolicy(champion, loadChampion(models, champion));
	const server = await new TestServer({
		...options,
		site: {
			trained: { [HARD]: { seats: [2], champion: describeChampion(champion) } },
			...options.site
		},
		tables: { bots: { ...defaultBots(), [HARD]: policy }, ...options.tables }
	}).start();
	servers.push(server);
	return server;
}

async function practice(player: Player, body?: unknown): Promise<p.PracticeResponse> {
	const response = await player.request('POST', '/api/practice', body);
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json()) as p.PracticeResponse;
}

const handNo = (message: TableMessage): number => message.view.hand?.hand_no ?? 0;
const botOf = (message: TableMessage) => message.view.seats[1]!;

describe('loading a champion', () => {
	it('loads the registered bundle and plays it', () => {
		const bundle = loadChampion(models, champion);
		expect(bundle.path).toBe(bundlePath(models, champion));
		const policy = new ChampionPolicy(champion, bundle);
		const state = startHand(handConfig(50, 100), [10_000, 10_000], 0, {
			rng: new PythonRandom(5)
		});
		const action = policy.act(seatView(state, state.toAct!), new PythonRandom(6));
		expect(['fold', 'call', 'raise']).toContain(action.kind);
		// Each table gets a policy with its own memory of hands, over the same arrays.
		const [one, two] = [policy.forTable(), policy.forTable()];
		expect(one).toBeInstanceOf(BlueprintPolicy);
		expect(one).not.toBe(two);
		expect(one.bundle).toBe(bundle);
		one.act(seatView(state, state.toAct!), new PythonRandom(6));
		expect(one.stats.decisions).toBe(1);
		expect(two.stats.decisions ?? 0).toBe(0);
	});

	it('refuses a bundle that is not the registered one', () => {
		const other = mkdtempSync(join(tmpdir(), 'rivermind-champion-'));
		scratch.push(other);
		// The same name, another strategy: a sound bundle, and not the one that was evaluated.
		writeChampion(other, trees, {
			strategy: randomStrategy(strategySize(trees), 2)
		});
		expect(() => loadChampion(other, champion)).toThrow(
			/not the bundle registered for test-champion: strategy.u8 differ/
		);
		expect(() =>
			loadChampion(models, {
				...champion,
				checkpoint: { ...champion.checkpoint, manifest_sha256: 'f'.repeat(64) }
			})
		).toThrow(/was not exported from test-champion's checkpoint/);
		expect(() =>
			loadChampion(models, {
				...champion,
				bundle: { ...champion.bundle, table_set: 'f'.repeat(64) }
			})
		).toThrow(/expected card table set/);
		// A file changed on disk after the bundle was written.
		const damaged = mkdtempSync(join(tmpdir(), 'rivermind-champion-'));
		scratch.push(damaged);
		cpSync(models, damaged, { recursive: true });
		const strategy = join(bundlePath(damaged, champion), 'strategy.u8');
		writeFileSync(strategy, randomStrategy(strategySize(trees), 3));
		expect(() => loadChampion(damaged, champion)).toThrow(BundleError);
		expect(() => loadChampion(join(models, 'missing'), champion)).toThrow(BundleError);
	});

	it('describes the champion by the gate matchups of what the site serves', () => {
		expect(describeChampion(champion)).toEqual({
			name: 'test-champion',
			promoted: '2026-11-21',
			iterations: 1_000,
			stack_bb: 100,
			results: [
				{
					opponent: 'heuristic',
					label: 'RiverMind Easy',
					hands: 40_000,
					bb_per_100: 58.79,
					ci95: [50.09, 67.48]
				},
				{
					opponent: 'calling_station',
					label: 'Calling bot',
					hands: 40_000,
					bb_per_100: 224.92,
					ci95: [208.64, 241.2]
				},
				{
					opponent: 'champion',
					label: 'the champion before it',
					hands: 40_000,
					bb_per_100: 21.14,
					ci95: [10.45, 31.84]
				}
			]
		});
	});
});

describe('the runtime', () => {
	const env = () => ({
		RIVERMIND_HAND_PAUSE: '0',
		RIVERMIND_BOT_DELAY: '0',
		RIVERMIND_MODELS: models,
		RIVERMIND_CHAMPIONS: join(models, 'champions.json')
	});
	const config = async (runtime: Runtime) =>
		(await (
			await runtime.api(new Request('http://127.0.0.1:4320/api/config'), { peer: '127.0.0.1' })
		).json()) as p.ConfigResponse;

	function start(settings: Record<string, string>): Runtime {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const runtime = createRuntime(settings);
		runtimes.push(runtime);
		return runtime;
	}

	it('offers RiverMind Hard once the bundle in RIVERMIND_MODELS checks out', async () => {
		const said = vi.spyOn(console, 'log').mockImplementation(() => {});
		const runtime = start(env());
		expect(said.mock.calls.flat().join('\n')).toMatch(
			new RegExp(
				`RiverMind Hard plays test-champion: .*strategy.u8 ${champion.bundle.files['strategy.u8']}, table set ${champion.bundle.table_set}`
			)
		);
		const { bots } = await config(runtime);
		expect(bots.map((b) => b.kind)).toEqual(['random', 'calling_station', 'heuristic', 'hard']);
		expect(bots.slice(0, 3).every((b) => !('seats' in b) && !('champion' in b))).toBe(true);
		expect(bots[3]).toEqual({
			kind: 'hard',
			label: 'RiverMind Hard',
			seats: [2],
			champion: describeChampion(champion)
		});
		expect(runtime.tables.bots[HARD]).toBeInstanceOf(ChampionPolicy);
	});

	it('runs without it when there is no models directory, or the bundle fails the check', async () => {
		const plain = start({ RIVERMIND_HAND_PAUSE: '0', RIVERMIND_BOT_DELAY: '0' });
		expect((await config(plain)).bots).toEqual([
			{ kind: 'random', label: 'Random bot' },
			{ kind: 'calling_station', label: 'Calling bot' },
			{ kind: 'heuristic', label: 'RiverMind Easy' }
		]);
		// The built-in registry names another champion than the bundle in this directory.
		const log = quietLog();
		expect(loadTrained({ RIVERMIND_MODELS: models }, log)).toEqual({ bots: {}, trained: {} });
		expect(log.lines.join('\n')).toMatch(/RiverMind Hard is not offered/);
		const failed = vi.spyOn(console, 'error').mockImplementation(() => {});
		const wrong = start({ ...env(), RIVERMIND_CHAMPIONS: '' });
		expect(failed).toHaveBeenCalled();
		expect((await config(wrong)).bots.map((b) => b.kind)).not.toContain('hard');
		expect(() => readRegistry(join(bundlePath(models, champion), 'manifest.json'))).toThrow(
			/not a registry of champions/
		);
	});
});

describe('RiverMind Hard at the tables', () => {
	it('is offered for two seats only', async () => {
		const server = await serve();
		const alice = await Player.create(server);
		const six = await alice.request('POST', '/api/tables', { seats: 6, bots: 'hard' });
		expect(six.status).toBe(400);
		expect(((await six.json()) as p.HttpError).detail).toBe(
			'RiverMind Hard plays only at tables of 2 seats'
		);
		const tableId = await alice.newTable(2, 'hard');
		await server.settle();
		const a = await alice.socket();
		const view = (await a.join(tableId)).view;
		expect(view.name).toBe('2-seat table with RiverMind Hards');
		expect(view.seats[1]).toMatchObject({ kind: 'bot', bot: 'hard', name: 'RiverMind Hard 2' });
		// Whole hands against it, at a wallet-backed table.
		await a.playUntil(tableId, (m) => handNo(m) > 3);
		const played = (await alice.json<p.HandListResponse>('GET', '/api/hands')).hands;
		expect(played.length).toBeGreaterThanOrEqual(3);
		expect(played.every((hand) => !hand.practice)).toBe(true);
	});

	it('is the practice opponent when asked for, and Easy stays the default', async () => {
		const server = await serve({ seed: 4 });
		const [alice, bob] = [await Player.create(server), await Player.create(server)];
		expect((await practice(bob)).bot).toBe('heuristic');
		expect((await practice(bob, {})).bot).toBe('heuristic');
		const started = await practice(alice, { bot: 'hard' });
		expect(started).toMatchObject({ created: true, seat: 0, bot: 'hard' });
		expect('next_bot' in started).toBe(false);
		await server.settle();
		const a = await alice.socket();
		const view = (await a.join(started.table_id)).view;
		expect(view.name).toBe('Practice vs RiverMind Hard');
		expect(view.seats[1]).toMatchObject({ kind: 'bot', bot: 'hard', name: 'RiverMind Hard 2' });
		await a.playUntil(started.table_id, (m) => handNo(m) > 4);
		// The table has its own policy, and that is what decided.
		const runner = server.runner(started.table_id);
		const shared = server.tables.bots[HARD] as ChampionPolicy;
		expect(shared.forTable().stats.decisions ?? 0).toBe(0);
		expect(runner.table.handNo).toBeGreaterThan(4);
		const bad = await alice.request('POST', '/api/practice', { bot: 'deep' });
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as p.HttpError).detail).toBe(
			"bot must be one of ['calling_station', 'hard', 'heuristic', 'random'] or null"
		);
		expect((await alice.request('POST', '/api/practice', { bot: 7 })).status).toBe(400);
	});

	it('changes the practice opponent between hands', async () => {
		const server = await serve({ seed: 9 });
		const alice = await Player.create(server);
		const started = await practice(alice);
		const tableId = started.table_id;
		await server.settle();
		const a = await alice.socket();
		await a.join(tableId);
		// Mid-hand: the guest is to act, so the bot is still in the hand and keeps its seat.
		const turn = await a.myTurn(tableId);
		const during = handNo(turn);
		const asked = await practice(alice, { bot: 'hard' });
		expect(asked).toMatchObject({
			table_id: tableId,
			created: false,
			bot: 'heuristic',
			next_bot: 'hard'
		});
		expect(server.runner(tableId).pendingBot).toBe('hard');
		// Asking for the bot already there takes the request back.
		expect('next_bot' in (await practice(alice, { bot: 'heuristic' }))).toBe(false);
		expect((await practice(alice, { bot: 'hard' })).next_bot).toBe('hard');
		// Asking with no choice says what is waiting and changes nothing.
		expect(await practice(alice)).toMatchObject({ bot: 'heuristic', next_bot: 'hard' });
		// The hand in progress is finished against the bot that started it.
		expect(botOf(a.latest.get(tableId)!).bot).toBe('heuristic');
		a.play(tableId, turn);
		const next = await a.playUntil(tableId, (m) => handNo(m) > during);
		expect(botOf(next)).toMatchObject({ bot: 'hard', name: 'RiverMind Hard 2' });
		expect(next.view.name).toBe('Practice vs RiverMind Hard');
		expect(server.runner(tableId).pendingBot).toBeNull();
		expect(await practice(alice)).toMatchObject({ created: false, bot: 'hard' });
		// The stored hands name the bot each was played against.
		await a.playUntil(tableId, (m) => handNo(m) > during + 2);
		const hands = (await alice.json<p.HandListResponse>('GET', '/api/hands')).hands;
		expect(hands.every((hand) => hand.practice)).toBe(true);
		const detail = async (id: string) => alice.json<p.HandDetail>('GET', `/api/hands/${id}`);
		const first = await detail(hands[hands.length - 1].hand_id);
		const last = await detail(hands[0].hand_id);
		expect(first.seats.find((s) => s.seat === 1)).toMatchObject({ bot: 'heuristic' });
		expect(last.seats.find((s) => s.seat === 1)).toMatchObject({ bot: 'hard' });
		// Practice chips still never touch the wallet.
		const wallet = await alice.json<p.WalletResponse>('GET', '/api/wallet');
		expect(wallet.entries.map((e) => e.kind)).toEqual(['grant']);
	});

	it('changes at once while no hand is being played', async () => {
		const server = await serve({ seed: 2 });
		const alice = await Player.create(server);
		const tableId = (await practice(alice, { bot: 'hard' })).table_id;
		await server.settle();
		const a = await alice.socket();
		await a.join(tableId);
		// Sitting out stops the deal once the hand in progress ends.
		const during = handNo(await a.myTurn(tableId));
		a.send({ type: 'sit_out', table_id: tableId });
		await a.playUntil(tableId, (m) => handNo(m) === during && m.view.hand!.result !== null);
		await server.settle();
		await waitFor(() => !server.runner(tableId).table.handInProgress);
		const swapped = await practice(alice, { bot: 'heuristic' });
		expect(swapped).toMatchObject({ created: false, bot: 'heuristic' });
		expect('next_bot' in swapped).toBe(false);
		const runner = server.runner(tableId);
		expect(runner.name).toBe('Practice vs RiverMind Easy');
		expect(runner.table.seats[1]).toMatchObject({ bot: 'heuristic', name: 'RiverMind Easy 2' });
		expect(runner.table.seats[1]!.stack).toBe(runner.table.config.maxBuyIn);
	});

	it('only practice tables change their bot', async () => {
		const server = await serve();
		const alice = await Player.create(server);
		const tableId = await alice.newTable(2, 'hard');
		await expect(server.runner(tableId).switchBot('heuristic')).rejects.toThrow(
			/only practice tables change their bot/
		);
		await expect(server.runner(tableId).switchBot('deep')).rejects.toThrow(/no bot called 'deep'/);
	});
});

describe('a saved table whose bot this server does not run', () => {
	it('plays on against RiverMind Easy, labelled as such', async () => {
		const server = await serve({ seed: 6 });
		const alice = await Player.create(server);
		const tableId = (await practice(alice, { bot: 'hard' })).table_id;
		await server.settle();
		const a = await alice.socket();
		await a.join(tableId);
		await a.myTurn(tableId); // mid-hand
		const old = server.runner(tableId);
		const saved = JSON.parse(
			JSON.stringify({ ...tableToDict(old.table), lobby: old.lobbyState() })
		);
		// A server without the bundle, or serve-nl after a rollback.
		const log = quietLog();
		const manager = new TableManager(defaultBots(), runnerOptions({ log, requirePerson: true }));
		const restored = manager.restore(tableId, tableFromDict(saved), {
			name: old.name,
			lobby: saved.lobby
		});
		expect(log.lines.join('\n')).toMatch(/does not run \(hard\); RiverMind Easy plays instead/);
		expect(restored.name).toBe('Practice vs RiverMind Easy');
		expect(restored.practice).toBe(alice.playerId);
		expect(restored.table.seats[1]).toMatchObject({ bot: 'heuristic', name: 'RiverMind Easy 2' });
		expect(restored.table.handInProgress).toBe(true);
		expect(restored.table.stackOf(0)).toBe(old.table.stackOf(0));
		// A table that fills its seats with the missing bot fills them with Easy instead.
		const filled = manager.restore('filled', tableFromDict(saved), {
			lobby: { fill: 'hard', private: false, invite: null }
		});
		expect(filled.fill).toBe('heuristic');
		await manager.shutdown();
		// With no fallback to seat, the table cannot run.
		const bare = new TableManager({ random: defaultBots().random }, runnerOptions({ log }));
		expect(() => bare.restore(tableId, tableFromDict(saved))).toThrow(/does not run: hard/);
	});
});

describe('the registry this build was made with', () => {
	it('names a heads-up champion with its bundle and its served evaluation', () => {
		const found = championFor(REGISTRY, 2);
		expect(found).not.toBeNull();
		expect(found!.format).toBe('heads-up');
		expect(Object.keys(found!.bundle.files)).toContain('strategy.u8');
		expect(found!.bundle.table_set).toMatch(/^[0-9a-f]{64}$/);
		const described = describeChampion(found!);
		// The gate: RiverMind Easy and the calling station, with every lower bound above zero.
		expect(described.results.map((r) => r.opponent).slice(0, 2)).toEqual([
			'heuristic',
			'calling_station'
		]);
		expect(described.results.every((r) => r.ci95[0] > 0)).toBe(true);
		expect(championFor(REGISTRY, 6)).toBeNull();
	});

	// The bundle is 450 MB and lives outside Git: checked where it is kept.
	const kept = resolve(import.meta.dirname, '../../../../../artifacts/models');
	const real = championFor(REGISTRY, 2);
	it.skipIf(real === null || !existsSync(bundlePath(kept, real)))(
		'is the bundle kept on this machine',
		() => {
			const bundle = loadChampion(kept, real!);
			const policy = new ChampionPolicy(real!, bundle).forTable();
			const rng = new PythonRandom(1);
			for (let deal = 0; deal < 50; deal++) {
				const state = startHand(handConfig(50, 100), [10_000, 10_000], deal % 2, {
					rng: new PythonRandom(deal)
				});
				policy.act(seatView(state, state.toAct!), rng);
			}
			expect(policy.stats.decisions).toBe(50);
			expect(policy.stats.trained).toBe(50);
		},
		60_000
	);
});

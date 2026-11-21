// Tables as running loops (P4B.5b), ported from test/server/test_runner.py:
// automatic hands, bots that never hold up another table, and requests that
// are applied, saved and published as one unit.
import { describe, expect, it } from 'vitest';
import { PythonRandom } from '../bots/mt.ts';
import {
	CallingStationPolicy,
	defaultBots,
	HeuristicPolicy,
	RandomPolicy
} from '../bots/policies.ts';
import { Action, potTotal } from '../engine/state.ts';
import { ManualClock } from './clock.ts';
import {
	cryptoDealer,
	Lock,
	runnerOptions,
	seededDealer,
	TableManager,
	TableRunner,
	type BotPolicy,
	type Log
} from './runner.ts';
import { BlockingBot, options, Recorder, silent, tick } from './runner.testing.ts';
import { Table, tableConfig, TableError } from './table.ts';

function tableChips(table: Table): number {
	const pot = table.handInProgress && table.hand !== null ? potTotal(table.hand) : 0;
	return pot + table.players().reduce((total, [seat]) => total + table.stackOf(seat), 0);
}

const heads = tableConfig({ seatCount: 2, smallBlind: 50, bigBlind: 100 });

describe('table runners', () => {
	it.each([2, 6, 9])('deal hands automatically at a bot table of %i', async (seatCount) => {
		const manager = new TableManager(defaultBots(), options(seatCount));
		const runner = manager.create(tableConfig({ seatCount, smallBlind: 50, bigBlind: 100 }));
		const recorder = new Recorder();
		runner.listeners.push(recorder.listen);
		const kinds = ['random', 'calling_station', 'heuristic'];
		for (let seat = 0; seat < seatCount; seat++) await runner.seatBot(seat, kinds[seat % 3]);
		await runner.waitUntil((t) => t.handNo >= 40 && !t.handInProgress, 60);
		await manager.shutdown();
		expect(runner.running).toBe(false);
		const table = runner.table;
		expect(tableChips(table)).toBe(recorder.chipsBought());
		const ended = recorder.kinds('hand_ended');
		expect(ended.length).toBeGreaterThanOrEqual(40);
		expect(ended.map((e) => e.data.hand_no)).toEqual(ended.map((_, i) => i + 1));
		// Bots are always labelled (D-7).
		for (const [, player] of table.players()) expect(player.name).toMatch(/bot|RiverMind/i);
	});

	it('has busted bots buy in again', async () => {
		const manager = new TableManager({ random: new RandomPolicy() }, options(3));
		const runner = manager.create(heads);
		const recorder = new Recorder();
		runner.listeners.push(recorder.listen);
		await runner.seatBot(0, 'random');
		await runner.seatBot(1, 'random');
		await runner.waitUntil(() => recorder.kinds('rebought').length > 0, 60);
		await manager.shutdown();
		expect(runner.table.handNo).toBeGreaterThan(1);
	});

	it('saves and publishes a change even if its caller has gone away', async () => {
		// A socket that closes mid-request stops reading the answer. The change it
		// asked for is still saved, finishes its bookkeeping and is published, so the
		// store never falls a change behind the table and departing chips are never
		// paid twice.
		const manager = new TableManager(defaultBots(), options());
		const runner = manager.create(tableConfig({ seatCount: 6, smallBlind: 50, bigBlind: 100 }));
		await runner.sit(2, 'alice', 'Alice', 10_000);
		let started = 0;
		let release: () => void = () => {};
		const saved: number[] = [];
		runner.beforePublish.push(async (r) => {
			started += 1;
			await new Promise<void>((resolve) => (release = resolve));
			saved.push(r.table.seq);
		});
		const recorder = new Recorder();
		runner.listeners.push(recorder.listen);
		// Nobody waits for the answer: the caller is gone as soon as it has asked.
		void runner.setConnected('alice', false);
		while (started < 1) await tick();
		// A second request arrives meanwhile; it waits its turn behind the first.
		const second = runner.sitOut('alice');
		for (let i = 0; i < 5; i++) await tick();
		expect(saved).toEqual([]);
		expect(recorder.events).toEqual([]); // nothing is shown before it is saved
		expect(started).toBe(1);
		release();
		while (started < 2) await tick();
		expect(recorder.events.map((e) => e.kind)).toEqual(['disconnected']); // published after its save
		release();
		await second;
		await manager.shutdown();
		const alice = runner.table.seats[2]!;
		expect(alice.connected).toBe(false);
		expect(alice.sittingOut).toBe(true);
		expect(saved).toEqual([runner.table.seq - 1, runner.table.seq]);
		expect(recorder.events.map((e) => e.kind)).toEqual(['disconnected', 'sat_out']);
	});

	it('finishes a change in flight before it stops', async () => {
		const manager = new TableManager(defaultBots(), options());
		const runner = manager.create(heads);
		await runner.sit(0, 'alice', 'Alice', 10_000);
		let release: () => void = () => {};
		const saved: number[] = [];
		runner.beforePublish.push(async (r) => {
			await new Promise<void>((resolve) => (release = resolve));
			saved.push(r.table.seq);
		});
		const change = runner.sitOut('alice');
		await tick();
		let stopped = false;
		const stopping = manager.shutdown().then(() => (stopped = true));
		for (let i = 0; i < 5; i++) await tick();
		expect(stopped).toBe(false); // the stop waits for the save
		release();
		await change;
		await stopping;
		expect(saved).toEqual([runner.table.seq]);
		// Chips paid for after the table closed are refused, so the caller can refund them.
		await expect(runner.sit(1, 'bob', 'Bob', 10_000)).rejects.toMatchObject({
			code: 'unknown_table'
		});
		await expect(runner.rebuy('alice', 500)).rejects.toMatchObject({ code: 'unknown_table' });
		expect(runner.table.seatOf('bob')).toBeNull();
	});

	it('waits for a second player before dealing', async () => {
		const manager = new TableManager(defaultBots(), options());
		const runner = manager.create(tableConfig({ seatCount: 6, smallBlind: 50, bigBlind: 100 }));
		await runner.sit(2, 'alice', 'Alice', 10_000);
		for (let i = 0; i < 20; i++) await tick();
		expect(runner.table.hand).toBeNull();
		await runner.seatBot(4, 'calling_station');
		await runner.waitUntil((t) => t.handNo === 1);
		await manager.shutdown();
	});

	it('waits for a person playing with bots', async () => {
		const manager = new TableManager(defaultBots(), options(11));
		const runner = manager.create(tableConfig({ seatCount: 3, smallBlind: 50, bigBlind: 100 }));
		await runner.seatBot(0, 'calling_station');
		await runner.seatBot(1, 'heuristic');
		await runner.sit(2, 'alice', 'Alice', 10_000);
		const table = runner.table;
		for (let played = 0; played < 10; played++) {
			await runner.waitUntil((t) => t.toAct === 2);
			const hand = table.hand!;
			const before = hand.actions.length;
			for (let i = 0; i < 10; i++) await tick();
			expect(table.hand).toBe(hand); // nothing happens until Alice acts
			expect(table.toAct).toBe(2);
			await expect(runner.act('bot:calling_station:1', Action.call())).rejects.toMatchObject({
				code: 'not_your_turn'
			});
			const legal = table.view(2)!.legal!;
			await runner.act('alice', legal.canCheck ? Action.check() : Action.call());
			expect(table.hand).not.toBe(hand);
			expect(table.hand!.result !== null || table.hand!.actions.length >= before + 1).toBe(true);
		}
		await runner.leave('alice');
		await runner.waitUntil((t) => t.seatOf('alice') === null);
		const hands = table.handNo;
		await runner.waitUntil((t) => t.handNo >= hands + 3); // the bots play on
		await manager.shutdown();
	});

	it('keeps other tables playing while a bot is slow to decide', async () => {
		const bot = new BlockingBot();
		const manager = new TableManager(
			{ blocking: bot, calling_station: new CallingStationPolicy() },
			options(5)
		);
		const slow = manager.create(heads);
		const fast = manager.create(heads);
		await slow.seatBot(0, 'blocking');
		await slow.seatBot(1, 'blocking');
		await fast.seatBot(0, 'calling_station');
		await fast.seatBot(1, 'calling_station');
		// While the slow table's bot is stuck thinking, the other table keeps playing.
		await fast.waitUntil((t) => t.handNo >= 20, 30);
		expect(bot.calls).toBe(1);
		expect(slow.table.handNo).toBe(1);
		bot.release();
		await slow.waitUntil((t) => t.handNo >= 3, 30);
		await manager.shutdown();
	});

	it('drops a bot decision if the table moved on', async () => {
		const bot = new BlockingBot();
		const manager = new TableManager(
			{ blocking: bot, calling_station: new CallingStationPolicy() },
			options(8)
		);
		const runner = manager.create(tableConfig({ seatCount: 3, smallBlind: 50, bigBlind: 100 }));
		await runner.seatBot(0, 'calling_station');
		await runner.seatBot(1, 'calling_station');
		const thinker = await runner.seatBot(2, 'blocking');
		await runner.waitUntil((t) => t.toAct === 2);
		while (bot.calls === 0) await tick();
		// The bot is told to leave while it thinks: it folds at once (rule 2.3).
		await runner.leave(thinker);
		expect(runner.table.hand!.folded[2]).toBe(true);
		bot.release();
		await runner.waitUntil((t) => t.seatOf(thinker) === null);
		const hands = runner.table.handNo;
		await runner.waitUntil((t) => t.handNo >= hands + 2);
		await manager.shutdown();
	});

	it('times out a failing bot instead of stopping the table', async () => {
		const broken: BotPolicy = {
			name: 'broken',
			act: () => {
				throw new Error('no idea');
			}
		};
		const illegal: BotPolicy = { name: 'illegal', act: () => Action.bet(1) };
		const errors: string[] = [];
		const log: Log = { ...silent, error: (message) => void errors.push(message) };
		const manager = new TableManager({ broken, illegal }, options(2, { log }));
		const runner = manager.create(heads);
		await runner.seatBot(0, 'broken');
		await runner.seatBot(1, 'illegal');
		await runner.waitUntil((t) => t.handNo >= 5, 30);
		expect(runner.running).toBe(true);
		await manager.shutdown();
		expect(errors.some((line) => line.includes('failed; timing it out'))).toBe(true);
		expect(errors.some((line) => line.includes('chose an illegal action'))).toBe(true);
	});

	it('refuses requests with codes', async () => {
		const manager = new TableManager(defaultBots(), options());
		const runner = manager.create(heads, { name: 'Heads-up' });
		expect(manager.get(runner.tableId)).toBe(runner);
		expect(runner.name).toBe('Heads-up');
		expect(runner.tableId).toMatch(/^[A-Za-z0-9_-]{12}$/);
		await expect(runner.seatBot(0, 'nonsense')).rejects.toMatchObject({ code: 'bad_request' });
		const refused = await runner.sit(0, 'alice', 'Alice', 1).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(TableError);
		expect((refused as TableError).code).toBe('bad_buy_in');
		await expect(runner.refill('alice')).rejects.toMatchObject({ code: 'bad_request' });
		await manager.close(runner.tableId);
		expect(manager.get(runner.tableId)).toBeNull();
		// A table that filled its seats with a bot this server does not run fills them with RiverMind Easy.
		expect(manager.restore('t', new Table(heads), { lobby: { fill: 'nobody' } }).fill).toBe(
			'heuristic'
		);
		expect(() => new TableRunner('u', new Table(heads), {}, options(), { fill: 'nobody' })).toThrow(
			RangeError
		);
		await manager.shutdown();
	});

	it('uses the injected sleep for its pauses', async () => {
		const slept: number[] = [];
		const manager = new TableManager(
			{ calling_station: new CallingStationPolicy(), heuristic: new HeuristicPolicy() },
			options(1, {
				handPause: 2.5,
				botDelay: 0.75,
				sleep: (seconds) => {
					slept.push(seconds);
					return tick();
				}
			})
		);
		const runner = manager.create(heads);
		await runner.seatBot(0, 'calling_station');
		await runner.seatBot(1, 'heuristic');
		const started = performance.now();
		await runner.waitUntil((t) => t.handNo >= 3);
		await manager.shutdown();
		expect(performance.now() - started).toBeLessThan(5_000); // no real waiting
		expect(slept).toContain(2.5);
		expect(slept).toContain(0.75);
	});

	it('numbers new bots after the ones a restored table already seats', async () => {
		const manager = new TableManager(defaultBots(), options());
		const table = new Table(tableConfig({ seatCount: 4, smallBlind: 50, bigBlind: 100 }));
		table.sit(1, 'bot:random:7', 'Random bot 2', 10_000, 'random');
		table.drainEvents();
		const runner = manager.restore('restored', table, {
			name: 'Old table',
			lobby: { fill: 'random', private: true, invite: 'code', practice: 'p_guest' }
		});
		expect(runner.lobbyState()).toEqual({
			fill: 'random',
			private: true,
			invite: 'code',
			practice: 'p_guest'
		});
		expect(await runner.seatBot(2, 'random')).toBe('bot:random:8');
		expect(() => manager.restore('restored', new Table(heads))).toThrow(/exists/);
		// A bot this server does not run plays on as RiverMind Easy; with none to stand in, the table cannot run.
		const stranger = new Table(heads);
		stranger.sit(0, 'bot:deep:1', 'Deep bot 1', 10_000, 'deep');
		const adopted = manager.restore('other', stranger);
		expect(adopted.table.seats[0]).toMatchObject({ bot: 'heuristic', name: 'RiverMind Easy 1' });
		const bare = new TableManager({ random: defaultBots().random }, options());
		const lost = new Table(heads);
		lost.sit(0, 'bot:deep:1', 'Deep bot 1', 10_000, 'deep');
		expect(() => bare.restore('other', lost)).toThrow(/does not run: deep/);
		await manager.shutdown();
	});
});

describe('dealing', () => {
	it('deals live tables from the operating system, never a seeded generator (D-8)', async () => {
		// Tables made the default way never repeat a deck.
		const decks = new Set<string>();
		const manager = new TableManager(
			defaultBots(),
			runnerOptions({
				handPause: 0,
				botDelay: 0,
				sleep: tick,
				clock: new ManualClock(),
				log: silent
			})
		);
		expect(manager.options.dealer()).toBe(cryptoDealer);
		let dealt = 0;
		for (let n = 0; n < 4; n++) {
			const runner = manager.create(heads);
			runner.listeners.push((r, events) => {
				if (!events.some((e) => e.kind === 'hand_started')) return;
				dealt += 1;
				decks.add(r.table.hand!.deck.join(','));
			});
			await runner.seatBot(0, 'calling_station');
			await runner.seatBot(1, 'calling_station');
			await runner.waitUntil((t) => t.handNo >= 12);
		}
		await manager.shutdown();
		expect(dealt).toBeGreaterThanOrEqual(48);
		expect(decks.size).toBe(dealt);
		// Every number a deal can ask for comes back in range, and the bots' seed is 64 bits.
		for (let bound = 1; bound <= 52; bound++) {
			const drawn = cryptoDealer.below(bound);
			expect(drawn >= 0 && drawn < bound).toBe(true);
		}
		const seed = cryptoDealer.botSeed();
		expect(seed >= 0n && seed < 2n ** 64n).toBe(true);
		expect(cryptoDealer.botSeed()).not.toBe(seed);
	});

	it('seeds tests as serve-nl seeds its tables', () => {
		// `random.Random(7)`: `getrandbits(64)` for the bots, then the first deal's draws.
		const dealer = seededDealer(7);
		const python = new PythonRandom(7);
		const low = BigInt(python.uint32());
		const high = BigInt(python.uint32());
		expect(dealer.botSeed()).toBe((high << 32n) | low);
		expect(dealer.below(52)).toBe(python.below(52));
	});
});

describe('the lock', () => {
	it('runs one holder at a time, in order, and survives a failure', async () => {
		const lock = new Lock();
		const order: string[] = [];
		const slow = lock.run(async () => {
			order.push('a starts');
			await tick();
			order.push('a ends');
		});
		const failing = lock.run(() => {
			order.push('b');
			throw new Error('refused');
		});
		const last = lock.run(() => order.push('c'));
		expect(lock.busy).toBe(true);
		await expect(failing).rejects.toThrow('refused');
		await slow;
		await last;
		expect(order).toEqual(['a starts', 'a ends', 'b', 'c']);
		await tick();
		expect(lock.busy).toBe(false);
	});
});

// Table snapshots (P4B.5b), ported from test/server/test_snapshot.py: a
// table rebuilt from its JSON plays on identically, and tables saved by
// serve-nl, in either snapshot format, load here and finish their hand as
// they would have there.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PythonRandom } from '../bots/mt.ts';
import { FormatError, handRecord, type JsonObject } from '../engine/history.ts';
import { Action, legalActions, options, type ActionKind } from '../engine/state.ts';
import { FORMAT, tableFromDict, tableToDict } from './snapshot.ts';
import { Table, tableConfig, TableError } from './table.ts';

type Drained = [number, string, Record<string, unknown>];

function drain(table: Table): Drained[] {
	const events = table.drainEvents().map((e): Drained => [e.seq, e.kind, e.data]);
	table.drainFinished();
	table.drainDepartures();
	return events;
}

/** Through JSON text, as PostgreSQL stores it. */
function reload(table: Table, clock: () => number): Table {
	return tableFromDict(JSON.parse(JSON.stringify(tableToDict(table))), clock);
}

/** Random seating, connections, clocks and play, optionally reloading the table after every step. */
function play(seatCount: number, restoreEveryStep: boolean, steps = 3_000) {
	const rng = new PythonRandom(1000 + seatCount);
	let now = 1_000_000;
	const clock = () => now;
	const config = tableConfig({
		seatCount,
		smallBlind: 5,
		bigBlind: 10,
		ante: rng.choice([0, 1]),
		actionSeconds: 5,
		timeBankSeconds: 8
	});
	let table = new Table(config, clock);
	const events: Drained[] = [];
	let nextId = 0;
	let hands = 0;
	for (let step = 0; step < steps; step++) {
		const roll = rng.random();
		const seated = table.players().map(([, player]) => player.playerId);
		try {
			if (roll < 0.07) {
				nextId += 1;
				const bot = rng.random() < 0.3 ? 'random' : null;
				const amount = rng.randint(config.minBuyIn, config.maxBuyIn);
				table.sit(rng.below(seatCount), `n${nextId}`, `N${nextId}`, amount, bot);
			} else if (roll < 0.09 && seated.length) {
				table.leave(rng.choice(seated));
			} else if (roll < 0.12 && seated.length) {
				table.sitOut(rng.choice(seated));
			} else if (roll < 0.16 && seated.length) {
				table.sitIn(rng.choice(seated));
			} else if (roll < 0.19 && seated.length) {
				table.rebuy(rng.choice(seated), rng.randint(1, config.maxBuyIn));
			} else if (roll < 0.24 && seated.length) {
				table.setConnected(rng.choice(seated), rng.random() < 0.5);
			} else if (roll < 0.3) {
				now += rng.choice([1, 4, 9, 20]);
				table.checkClock();
			} else if (table.handInProgress) {
				const legal = legalActions(table.hand!);
				now += rng.random() * 3;
				table.actSeat(legal.seat, rng.choice(options(legal)));
			} else if (table.canStart()) {
				table.startHand(rng);
				hands += 1;
			}
		} catch (error) {
			if (!(error instanceof TableError)) throw error;
		}
		events.push(...drain(table));
		if (restoreEveryStep) table = reload(table, clock);
	}
	return { events, final: tableToDict(table), hands };
}

function midHand(): Table {
	const table = new Table(tableConfig({ seatCount: 2, smallBlind: 50, bigBlind: 100 }));
	table.sit(0, 'p0', 'P0', 10_000);
	table.sit(1, 'p1', 'P1', 10_000);
	table.startHand(new PythonRandom(0));
	drain(table);
	return table;
}

describe('table snapshots', () => {
	it.each([2, 3, 6, 9])('a reloaded table of %i seats plays on identically', (seatCount) => {
		const straight = play(seatCount, false);
		const reloaded = play(seatCount, true);
		expect(straight.hands).toBeGreaterThan(40);
		const kinds = new Set(straight.events.map(([, kind]) => kind));
		for (const kind of ['timed_out', 'disconnected', 'sat_out', 'rebought', 'left', 'hand_ended']) {
			expect(kinds, kind).toContain(kind);
		}
		expect(reloaded.events).toEqual(straight.events);
		expect(reloaded.final).toEqual(straight.final);
	});

	it('round trip mid-hand with a turn', () => {
		const table = new Table(tableConfig({ seatCount: 6, smallBlind: 50, bigBlind: 100 }), () => 5);
		for (let seat = 0; seat < 4; seat++) {
			table.sit(seat, `p${seat}`, `P${seat}`, 10_000, seat ? 'heuristic' : null);
		}
		table.startHand(new PythonRandom(3));
		table.reserve('p_wait', 'Waiting', 5);
		drain(table);
		const snapshot = tableToDict(table);
		expect(snapshot).toMatchObject({ format: 2, kind: 'table' });
		expect(snapshot.turn).not.toBeNull();
		expect(FORMAT).toBe(2);
		const again = tableFromDict(JSON.parse(JSON.stringify(snapshot)));
		expect(tableToDict(again)).toEqual(snapshot);
		expect(again.turn).toEqual(table.turn);
		expect(again.hand).toEqual(table.hand);
		expect(again.seats).toEqual(table.seats);
		expect(again.reservations).toEqual(table.reservations);
	});

	it('need drained events', () => {
		const table = new Table(tableConfig({ seatCount: 2, smallBlind: 50, bigBlind: 100 }));
		table.sit(0, 'p0', 'P0', 10_000);
		expect(() => tableToDict(table)).toThrow(/drain/);
	});

	const changes: [string, (d: Record<string, never>) => void][] = [
		['a format this server does not know', (d) => void ((d.format as number) = 3)],
		['another kind of document', (d) => void ((d.kind as string) = 'hand_state')],
		['no seats', (d) => void delete d.seats],
		['too few seats', (d) => void ((d.seats as unknown[]) = (d.seats as unknown[]).slice(0, 1))],
		['a hand in an unknown format', (d) => void ((d.hand as JsonObject).format = 99)],
		['a stack that is not a number', (d) => void ((d.seats as JsonObject[])[0].stack = 'lots')],
		['a negative stack', (d) => void ((d.seats as JsonObject[])[0].stack = -1)],
		['a flag that is not a boolean', (d) => void ((d.seats as JsonObject[])[0].leaving = 0)],
		[
			'a held seat out of range',
			(d) =>
				void ((d.reservations as unknown[]) = [
					{ seat: 7, player_id: 'p', name: 'P', until: 1, bot: null }
				])
		],
		['a turn without its deadline', (d) => void delete (d.turn as JsonObject).deadline],
		['stakes the table refuses', (d) => void ((d.config as JsonObject).small_blind = 0)]
	];

	it.each(changes)('refuse %s', (_name, change) => {
		const snapshot = JSON.parse(JSON.stringify(tableToDict(midHand()))) as Record<string, never>;
		change(snapshot);
		expect(() => tableFromDict(snapshot)).toThrow(FormatError);
	});

	it('refuse what is not a document at all', () => {
		for (const bad of [null, 'table', 7, []]) expect(() => tableFromDict(bad)).toThrow(FormatError);
	});
});

interface Saved {
	format: number;
	now: number;
	snapshot: Record<string, unknown>;
	actions: [seat: number, kind: ActionKind][];
	events: { seq: number; kind: string; data: Record<string, unknown> }[];
	record: Record<string, unknown>;
	pots: { amount: number; winners: number[]; shares: number[] }[];
	stacks: (number | null)[];
	departures: Record<string, unknown>[];
	after: Record<string, unknown>;
}

const { saved } = JSON.parse(readFileSync(new URL('./parity.json', import.meta.url), 'utf8')) as {
	saved: Saved[];
};

describe('tables saved by serve-nl', () => {
	it.each(saved.map((s) => [s.format, s] as const))(
		'in snapshot format %i load mid-hand and finish the hand as they would there',
		(format, fixture) => {
			expect(fixture.snapshot.format).toBe(format);
			const table = tableFromDict(structuredClone(fixture.snapshot), () => fixture.now);
			expect(table.handInProgress).toBe(true);
			expect(table.seats[1]!.connected).toBe(false);
			expect(table.reservations.size).toBe(format === 1 ? 0 : 2);
			for (const [seat, kind] of fixture.actions) {
				expect(table.toAct).toBe(seat);
				table.actSeat(seat, Action.of(kind));
			}
			expect(table.handInProgress).toBe(false);
			const result = table.hand!.result!;
			// The pots, the stacks and the chips going home are what serve-nl would have paid.
			expect(
				result.pots.map((p) => ({
					amount: p.amount,
					winners: [...p.winners],
					shares: [...p.shares]
				}))
			).toEqual(fixture.pots);
			expect(table.seats.map((player) => player?.stack ?? null)).toEqual(fixture.stacks);
			const events = table.drainEvents().map((e) => ({ seq: e.seq, kind: e.kind, data: e.data }));
			expect(JSON.parse(JSON.stringify(events))).toEqual(fixture.events);
			const [finished] = table.drainFinished();
			expect(handRecord(finished.state)).toEqual(fixture.record);
			const departures = table.drainDepartures().map((d) => ({
				player_id: d.playerId,
				seat: d.seat,
				chips: d.chips,
				left: d.left,
				bot: d.bot
			}));
			expect(departures).toEqual(fixture.departures);
			// And the table is saved again in the current format, as serve-nl would save it.
			expect(JSON.parse(JSON.stringify(tableToDict(table)))).toEqual(fixture.after);
			// Alice's waiting rebuy arrived and she sat out, as she had asked before the save.
			expect(table.seats[0]).toMatchObject({ stack: 8_800, sittingOut: true, pendingRebuy: 0 });
		}
	);
});

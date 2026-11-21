// Held seats and the waitlist in the table core (rule 2.4), ported from
// test/server/test_seating.py (P4B.5b). Each case drives a `Table` directly
// with a clock the test moves, so holds run out exactly when the rule says.
import { describe, expect, it } from 'vitest';
import { PythonRandom } from '../bots/mt.ts';
import { tableFromDict, tableToDict } from './snapshot.ts';
import { RESERVE_SECONDS, Table, tableConfig, TableError, type TableErrorCode } from './table.ts';

const CONFIG = tableConfig({ seatCount: 3, smallBlind: 50, bigBlind: 100 });

class Clock {
	now = 1_000;
	readonly read = (): number => this.now;
}

function makeTable(people: number[] = [], bots: number[] = []): [Table, Clock] {
	const clock = new Clock();
	const table = new Table(CONFIG, clock.read);
	for (const seat of people) table.sit(seat, `p${seat}`, `Player ${seat}`, 5_000);
	for (const seat of bots) table.sit(seat, `bot:random:${seat}`, `Bot ${seat}`, 5_000, 'random');
	table.drainEvents();
	return [table, clock];
}

const kinds = (table: Table): string[] => table.drainEvents().map((event) => event.kind);

function codeOf(call: () => unknown): TableErrorCode {
	try {
		call();
	} catch (error) {
		if (error instanceof TableError) return error.code;
		throw error;
	}
	throw new Error('the table did not refuse');
}

describe('held seats and the waitlist', () => {
	it('holds an empty seat for its player only', () => {
		const [table, clock] = makeTable([0]);
		expect(table.reserve('x', 'X')).toBe(1); // the first empty seat
		expect(table.reservations.get(1)).toMatchObject({ until: clock.now + RESERVE_SECONDS });
		expect(kinds(table)).toEqual(['reserved']);
		expect(table.freeSeats()).toEqual([2]);
		expect(codeOf(() => table.sit(1, 'y', 'Y', 5_000))).toBe('seat_taken');
		expect(codeOf(() => table.reserve('y', 'Y', 1))).toBe('seat_taken');
		expect(codeOf(() => table.reserve('p0', 'Player 0'))).toBe('already_seated');
		expect(codeOf(() => table.reserve('y', 'Y', 3))).toBe('unknown_seat');
		expect(codeOf(() => table.reserve('y', 'Y', 0))).toBe('seat_taken'); // a person sits there
		expect(codeOf(() => table.reserve('', 'Y'))).toBe('bad_request');
		expect(table.reserve('x', 'X')).toBe(1); // asking again returns the same hold
		table.sit(1, 'x', 'X', 5_000);
		expect(table.reservations.size).toBe(0);
		expect(kinds(table)).toEqual(['seated']);
	});

	it('lets a hold run out, be moved or be given up', () => {
		const [table, clock] = makeTable([0]);
		table.reserve('x', 'X', 2);
		expect(table.reserve('x', 'X', 1)).toBe(1); // moving gives up the old hold
		expect([...table.reservations.keys()]).toEqual([1]);
		expect(kinds(table)).toEqual(['reserved', 'reservation_ended', 'reserved']);
		expect(table.reservationDeadline()).toBe(clock.now + RESERVE_SECONDS);
		clock.now += RESERVE_SECONDS - 1;
		table.settleSeats();
		expect(table.reservations.has(1)).toBe(true);
		clock.now += 1;
		table.settleSeats();
		expect(table.reservations.size).toBe(0);
		expect(table.drainEvents().map((e) => [e.kind, e.data])).toEqual([
			['reservation_ended', { seat: 1, reason: 'expired' }]
		]);
		expect(table.reservationDeadline()).toBeNull();
		table.reserve('x', 'X');
		table.cancelReservation('x');
		expect(table.reservations.size).toBe(0);
		expect(kinds(table).pop()).toBe('reservation_ended');
		table.cancelReservation('x'); // nothing held: nothing happens
		expect(kinds(table)).toEqual([]);
	});

	it('has a bot give up its seat at once between hands', () => {
		const [table] = makeTable([0], [1, 2]);
		expect(table.freeSeats()).toEqual([]);
		expect(table.botSeats()).toEqual([1, 2]);
		expect(table.reserve('x', 'X')).toBe(1);
		expect(table.seats[1]).toBeNull();
		expect(table.reservations.get(1)!.until).not.toBeNull();
		expect(kinds(table)).toEqual(['reserved', 'left']);
		expect(table.departures[table.departures.length - 1]).toMatchObject({
			bot: true,
			chips: 5_000
		});
	});

	it('has a bot in a hand play it out before giving up its seat', () => {
		const [table, clock] = makeTable([0], [1, 2]);
		table.startHand(new PythonRandom(3));
		table.drainEvents();
		const seat = table.reserve('x', 'X');
		expect(table.reservations.get(seat)).toEqual({
			playerId: 'x',
			name: 'X',
			until: null,
			bot: `bot:random:${seat}`
		});
		expect(table.seats[seat]!.leaving).toBe(false); // the bot is not folded out of the hand
		expect(table.botSeats()).toEqual([1, 2].filter((s) => s !== seat));
		expect(codeOf(() => table.sit(seat, 'x', 'X', 5_000))).toBe('seat_taken');
		clock.now += 500; // time does not run on a hold that is not ready
		table.settleSeats();
		expect(table.reservations.has(seat)).toBe(true);
		while (table.handInProgress) table.timeOut();
		expect(table.seats[seat]).toBeNull();
		expect(table.reservations.get(seat)).toMatchObject({
			until: clock.now + RESERVE_SECONDS,
			bot: null
		});
		table.sit(seat, 'x', 'X', 4_000);
		expect(table.seats[seat]!.name).toBe('X');
	});

	it('keeps the bot when a hold on its seat is given up', () => {
		const [table] = makeTable([0], [1, 2]);
		table.startHand(new PythonRandom(1));
		const seat = table.reserve('x', 'X');
		table.cancelReservation('x');
		while (table.handInProgress) table.timeOut();
		expect(table.seats[seat]!.bot).toBe('random');
	});

	it('serves the waitlist first come first served', () => {
		const [table, clock] = makeTable([0, 1]);
		expect(codeOf(() => table.joinWaitlist('w1', 'W1'))).toBe('bad_request'); // seat 2 is free
		table.sit(2, 'p2', 'Player 2', 5_000);
		expect(codeOf(() => table.joinWaitlist('p2', 'Player 2'))).toBe('already_seated');
		expect(table.joinWaitlist('w1', 'W1')).toBe(1);
		expect(table.joinWaitlist('w2', 'W2')).toBe(2);
		expect(table.joinWaitlist('w1', 'W1')).toBe(1); // joining twice keeps the place
		table.drainEvents();
		table.leave('p1');
		table.settleSeats();
		expect(table.reservations.get(1)!.playerId).toBe('w1');
		expect(table.waitlistPosition('w2')).toBe(1);
		expect(kinds(table)).toEqual(['left', 'reserved', 'waitlist']);
		// W1 does not come: the seat passes to W2 when the hold runs out.
		clock.now += RESERVE_SECONDS;
		table.settleSeats();
		expect(table.reservations.get(1)!.playerId).toBe('w2');
		expect(table.waitlist).toEqual([]);
		table.sit(1, 'w2', 'W2', 5_000);
		expect(table.reservations.size).toBe(0);
		expect(table.freeSeats()).toEqual([]);
	});

	it('gives up other holds and the waitlist on sitting', () => {
		const [table] = makeTable([0, 1, 2]);
		table.joinWaitlist('w', 'W');
		table.leaveWaitlist('w');
		expect(table.waitlist).toEqual([]);
		table.leaveWaitlist('w');
		table.leave('p2');
		table.reserve('w', 'W', 2);
		expect(codeOf(() => table.joinWaitlist('w', 'W'))).toBe('bad_request'); // already holds a seat
		table.leave('p1');
		table.sit(1, 'w', 'W', 5_000); // sits in another free seat instead
		expect(table.reservations.size).toBe(0);
		expect(table.freeSeats()).toEqual([2]);
	});

	it('keeps holds and the waitlist in snapshots', () => {
		const [table, clock] = makeTable([0, 1], [2]);
		table.startHand(new PythonRandom(5));
		table.reserve('x', 'X');
		table.drainEvents();
		const [full] = makeTable([0, 1, 2]);
		full.joinWaitlist('w', 'W');
		full.drainEvents();
		for (const original of [table, full]) {
			const snapshot = tableToDict(original);
			const copy = tableFromDict(snapshot, clock.read);
			expect(copy.reservations).toEqual(original.reservations);
			expect(copy.waitlist).toEqual(original.waitlist);
			expect(tableToDict(copy)).toEqual(snapshot);
		}
		// A format 1 snapshot, saved before seats could be held, still loads.
		const old = tableToDict(full) as Record<string, unknown>;
		old.format = 1;
		delete old.reservations;
		delete old.waitlist;
		const restored = tableFromDict(old, clock.read);
		expect(restored.reservations.size).toBe(0);
		expect(restored.waitlist).toEqual([]);
		const bad = tableToDict(table) as { reservations: { seat: number }[] };
		bad.reservations[0].seat = 7;
		expect(() => tableFromDict(bad, clock.read)).toThrow(/out of range/);
	});
});

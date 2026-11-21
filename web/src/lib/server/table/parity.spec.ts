// The TypeScript table against the Python one (P4B.5b): the fuzzed requests
// recorded in parity.json by test/server/table_differential.py give the same
// answers, events, departures, finished hands and snapshots here. The long
// run is `pnpm table:parity`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonical, digest, Driver, replaySequence, type Sequence } from './parity.ts';

const { sequences } = JSON.parse(
	readFileSync(new URL('./parity.json', import.meta.url), 'utf8')
) as { sequences: Sequence[] };

describe('the table fuzz recorded from the Python table', () => {
	it.each(sequences.map((s) => [s.seed, s] as const))('sequence %i matches', (_seed, sequence) => {
		const difference = replaySequence(sequence);
		expect(
			difference && `request ${difference.index} ${canonical(difference.op)} differs`
		).toBeNull();
	});

	it('covers every kind of request, and deals and finishes hands', () => {
		const kinds = new Set(sequences.flatMap((s) => s.ops.map((op) => op[0])));
		for (const kind of [
			'sit',
			'leave',
			'sit_out',
			'sit_in',
			'set_connected',
			'rebuy',
			'reserve',
			'cancel_reservation',
			'join_waitlist',
			'leave_waitlist',
			'settle',
			'start',
			'act',
			'act_seat',
			'time_out',
			'check_clock',
			'advance',
			'restore'
		]) {
			expect(kinds, kind).toContain(kind);
		}
		let finished = 0;
		for (const sequence of sequences) {
			const driver = new Driver(sequence.config, sequence.start, sequence.deal_seed);
			for (const op of sequence.ops) {
				finished += (driver.document(op).finished as unknown[]).length;
			}
		}
		expect(finished).toBeGreaterThan(50);
	});

	it('notices a table that plays differently', () => {
		const [sequence] = sequences;
		const moved = { ...sequence, deal_seed: sequence.deal_seed + 1 };
		expect(replaySequence(moved)).not.toBeNull();
	});

	it('writes whole numbers as Python does once its floats are made whole', () => {
		expect(canonical({ b: [1, 2.5, 1000000.125], a: 'é', c: null })).toBe(
			'{"a":"\\u00e9","b":[1,2.5,1000000.125],"c":null}'
		);
		expect(digest({ a: 1 })).toHaveLength(16);
	});
});

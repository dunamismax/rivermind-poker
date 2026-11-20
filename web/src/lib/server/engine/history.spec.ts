// Hand histories and serialization, ported from test/engine/test_history.py.

import { describe, expect, it } from 'vitest';
import { pretty } from '../../engine/cards.ts';
import { playRandomHand } from './fuzz.ts';
import {
	FORMAT,
	FormatError,
	dumps,
	formatText,
	handRecord,
	historyFromDict,
	historyOf,
	historyToDict,
	loads,
	replay,
	replayRecord,
	stateFromDict,
	stateToDict
} from './history.ts';
import { seededRandom } from './random.ts';
import { Action, apply, handConfig, legalActions, startHand } from './state.ts';
import { RULE_HANDS, deal, ruleHand, ruleHandStates } from './testing.ts';

describe('documents', () => {
	it.each(RULE_HANDS.map((f) => [f.name, f] as const))(
		'%s: every state round-trips and replays',
		(_, fixture) => {
			const states = ruleHandStates(fixture);
			for (const state of states) {
				const document = loads(dumps(stateToDict(state)));
				expect(document.format).toBe(FORMAT);
				expect(stateFromDict(document)).toEqual(state);
				expect(replay(historyFromDict(loads(dumps(historyToDict(historyOf(state))))))).toEqual(
					state
				);
			}
			const final = states.at(-1)!;
			expect(replayRecord(loads(dumps(handRecord(final))))).toEqual(final);
		}
	);

	it('round-trips and replays fuzzed hands', () => {
		const rng = seededRandom(0x5eed);
		for (let i = 0; i < 400; i++) {
			const state = playRandomHand(2 + (i % 8), rng, { checkIllegal: false });
			expect(stateFromDict(loads(dumps(stateToDict(state))))).toEqual(state);
			expect(replayRecord(loads(dumps(handRecord(state))))).toEqual(state);
			formatText(state, state.button);
		}
	});

	it('round-trips a hand in progress', () => {
		let state = startHand(handConfig(50, 100, 5), [1_000, 2_000, null, 3_000], 3, {
			rng: seededRandom(1)
		});
		state = apply(state, Action.raiseTo(300));
		expect(stateFromDict(stateToDict(state))).toEqual(state);
		const resumed = stateFromDict(loads(dumps(stateToDict(state))));
		expect(apply(resumed, Action.call())).toEqual(apply(state, Action.call()));
		expect(formatText(state)).toContain('in progress');
	});

	it('keeps the legal actions after a round trip', () => {
		const state = startHand(handConfig(5, 10), [500, 80, 900], 0, { rng: seededRandom(4) });
		expect(legalActions(stateFromDict(stateToDict(state)))).toEqual(legalActions(state));
	});

	it('rejects unknown formats, kinds and bad contents', () => {
		const document = stateToDict(deal([10_000, 10_000], 0));
		expect(() => stateFromDict({ ...document, format: FORMAT + 1 })).toThrow(FormatError);
		expect(() => historyFromDict(document)).toThrow(FormatError);
		expect(() => stateFromDict({ ...document, deck: new Array(52).fill('Zz') })).toThrow(
			FormatError
		);
		expect(() => stateFromDict({ ...document, street: 'fifth' })).toThrow(FormatError);
		const { stacks: _stacks, ...missing } = document;
		expect(_stacks).toBeDefined();
		expect(() => stateFromDict(missing)).toThrow(FormatError);
		expect(() => loads('[]')).toThrow(FormatError);
		expect(() => stateFromDict(null)).toThrow(FormatError);
	});

	it('fails the replay of a tampered record', () => {
		const state = ruleHandStates(ruleHand('kicker decides heads-up')).at(-1)!;
		const record = handRecord(state);
		record.final_stacks = [...(record.final_stacks as number[])].reverse();
		expect(() => replayRecord(record)).toThrow(FormatError);
	});
});

describe('dumps', () => {
	it('writes what Python’s json.dumps writes with sorted keys and compact separators', () => {
		expect(dumps({ b: [1, null, true], a: { d: 'x', c: false } })).toBe(
			'{"a":{"c":false,"d":"x"},"b":[1,null,true]}'
		);
		// ensure_ascii: everything outside printable ASCII is escaped.
		expect(dumps('A♠ "q" \\ \n é \u007f')).toBe('"A\\u2660 \\"q\\" \\\\ \\n \\u00e9 \\u007f"');
		expect(dumps('\u{1f0a1}')).toBe('"\\ud83c\\udca1"');
		expect(() => dumps(0.5)).toThrow(TypeError);
	});
});

describe('text histories', () => {
	it('read like a hand and hide mucked cards', () => {
		const state = ruleHandStates(ruleHand('river bettor shows first and a loser mucks')).at(-1)!;
		const lines = formatText(state).split('\n');
		expect(lines.slice(0, 2)).toEqual([
			"RiverMind Poker · No-limit hold'em · 6 seats · Blinds 50/100",
			'Button S0 · Small blind S1 · Big blind S3'
		]);
		for (const line of [
			'S1 posts the small blind 50',
			'S5 calls 100',
			'*** Flop *** 2♣ 7♦ 9♥',
			'*** River *** 2♣ 7♦ 9♥ J♠ · 3♠',
			'S1 bets 200',
			'S1 shows 9♣ 7♣ (Two Pair)',
			'S3 mucks J♦ 4♦',
			'S5 shows 8♣ T♦ (Straight)',
			'Pot 900: S5 wins 900',
			'Final stacks: S0 10,000 · S1 9,700 · S3 9,700 · S5 10,600'
		]) {
			expect(lines).toContain(line);
		}
		const mucked = state.holeCards[3]!;
		for (const viewer of [0, 1, 5]) {
			const seen = formatText(state, viewer);
			expect(seen.split('\n')).toContain('S3 mucks');
			expect(seen).not.toContain(`${pretty(mucked[0])} ${pretty(mucked[1])}`);
			if (viewer === 0) expect(seen).toContain('4♥ 5♠');
			else expect(seen).not.toContain('4♥ 5♠');
		}
		expect(formatText(state, 3)).toContain('J♦ 4♦');
	});

	it('show tabled hands before the run-out', () => {
		const state = ruleHandStates(ruleHand('heads-up all-in pre-flop is tabled')).at(-1)!;
		const lines = formatText(state, 0).split('\n');
		const tabled = lines.indexOf('*** All in: hands shown ***');
		expect(tabled).toBeGreaterThan(0);
		expect(tabled).toBeLessThan(lines.findIndex((line) => line.startsWith('*** Flop ***')));
		expect(lines).toContain('S5 shows A♥ A♦');
	});
});

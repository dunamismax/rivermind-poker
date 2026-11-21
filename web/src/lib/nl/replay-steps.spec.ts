// Moving through a replay (P6.1): the keys that step it, the name of the stage a
// step is in, and how the table finds the stored hand to review.
import { describe, expect, it } from 'vitest';
import type { HandSummary } from '../protocol-v2.ts';
import { findHand } from './api.ts';
import { stageOf, stepForKey, type ReplayStep } from './replay.ts';

describe('stepForKey', () => {
	it('steps with the arrows and stops at the ends', () => {
		expect(stepForKey('ArrowRight', 0, 5)).toBe(1);
		expect(stepForKey('ArrowRight', 4, 5)).toBe(4);
		expect(stepForKey('ArrowLeft', 3, 5)).toBe(2);
		expect(stepForKey('ArrowLeft', 0, 5)).toBe(0);
	});

	it('jumps to the first and last step with Home and End', () => {
		expect(stepForKey('Home', 3, 5)).toBe(0);
		expect(stepForKey('End', 1, 5)).toBe(4);
	});

	it('leaves every other key alone', () => {
		for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'a', 'Tab', 'Escape']) {
			expect(stepForKey(key, 2, 5)).toBeNull();
		}
	});
});

describe('stageOf', () => {
	const step = (kind: ReplayStep['kind'], street: ReplayStep['street']) =>
		({ kind, street }) as ReplayStep;

	it('names the street until the showdown, then the showdown and the result', () => {
		expect(stageOf(step('posts', 'pre-flop'))).toBe('Pre-flop');
		expect(stageOf(step('action', 'turn'))).toBe('Turn');
		expect(stageOf(step('tabled', 'flop'))).toBe('Flop');
		expect(stageOf(step('street', 'river'))).toBe('River');
		expect(stageOf(step('showdown', 'river'))).toBe('Showdown');
		expect(stageOf(step('result', 'river'))).toBe('Result');
	});
});

describe('findHand', () => {
	/** A player's hands, newest first, served twenty at a time as `/api/hands` does. */
	function archive(hands: [id: string, table: string, handNo: number][]) {
		const requests: string[] = [];
		const fetcher = (async (input: RequestInfo | URL) => {
			const url = new URL(String(input), 'http://site.test');
			requests.push(url.search);
			const before = url.searchParams.get('before');
			const from = before ? hands.findIndex(([id]) => id === before) + 1 : 0;
			const page = hands.slice(from, from + 20);
			const body = {
				hands: page.map(
					([hand_id, table_id, hand_no]) => ({ hand_id, table_id, hand_no }) as HandSummary
				),
				more: from + 20 < hands.length
			};
			return new Response(JSON.stringify(body), {
				headers: { 'Content-Type': 'application/json' }
			});
		}) as typeof fetch;
		return { fetcher, requests };
	}

	it('finds a hand at a table by its number, among hands at other tables', async () => {
		const { fetcher } = archive([
			['9', 'other', 4],
			['8', 'here', 7],
			['7', 'other', 3],
			['6', 'here', 6]
		]);
		expect(await findHand('here', 7, fetcher)).toBe('8');
		expect(await findHand('here', 6, fetcher)).toBe('6');
	});

	it('finds the newest hand at the table when no number is given', async () => {
		const { fetcher } = archive([
			['9', 'other', 4],
			['8', 'here', 7],
			['6', 'here', 6]
		]);
		expect(await findHand('here', null, fetcher)).toBe('8');
		expect(await findHand('nowhere', null, fetcher)).toBeNull();
	});

	it('answers null for a hand the player was not dealt into, without reading on', async () => {
		// Hand 7 is missing: the player sat it out. The list is newest first, so
		// hand 6 already shows that 7 is not there.
		const { fetcher, requests } = archive([
			['9', 'here', 8],
			['6', 'here', 6],
			...Array.from({ length: 30 }, (_, i): [string, string, number] => [`o${i}`, 'other', 30 - i])
		]);
		expect(await findHand('here', 7, fetcher)).toBeNull();
		expect(requests).toHaveLength(1);
	});

	it('reads older pages until it finds the hand, and gives up after three', async () => {
		const other = (count: number, tag: string): [string, string, number][] =>
			Array.from({ length: count }, (_, i) => [`${tag}${i}`, 'other', 1000 - i]);
		const near = archive([...other(25, 'a'), ['x', 'here', 2]]);
		expect(await findHand('here', 2, near.fetcher)).toBe('x');
		expect(near.requests).toHaveLength(2);
		expect(near.requests[1]).toContain('before=a19');

		const far = archive([...other(70, 'b'), ['y', 'here', 2]]);
		expect(await findHand('here', 2, far.fetcher)).toBeNull();
		expect(far.requests).toHaveLength(3);
	});
});

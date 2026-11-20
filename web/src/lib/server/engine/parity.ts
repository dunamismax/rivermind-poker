// The TypeScript side of the differential tests against the Python reference
// (rivermind/engine/differential.py). Each function here mirrors one there and
// must produce the same bytes.

import { createHash } from 'node:crypto';
import { combinations, evaluate, rankClass } from '../../engine/evaluator.ts';
import { dumps, formatText, handRecord, historyOf, stateToDict, type Json } from './history.ts';
import {
	apply,
	legalActions,
	seatOrder,
	startHand,
	type HandState,
	type LegalActions
} from './state.ts';

/** The legal actions as a list, the form both digests use. */
export function legalDoc(legal: LegalActions): Json[] {
	return [
		legal.seat,
		legal.canFold,
		legal.canCheck,
		legal.call,
		legal.raiseKind,
		legal.minTo,
		legal.maxTo
	];
}

/** Every state of a finished hand, replayed from its history. */
export function* states(final: HandState): Generator<HandState> {
	const history = historyOf(final);
	let state = startHand(history.config, history.startingStacks, history.button, {
		deck: history.deck
	});
	yield state;
	for (const action of history.actions) {
		state = apply(state, action);
		yield state;
	}
}

/**
 * SHA-256 over the `dumps` text of every state, the legal actions at every
 * decision and the finished hand's text history for the server and every seat
 * dealt in, exactly as `differential.hand_digest` computes it.
 */
export function handDigest(final: HandState): string {
	const digest = createHash('sha256');
	for (const state of states(final)) {
		digest.update(dumps(stateToDict(state)) + '\n');
		if (state.toAct !== null) digest.update(dumps(legalDoc(legalActions(state))) + '\n');
	}
	digest.update(formatText(final));
	for (const seat of seatOrder(final)) digest.update(formatText(final, seat));
	return digest.digest('hex');
}

/** The three tab-separated fields of a line of `differential hands`. */
export function handLine(final: HandState): [string, string, string] {
	return [dumps(handRecord(final)), dumps(stateToDict(final)), handDigest(final)];
}

/** SplitMix32, the sampler both evaluator digests use (not for dealing). */
export class SplitMix32 {
	private state: number;

	constructor(seed: number) {
		this.state = seed >>> 0;
	}

	next(): number {
		this.state = (this.state + 0x9e3779b9) >>> 0;
		let z = this.state;
		z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
		z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
		return (z ^ (z >>> 15)) >>> 0;
	}
}

/** `count` hands of `size` distinct cards: each card is `next() % 52`, repeats redrawn. */
export function* sampleHands(size: number, count: number, seed: number): Generator<number[]> {
	const gen = new SplitMix32(seed);
	for (let i = 0; i < count; i++) {
		const hand: number[] = [];
		while (hand.length < size) {
			const c = gen.next() % 52;
			if (!hand.includes(c)) hand.push(c);
		}
		yield hand;
	}
}

export function allFiveCardHands(): Generator<number[]> {
	return combinations(
		Array.from({ length: 52 }, (_, c) => c),
		5
	);
}

export interface EvaluatorReport {
	[key: string]: Json;
	hands: number;
	classes: number[];
	sha256: string;
}

/** Digest the ranks (two bytes each, little-endian) and count the hand classes. */
export function evaluatorReport(
	hands: Iterable<readonly number[]>,
	description: Record<string, Json>
): EvaluatorReport {
	const digest = createHash('sha256');
	const classes: number[] = new Array(9).fill(0);
	const chunk = Buffer.alloc(2 * 65536);
	let used = 0;
	let count = 0;
	for (const hand of hands) {
		const value = evaluate(hand);
		chunk.writeUInt16LE(value, used);
		used += 2;
		if (used === chunk.length) {
			digest.update(chunk);
			used = 0;
		}
		classes[rankClass(value) - 1]++;
		count++;
	}
	digest.update(chunk.subarray(0, used));
	return { ...description, hands: count, classes, sha256: digest.digest('hex') };
}

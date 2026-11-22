// Difficulty levels (P5.7): RiverMind Medium, a format's champion mixed with
// RiverMind Easy a hand at a time. A port of rivermind/bots/levels.py, which
// stays the reference: at its first decision in a hand Medium draws one
// number from the bot generator and plays the whole hand as the champion when
// it is below `share`, and as RiverMind Easy otherwise. scripts/bots-parity.ts
// checks the two agree draw for draw.
//
// A hand is told from the next as `BlueprintPolicy` tells them: by the seat,
// its cards, the blinds, the starting stacks and the button, and by whether
// the actions seen so far still begin the view's actions.

import type { Action, ActionRecord } from '../engine/state.ts';
import type { SeatView } from '../engine/view.ts';
import { sameRecord, type Stats } from './blueprint.ts';
import { HeuristicPolicy, type BotRandom, type Policy } from './policies.ts';

export const MEDIUM = 'medium';
/** The share of hands Medium plays as the champion. */
export const MEDIUM_SHARE = 0.5;
/** Hands remembered at once; a table has one in progress per seat. */
export const MEMORY = 64;

interface Choice {
	strong: boolean;
	seen: readonly ActionRecord[];
}

/** A policy with statistics and a memory of hands, such as `BlueprintPolicy`. */
interface Remembering extends Policy {
	readonly stats?: Stats;
	newHand?(): void;
}

/** Plays each hand as `strong` with probability `share`, otherwise as `weak`. */
export class MixedPolicy implements Policy {
	readonly name: string;
	readonly strong: Remembering;
	readonly weak: Remembering;
	readonly share: number;
	/** Hands played as each bot: `strong` and `weak`. */
	readonly hands: Stats = {};
	/** Whether the last decision was the strong bot's. */
	lastStrong: boolean | null = null;
	private readonly memory = new Map<string, Choice>();

	constructor(
		strong: Remembering,
		weak: Remembering = new HeuristicPolicy(),
		share: number = MEDIUM_SHARE,
		{ name = MEDIUM }: { name?: string } = {}
	) {
		if (!(share >= 0 && share <= 1)) throw new RangeError('share must be between 0 and 1');
		this.name = name;
		this.strong = strong;
		this.weak = weak;
		this.share = share;
	}

	/** The strong bot's decision statistics, with the hands played as each bot (`hands_strong`, `hands_weak`). */
	get stats(): Stats {
		const out: Stats = { ...(this.strong.stats ?? {}) };
		for (const [kind, count] of Object.entries(this.hands)) out[`hands_${kind}`] = count;
		return out;
	}

	newHand(): void {
		this.memory.clear();
		this.strong.newHand?.();
		this.weak.newHand?.();
	}

	private choice(view: SeatView, rng: BotRandom): Choice {
		const key = JSON.stringify([
			view.seat,
			view.holeCards,
			view.posts,
			view.stacks.map((stack, s) => (stack ?? 0) + view.contributions[s]),
			view.button
		]);
		let choice = this.memory.get(key);
		const matches =
			choice !== undefined &&
			choice.seen.length <= view.actions.length &&
			choice.seen.every((r, i) => sameRecord(r, view.actions[i]));
		if (choice === undefined || !matches) {
			choice = { strong: rng.random() < this.share, seen: [] };
			const kind = choice.strong ? 'strong' : 'weak';
			this.hands[kind] = (this.hands[kind] ?? 0) + 1;
			// Like an OrderedDict assignment: a replaced entry keeps its place.
			this.memory.set(key, choice);
			while (this.memory.size > MEMORY) this.memory.delete(this.memory.keys().next().value!);
		} else {
			this.memory.delete(key);
			this.memory.set(key, choice);
		}
		choice.seen = view.actions;
		return choice;
	}

	act(view: SeatView, rng: BotRandom): Action {
		if (view.legal === null) throw new Error(`S${view.seat} is not the seat to act`);
		const choice = this.choice(view, rng);
		this.lastStrong = choice.strong;
		return (choice.strong ? this.strong : this.weak).act(view, rng);
	}
}

/** RiverMind Medium for a champion: half its hands as the champion, half as RiverMind Easy. */
export function medium(champion: Remembering): MixedPolicy {
	return new MixedPolicy(champion, new HeuristicPolicy(), MEDIUM_SHARE, { name: MEDIUM });
}

// Play a trained blueprint through a SeatView: a port of
// rivermind/bots/blueprint/policy.py (P4B.6, docs/bots.md), reading a serving
// bundle (bundle.ts). Python stays the reference: on the same view, bundle and
// generator, both give the same probabilities, draws and actions.
//
// Each decision replays the hand's real actions onto the abstract tree of
// the depth class chosen from the effective stack. Folds, checks and calls
// map one for one, an all-in maps to all-in, and any other bet or raise maps
// to one of the two abstract sizes bracketing it by the pseudo-harmonic rule.
// When mapping leaves no abstract decision while the real hand goes on, the
// bot re-enters the tree at the start of the current street, at the node
// whose stack-to-pot ratio is closest to the real one. Its own choices are
// remembered per hand, so replaying never redraws them.

import { Action, PREFLOP, RIVER, type ActionRecord, type Street } from '../engine/state.ts';
import type { SeatView } from '../engine/view.ts';
import { abstractActions, streetLevel } from './abstraction.ts';
import type { Bundle, CardTables, Tree } from './bundle.ts';
import type { BotRandom, Policy } from './policies.ts';

/** Effective stacks below this many big blinds play the 50 big blind tree, others the 100. */
export const SPLIT_DEPTH_BB = 71;
/** Hands whose mapping the policy remembers. */
export const MEMORY = 256;

/** Probability of mapping a size x between abstract sizes a < b to a (Ganzfried and Sandholm, 2013). */
export function pseudoHarmonic(a: number, b: number, x: number): number {
	return ((b - x) * (1 + a)) / ((b - a) * (1 + x));
}

interface Hand {
	readonly d: number;
	/** Abstract token for each real action, by its index in the hand. */
	readonly tokens: Map<number, string>;
	/** The real actions when the policy last acted, to tell this hand from a later one with the same cards. */
	seen: readonly ActionRecord[];
}

/** The real chips, replayed from the posts and actions, as mapping needs them. */
class Real {
	/** The two players dealt in; a bigger table's empty seats have nothing behind. */
	seats: readonly number[] = [];
	start: number[];
	contributions: number[];
	streetBets: number[];
	street: Street = PREFLOP;
	currentBet: number;

	constructor(view?: SeatView) {
		if (!view) {
			this.start = [];
			this.contributions = [];
			this.streetBets = [];
			this.currentBet = 0;
			return;
		}
		const n = view.stacks.length;
		this.seats = view.seatOrder;
		this.start = Array.from({ length: n }, (_, s) => (view.stacks[s] ?? 0) + view.contributions[s]);
		this.contributions = new Array(n).fill(0);
		this.streetBets = new Array(n).fill(0);
		for (const post of view.posts) {
			this.contributions[post.seat] += post.amount;
			if (post.kind !== 'ante') this.streetBets[post.seat] += post.amount;
		}
		this.currentBet = Math.max(...this.streetBets);
	}

	get pot(): number {
		return this.contributions.reduce((a, b) => a + b, 0);
	}

	behind(seat: number): number {
		return this.start[seat] - this.contributions[seat];
	}

	toStreet(street: Street): void {
		if (street !== this.street) {
			this.street = street;
			this.streetBets = new Array(this.streetBets.length).fill(0);
			this.currentBet = 0;
		}
	}

	apply(record: ActionRecord): void {
		this.contributions[record.seat] += record.added;
		this.streetBets[record.seat] += record.added;
		this.currentBet = Math.max(this.currentBet, this.streetBets[record.seat]);
	}

	copy(): Real {
		const other = new Real();
		other.seats = this.seats;
		other.start = [...this.start];
		other.contributions = [...this.contributions];
		other.streetBets = [...this.streetBets];
		other.street = this.street;
		other.currentBet = this.currentBet;
		return other;
	}

	/** Effective stack behind over the pot. */
	spr(): number {
		const pot = this.pot;
		if (!pot) return Infinity;
		let least = Infinity;
		for (const s of this.seats) least = Math.min(least, this.behind(s));
		return least / pot;
	}
}

export const sameRecord = (a: ActionRecord, b: ActionRecord): boolean =>
	a.seat === b.seat &&
	a.street === b.street &&
	a.kind === b.kind &&
	a.to === b.to &&
	a.added === b.added &&
	a.allIn === b.allIn;

export type Stats = Record<string, number>;

interface Indexes {
	/** Per tree and street, the nodes a street can start at. */
	starts: number[][][];
	/** Per tree and node, each action token's place among the node's actions. */
	tokenIndex: Map<string, number>[][];
}

const indexes = new WeakMap<Bundle, Indexes>();

/** What a policy looks up in a bundle's trees, worked out once per bundle: a table gets its own policy (P5.7a). */
function indexesOf(bundle: Bundle): Indexes {
	let found = indexes.get(bundle);
	if (found === undefined) {
		found = {
			starts: bundle.trees.map((t) =>
				[0, 1, 2, 3].map((s) => {
					const out: number[] = [];
					t.street.forEach((st, v) => {
						if (st === s && (t.history[v] === '' || t.history[v].endsWith('/'))) out.push(v);
					});
					return out;
				})
			),
			tokenIndex: bundle.trees.map((t) =>
				t.tokens.map((tokens) => new Map(tokens.map((tok, i) => [tok, i])))
			)
		};
		indexes.set(bundle, found);
	}
	return found;
}

/** A Policy that plays a serving bundle heads-up. */
export class BlueprintPolicy implements Policy {
	readonly name: string;
	readonly stats: Stats = {};
	/** The probabilities of the last decision, or null when it checked or called without data. */
	lastProbabilities: number[] | null = null;
	private readonly trees: readonly Tree[];
	private readonly tables: CardTables;
	private readonly hands = new Map<string, Hand>();
	private readonly starts: number[][][];
	private readonly tokenIndex: Map<string, number>[][];

	readonly bundle: Bundle;

	constructor(bundle: Bundle, { name = 'blueprint' }: { name?: string } = {}) {
		this.bundle = bundle;
		this.name = name;
		this.trees = bundle.trees;
		this.tables = bundle.tables;
		const { starts, tokenIndex } = indexesOf(bundle);
		this.starts = starts;
		this.tokenIndex = tokenIndex;
	}

	private count(key: string): void {
		this.stats[key] = (this.stats[key] ?? 0) + 1;
	}

	/** Forget the hands mapped so far. */
	newHand(): void {
		this.hands.clear();
	}

	// Choosing the tree

	depthIndex(view: SeatView): number {
		const big = view.config.bigBlind;
		let effective = Infinity;
		for (const s of view.seatOrder) {
			effective = Math.min(effective, (view.stacks[s] ?? 0) + view.contributions[s]);
		}
		effective /= big;
		const depths = this.trees.map((t) => t.depth);
		if (depths.length === 1) return 0;
		const want = effective < SPLIT_DEPTH_BB ? 50 : 100;
		if (depths.includes(want)) return depths.indexOf(want);
		let best = 0;
		depths.forEach((d, i) => {
			if (Math.abs(d - effective) < Math.abs(depths[best] - effective)) best = i;
		});
		return best;
	}

	private hand(view: SeatView): Hand {
		const key = JSON.stringify([
			view.seat,
			view.holeCards,
			view.posts,
			view.stacks.map((stack, s) => (stack ?? 0) + view.contributions[s]),
			view.button
		]);
		let hand = this.hands.get(key);
		const matches =
			hand !== undefined &&
			hand.seen.length <= view.actions.length &&
			hand.seen.every((r, i) => sameRecord(r, view.actions[i]));
		if (hand === undefined || !matches) {
			hand = { d: this.depthIndex(view), tokens: new Map(), seen: [] };
			// Like an OrderedDict assignment: a replaced entry keeps its place.
			this.hands.set(key, hand);
			while (this.hands.size > MEMORY) this.hands.delete(this.hands.keys().next().value!);
		} else {
			this.hands.delete(key);
			this.hands.set(key, hand);
		}
		return hand;
	}

	// Mapping

	private reenter(tree: Tree, d: number, street: Street, real: Real): number {
		this.count('reentries');
		const target = real.spr();
		const distance = (v: number) => {
			const a = tree.spr[v];
			const b = target;
			if (a <= 0 || b <= 0 || !Number.isFinite(b)) return Number.isFinite(b) ? Math.abs(a - b) : -a;
			return Math.abs(Math.log(a) - Math.log(b));
		};
		const starts = this.starts[d][street];
		let best = starts[0];
		let bestDistance = distance(best);
		for (const v of starts.slice(1)) {
			const dv = distance(v);
			if (dv < bestDistance) {
				best = v;
				bestDistance = dv;
			}
		}
		if (best === undefined) throw new Error(`the tree has no street ${street} starts`);
		return best;
	}

	private mapRaise(
		tree: Tree,
		node: number,
		record: ActionRecord,
		real: Real,
		rng: BotRandom
	): string | null {
		const tokens = tree.tokens[node];
		const sized: [number, string][] = [];
		tree.measure[node].forEach((m, i) => {
			if (m !== null) sized.push([m, tokens[i]]);
		});
		if (!sized.length) return null;
		if (record.allIn && tokens.includes('a')) return 'a';
		const owed = real.currentBet - real.streetBets[record.seat];
		const x = (record.to - real.currentBet) / (real.pot + owed);
		if (x <= sized[0][0]) {
			if (x < sized[0][0]) this.count('below_smallest');
			return sized[0][1];
		}
		for (let i = 0; i + 1 < sized.length; i++) {
			const [a, ta] = sized[i];
			const [b, tb] = sized[i + 1];
			if (x <= b) {
				if (x === b) return tb;
				this.count('off_tree');
				return rng.random() < pseudoHarmonic(a, b, x) ? ta : tb;
			}
		}
		return sized[sized.length - 1][1];
	}

	private token(
		d: number,
		node: number,
		hand: Hand,
		index: number,
		record: ActionRecord,
		real: Real,
		rng: BotRandom
	): string | null {
		const tree = this.trees[d];
		const remembered = hand.tokens.get(index);
		if (remembered !== undefined && this.tokenIndex[d][node].has(remembered)) return remembered;
		let token: string | null;
		if (record.kind === 'bet' || record.kind === 'raise') {
			token = this.mapRaise(tree, node, record, real, rng);
		} else {
			token = { check: 'k', call: 'c', fold: 'f' }[record.kind];
		}
		if (token !== null) hand.tokens.set(index, token);
		return token;
	}

	/** Map one street's actions from `node`: whether that worked, and the node reached (null after a terminal). */
	private street(
		d: number,
		node: number,
		records: readonly [number, ActionRecord][],
		real: Real,
		hand: Hand,
		rng: BotRandom
	): [boolean, number | null] {
		const tree = this.trees[d];
		let at: number | null = node;
		for (const [index, record] of records) {
			if (at === null) return [false, null];
			const token = this.token(d, at, hand, index, record, real, rng);
			real.apply(record);
			const i = token === null ? undefined : this.tokenIndex[d][at].get(token);
			if (i === undefined) return [false, null];
			const child: number = tree.children[at][i];
			at = child >= 0 ? child : null;
		}
		return [true, at];
	}

	/** The abstract node of the decision facing `view.seat`, replaying the hand street by street. */
	private position(view: SeatView, hand: Hand, rng: BotRandom): number | null {
		const d = hand.d;
		const tree = this.trees[d];
		let real = new Real(view);
		let node: number | null = 0;
		for (let street = PREFLOP as Street; street <= RIVER; street = (street + 1) as Street) {
			if (street > view.street) break;
			real.toStreet(street);
			if (street > PREFLOP && (node === null || tree.street[node] !== street)) {
				node = this.reenter(tree, d, street, real);
			}
			const records: [number, ActionRecord][] = [];
			view.actions.forEach((r, i) => {
				if (r.street === street) records.push([i, r]);
			});
			const start = real.copy();
			let [ok, reached] = this.street(d, node as number, records, real, hand, rng);
			if (!ok) {
				real = start.copy();
				[ok, reached] = this.street(
					d,
					this.reenter(tree, d, street, real),
					records,
					real,
					hand,
					rng
				);
				if (!ok) return null;
			}
			node = reached;
		}
		if (node === null || tree.street[node] !== view.street) {
			node = this.reenter(tree, d, view.street, real);
		}
		// The tree's seat 0 is the button, wherever the button really sits.
		if (tree.player[node] !== (view.seat === view.button ? 0 : 1)) return null;
		return node;
	}

	// Acting

	private strategyAt(d: number, node: number, bucket: number): number[] | null {
		const tree = this.trees[d];
		const n = tree.children[node].length;
		const s = tree.street[node];
		const buckets = this.bundle.buckets[s];
		const width = tree.width[s];
		const first = this.bundle.base[d][s] + tree.offset[node];
		const strategy = this.bundle.strategy;
		const row = (b: number) => {
			const at = first + b * width;
			let total = 0;
			for (let i = 0; i < n; i++) total += strategy[at + i];
			return { at, total };
		};
		const own = row(bucket);
		const normalize = ({ at, total }: { at: number; total: number }) =>
			Array.from({ length: n }, (_, i) => strategy[at + i] / total);
		if (own.total > 0) {
			this.count('trained');
			return normalize(own);
		}
		let nearest: { at: number; total: number } | null = null;
		let nearestDistance = Infinity;
		for (let b = 0; b < buckets; b++) {
			const r = row(b);
			if (r.total > 0 && Math.abs(b - bucket) < nearestDistance) {
				nearest = r;
				nearestDistance = Math.abs(b - bucket);
			}
		}
		if (nearest === null) {
			this.count('untrained_node');
			return null;
		}
		this.count('borrowed');
		return normalize(nearest);
	}

	act(view: SeatView, rng: BotRandom): Action {
		const legal = view.legal;
		if (legal === null) throw new Error(`S${view.seat} is not the seat to act`);
		if (view.seatOrder.length !== 2) throw new Error('the blueprint plays heads-up only');
		this.count('decisions');
		this.lastProbabilities = null;
		const hand = this.hand(view);
		const node = this.position(view, hand, rng);
		const passive = legal.canCheck ? Action.check() : Action.call();
		if (node === null) {
			this.count('lost');
			return passive;
		}
		const d = hand.d;
		const tree = this.trees[d];
		const hole = view.holeCards;
		if (hole === null) throw new Error('the seat to act has no cards');
		const bucket = this.tables.bucket(hole, view.board);
		const probs = this.strategyAt(d, node, bucket);
		if (probs === null) {
			hand.tokens.set(view.actions.length, legal.canCheck ? 'k' : 'c');
			hand.seen = view.actions;
			return passive;
		}
		this.lastProbabilities = probs;
		const x = rng.random();
		let acc = 0;
		let choice = probs.length - 1;
		for (let i = 0; i < probs.length; i++) {
			acc += probs[i];
			if (x < acc) {
				choice = i;
				break;
			}
		}
		const token = tree.tokens[node][choice];
		hand.tokens.set(view.actions.length, token);
		hand.seen = view.actions;
		return this.realAction(view, tree, node, token);
	}

	/** The engine action for an abstract choice, sized from the real pot and stacks. */
	private realAction(view: SeatView, tree: Tree, node: number, token: string): Action {
		const legal = view.legal!;
		const options = abstractActions(
			legal,
			view.street,
			streetLevel(view.actions, view.street),
			view.pot,
			view.currentBet,
			view.streetBets
		);
		for (const option of options) if (option.token === token) return option.action;
		if (token === 'f' || token === 'k' || token === 'c') {
			if (legal.canCheck) return Action.check();
			return token === 'f' ? Action.fold() : Action.call();
		}
		// The size does not exist at the real stacks: play the closest real size.
		this.count('resized');
		const want = tree.measure[node][tree.tokens[node].indexOf(token)];
		const owed = view.currentBet - view.streetBets[view.seat];
		const raises = options.filter((o) => o.action.amount !== null);
		if (!raises.length || want === null || want === undefined) {
			return legal.canCheck ? Action.check() : Action.call();
		}
		const gap = (o: (typeof raises)[number]) =>
			Math.abs(((o.action.amount as number) - view.currentBet) / (view.pot + owed) - want);
		let best = raises[0];
		for (const o of raises.slice(1)) if (gap(o) < gap(best)) best = o;
		return best.action;
	}
}

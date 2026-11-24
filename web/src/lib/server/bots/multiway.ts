// Play a blueprint trained for a table of more than two: a port of
// MultiwayBlueprintPolicy in rivermind/bots/blueprint/policy.py (P5.7,
// docs/bots.md), reading a format 2 serving bundle (bundle.ts). Python stays
// the reference: on the same view, bundle and generator, both give the same
// probabilities, draws and actions.
//
// The graph's seat 0 is the button, seat 1 the small blind and seat 2 the big
// blind; the rest count back from the button. With fewer players dealt in
// than the graph has seats, its first seats to act have folded. Real actions
// map onto the graph as heads-up (blueprint.ts): folds, checks and calls one
// for one, an all-in to all-in, any other bet or raise to one of the two
// sizes bracketing it by the pseudo-harmonic rule. A graph seat that cannot
// act at the real table is passed over with a check or a call, a raise where
// the graph has none left is its call, and a street that does not fit
// restarts at the node that opens it for the seats still in, with the closest
// stack-to-pot ratio.

import { Action, PREFLOP, RIVER, type ActionRecord, type Street } from '../engine/state.ts';
import type { SeatView } from '../engine/view.ts';
import { abstractActions, abstractionNamed, streetLevel, type Abstraction } from './abstraction.ts';
import { MEMORY, pseudoHarmonic, SPLIT_DEPTH_BB, type Stats } from './blueprint.ts';
import type { Bundle, CardTables, Graph } from './bundle.ts';
import type { BotRandom, Policy } from './policies.ts';

export interface Hand {
	readonly d: number;
	/** Abstract token for each real action, by its index in the hand. */
	readonly tokens: Map<number, string>;
	/** The real actions when the policy last acted, to tell this hand from a later one with the same cards. */
	seen: readonly ActionRecord[];
}

/** The real chips at the table, replayed from the posts and actions: who has folded, and the stack that matters to one seat. */
export class RealTable {
	seats: readonly number[] = [];
	me = 0;
	start: number[] = [];
	contributions: number[] = [];
	streetBets: number[] = [];
	street: Street = PREFLOP;
	currentBet = 0;
	folded = new Set<number>();

	static of(view: SeatView): RealTable {
		const real = new RealTable();
		const n = view.stacks.length;
		real.seats = view.seatOrder;
		real.me = view.seat;
		real.start = Array.from({ length: n }, (_, s) => (view.stacks[s] ?? 0) + view.contributions[s]);
		real.contributions = new Array<number>(n).fill(0);
		real.streetBets = new Array<number>(n).fill(0);
		for (const post of view.posts) {
			real.contributions[post.seat] += post.amount;
			if (post.kind !== 'ante') real.streetBets[post.seat] += post.amount;
		}
		real.currentBet = Math.max(...real.streetBets);
		return real;
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
			this.streetBets = new Array<number>(this.streetBets.length).fill(0);
			this.currentBet = 0;
		}
	}

	apply(record: ActionRecord): void {
		this.contributions[record.seat] += record.added;
		this.streetBets[record.seat] += record.added;
		this.currentBet = Math.max(this.currentBet, this.streetBets[record.seat]);
		if (record.kind === 'fold') this.folded.add(record.seat);
	}

	copy(): RealTable {
		const other = new RealTable();
		other.seats = this.seats;
		other.me = this.me;
		other.start = [...this.start];
		other.contributions = [...this.contributions];
		other.streetBets = [...this.streetBets];
		other.street = this.street;
		other.currentBet = this.currentBet;
		other.folded = new Set(this.folded);
		return other;
	}

	/** What this seat can win or lose from here, over the pot: its stack, or the biggest stack against it if smaller. */
	spr(): number {
		const pot = this.pot;
		if (!pot) return Infinity;
		const mine = this.behind(this.me);
		let most = -Infinity;
		for (const s of this.seats) {
			if (s !== this.me && !this.folded.has(s)) most = Math.max(most, this.behind(s));
		}
		return (most === -Infinity ? mine : Math.min(mine, most)) / pot;
	}
}

const sameRecord = (a: ActionRecord, b: ActionRecord) =>
	a.seat === b.seat &&
	a.street === b.street &&
	a.kind === b.kind &&
	a.to === b.to &&
	a.added === b.added &&
	a.allIn === b.allIn;

interface Indexes {
	/** Per graph and street, the nodes that open the street, by the seats still in (a bit mask). */
	startsByLive: Map<number, number[]>[][];
	/** Per graph and token set, each token's place among the set's actions. */
	tokenIndex: Map<string, number>[][];
}

const indexes = new WeakMap<Bundle, Indexes>();

/** What a policy looks up in a bundle's graphs, worked out once per bundle: a table gets its own policy. */
function indexesOf(bundle: Bundle): Indexes {
	let found = indexes.get(bundle);
	if (found === undefined) {
		found = {
			startsByLive: bundle.graphs.map((g) =>
				g.starts.map((nodes) => {
					const byLive = new Map<number, number[]>();
					for (const v of nodes) {
						const list = byLive.get(g.live[v]);
						if (list === undefined) byLive.set(g.live[v], [v]);
						else list.push(v);
					}
					return byLive;
				})
			),
			tokenIndex: bundle.graphs.map((g) =>
				g.tokenSets.map((set) => new Map(set.map((token, i) => [token, i])))
			)
		};
		indexes.set(bundle, found);
	}
	return found;
}

/** A Policy that plays a multiway serving bundle at a table of three or more. */
export class MultiwayBlueprintPolicy implements Policy {
	readonly name: string;
	readonly stats: Stats = {};
	/** The probabilities of the last decision, or null when it checked or called without data. */
	lastProbabilities: number[] | null = null;
	readonly bundle: Bundle;
	readonly abstraction: Abstraction;
	protected readonly graphs: readonly Graph[];
	protected readonly tables: CardTables;
	private readonly hands = new Map<string, Hand>();
	protected readonly startsByLive: Map<number, number[]>[][];
	private readonly tokenIndex: Map<string, number>[][];

	constructor(bundle: Bundle, { name = 'blueprint' }: { name?: string } = {}) {
		if (!bundle.graphs.length) throw new Error('a multiway policy needs a format 2 bundle');
		this.bundle = bundle;
		this.name = name;
		this.abstraction = abstractionNamed(bundle.manifest.abstraction);
		this.graphs = bundle.graphs;
		this.tables = bundle.tables;
		const { startsByLive, tokenIndex } = indexesOf(bundle);
		this.startsByLive = startsByLive;
		this.tokenIndex = tokenIndex;
	}

	get seats(): number {
		return this.graphs[0].seats;
	}

	protected count(key: string): void {
		this.stats[key] = (this.stats[key] ?? 0) + 1;
	}

	/** Forget the hands mapped so far. */
	newHand(): void {
		this.hands.clear();
	}

	protected tokensAt(d: number, node: number): readonly string[] {
		const g = this.graphs[d];
		return g.tokenSets[g.tokens[node]];
	}

	/** The child a token leads to at a node, or undefined when the node has no such action. */
	protected child(d: number, node: number, token: string | null): number | undefined {
		if (token === null) return undefined;
		const g = this.graphs[d];
		const i = this.tokenIndex[d][g.tokens[node]].get(token);
		return i === undefined ? undefined : g.children[g.first[node] + i];
	}

	// Choosing the graph

	depthIndex(view: SeatView): number {
		const big = view.config.bigBlind;
		const startOf = (s: number) => (view.stacks[s] ?? 0) + view.contributions[s];
		let others = -Infinity;
		for (const s of view.seatOrder) if (s !== view.seat) others = Math.max(others, startOf(s));
		const effective = Math.min(startOf(view.seat), others) / big;
		const depths = this.graphs.map((g) => g.depth);
		if (depths.length === 1) return 0;
		const want = effective < SPLIT_DEPTH_BB ? 50 : 100;
		if (depths.includes(want)) return depths.indexOf(want);
		let best = 0;
		depths.forEach((d, i) => {
			if (Math.abs(d - effective) < Math.abs(depths[best] - effective)) best = i;
		});
		return best;
	}

	/** Each real seat's seat in the graph, by its position from the button. */
	treeSeats(view: SeatView): Map<number, number> {
		const order = view.seatOrder; // clockwise from the small blind; the button is last
		const k = order.length;
		const out = new Map<number, number>();
		order.forEach((seat, i) => {
			const back = k - 1 - i;
			out.set(seat, back === 0 ? 0 : i <= 1 ? i + 1 : this.seats - back);
		});
		return out;
	}

	protected hand(view: SeatView): Hand {
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

	/** The pre-flop node the hand starts at: the root, after a fold for each graph seat nobody sits in. */
	protected open(d: number, view: SeatView): number | null {
		let node = 0;
		for (let i = this.seats - view.seatOrder.length; i > 0; i--) {
			if (this.tokensAt(d, node)[0] !== 'f') return null;
			node = this.graphs[d].children[this.graphs[d].first[node]];
			if (node < 0) return null;
		}
		return node;
	}

	/** The node that opens `street` for the players still in, with the stack-to-pot ratio closest to the real one. */
	protected reenter(
		d: number,
		street: Street,
		real: RealTable,
		seats: Map<number, number>,
		view: SeatView
	): number | null {
		if (street === PREFLOP) return this.open(d, view);
		let live = 0;
		for (const s of real.seats) if (!real.folded.has(s)) live |= 1 << seats.get(s)!;
		const starts = this.startsByLive[d][street].get(live);
		if (starts === undefined || !starts.length) return null;
		this.count('reentries');
		const g = this.graphs[d];
		const target = real.spr();
		const distance = (v: number) => {
			const a = g.spr[v];
			const b = target;
			if (a <= 0 || b <= 0 || !Number.isFinite(b)) return Number.isFinite(b) ? Math.abs(a - b) : -a;
			return Math.abs(Math.log(a) - Math.log(b));
		};
		let best = starts[0];
		let bestDistance = distance(best);
		for (let i = 1; i < starts.length; i++) {
			const dv = distance(starts[i]);
			if (dv < bestDistance) {
				best = starts[i];
				bestDistance = dv;
			}
		}
		return best;
	}

	/**
	 * From `node`, the node where graph seat `actor` acts on `street`. A graph
	 * seat due to act before it did not act at the real table, where it is
	 * all-in or the betting had already closed: the graph checks or calls for it.
	 */
	protected passTo(d: number, node: number, actor: number, street: Street): number | null {
		const g = this.graphs[d];
		for (let i = 2 * this.seats; i > 0; i--) {
			if (g.street[node] !== street) return null;
			if (g.player[node] === actor) return node;
			const next = this.child(d, node, 'k') ?? this.child(d, node, 'c');
			if (next === undefined || next < 0) return null;
			node = next;
			this.count('passed');
		}
		return null;
	}

	private mapRaise(
		d: number,
		node: number,
		record: ActionRecord,
		real: RealTable,
		rng: BotRandom
	): string | null {
		const g = this.graphs[d];
		const tokens = this.tokensAt(d, node);
		const sized: [number, string][] = [];
		g.measureSets[g.measure[node]].forEach((m, i) => {
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
		real: RealTable,
		rng: BotRandom
	): string | null {
		const remembered = hand.tokens.get(index);
		if (remembered !== undefined && this.child(d, node, remembered) !== undefined) {
			return remembered;
		}
		let token: string | null;
		if (record.kind === 'bet' || record.kind === 'raise') {
			token = this.mapRaise(d, node, record, real, rng);
		} else {
			token = { check: 'k', call: 'c', fold: 'f' }[record.kind];
		}
		if (token !== null) {
			hand.tokens.set(index, token);
			return token;
		}
		// The graph has no raise left here, where it holds a seat all-in or the
		// street's raises are spent: the raiser has at least matched the bet.
		const tokens = this.tokensAt(d, node);
		token = tokens.includes('c') ? 'c' : tokens.includes('k') ? 'k' : null;
		if (token !== null) {
			this.count('capped');
			hand.tokens.set(index, token);
		}
		return token;
	}

	/** Map one street's actions from `node`: whether that worked, and the node reached (null after a terminal). */
	protected streetTable(
		d: number,
		node: number,
		records: readonly [number, ActionRecord][],
		real: RealTable,
		hand: Hand,
		rng: BotRandom,
		seats: Map<number, number>,
		street: Street
	): [boolean, number | null] {
		let at: number | null = node;
		for (const [index, record] of records) {
			if (at === null) return [false, null];
			at = this.passTo(d, at, seats.get(record.seat)!, street);
			if (at === null) {
				real.apply(record);
				return [false, null];
			}
			const token = this.token(d, at, hand, index, record, real, rng);
			real.apply(record);
			const child = this.child(d, at, token);
			if (child === undefined) return [false, null];
			at = child >= 0 ? child : null;
		}
		return [true, at];
	}

	/** The graph node of the decision facing `view.seat`, replaying the hand street by street. */
	protected position(view: SeatView, hand: Hand, rng: BotRandom): number | null {
		const d = hand.d;
		const g = this.graphs[d];
		const seats = this.treeSeats(view);
		let real = RealTable.of(view);
		let node = this.open(d, view);
		for (let street = PREFLOP as Street; street <= RIVER; street = (street + 1) as Street) {
			if (street > view.street) break;
			real.toStreet(street);
			if (street > PREFLOP && (node === null || g.street[node] !== street)) {
				node = this.reenter(d, street, real, seats, view);
			}
			const records: [number, ActionRecord][] = [];
			view.actions.forEach((r, i) => {
				if (r.street === street) records.push([i, r]);
			});
			const start = real.copy();
			let ok = false;
			let reached: number | null = null;
			if (node !== null) {
				[ok, reached] = this.streetTable(d, node, records, real, hand, rng, seats, street);
			}
			if (!ok) {
				real = start.copy();
				const again = this.reenter(d, street, real, seats, view);
				if (again === null) return null;
				[ok, reached] = this.streetTable(d, again, records, real, hand, rng, seats, street);
				if (!ok) return null;
			}
			node = reached;
		}
		const me = seats.get(view.seat)!;
		let found = node === null ? null : this.passTo(d, node, me, view.street);
		if (found === null) {
			const again = this.reenter(d, view.street, real, seats, view);
			found = again === null ? null : this.passTo(d, again, me, view.street);
		}
		return found;
	}

	// Acting

	private strategyAt(d: number, node: number, bucket: number): number[] | null {
		const g = this.graphs[d];
		const n = g.first[node + 1] - g.first[node];
		const s = g.street[node];
		const buckets = this.bundle.buckets[s];
		const width = g.width[s];
		const first = this.bundle.base[d][s] + g.offset[node];
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
		this.checkTable(view);
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
		const token = this.tokensAt(d, node)[choice];
		hand.tokens.set(view.actions.length, token);
		hand.seen = view.actions;
		return this.realAction(view, d, node, token);
	}

	protected checkTable(view: SeatView): void {
		if (view.seatOrder.length < 3 || view.seatOrder.length > this.seats) {
			throw new Error(`this blueprint plays three to ${this.seats} players`);
		}
	}

	/** The engine action for an abstract choice, sized from the real pot and stacks. */
	private realAction(view: SeatView, d: number, node: number, token: string): Action {
		const legal = view.legal!;
		const options = abstractActions(
			legal,
			view.street,
			streetLevel(view.actions, view.street),
			view.pot,
			view.currentBet,
			view.streetBets,
			this.abstraction
		);
		for (const option of options) if (option.token === token) return option.action;
		if (token === 'f' || token === 'k' || token === 'c') {
			if (legal.canCheck) return Action.check();
			return token === 'f' ? Action.fold() : Action.call();
		}
		// The size does not exist at the real stacks: play the closest real size.
		this.count('resized');
		const g = this.graphs[d];
		const want = g.measureSets[g.measure[node]][this.tokensAt(d, node).indexOf(token)];
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

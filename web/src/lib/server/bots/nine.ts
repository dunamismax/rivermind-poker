// Nine seats on the six-seat blueprint, option 1 (P5.6, docs/bots.md): a port
// of NineSeatPolicy in rivermind/bots/blueprint/nine.py. Python stays the
// reference: on the same view, model and generator, both give the same
// probabilities, draws and actions.
//
// At a table of seven to nine, the first k - 6 players to act before the flop
// are the early seats. An early seat's first decision comes from the model's
// early table, by depth class, players dealt in, early position, what the
// earlier early seats did, and the 169 pre-flop hand classes. Everything else
// is the six-seat policy: the players are placed on the graph's seats in their
// order of play, the early players who entered first, the blinds always on the
// blinds; a later player who folded without putting chips in, or failing that
// one still to act, makes way when more than four besides the blinds are in,
// and a graph seat nobody is placed on folds at its turn. When every early seat
// folds, the hand is the six-seat game among the last six exactly.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Action, PREFLOP, type ActionRecord, type Street } from '../engine/state.ts';
import type { SeatView } from '../engine/view.ts';
import { abstractActions, streetLevel, type Abstraction } from './abstraction.ts';
import { BundleError, type Bundle } from './bundle.ts';
import { MultiwayBlueprintPolicy, type Hand, type RealTable } from './multiway.ts';
import { HeuristicPolicy, type BotRandom } from './policies.ts';

export const NAME = '9max-o1';
export const SEATS = 9;
const SIX = 6;
export const DEPTHS = [50, 100] as const;
export const ACTIONS = ['f', 'c', 'r', 'a'] as const;
const CONTEXT = 'fcra';
export const CLASSES = 169;
export const BUNDLE_KIND = 'rivermind-nine-bundle';

function rows(): [number, number, number, string][] {
	const out: [number, number, number, string][] = [];
	const contexts = (i: number): string[] =>
		i === 0 ? [''] : contexts(i - 1).flatMap((c) => [...CONTEXT].map((t) => c + t));
	for (const depth of DEPTHS) {
		for (let k = SIX + 1; k <= SEATS; k++) {
			for (let i = 0; i < k - SIX; i++) for (const c of contexts(i)) out.push([depth, k, i, c]);
		}
	}
	return out;
}

/** Each row of the early table: depth class, players dealt in, early position (0 first to act) and the earlier early seats' actions. */
export const ROWS = rows();
const ROW_INDEX = new Map(ROWS.map((r, n) => [r.join('/'), n]));
export const SIZE = ROWS.length * CLASSES * ACTIONS.length;

/** The early seats of a hand, in their order of play: the first k - 6 after the big blind. */
export function earlySeats(seatOrder: readonly number[]): readonly number[] {
	return seatOrder.slice(2, 2 + Math.max(0, seatOrder.length - SIX));
}

function contextToken(record: ActionRecord): string {
	if (record.kind === 'fold') return 'f';
	if (record.kind === 'bet' || record.kind === 'raise') return record.allIn ? 'a' : 'r';
	return 'c';
}

/** The early-table row of the decision facing `view.seat`, which must be an early seat's first. */
export function earlyRow(view: SeatView, depth: number): number | null {
	const early = earlySeats(view.seatOrder);
	const i = early.indexOf(view.seat);
	const first = new Map<number, string>();
	for (const r of view.actions) {
		if (r.street === PREFLOP && !first.has(r.seat)) first.set(r.seat, contextToken(r));
	}
	if (early.slice(0, i).some((s) => !first.has(s))) return null;
	const context = early
		.slice(0, i)
		.map((s) => first.get(s))
		.join('');
	return ROW_INDEX.get([depth, view.seatOrder.length, i, context].join('/')) ?? null;
}

/** Whether the decision is an early seat's first of the hand, which the early table plays. */
export function isEarlyFirst(view: SeatView): boolean {
	return (
		view.seatOrder.length > SIX &&
		view.street === PREFLOP &&
		earlySeats(view.seatOrder).includes(view.seat) &&
		!view.actions.some((r) => r.seat === view.seat)
	);
}

/** The engine action for each early choice the real table allows. */
export function earlyOptions(view: SeatView, abstraction: Abstraction): Map<string, Action> {
	const options = abstractActions(
		view.legal!,
		PREFLOP,
		streetLevel(view.actions, PREFLOP),
		view.pot,
		view.currentBet,
		view.streetBets,
		abstraction
	);
	const by = new Map(options.map((o) => [o.token, o.action]));
	const out = new Map<string, Action>();
	if (by.has('f')) out.set('f', by.get('f')!);
	if (by.has('c') || by.has('k')) out.set('c', by.get('c') ?? by.get('k')!);
	const raise = options.find((o) => o.token.startsWith('r'));
	if (raise) out.set('r', raise.action);
	if (by.has('a')) out.set('a', by.get('a')!);
	return out;
}

/** The early seats' strategy: byte weights over ACTIONS by row and hand class. */
export class EarlyTable {
	readonly weights: Uint8Array;

	constructor(weights: Uint8Array) {
		if (weights.length !== SIZE)
			throw new BundleError(`an early table has ${SIZE} weights, not ${weights.length}`);
		this.weights = weights;
	}

	probs(row: number, cls: number): number[] | null {
		const at = (row * CLASSES + cls) * ACTIONS.length;
		let total = 0;
		for (let i = 0; i < ACTIONS.length; i++) total += this.weights[at + i];
		if (total <= 0) return null;
		return Array.from({ length: ACTIONS.length }, (_, i) => this.weights[at + i] / total);
	}
}

export interface NineManifest {
	format: number;
	kind: string;
	abstraction: string;
	seats: number;
	builds_on: { bundle: string; files: Record<string, string>; table_set: string };
	strategy: { levels: number; shape: number[] };
	checkpoint: {
		iteration: number | null;
		manifest_sha256: string | null;
		strategy_sha256: string | null;
	};
	files: Record<string, { sha256: string; bytes: number }>;
}

/** A nine-seat bundle: its early table, read and checked against its manifest. */
export interface NineBundle {
	readonly path: string;
	readonly manifest: NineManifest;
	readonly early: EarlyTable;
}

/** Read a nine-seat bundle, refusing one whose files do not match its manifest or that builds on another six-seat bundle. */
export function loadNineBundle(path: string, six: Bundle): NineBundle {
	let manifest: NineManifest;
	try {
		manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as NineManifest;
	} catch (error) {
		throw new BundleError(`${path} has no readable manifest.json: ${error}`);
	}
	if (manifest.kind !== BUNDLE_KIND || manifest.abstraction !== NAME) {
		throw new BundleError(`${path} is not a nine-seat bundle`);
	}
	const names = Object.keys(manifest.files);
	if (names.length !== 1 || names[0] !== 'early.u8') {
		throw new BundleError(`${path} should hold early.u8 alone`);
	}
	const bytes = readFileSync(join(path, 'early.u8'));
	const data = new Uint8Array(bytes.byteLength);
	data.set(bytes);
	const sha256 = createHash('sha256').update(data).digest('hex');
	if (
		sha256 !== manifest.files['early.u8'].sha256 ||
		data.length !== manifest.files['early.u8'].bytes
	) {
		throw new BundleError('early.u8 differs from the manifest');
	}
	const sixFiles = Object.fromEntries(
		Object.entries(six.manifest.files).map(([name, entry]) => [name, entry.sha256])
	);
	const wanted = manifest.builds_on.files;
	const differ = [...new Set([...Object.keys(sixFiles), ...Object.keys(wanted)])].filter(
		(name) => sixFiles[name] !== wanted[name]
	);
	if (differ.length || manifest.builds_on.table_set !== six.manifest.cards.table_set) {
		throw new BundleError(`${path} builds on another six-seat bundle than ${six.path}`);
	}
	return { path, manifest, early: new EarlyTable(data) };
}

/**
 * A Policy for tables of three to nine: the six-seat bundle's blueprint, and
 * the early table for the early seats' first decisions. At six or fewer it is
 * the six-seat policy unchanged.
 */
export class NineSeatPolicy extends MultiwayBlueprintPolicy {
	readonly early: EarlyTable;
	readonly nine: NineBundle | null;
	readonly easy = new HeuristicPolicy();
	#placed: Map<number, number> | null = null;
	#unmapped = new Set<number>();

	constructor(
		bundle: Bundle,
		early: NineBundle | EarlyTable,
		{ name = 'blueprint' }: { name?: string } = {}
	) {
		super(bundle, { name });
		if (this.seats !== SIX) throw new Error('the nine-seat model plays on a six-seat blueprint');
		this.nine = early instanceof EarlyTable ? null : early;
		this.early = early instanceof EarlyTable ? early : early.early;
	}

	/** The table sizes it plays. */
	get tableSeats(): number {
		return SEATS;
	}

	protected override checkTable(view: SeatView): void {
		if (view.seatOrder.length < 3 || view.seatOrder.length > SEATS) {
			throw new Error(`this model plays three to ${SEATS} players`);
		}
	}

	// Placing the players on the six-seat graph

	/** Each placed player's graph seat, and the graph seats nobody is placed on; null when more than four besides the blinds stay in. */
	place(view: SeatView): [Map<number, number>, Set<number>] | null {
		const order = view.seatOrder;
		const k = order.length;
		if (k <= SIX) return [super.treeSeats(view), new Set()];
		const early = earlySeats(order);
		const late = order.slice(2 + k - SIX);
		const first = new Map<number, string>();
		const entered = new Set<number>();
		for (const r of view.actions) {
			if (r.street !== PREFLOP) continue;
			if (!first.has(r.seat)) first.set(r.seat, r.kind);
			if (r.kind === 'call' || r.kind === 'bet' || r.kind === 'raise') entered.add(r.seat);
		}
		const placed = early.filter((s) => entered.has(s));
		let excess = placed.length + late.length - 4;
		if (excess > 0) {
			const folded = late.filter((s) => first.get(s) === 'fold' && !entered.has(s));
			const waiting = late.filter((s) => !first.has(s) && s !== view.seat);
			for (const s of [...folded, ...waiting]) {
				if (excess === 0) break;
				late.splice(late.indexOf(s), 1);
				excess--;
			}
			if (excess > 0) return null;
			this.count('dropped');
		}
		placed.push(...late);
		const slots = [3, 4, 5, 0];
		const seats = new Map<number, number>();
		const from = 4 - placed.length;
		placed.forEach((s, i) => seats.set(s, slots[from + i]));
		seats.set(order[0], 1);
		seats.set(order[1], 2);
		return [seats, new Set(slots.slice(0, from))];
	}

	override treeSeats(view: SeatView): Map<number, number> {
		if (this.#placed !== null) return this.#placed;
		const placed = this.place(view);
		if (placed === null) throw new Error('no room on the graph for these players');
		return placed[0];
	}

	protected override position(view: SeatView, hand: Hand, rng: BotRandom): number | null {
		if (view.seatOrder.length <= SIX) return super.position(view, hand, rng);
		const placed = this.place(view);
		if (placed === null) return null;
		[this.#placed, this.#unmapped] = placed;
		try {
			if (!this.#placed.has(view.seat)) return null;
			return super.position(view, hand, rng);
		} finally {
			this.#placed = null;
			this.#unmapped = new Set();
		}
	}

	/** As the six-seat policy, and a graph seat nobody is placed on folds. */
	protected override passTo(d: number, node: number, actor: number, street: Street): number | null {
		if (!this.#unmapped.size) return super.passTo(d, node, actor, street);
		const g = this.graphs[d];
		for (let i = 2 * this.seats; i > 0; i--) {
			if (g.street[node] !== street) return null;
			if (g.player[node] === actor) return node;
			if (this.#unmapped.has(g.player[node])) {
				const fold = this.child(d, node, 'f');
				if (fold !== undefined) {
					if (fold < 0) return null;
					node = fold;
					continue;
				}
			}
			const next = this.child(d, node, 'k') ?? this.child(d, node, 'c');
			if (next === undefined || next < 0) return null;
			node = next;
			this.count('passed');
		}
		return null;
	}

	/** As the six-seat policy, over the placed players' actions; the others only fold, which costs no chips. */
	protected override streetTable(
		d: number,
		node: number,
		records: readonly [number, ActionRecord][],
		real: RealTable,
		hand: Hand,
		rng: BotRandom,
		seats: Map<number, number>,
		street: Street
	): [boolean, number | null] {
		const kept: [number, ActionRecord][] = [];
		for (const [index, record] of records) {
			if (seats.has(record.seat)) kept.push([index, record]);
			else real.apply(record);
		}
		return super.streetTable(d, node, kept, real, hand, rng, seats, street);
	}

	protected override reenter(
		d: number,
		street: Street,
		real: RealTable,
		seats: Map<number, number>,
		view: SeatView
	): number | null {
		if (street === PREFLOP || view.seatOrder.length <= SIX) {
			return super.reenter(d, street, real, seats, view);
		}
		let live = 0;
		for (const s of real.seats) {
			if (seats.has(s) && !real.folded.has(s)) live |= 1 << seats.get(s)!;
		}
		if (real.seats.some((s) => !seats.has(s) && !real.folded.has(s))) return null;
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
	 * Where the graph has no room for the players in, or the mapping found no
	 * node: RiverMind Easy's action. At nine seats a pot can hold more players
	 * than the six-seat graph has seats; checking and calling there played a
	 * calling station's game against players who limp (docs/bots.md).
	 */
	protected override lost(view: SeatView): Action {
		this.count('easy');
		return this.easy.act(view);
	}

	// The early seats

	override act(view: SeatView, rng: BotRandom): Action {
		if (view.legal !== null && isEarlyFirst(view)) return this.earlyAct(view, rng);
		return super.act(view, rng);
	}

	private earlyAct(view: SeatView, rng: BotRandom): Action {
		this.checkTable(view);
		this.count('decisions');
		this.count('early');
		this.lastProbabilities = null;
		const hand = this.hand(view);
		hand.seen = view.actions;
		const options = earlyOptions(view, this.abstraction);
		const row = earlyRow(view, this.graphs[hand.d].depth);
		const hole = view.holeCards;
		if (hole === null) throw new Error('the seat to act has no cards');
		let probs = row === null ? null : this.early.probs(row, this.tables.bucket(hole, []));
		if (probs !== null) {
			const masked = ACTIONS.map((a, i) => (options.has(a) ? probs![i] : 0));
			let total = 0;
			for (const p of masked) total += p;
			probs = total > 0 ? masked.map((p) => p / total) : null;
		}
		if (probs === null) {
			this.count('early_untrained');
			return options.get('f') ?? options.get('c')!;
		}
		this.count('trained');
		this.lastProbabilities = probs;
		const x = rng.random();
		let acc = 0;
		let last = 0;
		probs.forEach((p, i) => {
			if (p !== 0) last = i;
		});
		let choice: string = ACTIONS[last];
		for (let i = 0; i < ACTIONS.length; i++) {
			acc += probs[i];
			if (x < acc) {
				choice = ACTIONS[i];
				break;
			}
		}
		return options.get(choice)!;
	}
}

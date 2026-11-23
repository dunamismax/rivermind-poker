// The champions the site may serve (P5.7a): each format's promoted model from
// the registry (docs/models.md), as `rivermind-poker blueprint promote` writes
// it into src/lib/champions.json.
//
// `loadChampion` reads a champion's serving bundle and refuses it unless it is
// the registered one: `loadBundle` checks every file against the bundle's own
// manifest, and this checks that manifest against the registry, file by file,
// together with the card table set and the checkpoint the bundle names. A
// server therefore never plays a strategy other than the one whose evaluation
// its label links to (D-7).
//
// A table gets its own policies (`forTable`): a policy remembers how it mapped
// each hand's actions, and one memory shared by every table could forget a
// slow table's hand while busier tables deal.
//
// RiverMind Hard and Medium each play every format the server has a champion
// for (P5.7): a hand with two players dealt in is the heads-up champion's,
// whatever the table's size, and a hand of three to six is the six-seat
// champion's. Heads-up is not the six-seat game with four seats folded (the
// button posts the small blind and acts last after the flop), so the six-seat
// policy refuses it; three to five dealt in are the six-seat game with its
// first seats to act folded, which is exact, since folding in turn puts no
// chips in (docs/bots.md).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Action } from '../engine/state.ts';
import type { SeatView } from '../engine/view.ts';
import builtIn from '../../champions.json' with { type: 'json' };
import { BlueprintPolicy } from './blueprint.ts';
import { BundleError, loadBundle, type Bundle } from './bundle.ts';
import { medium, MEDIUM, MEDIUM_SHARE, type MixedPolicy } from './levels.ts';
import { MultiwayBlueprintPolicy } from './multiway.ts';
import type { Stats } from './blueprint.ts';
import type { BotRandom, Policy } from './policies.ts';

/** The bot kind that plays a format's champion. */
export const HARD = 'hard';
export { MEDIUM };
export const REGISTRY_KIND = 'rivermind-site-champions';

export interface ChampionResult {
	/** A bot kind, or `champion` for an earlier model, named by `name`. */
	opponent: string;
	name: string | null;
	stack_bb: number;
	hands: number;
	bb_per_100: number;
	ci95: [number, number];
	/** Whether the promotion gate rests on this matchup. */
	gate: boolean;
}

export interface ChampionEvaluation {
	candidate: 'bundle' | 'checkpoint' | 'medium';
	/** The report under docs/, without its extension. */
	report: string;
	deals: number;
	seed: number;
	blinds: [number, number];
	evaluated_at: string | null;
	results: ChampionResult[];
}

export interface Champion {
	format: string;
	seats: number;
	name: string;
	abstraction: string;
	iterations: number;
	promoted: string;
	replaced: string | null;
	checkpoint: { manifest_sha256: string; files: Record<string, string> };
	bundle: { levels: number; table_set: string; files: Record<string, string> };
	evaluations: ChampionEvaluation[];
	/** The champion's difficulty levels with a recorded evaluation (`blueprint level`, P5.7). */
	levels?: { medium?: ChampionLevel };
}

/** A difficulty level made from a champion, and its own published evaluation. */
export interface ChampionLevel {
	/** The share of hands played as the champion; the rest are RiverMind Easy's. */
	share: number;
	recorded: string;
	evaluation: ChampionEvaluation;
}

export interface ChampionRegistry {
	format: number;
	kind: string;
	champions: Champion[];
}

/** The registry this build was made with. */
export const REGISTRY = builtIn as unknown as ChampionRegistry;

/** A registry extract from a file, for tests that serve a synthetic bundle. */
export function readRegistry(path: string): ChampionRegistry {
	const registry = JSON.parse(readFileSync(path, 'utf8')) as ChampionRegistry;
	if (registry.kind !== REGISTRY_KIND || !Array.isArray(registry.champions)) {
		throw new BundleError(`${path} is not a registry of champions`);
	}
	return registry;
}

/** The champion that plays tables of `seats`, if its format has one. */
export function championFor(registry: ChampionRegistry, seats: number): Champion | null {
	return registry.champions.find((c) => c.seats === seats) ?? null;
}

/** Where a champion's bundle is kept under a models directory, as `blueprint promote` lays it out. */
export function bundlePath(models: string, champion: Champion): string {
	return join(models, champion.name, 'bundle');
}

/** Load the champion's bundle from `models`, refusing anything but the registered files. */
export function loadChampion(models: string, champion: Champion): Bundle {
	const bundle = loadBundle(bundlePath(models, champion), { tableSet: champion.bundle.table_set });
	const found = bundle.manifest.files;
	const wanted = champion.bundle.files;
	const bad = [...new Set([...Object.keys(found), ...Object.keys(wanted)])]
		.filter((name) => found[name]?.sha256 !== wanted[name])
		.sort();
	if (bad.length) {
		throw new BundleError(
			`${bundle.path} is not the bundle registered for ${champion.name}: ${bad.join(', ')} differ`
		);
	}
	const source = bundle.manifest.checkpoint;
	if (
		source.manifest_sha256 !== champion.checkpoint.manifest_sha256 ||
		source.strategy_sha256 !== champion.checkpoint.files['strategy.npy']
	) {
		throw new BundleError(`${bundle.path} was not exported from ${champion.name}'s checkpoint`);
	}
	return bundle;
}

/** A champion and its checked bundle. */
export interface LoadedChampion {
	champion: Champion;
	bundle: Bundle;
}

/** The fewest players dealt in that a multiway champion plays; two is heads-up. */
export const MULTIWAY_LEAST = 3;

/**
 * The trained bot at one table: the heads-up champion for a hand of two, and
 * the six-seat champion, when there is one, for a hand of three to six.
 */
export class TablePolicy implements Policy {
	readonly name: string;
	readonly heads: BlueprintPolicy;
	readonly multi: MultiwayBlueprintPolicy | null;

	constructor(name: string, heads: Bundle, multi: Bundle | null = null) {
		this.name = name;
		this.heads = new BlueprintPolicy(heads, { name });
		this.multi = multi === null ? null : new MultiwayBlueprintPolicy(multi, { name });
	}

	/** The players dealt in that this bot has a model for. */
	plays(dealt: number): boolean {
		return (
			dealt === 2 || (this.multi !== null && MULTIWAY_LEAST <= dealt && dealt <= this.multi.seats)
		);
	}

	/** Both models' decision statistics, added together. */
	get stats(): Stats {
		const out: Stats = { ...this.heads.stats };
		for (const [key, count] of Object.entries(this.multi?.stats ?? {})) {
			out[key] = (out[key] ?? 0) + count;
		}
		return out;
	}

	/** The probabilities of the last decision, from whichever model made it. */
	lastProbabilities: number[] | null = null;

	newHand(): void {
		this.heads.newHand();
		this.multi?.newHand();
	}

	act(view: SeatView, rng: BotRandom): Action {
		const dealt = view.seatOrder.length;
		if (!this.plays(dealt)) throw new Error(`${this.name} has no model for ${dealt} players`);
		const model = dealt === 2 ? this.heads : this.multi!;
		const action = model.act(view, rng);
		this.lastProbabilities = model.lastProbabilities;
		return action;
	}
}

/** The table sizes a bot made from these champions plays: two, and three to the multiway champion's size. */
export function seatsFor(multi: LoadedChampion | null): number[] {
	const seats = [2];
	if (multi !== null) for (let n = MULTIWAY_LEAST; n <= multi.champion.seats; n++) seats.push(n);
	return seats;
}

/**
 * A loaded champion as a table's bot, RiverMind Hard: the heads-up champion,
 * and with `multi` the six-seat one for hands of three or more.
 */
export class ChampionPolicy implements Policy {
	readonly name = HARD;
	readonly champion: Champion;
	readonly bundle: Bundle;
	readonly multi: LoadedChampion | null;
	private readonly shared: TablePolicy;

	constructor(champion: Champion, bundle: Bundle, multi: LoadedChampion | null = null) {
		this.champion = champion;
		this.bundle = bundle;
		this.multi = multi;
		this.shared = this.forTable();
	}

	/** The table sizes it plays. */
	get seats(): number[] {
		return seatsFor(this.multi);
	}

	act(view: SeatView, rng: BotRandom): Action {
		return this.shared.act(view, rng);
	}

	/** Policies with their own memory of hands, for one table. */
	forTable(): TablePolicy {
		return new TablePolicy(HARD, this.bundle, this.multi?.bundle ?? null);
	}
}

/**
 * RiverMind Medium for a loaded champion (P5.7): each hand played as the
 * champion or as RiverMind Easy, half and half, as `levels.ts` mixes them. It
 * is offered only for a champion whose Medium has a recorded evaluation made
 * with the site's share, so its label links to a measurement of what it plays;
 * `multi` is the six-seat champion, given only when its Medium is recorded too.
 */
export class MediumPolicy implements Policy {
	readonly name = MEDIUM;
	readonly champion: Champion;
	readonly bundle: Bundle;
	readonly multi: LoadedChampion | null;
	private readonly shared: MixedPolicy;

	constructor(champion: Champion, bundle: Bundle, multi: LoadedChampion | null = null) {
		this.champion = champion;
		this.bundle = bundle;
		this.multi = multi;
		this.shared = this.forTable();
	}

	/** Whether the registry records a Medium for `champion` that this server plays. */
	static recorded(champion: Champion): boolean {
		return champion.levels?.medium?.share === MEDIUM_SHARE;
	}

	/** The table sizes it plays. */
	get seats(): number[] {
		return seatsFor(this.multi);
	}

	act(view: SeatView, rng: BotRandom): Action {
		return this.shared.act(view, rng);
	}

	/** A Medium with its own memory of hands, the champions' included, for one table. */
	forTable(): MixedPolicy {
		return medium(new TablePolicy(HARD, this.bundle, this.multi?.bundle ?? null));
	}
}

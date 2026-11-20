// Simple bots: random, calling station, the min-bet probe and the
// tight-aggressive heuristic (RiverMind Easy). A port of
// rivermind/bots/policies.py, which stays the reference (P4B.6): given the
// same view and a generator seeded the same way, each picks the same action.

import { evaluate } from '../../engine/evaluator.ts';
import {
	Action,
	PREFLOP,
	type ActionKind,
	type HoleCards,
	type LegalActions
} from '../engine/state.ts';
import { opponents, stackOf, streetActions, type SeatView } from '../engine/view.ts';
import type { PythonRandom } from './mt.ts';

/** What a bot draws its random choices from: Python's generator, ported. */
export type BotRandom = Pick<PythonRandom, 'random' | 'below' | 'randint' | 'choice'>;

export interface Policy {
	readonly name: string;
	/** Choose a legal action for `view.seat`, which must be the seat to act. */
	act(view: SeatView, rng: BotRandom): Action;
}

export function legalOf(view: SeatView): LegalActions {
	if (view.legal === null) throw new Error(`S${view.seat} is not the seat to act`);
	return view.legal;
}

export function passive(legal: LegalActions): Action {
	return legal.canCheck ? Action.check() : Action.call();
}

const isAggressive = (kind: ActionKind) => kind === 'bet' || kind === 'raise';

/** Picks uniformly among fold, check or call, and bet or raise, then a uniform size. It never folds when it could check. */
export class RandomPolicy implements Policy {
	readonly name = 'random';

	act(view: SeatView, rng: BotRandom): Action {
		const legal = legalOf(view);
		const kinds = ['passive'];
		if (legal.canFold) kinds.push('fold');
		if (legal.raiseKind !== null) kinds.push('raise');
		const kind = rng.choice(kinds);
		if (kind === 'fold') return Action.fold();
		if (kind === 'raise' && legal.raiseKind !== null) {
			return Action.of(legal.raiseKind, rng.randint(legal.minTo, legal.maxTo));
		}
		return passive(legal);
	}
}

/** Checks when it can and calls otherwise. It never folds or raises. */
export class CallingStationPolicy implements Policy {
	readonly name = 'calling_station';

	act(view: SeatView): Action {
		return passive(legalOf(view));
	}
}

/** An evaluation probe: on every street it opens with the minimum bet or raise, then checks or calls. */
export class MinBetPolicy implements Policy {
	readonly name = 'min_bettor';

	act(view: SeatView): Action {
		const legal = legalOf(view);
		const opened = streetActions(view).some((a) => isAggressive(a.kind));
		if (!opened && legal.raiseKind !== null) return Action.of(legal.raiseKind, legal.minTo);
		return passive(legal);
	}
}

// Hand strength

const rankOf = (card: number) => card >> 2;
const suitOf = (card: number) => card & 3;

/** Bill Chen's pre-flop score, from -1 (7-2 offsuit) to 20 (aces). */
export function chenScore(hole: HoleCards): number {
	const [high, low] = [rankOf(hole[0]), rankOf(hole[1])].sort((a, b) => b - a);
	let value = ({ 12: 10, 11: 8, 10: 7, 9: 6 } as Record<number, number>)[high] ?? (high + 2) / 2;
	if (high === low) return Math.max(5, Math.ceil(value * 2));
	if (suitOf(hole[0]) === suitOf(hole[1])) value += 2;
	const gap = high - low - 1;
	value -= gap < 4 ? [0, 1, 2, 4][gap] : 5;
	if (gap <= 1 && high < 10) value += 1;
	return Math.ceil(value);
}

const strengthCache = new Map<string, number>();
const STRENGTH_CACHE = 4096;

/** Share of possible opponent hands that this hand beats now, ties counting half. */
export function handStrength(hole: HoleCards, board: readonly number[]): number {
	const h = [...hole].sort((a, b) => a - b);
	const b = [...board].sort((x, y) => x - y);
	const key = `${h.join(',')}|${b.join(',')}`;
	const cached = strengthCache.get(key);
	if (cached !== undefined) return cached;
	const mine = evaluate([...h, ...b]);
	const seen = new Set([...h, ...b]);
	const rest: number[] = [];
	for (let c = 0; c < 52; c++) if (!seen.has(c)) rest.push(c);
	let wins = 0;
	let ties = 0;
	let total = 0;
	const cards = [0, 0, ...b];
	for (let i = 0; i < rest.length; i++) {
		cards[0] = rest[i];
		for (let j = i + 1; j < rest.length; j++) {
			cards[1] = rest[j];
			const theirs = evaluate(cards);
			total++;
			if (mine < theirs) wins++;
			else if (mine === theirs) ties++;
		}
	}
	const value = (wins + ties / 2) / total;
	if (strengthCache.size >= STRENGTH_CACHE) strengthCache.clear();
	strengthCache.set(key, value);
	return value;
}

/**
 * A rule-based tight-aggressive bot: the "easy" bot and an evaluation opponent.
 * Pre-flop it opens and re-raises by Chen score, looser in late position; after
 * the flop it bets, raises, calls or folds by hand strength against each
 * opponent still in. It is deterministic; `rng` is unused.
 */
export class HeuristicPolicy implements Policy {
	readonly name = 'heuristic';

	act(view: SeatView): Action {
		const legal = legalOf(view);
		const hole = view.holeCards;
		if (hole === null) throw new Error('the seat to act has no cards');
		if (view.street === PREFLOP) return this.preflop(view, legal, chenScore(hole));
		const strength = handStrength(hole, view.board) ** Math.max(1, opponents(view).length);
		return this.postflop(view, legal, strength);
	}

	private static raiseTo(legal: LegalActions, target: number): Action {
		if (legal.raiseKind === null) throw new Error('no raise is legal');
		return Action.of(legal.raiseKind, Math.min(Math.max(legal.minTo, target), legal.maxTo));
	}

	private preflop(view: SeatView, legal: LegalActions, score: number): Action {
		const big = view.config.bigBlind;
		const street = streetActions(view);
		const raises = street.filter((a) => isAggressive(a.kind)).length;
		const canRaise = legal.raiseKind !== null;
		const fallback = () => (legal.canCheck ? passive(legal) : Action.fold());
		if (raises === 0) {
			const limpers = street.filter((a) => a.kind === 'call').length;
			const order = view.seatOrder;
			const at = order.indexOf(view.seat);
			const behind = at >= 0 ? order.length - 1 - at : 0;
			let need: number;
			if (view.seat === view.bigBlindSeat) need = 9;
			else if (behind <= 2 || view.seat === view.smallBlindSeat) need = 8;
			else if (behind <= 4) need = 9;
			else need = 10;
			if (score >= need && canRaise) {
				return HeuristicPolicy.raiseTo(legal, Math.trunc(2.5 * big) + limpers * big);
			}
			return fallback();
		}
		const callShare = legal.call / Math.max(1, stackOf(view));
		if (raises === 1) {
			if (score >= 12 && canRaise) return HeuristicPolicy.raiseTo(legal, 3 * view.currentBet);
			if (score >= 10 && callShare <= 0.15) return Action.call();
		} else {
			if (score >= 14 && canRaise) return HeuristicPolicy.raiseTo(legal, legal.maxTo);
			if (score >= 12 && callShare <= 0.3) return Action.call();
		}
		return fallback();
	}

	private postflop(view: SeatView, legal: LegalActions, strength: number): Action {
		const pot = view.pot;
		const canRaise = legal.raiseKind !== null;
		if (legal.canCheck) {
			if (strength >= 0.6 && canRaise) {
				return HeuristicPolicy.raiseTo(legal, strength < 0.85 ? Math.floor((2 * pot) / 3) : pot);
			}
			return Action.check();
		}
		const odds = legal.call / (pot + legal.call);
		if (strength >= 0.9 && canRaise) {
			return HeuristicPolicy.raiseTo(legal, view.currentBet + pot + legal.call);
		}
		if (strength >= odds + 0.15) return Action.call();
		return Action.fold();
	}
}

/** The bots a table can seat, by the names the protocol uses. */
export function defaultBots(): Record<string, Policy> {
	return {
		random: new RandomPolicy(),
		calling_station: new CallingStationPolicy(),
		heuristic: new HeuristicPolicy()
	};
}

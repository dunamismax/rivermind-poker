// A finished hand as steps to walk through (P6.1): the blinds, every action,
// each street's cards, the showdown and the result, with the board, each
// seat's cards and bets and the pot as they stood after each step, and why
// each pot went where it did.
//
// It is built from a `HandDetail`, which holds only what the viewer may see:
// their own cards and the hands shown at showdown. The replay adds nothing to
// that. It shows the viewer's cards throughout, as they held them, and every
// other hand only from the showdown step on.

import type {
	ActionKind,
	ActionRecord,
	Card,
	HandDetail,
	HandSeat,
	PotResult,
	Street
} from '../protocol-v2.ts';
import { nameHand } from './hand-name.ts';

const STREETS: readonly Street[] = ['pre-flop', 'flop', 'turn', 'river'];
/** Board cards on each street. */
const BOARD: Record<Street, number> = { 'pre-flop': 0, flop: 3, turn: 4, river: 5 };
const STREET_NAMES: Record<Street, string> = {
	'pre-flop': 'Pre-flop',
	flop: 'Flop',
	turn: 'Turn',
	river: 'River'
};
const RANKS: Record<number, string> = { 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const SUITS: Record<Card['suit'], string> = {
	spades: '♠',
	hearts: '♥',
	diamonds: '♦',
	clubs: '♣'
};
const VERBS: Record<ActionKind, string> = {
	fold: 'folds',
	check: 'checks',
	call: 'calls',
	bet: 'bets',
	raise: 'raises to'
};
const POSTS: Record<string, string> = {
	ante: 'an ante of',
	small_blind: 'the small blind,',
	big_blind: 'the big blind,'
};

/** “K♠”, “10♥”. */
export function shortCard(card: Card): string {
	return `${RANKS[card.rank] ?? String(card.rank)}${SUITS[card.suit]}`;
}

const chips = (amount: number): string => amount.toLocaleString('en-US');

/** “Ann”, “Ann and Bob”, “Ann, Bob and Cy”. */
function list(names: readonly string[]): string {
	if (names.length < 3) return names.join(' and ');
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export interface ReplaySeat {
	seat: number;
	name: string;
	kind: HandSeat['kind'];
	bot: string | null;
	you: boolean;
	/** The seat's hole cards once the viewer may see them at this step, else null. */
	cards: Card[] | null;
	/** Chips put in on the current street. */
	bet: number;
	/** Chips put in over the whole hand so far. */
	total: number;
	folded: boolean;
	allIn: boolean;
	/** Chips taken from the pots; set on the result step. */
	won: number;
	/** Chips won or lost in the hand; set on the result step. */
	net: number | null;
}

/** Why a pot went to its winners. */
export interface Award {
	/** “The pot”, “Main pot”, “Side pot”, “Side pot 2”. */
	label: string;
	amount: number;
	winners: { seat: number; name: string; share: number }[];
	/** The seats that could win it. */
	eligible: number[];
	/** One sentence: who won it, and with what or why. */
	text: string;
}

export type StepKind = 'posts' | 'action' | 'street' | 'showdown' | 'result';

export interface ReplayStep {
	kind: StepKind;
	street: Street;
	/** What happened at this step, as one line. */
	text: string;
	/** The board as it stood. */
	board: Card[];
	/** Every chip put in so far; on the result step, the chips the pots held. */
	pot: number;
	seats: ReplaySeat[];
	/** The seat that acted at this step. */
	acting: number | null;
	/** Chips the action put in. */
	amount: number | null;
	/** How each pot was awarded; on the result step. */
	awards: Award[];
}

function potLabel(index: number, count: number): string {
	if (count === 1) return 'The pot';
	if (index === 0) return 'Main pot';
	return count === 2 ? 'Side pot' : `Side pot ${index}`;
}

/** How a pot was awarded, from the stored result and the cards shown. */
function award(
	detail: HandDetail,
	pot: PotResult,
	index: number,
	nameOf: (seat: number) => string
): Award {
	const label = potLabel(index, detail.pots.length);
	// “the pot”, “the main pot”, “the side pot 2”.
	const lower = label === 'The pot' ? 'the pot' : `the ${label[0].toLowerCase()}${label.slice(1)}`;
	const winners = pot.winners.map((seat, i) => ({
		seat,
		name: nameOf(seat),
		share: pot.shares[i]
	}));
	const names = list(winners.map((w) => w.name));
	const of = `${lower} of ${chips(pot.amount)}`;
	let text: string;
	if (!detail.hand.showdown) {
		text = `${names} wins ${of}: everyone else folded.`;
	} else {
		const board = detail.hand.board;
		const hands = winners.map((w) => {
			const cards = detail.seats.find((s) => s.seat === w.seat)?.cards;
			return cards ? nameHand([...cards, ...board]).name : null;
		});
		const shown = hands.every((h): h is string => h !== null);
		const rivals = pot.eligible.filter((seat) => !pot.winners.includes(seat));
		if (winners.length > 1) {
			const same = shown && new Set(hands).size === 1;
			const how = same ? `, each with ${hands[0]}` : shown ? `, with ${list(hands)}` : '';
			text = `${names} split ${of}${how}: ${winners.map((w) => chips(w.share)).join(' and ')}.`;
		} else if (!rivals.length) {
			// Chips nobody else could win: a stack no other player covered.
			text = `${names} takes ${of}: no other player had chips in it.`;
		} else if (shown) {
			text = `${names} wins ${of} with ${hands[0]}.`;
		} else {
			text = `${names} wins ${of} at showdown.`;
		}
	}
	return { label, amount: pot.amount, winners, eligible: [...pot.eligible], text };
}

/** The steps of a finished hand, from the blinds to the result. */
export function buildReplay(detail: HandDetail): ReplayStep[] {
	const names = new Map(detail.seats.map((s) => [s.seat, s.name]));
	const nameOf = (seat: number) => names.get(seat) ?? `Seat ${seat + 1}`;
	const bet = new Map<number, number>();
	const total = new Map<number, number>();
	const folded = new Set<number>();
	const allIn = new Set<number>();
	let street: Street = 'pre-flop';
	let pot = 0;
	let revealed = false;
	const steps: ReplayStep[] = [];

	const put = (seat: number, amount: number, isAllIn: boolean) => {
		bet.set(seat, (bet.get(seat) ?? 0) + amount);
		total.set(seat, (total.get(seat) ?? 0) + amount);
		pot += amount;
		if (isAllIn) allIn.add(seat);
	};
	const seats = (final = false): ReplaySeat[] =>
		detail.seats.map((s) => ({
			seat: s.seat,
			name: s.name,
			kind: s.kind,
			bot: s.bot,
			you: s.you,
			cards: s.cards && (s.you || (revealed && s.shown)) ? s.cards : null,
			bet: bet.get(s.seat) ?? 0,
			total: total.get(s.seat) ?? 0,
			folded: folded.has(s.seat),
			allIn: allIn.has(s.seat),
			won: 0,
			net: final ? s.net : null
		}));
	const push = (
		kind: StepKind,
		text: string,
		acting: number | null = null,
		amount: number | null = null
	): ReplayStep => {
		const step: ReplayStep = {
			kind,
			street,
			text,
			board: detail.hand.board.slice(0, BOARD[street]),
			pot,
			seats: seats(kind === 'result'),
			acting,
			amount,
			awards: []
		};
		steps.push(step);
		return step;
	};
	/** Deal the streets up to `target`, one step each, as far as the board goes. */
	const dealTo = (target: Street) => {
		while (STREETS.indexOf(street) < STREETS.indexOf(target)) {
			const next = STREETS[STREETS.indexOf(street) + 1];
			if (detail.hand.board.length < BOARD[next]) return;
			const fresh = detail.hand.board.slice(BOARD[street], BOARD[next]);
			street = next;
			bet.clear();
			push('street', `${STREET_NAMES[street]}: ${fresh.map(shortCard).join(' ')}`);
		}
	};

	for (const post of detail.posts) put(post.seat, post.amount, post.all_in);
	push(
		'posts',
		detail.posts.length
			? `${list(detail.posts.map((post) => `${nameOf(post.seat)} posts ${POSTS[post.kind] ?? ''} ${chips(post.amount)}`))}.`
			: 'The hand begins.'
	);
	// Antes sit in the pot, not in front of the seat.
	for (const post of detail.posts) {
		if (post.kind === 'ante') bet.set(post.seat, (bet.get(post.seat) ?? 0) - post.amount);
	}

	for (const action of detail.actions) {
		dealTo(action.street);
		put(action.seat, action.added, action.all_in);
		if (action.action === 'fold') folded.add(action.seat);
		push('action', describeAction(action, nameOf(action.seat)), action.seat, action.added);
	}
	// Players all-in before the river: the rest of the board comes with no more betting.
	dealTo('river');

	if (detail.hand.showdown) {
		revealed = true;
		const shows = detail.seats
			.filter((s) => s.shown && s.cards)
			.map((s) => `${s.name} shows ${nameHand([...s.cards!, ...detail.hand.board]).name}`);
		push('showdown', shows.length ? `Showdown: ${list(shows)}.` : 'Showdown.');
	}

	const lines: string[] = [];
	if (detail.uncalled) {
		const { seat, amount } = detail.uncalled;
		pot -= amount;
		total.set(seat, (total.get(seat) ?? 0) - amount);
		lines.push(`${nameOf(seat)} takes back ${chips(amount)} that nobody called.`);
	}
	bet.clear();
	const awards = detail.pots.map((p, i) => award(detail, p, i, nameOf));
	const result = push('result', [...lines, ...awards.map((a) => a.text)].join(' '));
	result.awards = awards;
	for (const seat of result.seats) {
		seat.won = awards.reduce(
			(sum, a) => sum + (a.winners.find((w) => w.seat === seat.seat)?.share ?? 0),
			0
		);
	}
	return steps;
}

/** “Ann raises to 300 and is all-in”. A call names the chips it adds. */
export function describeAction(action: ActionRecord, who: string): string {
	const amount = action.action === 'call' ? action.added : action.to;
	const tail = action.action === 'fold' || action.action === 'check' ? '' : ` ${chips(amount)}`;
	return `${who} ${VERBS[action.action]}${tail}${action.all_in ? ' and is all-in' : ''}.`;
}

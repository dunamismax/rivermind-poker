// The iPhone app's display fixture (P5D.4): what the page computes only to show
// (hand names, bet sizes and button labels, the hand log's lines, the pots'
// lines, seat words, faces, replay steps and card names), written from the
// TypeScript for RiverMindKit's tests to match exactly (DisplayParityTests.swift).
// The cases are seeded: random card sets for every class of hand, and hands the
// engine plays from random stacks, read back as `HandDetail`s as a viewer gets
// them, so the replay sees every kind of step and pot.
//
// This test fails while the committed fixture is stale. `pnpm ios:fixtures`
// writes it again. A change to either side lands in both in the same commit.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluate } from '../../engine/evaluator.ts';
import {
	callLabel,
	clampAmount,
	describeEvent,
	potFraction,
	potLines,
	presets,
	raiseLabel
} from '../../nl/bet.ts';
import {
	avatarClass,
	botLabel,
	championLine,
	chipFor,
	personAvatar,
	podName,
	seatLabel,
	seatStatus,
	seatsNote,
	winRate
} from '../../nl/faces.ts';
import { HAND_CLASSES, nameHand } from '../../nl/hand-name.ts';
import { buildReplay, describeAction, shortCard, stageOf, stepForKey } from '../../nl/replay.ts';
import { REACTIONS, REPORT_REASONS, VOICE_REPORT_NOTE, relationText } from '../../nl/safety.ts';
import type * as p from '../../protocol-v2.ts';
import { cardName } from '../../wording.ts';
import {
	choice,
	randint,
	randomAction,
	randomConfig,
	randomStacks,
	uniform
} from '../engine/fuzz.ts';
import { handRecord } from '../engine/history.ts';
import { seededRandom, type Random } from '../engine/random.ts';
import {
	apply,
	isOver,
	legalActions,
	potTotal,
	startHand,
	type HandState
} from '../engine/state.ts';
import type { PlayedHand } from './hands.ts';
import { handDetail } from './views.ts';

const FIXTURE = new URL('../../../../../ios/RiverMindKit/Fixtures/display.json', import.meta.url);
const PROTOCOL = new URL('../../../../../ios/RiverMindKit/Fixtures/protocol.json', import.meta.url);

const SUITS: p.Suit[] = ['clubs', 'diamonds', 'hearts', 'spades'];
/** The engine's card number, rank * 4 + suit with clubs, diamonds, hearts, spades. */
const engineCard = (card: p.Card) => (card.rank - 2) * 4 + SUITS.indexOf(card.suit);
const protocolCard = (n: number): p.Card => ({ rank: (n >> 2) + 2, suit: SUITS[n & 3] });
const DECK: p.Card[] = Array.from({ length: 52 }, (_, n) => protocolCard(n));

function shuffled(rng: Random): p.Card[] {
	const deck = [...DECK];
	for (let i = deck.length - 1; i > 0; i--) {
		const j = rng.below(i + 1);
		[deck[i], deck[j]] = [deck[j], deck[i]];
	}
	return deck;
}

const parse = (text: string) =>
	text.split(' ').map((c): p.Card => {
		const rank = '23456789TJQKA'.indexOf(c[0]) + 2;
		return { rank, suit: SUITS['cdhs'.indexOf(c[1])] };
	});

// ---- Hand names, with the evaluator's value for five to seven cards.

/** Hands a random deal rarely makes, and the words with a rule of their own. */
const NAMED = [
	'As Ks Qs Js Ts',
	'Ah Kh Qh Jh Th 9h 2c',
	'5d 4d 3d 2d Ad',
	'5d 4d 3d 2d Ad 6d Kc',
	'9c 8c 7c 6c 5c 4c 3c',
	'8s 7s 6s 5s 4s',
	'Ac 2d 3h 4s 5c',
	'Ac 2d 3h 4s 5c 6d',
	'Ac Kd Qh Js Tc',
	'Ac Kd Qh Js Tc 9d 8h',
	'6c 6d 6h 6s 2c',
	'6c 6d 6h 6s Ac Ad Ah',
	'Ac Ad Ah Kc Kd Kh 2s',
	'8c 8d 8h 6c 6d 6h 6s',
	'8c 8d 8h 7c 7d 2s 2h',
	'6c 6d 2h 2s 9c 9d 4h',
	'Ac Kc 9c 7c 3c 2c 4d',
	'8c 6c 5c 4c 2c',
	'Ac Ad',
	'7c 2d',
	'8h 8d',
	'Ac Ad Kc',
	'Ac Kd Qh Js',
	'5c 4d 3h 2s',
	'Tc Td Th',
	'Tc 9d 8h 7s 6c 5d'
];

function handCases(rng: Random) {
	const cases: { cards: p.Card[]; class: string; name: string; value: number | null }[] = [];
	const add = (cards: p.Card[]) => {
		const named = nameHand(cards);
		cases.push({
			cards,
			class: named.class,
			name: named.name,
			value: cards.length >= 5 ? evaluate(cards.map(engineCard)) : null
		});
	};
	NAMED.forEach((text) => add(parse(text)));
	// Up to 30 of each class at each size from five to seven, and 20 at each smaller size.
	const kept = new Map<string, number>();
	for (let i = 0; i < 400_000; i++) {
		const size = 2 + rng.below(6);
		const cards = shuffled(rng).slice(0, size);
		const key = `${size} ${nameHand(cards).class}`;
		const room = size >= 5 ? 30 : 20;
		if ((kept.get(key) ?? 0) >= room) continue;
		kept.set(key, (kept.get(key) ?? 0) + 1);
		add(cards);
	}
	return cases;
}

// ---- Hands the engine plays, read back as a viewer's HandDetail.

const PEOPLE = ['Ann', 'Bob', 'Cy', 'Dee', 'Émile', '李雷', 'Zoë 7', 'Kai'];
const BOTS: [string, string][] = [
	['RiverMind Easy 2', 'heuristic'],
	['RiverMind Hard 1', 'hard'],
	['Calling bot 3', 'calling_station'],
	['Random bot 4', 'random']
];

interface Played {
	state: HandState;
	detail: p.HandDetail;
	/** Each decision on the way: the legal actions and the hand as the protocol sends them. */
	decisions: { legal: p.Legal; currentBet: number; pot: number }[];
}

function playHand(rng: Random, handNo: number): Played {
	const seats = 2 + rng.below(8);
	const config = randomConfig(rng);
	const stacks = randomStacks(seats, config, rng);
	const dealt = stacks.flatMap((stack, seat) => (stack ? [seat] : []));
	const button = choice(rng, dealt);
	let state = startHand(config, stacks, button, { rng });
	const decisions: Played['decisions'] = [];
	while (!isOver(state)) {
		const legal = legalActions(state);
		decisions.push({
			legal: {
				can_fold: legal.canFold,
				can_check: legal.canCheck,
				call: legal.call,
				raise_kind: legal.raiseKind,
				min_to: legal.minTo,
				max_to: legal.maxTo
			},
			currentBet: state.currentBet,
			pot: potTotal(state)
		});
		state = apply(state, randomAction(state, legal, rng));
	}
	const names = new Map<number, [string, string | null]>();
	for (const seat of dealt) {
		names.set(seat, uniform(rng) < 0.3 ? choice(rng, BOTS) : [choice(rng, PEOPLE), null]);
	}
	const played: PlayedHand = {
		handId: String(handNo),
		tableId: 't1',
		tableName: 'Test table',
		handNo,
		at: 1_700_000_000 + handNo,
		record: handRecord(state),
		seats: dealt.map((seat) => ({
			seat,
			playerId: `p${seat}`,
			name: names.get(seat)![0],
			bot: names.get(seat)![1],
			net: state.stacks[seat] - (stacks[seat] ?? 0)
		})),
		practice: false
	};
	const viewer = choice(rng, dealt);
	return { state, detail: handDetail(played, viewer), decisions };
}

/** What a hand shows a replay, so the kept hands cover every kind. */
function traits(detail: p.HandDetail): string[] {
	const found: string[] = [];
	found.push(detail.hand.showdown ? 'showdown' : 'fold-out');
	if (detail.posts.some((post) => post.kind === 'ante')) found.push('ante');
	if (detail.uncalled) found.push('uncalled');
	if (detail.pots.length === 2) found.push('side pot');
	if (detail.pots.length > 2) found.push('side pots');
	if (detail.pots.some((pot) => pot.winners.length > 1)) found.push('split');
	if (detail.pots.some((pot) => pot.eligible.length === 1)) found.push('uncovered');
	if (detail.posts.some((post) => post.all_in)) found.push('all-in post');
	const steps = buildReplay(detail);
	if (steps.some((step) => step.kind === 'tabled')) found.push('tabled');
	if (detail.hand.showdown && detail.seats.some((s) => !s.you && !s.shown && s.cards === null))
		found.push('mucked');
	if (detail.seats.length >= 7) found.push('seven or more seats');
	if (detail.seats.length === 2) found.push('heads-up');
	return found;
}

function playedHands(rng: Random) {
	const kept: Played[] = [];
	const counts = new Map<string, number>();
	for (let n = 1; n <= 20_000 && kept.length < 50; n++) {
		const hand = playHand(rng, n);
		const found = traits(hand.detail);
		// Every fifth hand is kept whatever it holds; the rest only for a trait still short.
		if (n % 10 !== 0 && !found.some((t) => (counts.get(t) ?? 0) < 4)) continue;
		for (const t of found) counts.set(t, (counts.get(t) ?? 0) + 1);
		kept.push(hand);
	}
	return { kept, counts };
}

// ---- Seats and events from the recorded sessions.

interface Recorded {
	views: p.TableView[];
}

function recorded(): Recorded {
	const document = JSON.parse(readFileSync(PROTOCOL, 'utf8')) as { server: p.ServerMessage[] };
	const views = document.server.flatMap((m) => (m.type === 'table' ? [m] : []));
	return { views: views.map((m) => m.view) };
}

const SEAT: p.SeatInfo = {
	seat: 0,
	name: 'Ann',
	kind: 'human',
	ref: 'r0',
	bot: null,
	stack: 1000,
	bet: 0,
	in_hand: true,
	folded: false,
	all_in: false,
	sitting_out: false,
	leaving: false,
	connected: true,
	has_cards: true,
	cards: null
};

function seatCases(views: p.TableView[]) {
	const infos: p.SeatInfo[] = [];
	for (const view of views) for (const seat of view.seats) if (seat) infos.push(seat);
	// Every combination of the flags a seat's word reads, for a person and a bot.
	for (let bits = 0; bits < 32; bits++) {
		for (const bot of [false, true]) {
			infos.push({
				...SEAT,
				seat: bits % 9,
				name: bot ? `RiverMind Easy ${bits % 9}` : `Player ${bits}`,
				kind: bot ? 'bot' : 'human',
				ref: bot ? null : `r${bits}`,
				bot: bot ? 'heuristic' : null,
				leaving: Boolean(bits & 1),
				sitting_out: Boolean(bits & 2),
				folded: Boolean(bits & 4),
				all_in: Boolean(bits & 8),
				connected: !(bits & 16)
			});
		}
	}
	const seen = new Set<string>();
	return infos
		.filter((info) => {
			const key = JSON.stringify(info);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.map((info) => ({
			info,
			status: seatStatus(info),
			label: seatLabel(info, false),
			mine: seatLabel(info, true),
			avatar: avatarClass(info)
		}));
}

/** Events of every kind the hand log names, beside those the sessions recorded. */
const EVENTS: Omit<p.TableEvent, 'seq'>[] = [
	{ kind: 'hand_started', seat: 4, hand_no: 7 },
	{ kind: 'hand_started', seat: 0, hand_no: 1234 },
	{ kind: 'action', seat: 2, action: 'raise', amount: 600, added: 500 },
	{ kind: 'action', seat: 1, action: 'call', amount: 600, added: 550 },
	{ kind: 'action', seat: 1, action: 'call', amount: 600, added: 550, all_in: true },
	{ kind: 'action', seat: 3, action: 'check', amount: 0, added: 0 },
	{ kind: 'action', seat: 3, action: 'fold', amount: 0, added: 0 },
	{ kind: 'action', seat: 0, action: 'bet', amount: 900, added: 900, all_in: true },
	{ kind: 'action', seat: 5, action: 'bet', amount: 12500, added: 12500, all_in: false },
	{ kind: 'board', street: 'flop', cards: parse('As Kd 7c') },
	{ kind: 'board', street: 'turn' },
	{ kind: 'board', street: 'river' },
	{ kind: 'timed_out', seat: 6 },
	{ kind: 'seated', seat: 2, name: 'Bob', amount: 2000 },
	{ kind: 'seated', seat: 2, amount: 2000 },
	{ kind: 'left', seat: 7 },
	{ kind: 'sat_out', seat: 1, reason: 'away' },
	{ kind: 'sat_out', seat: 1, reason: 'asked' },
	{ kind: 'sat_out', seat: 1 },
	{ kind: 'sat_in', seat: 1 },
	{ kind: 'rebought', seat: 3, amount: 1500 },
	{ kind: 'rebuy_dropped', seat: 1, amount: 900 },
	{ kind: 'disconnected', seat: 8 },
	{ kind: 'connected', seat: 8 },
	{ kind: 'reserved', seat: 3, name: 'Cy' },
	{ kind: 'reserved', seat: 3 },
	{ kind: 'reservation_ended', seat: 3, reason: 'expired' },
	{ kind: 'reservation_ended', seat: 3, reason: 'taken' },
	{ kind: 'turn', seat: 2 },
	{ kind: 'hand_ended' },
	{ kind: 'leaving', seat: 1 },
	{ kind: 'waitlist', count: 2 },
	{ kind: 'sitting_out_next', seat: 0 },
	{ kind: 'rebuy_pending', seat: 0, amount: 100 }
];

function eventCases(messages: p.TableMessage[]) {
	const cases: { event: p.TableEvent; names: (string | null)[]; text: string | null }[] = [];
	const nameOf = (names: (string | null)[]) => (seat: number) => names[seat] ?? `Seat ${seat + 1}`;
	const seen = new Set<string>();
	for (const message of messages) {
		const names = message.view.seats.map((s) => s?.name ?? null);
		for (const event of message.events) {
			const key = JSON.stringify([event, names]);
			if (seen.has(key)) continue;
			seen.add(key);
			cases.push({ event, names, text: describeEvent(event, nameOf(names)) });
		}
	}
	const names = [
		'Ann',
		'Bob',
		null,
		'RiverMind Easy 4',
		'Dee',
		'Émile',
		'Calling bot 2',
		null,
		'Kai'
	];
	EVENTS.forEach((event, i) => {
		const full = { seq: 1000 + i, ...event } as p.TableEvent;
		cases.push({ event: full, names, text: describeEvent(full, nameOf(names)) });
	});
	return cases;
}

function potCases(views: p.TableView[], hands: Played[]) {
	const cases: { result: p.HandResult; names: (string | null)[]; lines: string[] }[] = [];
	const line = (result: p.HandResult, names: (string | null)[]) =>
		cases.push({
			result,
			names,
			lines: potLines(result, (seat) => names[seat] ?? `Seat ${seat + 1}`)
		});
	const seen = new Set<string>();
	for (const view of views) {
		const result = view.hand?.result;
		if (!result) continue;
		const names = view.seats.map((s) => s?.name ?? null);
		const key = JSON.stringify([result, names]);
		if (seen.has(key)) continue;
		seen.add(key);
		line(result, names);
	}
	for (const { state, detail } of hands) {
		const names = state.startingStacks.map(
			(_, seat) => detail.seats.find((s) => s.seat === seat)?.name ?? null
		);
		const seats = state.startingStacks.length;
		line(
			{
				pots: detail.pots,
				uncalled: detail.uncalled,
				showdown: detail.hand.showdown,
				shown: detail.seats.filter((s) => s.shown).map((s) => s.seat),
				mucked: [],
				winnings: Array.from({ length: seats }, () => 0),
				net: Array.from({ length: seats }, () => 0)
			},
			names
		);
	}
	return cases;
}

// ---- Bets: presets, labels and clamping at the decisions of the played hands.

function betCases(hands: Played[], rng: Random) {
	const decisions = hands.flatMap((hand) => hand.decisions);
	const cases = [];
	for (let i = 0; i < decisions.length && cases.length < 400; i += 1 + rng.below(3)) {
		const { legal, currentBet, pot } = decisions[i];
		const hand = { current_bet: currentBet, pot } as p.HandInfo;
		const mid = Math.floor((legal.min_to + legal.max_to) / 2);
		const amounts = [
			-5,
			0,
			legal.min_to - 1,
			legal.min_to,
			mid + 0.7,
			legal.max_to,
			legal.max_to + 100,
			1e12,
			randint(rng, 0, legal.max_to * 2 + 10) + uniform(rng)
		];
		cases.push({
			legal,
			currentBet,
			pot,
			presets: presets(legal, hand),
			call: callLabel(legal),
			fractions: [0.5, 0.75, 1, 1 / 3].map((f) => ({
				fraction: f,
				to: potFraction(f, legal, hand)
			})),
			raises: [legal.min_to, mid, legal.max_to - 1, legal.max_to].map((amount) => ({
				amount,
				label: raiseLabel(legal, amount)
			})),
			clamps: amounts.map((amount) => ({ amount, to: clampAmount(amount, legal) }))
		});
	}
	return cases;
}

// ---- Faces and bots.

const CHAMPION: p.BotChampion = {
	name: 'hu-m1-s0-1024m',
	promoted: '2026-11-21',
	iterations: 1_024_000_000,
	stack_bb: 100,
	results: [
		{
			opponent: 'champion',
			label: 'hu-m1-s0-512m',
			hands: 200_000,
			bb_per_100: 1.25,
			ci95: [-0.05, 2.55]
		},
		{
			opponent: 'heuristic',
			label: 'RiverMind Easy',
			hands: 1_000_000,
			bb_per_100: 45.678,
			ci95: [43.25, 48.15]
		}
	]
};

function faceCases(rng: Random) {
	const rates = [
		0, -0, 0.25, -0.25, 0.05, -0.05, 0.15, 1.45, 2.675, 12.35, -3.25, 100.95, 1e-9, -1e-9, 0.95,
		-0.95, 99.95, 1234.5678, 45.678, -0.04999
	];
	for (let i = 0; i < 60; i++) rates.push(Math.round((uniform(rng) * 400 - 200) * 1000) / 1000);
	for (let i = 0; i < 20; i++) rates.push(uniform(rng) * 20 - 10);
	const champions: p.BotChampion[] = [
		CHAMPION,
		{ ...CHAMPION, results: [CHAMPION.results[0]] },
		{ ...CHAMPION, results: [] },
		{
			...CHAMPION,
			name: '6max-s1-s0-3600m',
			seats: [3, 4, 5, 6],
			results: [
				{
					opponent: 'heuristic',
					label: 'RiverMind Easy',
					hands: 12_345,
					bb_per_100: -2.5,
					ci95: [-9.95, 4.95]
				}
			]
		}
	];
	const seatLists = [
		[2],
		[6],
		[9],
		[2, 3, 4, 5, 6],
		[3, 4, 5, 6],
		[7, 8, 9],
		[2, 6, 9],
		[2, 4],
		[2, 3]
	];
	const kinds = [
		null,
		'',
		'heuristic',
		'medium',
		'hard',
		'random',
		'calling_station',
		'new_kind',
		'deep_blue_2',
		'x'
	];
	const names = [
		'RiverMind Easy 4',
		'RiverMind Hard 1',
		'RiverMind Medium 12',
		'Calling bot 2',
		'Random bot 9',
		'RiverMind',
		'RiverMind ',
		'RiverMind bot',
		'RiverMind 3',
		'bot',
		' bot',
		'Ann',
		'Ann 12',
		'Ann bot',
		'Ann bot 2 bot',
		'a 12 3',
		'Zoë 7',
		'李雷',
		'Émile bot 3',
		'7',
		' 3',
		'x'
	];
	const people = [
		'Ann',
		'Bob',
		'Émile',
		'李雷',
		'Zoë',
		'🂡 King',
		'a',
		'',
		'RiverMind fan',
		'Player 1234'
	];
	for (let i = 0; i < 30; i++) people.push(`Guest ${rng.below(100_000)}`);
	const amounts = [
		0, 1, 49, 50, 99, 100, 101, 299, 300, 999, 1000, 2499, 2500, 5999, 6000, 100_000
	];
	return {
		winRates: rates.map((value) => ({ value, text: winRate(value) })),
		championLines: champions.map((champion) => ({ champion, text: championLine(champion) })),
		seatsNotes: seatLists.map((seats) => ({ seats, text: seatsNote(seats) })),
		botLabels: kinds.map((kind) => ({ kind, text: botLabel(kind) })),
		podNames: names.map((name) => ({ name, parts: podName(name) })),
		personAvatars: people.map((name) => ({ name, avatar: personAvatar(name) })),
		chips: [100, 2, 1, 0, 50].flatMap((big) =>
			amounts.map((amount) => ({ amount, big, chip: chipFor(amount, big) }))
		)
	};
}

// ---- The fixture.

describe('the iPhone app display fixture', () => {
	it('holds what the page shows for seeded cases of every kind', () => {
		const rng = seededRandom(20261127);
		const hands = handCases(rng);
		const classes = new Set(hands.map((h) => h.class));
		expect([...classes].sort()).toEqual([...HAND_CLASSES].sort());

		const { kept, counts } = playedHands(seededRandom(5_400_004));
		for (const trait of [
			'showdown',
			'fold-out',
			'ante',
			'uncalled',
			'side pot',
			'side pots',
			'split',
			'uncovered',
			'all-in post',
			'tabled',
			'mucked',
			'seven or more seats',
			'heads-up'
		]) {
			expect(counts.get(trait) ?? 0, `played hands with ${trait}`).toBeGreaterThanOrEqual(2);
		}
		const replays = kept.map(({ detail }) => {
			const steps = buildReplay(detail);
			return { detail, steps, stages: steps.map(stageOf) };
		});
		const actions = kept
			.flatMap(({ detail }) => detail.actions)
			.filter((_, i) => i % 3 === 0)
			.map((action) => ({ action, text: describeAction(action, 'Ann') }));

		const { views } = recorded();
		const messages = (
			JSON.parse(readFileSync(PROTOCOL, 'utf8')) as { server: p.ServerMessage[] }
		).server.flatMap((m) => (m.type === 'table' ? [m] : []));

		const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'ArrowUp', 'Enter', ' ', 'a'];
		const document = {
			note: 'Written by web/src/lib/server/api/ios-display.spec.ts (pnpm ios:fixtures) from the page’s display code. Do not edit.',
			hands,
			bets: betCases(kept, seededRandom(77)),
			events: eventCases(messages),
			pots: potCases(views, kept),
			seats: seatCases(views),
			faces: faceCases(seededRandom(31)),
			replays,
			actions,
			stepKeys: keys.flatMap((key) =>
				[
					[0, 5],
					[2, 5],
					[4, 5],
					[0, 1]
				].map(([index, count]) => ({ key, index, count, to: stepForKey(key, index, count) }))
			),
			cards: DECK.map((card) => ({ card, name: cardName(card), short: shortCard(card) })),
			safety: {
				reactions: REACTIONS,
				reportReasons: REPORT_REASONS,
				voiceReportNote: VOICE_REPORT_NOTE,
				relations: (['block', 'mute', null] as const).map((kind) => ({
					kind,
					text: relationText(kind)
				}))
			}
		};
		const list = (items: readonly unknown[]) =>
			items.length ? `[\n${items.map((i) => JSON.stringify(i)).join(',\n')}\n]` : '[]';
		const text =
			'{\n' +
			Object.entries(document)
				.map(([key, value]) =>
					Array.isArray(value)
						? `${JSON.stringify(key)}:${list(value)}`
						: `${JSON.stringify(key)}:${JSON.stringify(value)}`
				)
				.join(',\n') +
			'}\n';

		if (process.env.IOS_FIXTURES === 'write') writeFileSync(FIXTURE, text);
		let committed = '';
		try {
			committed = readFileSync(FIXTURE, 'utf8');
		} catch {
			// missing: fails below
		}
		expect(committed === text, 'the iOS display fixture is stale: run pnpm ios:fixtures').toBe(
			true
		);
	});
});

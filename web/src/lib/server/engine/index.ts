// No-limit Texas hold'em engine for 2 to 9 seats (docs/rules.md), ported from
// the Python reference in rivermind/engine (P4B.4). The engine is pure: states
// are immutable, there is no global mutable state, and randomness comes only
// from the caller. Cards and the evaluator are browser-safe and live in
// $lib/engine.

export { buildDeck, card, cardStr, cards, cardsStr, pretty } from '../../engine/cards.ts';
export { describe, evaluate, rankClass } from '../../engine/evaluator.ts';
export type { Pot } from './pots.ts';
export { cryptoRandom, seededRandom, shuffle, type Random } from './random.ts';
export { blindSeats, dealOrder, initialButton, nextButton, seatsDealtIn } from './seating.ts';
export * from './state.ts';
export { opponents, seatView, stackOf, streetActions, toCall, type SeatView } from './view.ts';

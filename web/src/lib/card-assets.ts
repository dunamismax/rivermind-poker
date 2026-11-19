import type { Card } from './protocol.ts';

export const CARD_TREATMENTS = ['standard', 'four-colour'] as const;
export const CARD_BACKS = ['rivermind', 'current', 'lattice'] as const;
export const CARD_RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;

export type CardTreatment = (typeof CARD_TREATMENTS)[number];
export type CardBack = (typeof CARD_BACKS)[number];

export function cardFacePath({ rank, suit }: Card, treatment: CardTreatment = 'standard') {
	// The server protocol validates rank as an integer from 2 through 14.
	const cardRank = rank as (typeof CARD_RANKS)[number];
	// Hearts and spades use the same inks in both treatments.
	if (treatment === 'four-colour' && (suit === 'clubs' || suit === 'diamonds')) {
		return `cards/four-colour/${cardRank}-${suit}.svg` as const;
	}
	return `cards/standard/${cardRank}-${suit}.svg` as const;
}

export function cardBackPath(back: CardBack = 'rivermind') {
	return `cards/backs/${back}.svg` as const;
}

// The pixel card art (src/lib/art/cards/, drawn by `pnpm art`). Vite gives
// every file a content-hashed URL, so the cards cache as immutable.
import type { Card } from './protocol.ts';

export const CARD_TREATMENTS = ['standard', 'four-colour'] as const;
export const CARD_BACKS = ['rivermind', 'current', 'lattice'] as const;
export const CARD_RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;
/** A card's size in art pixels; the page draws it at a whole multiple. */
export const CARD_SIZE = { width: 33, height: 45 } as const;

export type CardTreatment = (typeof CARD_TREATMENTS)[number];
export type CardBack = (typeof CARD_BACKS)[number];

const files = import.meta.glob<string>('./art/cards/**/*.png', {
	eager: true,
	query: '?url',
	import: 'default'
});

function url(path: string): string {
	const found = files[`./art/cards/${path}`];
	if (!found) throw new Error(`no card art at ${path}`);
	return found;
}

export function cardFacePath({ rank, suit }: Card, treatment: CardTreatment = 'standard'): string {
	// Hearts and spades use the same inks in both treatments.
	if (treatment === 'four-colour' && (suit === 'clubs' || suit === 'diamonds')) {
		return url(`four-colour/${rank}-${suit}.png`);
	}
	return url(`standard/${rank}-${suit}.png`);
}

export function cardBackPath(back: CardBack = 'rivermind'): string {
	return url(`backs/${back}.png`);
}

export const CARD_SLOT = url('slot.png');

/** Every card image, to fetch ahead of the first deal. */
export function allCardUrls(): string[] {
	return Object.values(files);
}

// The card art: the deck in src/lib/art/cards/, drawn by scripts/art/deck.js
// (P5C.3) through `pnpm art`. Vite gives every file a content-hashed URL, so the
// cards cache as immutable.
import type { Card } from './protocol.ts';

/** The backs, by the names of their files; the first is the site's default: FeltPrep's lattice in three colours. */
export const CARD_BACKS = ['lattice-burgundy', 'lattice-navy', 'lattice-green'] as const;
export const CARD_RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;
/** A card's box in card units; the page draws it at a whole number of device pixels per unit. */
export const CARD_SIZE = { width: 71, height: 95 } as const;

export type CardBack = (typeof CARD_BACKS)[number];
export const DEFAULT_BACK: CardBack = CARD_BACKS[0];

const DIR = './art/cards';
const files = import.meta.glob<string>('./art/cards/**/*.svg', {
	eager: true,
	query: '?url',
	import: 'default'
});

function url(name: string): string {
	const found = files[`${DIR}/${name}.svg`];
	if (!found) throw new Error(`no card art at ${name}`);
	return found;
}

export function cardFacePath({ rank, suit }: Card): string {
	return url(`faces/${rank}-${suit}`);
}

/** A back of the deck; none gives the default. */
export function cardBackPath(back: CardBack = DEFAULT_BACK): string {
	return url(`backs/${back}`);
}

export const CARD_SLOT = url('slot');

/** Every image a table can show with this back, to fetch ahead of the first deal. */
export function tableCardUrls(back?: CardBack): string[] {
	return Object.entries(files)
		.filter(([path]) => !path.includes('/backs/'))
		.map(([, href]) => href)
		.concat(cardBackPath(back));
}

/** Every card image of the deck, faces, backs and the slot. */
export function allCardUrls(): string[] {
	return Object.values(files);
}

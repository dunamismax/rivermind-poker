// The card art (src/lib/art/cards/, made by `pnpm art` from the sprites in
// web/art/cards/). Vite gives every file a content-hashed URL, so the cards
// cache as immutable.
import type { Card } from './protocol.ts';

/** The backs, by the names of their files; the first is the site's default. */
export const CARD_BACKS = [
	'classic-red',
	'classic-blue',
	'classic-green',
	'classic-amber',
	'classic-slate',
	'classic-dusk',
	'parchment',
	'argyle',
	'confetti',
	'maze',
	'tracks',
	'moons',
	'nebula',
	'marble-rose',
	'contour-blue',
	'contour-rainbow',
	'swirl-violet',
	'shapes'
] as const;
export const CARD_RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as const;
/** A card's size in art pixels; the page draws it at a whole number of device pixels per art pixel. */
export const CARD_SIZE = { width: 71, height: 95 } as const;

export type CardBack = (typeof CARD_BACKS)[number];
export const DEFAULT_BACK: CardBack = CARD_BACKS[0];

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

export function cardFacePath({ rank, suit }: Card): string {
	return url(`faces/${rank}-${suit}.png`);
}

export function cardBackPath(back: CardBack = DEFAULT_BACK): string {
	return url(`backs/${back}.png`);
}

export const CARD_SLOT = url('slot.png');

/** Every image a table can show with this back, to fetch ahead of the first deal. */
export function tableCardUrls(back: CardBack = DEFAULT_BACK): string[] {
	return Object.entries(files)
		.filter(([path]) => !path.includes('/backs/'))
		.map(([, href]) => href)
		.concat(cardBackPath(back));
}

/** Every card image, faces, backs and the slot. */
export function allCardUrls(): string[] {
	return Object.values(files);
}

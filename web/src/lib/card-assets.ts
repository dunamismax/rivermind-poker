// The card art, one deck for each look (Phase 5C): the pixel deck in
// src/lib/art/cards/, made by `pnpm art` from the sprites in web/art/cards/, and
// the clean deck in src/lib/art/clean/cards/, drawn by scripts/clean-art/deck.js
// (P5C.3). Vite gives every file a content-hashed URL, so the cards cache as
// immutable.
import type { Look } from './look.ts';
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

/** The clean deck's backs (P5C.3), the default first: FeltPrep's lattice in three colours. */
export const CLEAN_CARD_BACKS = ['lattice-burgundy', 'lattice-navy', 'lattice-green'] as const;
export type CleanCardBack = (typeof CLEAN_CARD_BACKS)[number];
export const DEFAULT_CLEAN_BACK: CleanCardBack = CLEAN_CARD_BACKS[0];

const pixelFiles = import.meta.glob<string>('./art/cards/**/*.png', {
	eager: true,
	query: '?url',
	import: 'default'
});
const cleanFiles = import.meta.glob<string>('./art/clean/cards/**/*.svg', {
	eager: true,
	query: '?url',
	import: 'default'
});
const DECKS: Record<Look, { dir: string; ext: string; files: Record<string, string> }> = {
	pixel: { dir: './art/cards', ext: 'png', files: pixelFiles },
	clean: { dir: './art/clean/cards', ext: 'svg', files: cleanFiles }
};

function url(look: Look, name: string): string {
	const { dir, ext, files } = DECKS[look];
	const found = files[`${dir}/${name}.${ext}`];
	if (!found) throw new Error(`no ${look} card art at ${name}`);
	return found;
}

function isCleanBack(back: string | undefined): back is CleanCardBack {
	return (CLEAN_CARD_BACKS as readonly string[]).includes(back ?? '');
}

export function cardFacePath({ rank, suit }: Card, look: Look = 'pixel'): string {
	return url(look, `faces/${rank}-${suit}`);
}

/**
 * A back of this look's deck. A back of the other deck's (or none) gives the
 * look's default, so a table asking for a pixel back still draws in the clean look.
 */
export function cardBackPath(back?: CardBack | CleanCardBack, look: Look = 'pixel'): string {
	if (look === 'clean') return url(look, `backs/${isCleanBack(back) ? back : DEFAULT_CLEAN_BACK}`);
	return url(look, `backs/${back && !isCleanBack(back) ? back : DEFAULT_BACK}`);
}

export function cardSlotPath(look: Look = 'pixel'): string {
	return url(look, 'slot');
}

export const CARD_SLOT = cardSlotPath();

/** Every image a table can show in this look with this back, to fetch ahead of the first deal. */
export function tableCardUrls(back?: CardBack | CleanCardBack, look: Look = 'pixel'): string[] {
	return Object.entries(DECKS[look].files)
		.filter(([path]) => !path.includes('/backs/'))
		.map(([, href]) => href)
		.concat(cardBackPath(back, look));
}

/** Every card image of a look's deck, faces, backs and the slot. */
export function allCardUrls(look: Look = 'pixel'): string[] {
	return Object.values(DECKS[look].files);
}

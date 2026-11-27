// The site's look (Phase 5C, D-18): `clean`, drawn without pixel art, or `pixel`,
// the pixel-art kit. Both share every page, component and behaviour; a look is a
// stylesheet, a set of art and a deck, chosen by `data-look` on <html>. The choice
// is kept in this browser alone, and a browser that cannot keep it gets the default.

export const LOOKS = ['clean', 'pixel'] as const;
export type Look = (typeof LOOKS)[number];

/** What a browser with no choice of its own gets: clean since P5C.7. A browser that chose pixel keeps it. */
export const DEFAULT_LOOK: Look = 'clean';

/** Where the choice is kept. */
export const LOOK_KEY = 'rivermind.look';

/** The names the switch shows. */
export const LOOK_NAMES: Readonly<Record<Look, string>> = { clean: 'Clean', pixel: 'Pixel' };

export function isLook(value: unknown): value is Look {
	return typeof value === 'string' && (LOOKS as readonly string[]).includes(value);
}

/** This page's storage, or null where there is none or it may not be touched. */
export function pageStorage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

/** The kept look, or the default when there is none, it is not a look or storage throws. */
export function readLook(storage: Pick<Storage, 'getItem'> | null): Look {
	try {
		const kept = storage?.getItem(LOOK_KEY);
		return isLook(kept) ? kept : DEFAULT_LOOK;
	} catch {
		return DEFAULT_LOOK;
	}
}

/** Keep a look; false when the storage would not take it, and the choice then lasts for this page. */
export function writeLook(storage: Pick<Storage, 'setItem'> | null, look: Look): boolean {
	if (!storage) return false;
	try {
		storage.setItem(LOOK_KEY, look);
		return true;
	} catch {
		return false;
	}
}

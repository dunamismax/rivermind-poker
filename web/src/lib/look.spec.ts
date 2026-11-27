import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOK, LOOK_KEY, LOOKS, isLook, look, readLook, writeLook } from './look.svelte.ts';

/** A storage that holds what it is given, like localStorage. */
function memory(initial: Record<string, string> = {}) {
	const kept = new Map(Object.entries(initial));
	return {
		kept,
		getItem: (key: string) => kept.get(key) ?? null,
		setItem: (key: string, value: string) => void kept.set(key, value)
	};
}

/** A storage that throws on every call, as a browser that blocks site data does. */
const blocked = {
	getItem(): string | null {
		throw new DOMException('blocked', 'SecurityError');
	},
	setItem(): void {
		throw new DOMException('full', 'QuotaExceededError');
	}
};

/** Just enough of <html> for the look to set its attribute on. */
function root() {
	return { dataset: {} as Record<string, string> } as unknown as HTMLElement;
}

describe('the look', () => {
	it('has two looks and a default among them', () => {
		expect(LOOKS).toEqual(['clean', 'pixel']);
		expect(LOOKS).toContain(DEFAULT_LOOK);
		// The clean look is the default since P5C.7 (D-18).
		expect(DEFAULT_LOOK).toBe('clean');
	});

	it('knows a look from anything else', () => {
		expect(isLook('clean')).toBe(true);
		expect(isLook('pixel')).toBe(true);
		for (const other of ['Clean', '', 'dark', null, undefined, 1, {}])
			expect(isLook(other)).toBe(false);
	});

	it('keeps a browser that chose pixel in pixel, now that clean is the default', () => {
		const page = root();
		expect(look.start(page, memory({ [LOOK_KEY]: 'pixel' }))).toBe('pixel');
		expect(page.dataset.look).toBe('pixel');
	});

	it('reads the kept look', () => {
		expect(readLook(memory({ [LOOK_KEY]: 'clean' }))).toBe('clean');
		expect(readLook(memory({ [LOOK_KEY]: 'pixel' }))).toBe('pixel');
	});

	it('falls back to the default for nothing kept, a stranger value, no storage or storage that throws', () => {
		expect(readLook(memory())).toBe(DEFAULT_LOOK);
		expect(readLook(memory({ [LOOK_KEY]: 'neon' }))).toBe(DEFAULT_LOOK);
		expect(readLook(null)).toBe(DEFAULT_LOOK);
		expect(readLook(blocked)).toBe(DEFAULT_LOOK);
	});

	it('keeps a look, and says when it could not', () => {
		const storage = memory();
		expect(writeLook(storage, 'clean')).toBe(true);
		expect(storage.kept.get(LOOK_KEY)).toBe('clean');
		expect(writeLook(null, 'clean')).toBe(false);
		expect(writeLook(blocked, 'clean')).toBe(false);
	});

	it('applies the kept look to the page when it starts, and a new one when it is set', () => {
		const page = root();
		const storage = memory({ [LOOK_KEY]: 'clean' });
		expect(look.start(page, storage)).toBe('clean');
		expect(page.dataset.look).toBe('clean');
		expect(look.current).toBe('clean');

		look.set('pixel');
		expect(page.dataset.look).toBe('pixel');
		expect(look.current).toBe('pixel');
		expect(storage.kept.get(LOOK_KEY)).toBe('pixel');
	});

	it('still switches for this page when storage will not keep the choice', () => {
		const page = root();
		expect(look.start(page, blocked)).toBe(DEFAULT_LOOK);
		look.set('pixel');
		expect(page.dataset.look).toBe('pixel');
		expect(look.current).toBe('pixel');
	});

	it('ignores something that is not a look', () => {
		const page = root();
		look.start(page, memory({ [LOOK_KEY]: 'clean' }));
		look.set('neon' as never);
		expect(page.dataset.look).toBe('clean');
	});
});

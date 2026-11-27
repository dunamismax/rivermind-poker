// The look this page shows (Phase 5C): the choice in look.ts, held as state
// so the switch and the deck follow it, and applied to <html> as `data-look`.
import { DEFAULT_LOOK, isLook, pageStorage, readLook, writeLook, type Look } from './look.ts';

export * from './look.ts';

/** The look this page shows, applied to <html> as `data-look`. */
class PageLook {
	current = $state<Look>(DEFAULT_LOOK);
	#root: HTMLElement | null = null;
	#storage: Pick<Storage, 'getItem' | 'setItem'> | null = null;

	/** Read the kept look and apply it. Called once, before the first render. */
	start(
		root: HTMLElement = document.documentElement,
		storage: Pick<Storage, 'getItem' | 'setItem'> | null = pageStorage()
	): Look {
		this.#root = root;
		this.#storage = storage;
		this.current = readLook(storage);
		root.dataset.look = this.current;
		return this.current;
	}

	/** Show another look at once, and keep it. */
	set(look: Look): void {
		if (!isLook(look)) return;
		this.current = look;
		if (this.#root) this.#root.dataset.look = look;
		writeLook(this.#storage, look);
	}
}

export const look = new PageLook();

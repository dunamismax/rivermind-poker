// What a browser keeps of a person's table voice choices (P4C.6).
import { describe, expect, it } from 'vitest';
import {
	DEFAULTS,
	MAX_PEOPLE,
	STORAGE_KEY,
	clampVolume,
	firstStep,
	loadSettings,
	parseSettings,
	saveSettings,
	serializeSettings,
	withEntry
} from './settings.ts';

class Memory implements Storage {
	#items = new Map<string, string>();
	refuse = false;
	get length() {
		return this.#items.size;
	}
	clear() {
		this.#items.clear();
	}
	getItem(key: string) {
		if (this.refuse) throw new DOMException('denied', 'SecurityError');
		return this.#items.get(key) ?? null;
	}
	key(index: number) {
		return [...this.#items.keys()][index] ?? null;
	}
	removeItem(key: string) {
		this.#items.delete(key);
	}
	setItem(key: string, value: string) {
		if (this.refuse) throw new DOMException('full', 'QuotaExceededError');
		this.#items.set(key, value);
	}
}

describe('voice settings', () => {
	it('start at the defaults, asking on the first table', () => {
		expect(parseSettings(null)).toEqual(DEFAULTS);
		expect(firstStep(parseSettings(null))).toBe('ask');
		expect(DEFAULTS).toMatchObject({
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: true,
			denoise: true,
			spatial: true,
			bitrate: 64000,
			pushToTalk: false
		});
	});

	it('remember a choice, unless the person asked to be asked each time', () => {
		const storage = new Memory();
		saveSettings(storage, { ...DEFAULTS, choice: 'listen' });
		expect(firstStep(loadSettings(storage))).toBe('listen');
		saveSettings(storage, { ...DEFAULTS, choice: 'join', ask: true });
		expect(firstStep(loadSettings(storage))).toBe('ask');
		saveSettings(storage, { ...DEFAULTS, choice: 'not-now' });
		expect(firstStep(loadSettings(storage))).toBe('not-now');
		expect(JSON.parse(storage.getItem(STORAGE_KEY)!).choice).toBe('not-now');
	});

	it('keep what is well formed and drop the rest', () => {
		const stored = JSON.stringify({
			choice: 'shout',
			ask: 'yes',
			pushToTalk: true,
			input: 'mic-1',
			output: 7,
			bitrate: 128000,
			spatial: false,
			volumes: { alice: 1.5, bob: 9, carol: -1, dave: 'loud', [''.padEnd(65, 'x')]: 1 },
			mutes: { alice: true, bob: 'no' }
		});
		expect(parseSettings(stored)).toEqual({
			...DEFAULTS,
			pushToTalk: true,
			input: 'mic-1',
			spatial: false,
			volumes: { alice: 1.5, bob: 2, carol: 0 },
			mutes: { alice: true }
		});
		expect(parseSettings('not json')).toEqual(DEFAULTS);
		expect(parseSettings('[1,2]')).toEqual(DEFAULTS);
	});

	it('clamp volumes to 0 to 200%', () => {
		expect([clampVolume(-1), clampVolume(0.333), clampVolume(3), clampVolume(NaN)]).toEqual([
			0, 0.33, 2, 1
		]);
	});

	it('keep the newest players when there are too many', () => {
		let mutes: Record<string, boolean> = {};
		for (let at = 0; at < MAX_PEOPLE + 10; at += 1) mutes = withEntry(mutes, `p${at}`, true);
		mutes = withEntry(mutes, 'p0', false);
		const kept = parseSettings(serializeSettings({ ...DEFAULTS, mutes })).mutes;
		expect(Object.keys(kept)).toHaveLength(MAX_PEOPLE);
		expect(kept.p0).toBe(false);
		expect(kept.p5).toBeUndefined();
		expect(kept[`p${MAX_PEOPLE + 9}`]).toBe(true);
	});

	it('work without storage, or with storage that refuses', () => {
		const storage = new Memory();
		storage.refuse = true;
		expect(() => saveSettings(storage, DEFAULTS)).not.toThrow();
		expect(loadSettings(storage)).toEqual(DEFAULTS);
		expect(loadSettings(null)).toEqual(DEFAULTS);
	});
});

// What a person chose about table voice, kept in this browser (P4C.6): what to
// do on sitting down at a table with someone else, how they talk, the
// microphone's processing, and the mute and volume they gave each player.
// Nothing here leaves the browser.
//
// Storage may be missing or refuse (a private window, blocked site data), so
// every read and write is guarded and a person without it gets the defaults.

// The bitrates a person may choose (docs/voice.md): a saver, the default and a high one.
export const BITRATES = [32000, 64000, 96000] as const;
export type Bitrate = (typeof BITRATES)[number];

// What the voice card's buttons chose: talk, listen only, or stay out.
export type VoiceChoice = 'join' | 'listen' | 'not-now';

export type VoiceSettings = {
	// The last choice made on the card, which the next table makes without
	// asking; null until the first. With `ask`, the card always asks.
	choice: VoiceChoice | null;
	ask: boolean;
	// Hold a key (V) or a button to talk, instead of an open microphone.
	pushToTalk: boolean;
	// The microphone and the speakers by device id; null for the default.
	input: string | null;
	output: string | null;
	// The browser's own processing of the microphone.
	echoCancellation: boolean;
	noiseSuppression: boolean;
	autoGainControl: boolean;
	// RNNoise on top of it (Q-11).
	denoise: boolean;
	bitrate: Bitrate;
	// Each voice from its seat's side of the table.
	spatial: boolean;
	// By public reference: a volume from 0 to 2, and a mute of this person's
	// own, which wins over the one a P4.5 mute gives.
	volumes: Record<string, number>;
	mutes: Record<string, boolean>;
};

export const DEFAULTS: VoiceSettings = {
	choice: null,
	ask: false,
	pushToTalk: false,
	input: null,
	output: null,
	echoCancellation: true,
	noiseSuppression: true,
	autoGainControl: true,
	denoise: true,
	bitrate: 64000,
	spatial: true,
	volumes: {},
	mutes: {}
};

export const STORAGE_KEY = 'rivermind.voice';
// A browser keeps this many players' volumes and mutes, the latest first.
export const MAX_PEOPLE = 200;

const CHOICES: readonly VoiceChoice[] = ['join', 'listen', 'not-now'];
const FLAGS = [
	'ask',
	'pushToTalk',
	'echoCancellation',
	'noiseSuppression',
	'autoGainControl',
	'denoise',
	'spatial'
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isRef = (key: string) => key.length > 0 && key.length <= 64;
const device = (value: unknown) =>
	typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;

export const clampVolume = (volume: number): number =>
	Number.isFinite(volume) ? Math.min(2, Math.max(0, Math.round(volume * 100) / 100)) : 1;

// Settings as stored, with anything missing or malformed at its default.
export function parseSettings(text: string | null): VoiceSettings {
	const settings: VoiceSettings = { ...DEFAULTS, volumes: {}, mutes: {} };
	if (text === null) return settings;
	let stored: unknown;
	try {
		stored = JSON.parse(text);
	} catch {
		return settings;
	}
	if (!isRecord(stored)) return settings;
	if (CHOICES.includes(stored.choice as VoiceChoice))
		settings.choice = stored.choice as VoiceChoice;
	for (const flag of FLAGS) {
		if (typeof stored[flag] === 'boolean') settings[flag] = stored[flag];
	}
	settings.input = device(stored.input);
	settings.output = device(stored.output);
	if (BITRATES.includes(stored.bitrate as Bitrate)) settings.bitrate = stored.bitrate as Bitrate;
	if (isRecord(stored.volumes)) {
		for (const [ref, volume] of Object.entries(stored.volumes)) {
			if (isRef(ref) && typeof volume === 'number') settings.volumes[ref] = clampVolume(volume);
		}
	}
	if (isRecord(stored.mutes)) {
		for (const [ref, muted] of Object.entries(stored.mutes)) {
			if (isRef(ref) && typeof muted === 'boolean') settings.mutes[ref] = muted;
		}
	}
	return settings;
}

// Keep the newest `MAX_PEOPLE` entries of a per-player map.
function newest<T>(map: Record<string, T>): Record<string, T> {
	const entries = Object.entries(map);
	return Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_PEOPLE)));
}

export function serializeSettings(settings: VoiceSettings): string {
	return JSON.stringify({
		...settings,
		volumes: newest(settings.volumes),
		mutes: newest(settings.mutes)
	});
}

export function loadSettings(storage: Storage | null): VoiceSettings {
	try {
		return parseSettings(storage?.getItem(STORAGE_KEY) ?? null);
	} catch {
		return parseSettings(null);
	}
}

export function saveSettings(storage: Storage | null, settings: VoiceSettings): void {
	try {
		storage?.setItem(STORAGE_KEY, serializeSettings(settings));
	} catch {
		// The choices last as long as the page does.
	}
}

// Whether to show the voice card on sitting down, or go straight to a choice.
export function firstStep(settings: VoiceSettings): VoiceChoice | 'ask' {
	return settings.ask || settings.choice === null ? 'ask' : settings.choice;
}

// Set a per-player entry, moving it to the newest end.
export function withEntry<T>(map: Record<string, T>, ref: string, value: T): Record<string, T> {
	const rest = { ...map };
	delete rest[ref];
	return { ...rest, [ref]: value };
}

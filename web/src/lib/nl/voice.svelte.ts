// Table voice at the table (P4C.6): what the table shows of it and what its
// controls do, over VoiceRoom (src/lib/voice/room.ts).
//
// Voice is offered to someone seated at a table where another person is too,
// never at a practice table (Q-10), and only where the site offers it at all
// (`GET /api/voice`). Taking such a seat shows the voice card: “Join voice”
// asks for the microphone, “Listen only” joins without one, “Not now” stays
// out. The choice is remembered in this browser and made by itself at the
// next table, unless the person chose “Ask each time”. Playback starts from
// the card's click, so autoplay rules never silence the room; a remembered
// choice that the browser holds back for want of a click asks for one.
import { placeOf, places } from './layout.ts';
import { fetchVoiceOffer, fetchVoiceToken } from './api.ts';
import type { RelationItem, TableView } from '../protocol-v2.ts';
import type { Epoch } from '../voice/group-keys.ts';
import type { Identity } from '../voice/group.ts';
import { Microphone, MicError, explainMic } from '../voice/microphone.ts';
import { Playback, SpeakingGate, panFor } from '../voice/playback.ts';
import type { Heard, VoicePerson, VoiceRoom } from '../voice/room.ts';
import {
	clampVolume,
	firstStep,
	loadSettings,
	saveSettings,
	withEntry,
	type Bitrate,
	type VoiceChoice,
	type VoiceSettings
} from '../voice/settings.ts';
import { CLOSE } from '../voice/signalling.ts';

export type Phase =
	// Not offered here: not seated, alone, at a practice table, or no voice on this site.
	| 'idle'
	// The voice card is up.
	| 'offer'
	| 'joining'
	| 'in'
	// The connection went and the room is coming back by itself.
	| 'reconnecting'
	// Offered, and the person is out of it: “Not now”, or they left voice.
	| 'out'
	| 'failed';

// What a seat shows of its person's voice.
export type SeatVoice = {
	state: 'talking' | 'muted' | 'deafened' | 'listening' | 'out';
	speaking: boolean;
	// The viewer muted them (their audio is paused at the voice service).
	mutedByMe: boolean;
	volume: number;
};

export type Quality = 'good' | 'fair' | 'poor';

const QUALITY_MS = 2000;
const LEVEL_MS = 100;

const editable = (target: EventTarget | null): boolean => {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
	if (!(target instanceof HTMLInputElement)) return false;
	return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes(target.type);
};

function storage(): Storage | null {
	try {
		return typeof localStorage === 'undefined' ? null : localStorage;
	} catch {
		return null;
	}
}

// The WebSocket address of the voice service's path on this page's origin.
export function socketUrl(path: string, at: Location = location): string {
	return `${at.protocol === 'https:' ? 'wss:' : 'ws:'}//${at.host}${path}`;
}

// Why a room ended, for the table.
function closedWhy(code: number): string | null {
	switch (code) {
		case CLOSE.unseated:
			return null;
		case CLOSE.replaced:
			return 'Voice moved to another tab or window of yours at this table.';
		case CLOSE.removed:
			return 'You were taken out of the voice group. Join again to come back.';
		case CLOSE.unauthorised:
			return 'The voice service did not accept this page. Join again to try once more.';
		default:
			return 'The connection to voice was lost. Join again to come back.';
	}
}

export class TableVoice {
	phase = $state<Phase>('idle');
	// The site offers voice at all (`GET /api/voice`).
	offered = $state(false);
	// Talking with a microphone, or listening only.
	mode = $state<'talk' | 'listen'>('listen');
	selfMuted = $state(false);
	deafened = $state(false);
	// Push-to-talk held.
	talking = $state(false);
	micProblem = $state<string | null>(null);
	// Why the stronger noise suppression (RNNoise) is not running though it is on.
	denoiseProblem = $state<string | null>(null);
	failure = $state<string | null>(null);
	code = $state<string[] | null>(null);
	// The group holds someone who is not seated here, so this page sends nothing.
	strangers = $state(false);
	quality = $state<Quality | null>(null);
	// The browser held playback back: a click on “Turn on sound” starts it.
	needsGesture = $state(false);
	level = $state(0);
	settings = $state<VoiceSettings>(loadSettings(storage()));
	inputs = $state<{ id: string; label: string }[]>([]);
	outputs = $state<{ id: string; label: string }[]>([]);
	canChooseOutput = $state(false);
	panelOpen = $state(false);
	// The last change to this person's own voice, for screen readers.
	announcement = $state('');
	notice = $state<string | null>(null);

	#people = $state<VoicePerson[]>([]);
	#speaking = $state<Record<string, boolean>>({});
	#mySpeaking = $state(false);
	#relations: RelationItem[] = [];
	#view: TableView | null = null;
	#tableId: string | null = null;
	// A choice was made at this table, so the card does not come up again by itself.
	#decided = false;
	#eligible = false;
	#room: VoiceRoom | null = null;
	#mic: Microphone | null = null;
	#playback: Playback | null = null;
	// The streams this page hears, by peer: what is shown of them is #people and #speaking.
	#heard: Record<string, Heard> = {};
	#seated = '';
	#gate = new SpeakingGate();
	#timers: ReturnType<typeof setInterval>[] = [];
	#lost: { packets: number; lost: number } | null = null;
	#joining = 0;
	#offerAsked = false;
	#destroyed = false;
	#log = (line: string) => console.info(line);

	constructor() {
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', this.#visibility);
			window.addEventListener('blur', this.#blur);
		}
	}

	get inVoice(): boolean {
		return this.phase === 'in' || this.phase === 'reconnecting';
	}

	// The microphone is open and sending: the table always shows it.
	get live(): boolean {
		return this.inVoice && this.#sendingNow();
	}

	get speakingSelf(): boolean {
		return this.#mySpeaking;
	}

	// What the table's seats show, by seat.
	seat(seat: number, ref: string | null, mine: boolean): SeatVoice | null {
		if (!this.inVoice || !ref) return null;
		if (mine) {
			const state = this.deafened
				? 'deafened'
				: this.mode === 'listen'
					? 'listening'
					: this.#sendingNow()
						? 'talking'
						: 'muted';
			return { state, speaking: this.#mySpeaking, mutedByMe: false, volume: 1 };
		}
		const person = this.#people.find((one) => one.seat === seat && one.player === ref);
		const mutedByMe = this.isMuted(ref);
		const volume = this.volumeOf(ref);
		if (!person) return { state: 'out', speaking: false, mutedByMe, volume };
		const state = person.deafened
			? 'deafened'
			: person.muted
				? 'muted'
				: person.sending
					? 'talking'
					: 'listening';
		const speaking = !mutedByMe && !this.deafened && (this.#speaking[person.peer] ?? false);
		return { state, speaking, mutedByMe, volume };
	}

	// This person's own mute of `ref`, or the one their P4.5 mute gives.
	isMuted(ref: string): boolean {
		const own = this.settings.mutes[ref];
		if (own !== undefined) return own;
		return this.#relations.some((one) => one.ref === ref && one.kind === 'mute');
	}

	volumeOf(ref: string): number {
		return this.settings.volumes[ref] ?? 1;
	}

	// The table changed: who is seated, whether this person may be in voice.
	update(view: TableView, relations: RelationItem[]): void {
		if (this.#destroyed) return;
		const relationsChanged = JSON.stringify(relations) !== JSON.stringify(this.#relations);
		const before = this.#relations;
		this.#relations = relations;
		if (view.table_id !== this.#tableId) {
			this.#leaveRoom(false);
			this.#tableId = view.table_id;
			this.#decided = false;
			this.phase = 'idle';
		}
		this.#view = view;
		if (!this.#offerAsked) {
			this.#offerAsked = true;
			fetchVoiceOffer().then(
				(offered) => {
					this.offered = offered;
					if (this.#view) this.update(this.#view, this.#relations);
				},
				() => (this.offered = false)
			);
		}
		const mine = view.you.seat;
		const me = mine === null ? null : view.seats[mine];
		const people = view.seats.filter((one) => one?.kind === 'human');
		const eligible =
			this.offered &&
			!view.practice &&
			me !== null &&
			me !== undefined &&
			!(me.stack === 0 && !me.in_hand && view.you.pending_rebuy === 0) &&
			people.length >= 2;
		const wasEligible = this.#eligible;
		this.#eligible = eligible;
		if (!eligible) {
			if (this.phase !== 'idle') this.#leaveRoom(false);
			this.phase = 'idle';
			this.panelOpen = false;
			return;
		}
		if (!wasEligible && this.phase === 'idle') this.#arrive();
		const seated: Identity[] = people.map((one) => ({ player: one!.ref!, seat: one!.seat }));
		const shape = JSON.stringify(seated);
		if (shape !== this.#seated) {
			this.#seated = shape;
			this.#room?.seats(seated);
			this.#place();
		}
		if (relationsChanged) this.#relationsChanged(before);
	}

	// Seated with someone: offer voice, or do what this browser chose last time.
	#arrive(): void {
		if (this.#decided) {
			this.phase = 'out';
			return;
		}
		const step = firstStep(this.settings);
		if (step === 'ask') {
			this.phase = 'offer';
			return;
		}
		if (step === 'not-now') {
			this.phase = 'out';
			return;
		}
		void this.#join(step === 'join');
	}

	// The card's buttons, from a click.
	choose(choice: VoiceChoice): void {
		this.#decided = true;
		if (!this.settings.ask) this.#save({ choice });
		if (choice === 'not-now') {
			this.phase = 'out';
			return;
		}
		// Start playback inside the click, before anything waits.
		this.#playbackStart();
		void this.#join(choice === 'join');
	}

	// Open the card again, from the bar.
	offer(): void {
		if (this.phase === 'out' || this.phase === 'failed') {
			this.failure = null;
			this.phase = 'offer';
		}
	}

	// Leave voice, from a click: out until the person joins again here.
	leave(): void {
		this.#decided = true;
		this.#leaveRoom(true);
		this.phase = 'out';
		this.panelOpen = false;
	}

	// Start the microphone from the panel, for someone listening only.
	speak(): void {
		this.#playbackStart();
		void (async () => {
			if (!(await this.#openMic())) return;
			await this.#room?.setTrack(this.#mic!.track);
			await this.#apply();
		})();
	}

	// Stop the microphone and keep listening.
	listenOnly(): void {
		this.mode = 'listen';
		this.#closeMic();
		void this.#room?.setTrack(null);
		void this.#apply();
	}

	// “Turn on sound”, from a click.
	resumeSound(): void {
		void this.#playback?.resume().then(() => this.#syncPlayback());
	}

	toggleSelfMute(): void {
		if (!this.inVoice || this.mode === 'listen') return;
		this.selfMuted = !this.selfMuted;
		this.announcement = this.selfMuted ? 'Your microphone is muted.' : 'Your microphone is on.';
		void this.#apply();
	}

	toggleDeafen(): void {
		if (!this.inVoice) return;
		this.deafened = !this.deafened;
		this.announcement = this.deafened
			? 'Voice is silenced: you hear nobody, and your microphone is off.'
			: 'You hear the table again.';
		this.#playback?.setDeafened(this.deafened);
		void this.#room?.deafen(this.deafened);
		void this.#apply();
	}

	// Push-to-talk, held and let go.
	press(): void {
		if (!this.settings.pushToTalk || this.talking) return;
		this.talking = true;
		void this.#apply();
	}

	release(): void {
		if (!this.talking) return;
		this.talking = false;
		void this.#apply();
	}

	toggleMute(ref: string): void {
		const muted = !this.isMuted(ref);
		this.#save({ mutes: withEntry(this.settings.mutes, ref, muted) });
		void this.#room?.mute(ref, muted);
	}

	setVolume(ref: string, volume: number): void {
		const value = clampVolume(volume);
		this.#save({ volumes: withEntry(this.settings.volumes, ref, value) });
		for (const person of this.#people) {
			if (person.player === ref) this.#playback?.setVolume(person.peer, value);
		}
	}

	// A change in the voice settings.
	set<K extends keyof VoiceSettings>(name: K, value: VoiceSettings[K]): void {
		this.#save({ [name]: value } as Partial<VoiceSettings>);
		switch (name) {
			case 'input':
			case 'echoCancellation':
			case 'noiseSuppression':
			case 'autoGainControl':
			case 'denoise':
				if (this.#mic) void this.#reopenMic();
				return;
			case 'output':
				void this.#playback?.setOutput(value as string | null);
				return;
			case 'bitrate':
				void this.#room?.setBitrate(value as Bitrate);
				return;
			case 'spatial':
				this.#playback?.setSpatial(value as boolean);
				return;
			case 'pushToTalk':
				this.talking = false;
				void this.#apply();
				return;
		}
	}

	// Keys: M mutes, D deafens, V held talks. Never while typing in a field.
	keydown = (event: KeyboardEvent): void => {
		if (!this.inVoice || editable(event.target)) return;
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const key = event.key.toLowerCase();
		if (key === 'v' && this.settings.pushToTalk) {
			event.preventDefault();
			this.press();
			return;
		}
		if (event.repeat) return;
		if (key === 'm') {
			event.preventDefault();
			this.toggleSelfMute();
		} else if (key === 'd') {
			event.preventDefault();
			this.toggleDeafen();
		}
	};

	keyup = (event: KeyboardEvent): void => {
		if (event.key.toLowerCase() === 'v') this.release();
	};

	// What a test or the page's own diagnostics may read: never a key.
	diagnostics(): {
		phase: Phase;
		mode: 'talk' | 'listen';
		denoising: boolean;
		micProblem: string | null;
		output: string | null;
		heard: { seat: number | null; gain: number | null; pan: number | null; speaking: boolean }[];
		code: string[] | null;
		live: boolean;
		quality: Quality | null;
	} {
		return {
			phase: this.phase,
			mode: this.mode,
			denoising: this.#mic?.denoising ?? false,
			micProblem: this.micProblem,
			output: this.#playback?.mode ?? null,
			heard: Object.values(this.#heard).map((heard) => ({
				seat: this.#people.find((one) => one.peer === heard.peer)?.seat ?? null,
				gain: this.#playback?.gainOf(heard.peer) ?? null,
				pan: this.#playback?.panOf(heard.peer) ?? null,
				speaking: this.#speaking[heard.peer] ?? false
			})),
			code: this.code,
			live: this.live,
			quality: this.quality
		};
	}

	destroy(): void {
		this.#destroyed = true;
		this.#leaveRoom(false);
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', this.#visibility);
			window.removeEventListener('blur', this.#blur);
		}
	}

	#save(change: Partial<VoiceSettings>): void {
		this.settings = { ...this.settings, ...change };
		saveSettings(storage(), this.settings);
	}

	#sendingNow(): boolean {
		return (
			this.mode === 'talk' &&
			!this.selfMuted &&
			!this.deafened &&
			!this.strangers &&
			(!this.settings.pushToTalk || this.talking)
		);
	}

	async #apply(): Promise<void> {
		const room = this.#room;
		if (!room) return;
		await room.setSending(this.#sendingNow());
		await room.setStatus({ muted: this.selfMuted, deafened: this.deafened });
	}

	#playbackStart(): void {
		if (!this.#playback) {
			const playback = new Playback({
				onspeaking: (key, speaking) => {
					this.#speaking = { ...this.#speaking, [key]: speaking };
				},
				stats: async (key) => {
					const heard = this.#heard[key];
					if (!heard) return null;
					for (const stat of (await heard.consumer.getStats()).values()) {
						if (stat.type === 'inbound-rtp') return stat;
					}
					return null;
				},
				log: this.#log
			});
			playback.onchange = () => this.#syncPlayback();
			this.#playback = playback;
		}
		this.#playback.start();
		this.#playback.setDeafened(this.deafened);
		this.#playback.setSpatial(this.settings.spatial);
		this.#syncPlayback();
		if (this.settings.output) void this.#playback.setOutput(this.settings.output);
	}

	#syncPlayback(): void {
		this.needsGesture = this.#playback?.blocked ?? false;
		this.canChooseOutput = this.#playback?.canChooseOutput ?? false;
		this.#mic?.meter(this.#playback?.context ?? null);
	}

	async #openMic(): Promise<boolean> {
		this.micProblem = null;
		try {
			const mic = await Microphone.open(this.settings);
			if (this.#destroyed || !this.#eligible) {
				mic.close();
				return false;
			}
			this.#closeMic();
			this.#mic = mic;
			this.denoiseProblem = mic.denoiseProblem;
			mic.meter(this.#playback?.context ?? null);
			// RNNoise stopped: send the microphone as the browser gives it.
			mic.ontrack = (track) => {
				if (this.#mic !== mic) return;
				this.denoiseProblem = mic.denoiseProblem;
				mic.meter(this.#playback?.context ?? null);
				void this.#room?.setTrack(track);
			};
			mic.track.addEventListener('ended', () => {
				if (this.#mic === mic && !document.hidden) void this.#micEnded();
			});
			this.mode = 'talk';
			void this.#listDevices();
			return true;
		} catch (error) {
			this.mode = 'listen';
			const problem = error instanceof MicError ? error.problem : 'failed';
			this.#log(`voice: no microphone (${problem}: ${(error as Error)?.cause ?? error})`);
			this.micProblem = explainMic(problem);
			return false;
		}
	}

	async #reopenMic(): Promise<void> {
		if (!(await this.#openMic())) {
			await this.#room?.setTrack(null);
			return;
		}
		await this.#room?.setTrack(this.#mic!.track);
		await this.#apply();
	}

	async #micEnded(): Promise<void> {
		this.notice = 'The microphone stopped. Trying it again…';
		await this.#reopenMic();
		this.notice = this.#mic ? null : 'The microphone stopped, so you are listening only.';
	}

	#closeMic(): void {
		this.#mic?.close();
		this.#mic = null;
		this.denoiseProblem = null;
		this.level = 0;
		this.#mySpeaking = false;
	}

	async #listDevices(): Promise<void> {
		const { inputs, outputs } = await Microphone.devices();
		const named = (one: MediaDeviceInfo) => ({ id: one.deviceId, label: one.label });
		this.inputs = inputs.map(named);
		this.outputs = outputs.map(named);
	}

	async #join(withMic: boolean): Promise<void> {
		const tableId = this.#tableId;
		const view = this.#view;
		if (!tableId || !view) return;
		const attempt = ++this.#joining;
		this.failure = null;
		this.phase = 'joining';
		if (typeof RTCRtpScriptTransform === 'undefined' || !globalThis.crypto?.subtle) {
			this.phase = 'failed';
			this.failure =
				'This browser cannot encrypt voice end to end, so voice is off here. The table plays as before.';
			return;
		}
		this.#playbackStart();
		if (!withMic) this.mode = 'listen';
		// A refusal opens the panel, where it says how to allow the microphone.
		else if (!(await this.#openMic())) this.panelOpen = true;
		if (attempt !== this.#joining || !this.#eligible) return;
		try {
			const first = await fetchVoiceToken(tableId);
			let fresh = true;
			const token = async () => {
				if (fresh) {
					fresh = false;
					return first.token;
				}
				return (await fetchVoiceToken(tableId)).token;
			};
			const { VoiceRoom } = await import('../voice/room.ts');
			const seated = JSON.parse(this.#seated || '[]') as Identity[];
			const muted = (this.#view?.seats ?? [])
				.map((one) => one?.ref ?? null)
				.filter((ref): ref is string => ref !== null && this.isMuted(ref));
			const room = await VoiceRoom.join({
				url: socketUrl(first.url),
				table: tableId,
				token,
				track: this.#mic?.track ?? null,
				seated,
				muted,
				sending: this.#sendingNow(),
				status: { muted: this.selfMuted, deafened: this.deafened },
				deafened: this.deafened,
				bitrate: this.settings.bitrate,
				onepoch: (epoch) => this.#epoch(epoch),
				onheard: (heard) => this.#hear(heard),
				onended: (heard) => this.#unhear(heard),
				onchange: () => this.#changed(),
				onclose: (code) => this.#closed(room, code),
				onreconnecting: () => {
					if (this.#room === room) this.phase = 'reconnecting';
				},
				onreconnected: () => {
					if (this.#room !== room) return;
					this.phase = 'in';
					this.#changed();
				},
				log: this.#log
			});
			if (attempt !== this.#joining || !this.#eligible || this.#destroyed) {
				room.close();
				return;
			}
			this.#room = room;
			this.phase = 'in';
			this.#changed();
			this.#watch();
			await this.#apply();
		} catch (error) {
			if (attempt !== this.#joining) return;
			this.#closeMic();
			this.phase = 'failed';
			this.failure = `Voice could not start: ${error instanceof Error ? error.message : String(error)}. The table plays as before.`;
		}
	}

	#closed(room: VoiceRoom, code: number): void {
		if (this.#room !== room) return;
		this.#leaveRoom(false);
		const why = closedWhy(code);
		if (why === null) {
			this.phase = this.#eligible ? 'out' : 'idle';
			return;
		}
		this.phase = 'failed';
		this.failure = why;
	}

	#leaveRoom(releaseNow: boolean): void {
		this.#joining += 1;
		for (const timer of this.#timers) clearInterval(timer);
		this.#timers = [];
		this.#room?.close();
		this.#room = null;
		this.#heard = {};
		this.#people = [];
		this.#speaking = {};
		this.#closeMic();
		this.#playback?.close();
		this.#playback = null;
		this.code = null;
		this.strangers = false;
		this.quality = null;
		this.needsGesture = false;
		this.talking = false;
		this.#lost = null;
		if (releaseNow) this.announcement = 'You left voice.';
	}

	#epoch(epoch: Epoch): void {
		this.code = epoch.code;
		const strangers = !epoch.seats.ok;
		if (strangers !== this.strangers) {
			this.strangers = strangers;
			void this.#apply();
		}
	}

	#hear(heard: Heard): void {
		this.#heard[heard.peer] = heard;
		const person = this.#room?.people.find((one) => one.peer === heard.peer);
		const ref = person?.player ?? heard.player;
		this.#playback?.add(
			heard.peer,
			heard.track,
			ref ? this.volumeOf(ref) : 1,
			this.#panOf(person?.seat ?? null)
		);
	}

	#unhear(heard: Heard): void {
		delete this.#heard[heard.peer];
		this.#playback?.remove(heard.peer);
	}

	#changed(): void {
		const room = this.#room;
		if (!room) return;
		this.#people = room.people;
		const epoch = room.epoch;
		if (epoch) this.#epoch(epoch);
		this.#place();
	}

	// Put each voice on its seat's side, at the volume this person gave it.
	#place(): void {
		for (const person of this.#people) {
			if (!this.#playback?.has(person.peer)) continue;
			this.#playback.setPan(person.peer, this.#panOf(person.seat));
			if (person.player) this.#playback.setVolume(person.peer, this.volumeOf(person.player));
		}
	}

	#panOf(seat: number | null): number {
		const view = this.#view;
		if (!view || seat === null) return 0;
		const count = view.settings.seat_count;
		const spot = places(count, 'wide')[placeOf(seat, view.you.seat, count)];
		return spot ? panFor(spot.left) : 0;
	}

	#relationsChanged(before: RelationItem[]): void {
		const kind = (list: RelationItem[], ref: string) =>
			list.find((one) => one.ref === ref)?.kind ?? null;
		const refs = [...before, ...this.#relations].map((one) => one.ref);
		for (const ref of refs.filter((one, at) => refs.indexOf(one) === at)) {
			if (this.settings.mutes[ref] !== undefined) continue;
			if ((kind(before, ref) === 'mute') !== (kind(this.#relations, ref) === 'mute')) {
				void this.#room?.mute(ref, this.isMuted(ref));
			}
		}
	}

	// The meter, this person's own ring and the connection's quality.
	#watch(): void {
		for (const timer of this.#timers) clearInterval(timer);
		this.#timers = [
			setInterval(() => {
				const level = this.#mic?.level() ?? null;
				this.level = level ?? 0;
				const speaking =
					this.#sendingNow() && level !== null && this.#gate.update(level, performance.now());
				if (speaking !== this.#mySpeaking) this.#mySpeaking = speaking;
			}, LEVEL_MS),
			setInterval(() => void this.#measure(), QUALITY_MS)
		];
	}

	async #measure(): Promise<void> {
		const room = this.#room;
		if (!room) return;
		let rtt: number | null = null;
		let packets = 0;
		let lost = 0;
		for (const transport of [room.transports.recv, room.transports.send]) {
			if (!transport) continue;
			const stats = await transport.getStats().catch(() => null);
			for (const stat of stats?.values() ?? []) {
				if (stat.type === 'candidate-pair' && (stat.nominated || stat.selected)) {
					if (typeof stat.currentRoundTripTime === 'number') {
						rtt = Math.max(rtt ?? 0, stat.currentRoundTripTime);
					}
				}
				if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
					packets += stat.packetsReceived ?? 0;
					lost += stat.packetsLost ?? 0;
				}
			}
		}
		const before = this.#lost;
		this.#lost = { packets, lost };
		const got = before ? packets - before.packets : 0;
		const missed = before ? lost - before.lost : 0;
		const loss = got + missed > 0 ? missed / (got + missed) : 0;
		if (rtt === null) {
			this.quality = null;
			return;
		}
		this.quality = rtt < 0.25 && loss < 0.02 ? 'good' : rtt < 0.5 && loss < 0.08 ? 'fair' : 'poor';
	}

	// The page was hidden and is shown again: carry on, or say why not.
	#visibility = (): void => {
		if (document.hidden) {
			this.release();
			return;
		}
		if (!this.inVoice) return;
		void (async () => {
			await this.#playback?.resume();
			this.#syncPlayback();
			if (this.mode === 'talk' && this.#mic && !this.#mic.live) await this.#micEnded();
			if (this.needsGesture) {
				this.notice = 'Your browser paused the sound while the page was hidden.';
			} else if (this.notice?.startsWith('Your browser paused')) {
				this.notice = null;
			}
		})();
	};

	#blur = (): void => this.release();
}

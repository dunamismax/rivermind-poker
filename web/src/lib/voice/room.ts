// One page in a table's voice room, over voice signalling v1 (P4C.4): it joins
// the table's MLS group (group.ts), keys its frames from each epoch
// (group-keys.ts) and carries the audio through mediasoup-client, every frame
// sealed or opened in the page's worker (sframe-client.ts). What the table
// shows of it, and when a page joins, is P4C.5's and P4C.6's.
//
// The group's rules for a page, as docs/voice.md sets them:
//
//   - with no group yet it makes one; otherwise it joins by external commit,
//     and starts again from the GroupInfo the service hands back when another
//     commit took the epoch first;
//   - it applies what the service passes on, in order, and takes each new
//     epoch's key at once;
//   - when the service proposes a removal, the member at rank 0 commits it at
//     once, and the one at rank n after n turns if nobody has.
//
// It sends audio only once it is in the group, and each stream it hears is
// opened only as the leaf the service says it is from.
//
// `VoiceRoom` is what a page holds. Each connection to the service is a
// `VoiceSession` of its own; when the service restarts or the connection
// drops, the room asks for a new token and joins a new group, keeping the
// person's mutes (P4C.5). A new group starts again at epoch 0, which a key
// store never goes back to, so each session has a worker and keys of its own.
//
// A session also looks after its own path to the media server (P4C.7). When a
// transport loses it (the person's network changed), ICE starts again under
// new credentials from the service, and the group and every stream stand. A
// transport that is not connected again soon after ends the session, and the
// room comes back as it does after a restart. A room that cannot come back
// keeps trying for a while, less and less often, and then ends.
//
// What the person does with their own audio (P4C.6) is kept by the room too,
// across sessions: the microphone, which can change or go (listening only);
// whether it sends, which a mute or push-to-talk stops at the page and at the
// service; whether they hear anyone (deafened, which pauses every stream at
// the service); and the bitrate. `status` tells everyone else they muted
// themself or deafened, where the service takes it.
import { Device, type types as msc } from 'mediasoup-client';
import { EpochKeys, type Epoch } from './group-keys.ts';
import { Member, type Identity } from './group.ts';
import type { Bitrate } from './settings.ts';
import { FrameCrypto } from './sframe-client.ts';
import type { Tally } from './sframe-transform.ts';
import { Refused, VoiceSocket } from './signalling-client.ts';
import {
	CLOSE,
	VOICE_PROTOCOL,
	fromBase64,
	toBase64,
	type Notice,
	type PeerInfo,
	type PeerStatus,
	type Requests,
	type TransportInfo,
	type VoiceError
} from './signalling.ts';

// How long a member waits for each member ahead of it to commit a removal.
export const COMMIT_TURN_MS = 1000;
// How long a transport that lost its path has to connect again, ICE restarted,
// before the session is given up for a new one.
export const ICE_GIVE_UP_MS = 3000;
// How long a transport may take to connect in the first place before it is
// treated as one that lost its path. A browser left to itself takes two or
// three times as long to say that ICE failed.
export const CONNECT_MS = 10_000;

// docs/voice.md: mono, in-band FEC, DTX, 64 kbps on average, 20 ms frames.
export const CODEC_OPTIONS: msc.ProducerCodecOptions = {
	opusStereo: false,
	opusFec: true,
	opusDtx: true,
	opusMaxAverageBitrate: 64000,
	opusPtime: 20
};

export type VoiceRoomOptions = {
	// The service's WebSocket, such as wss://rivermindpoker.com/voice.
	url: string;
	table: string;
	// A token for this seat (POST /api/tables/{id}/voice). Each is good for one
	// connection, so a room that is to come back by itself is given a way to get
	// another; with a token alone, a lost connection ends the room.
	token: string | (() => Promise<string>);
	// The microphone, or null to listen only.
	track: MediaStreamTrack | null;
	// Who the table shows seated, for the check of the group's members (group-keys.ts).
	seated: Identity[];
	// The public references of the people this person has muted (P4.5): their
	// audio stays paused at the voice service from the start, never sent here.
	muted?: string[];
	// Whether the microphone sends now: false while the person has muted
	// themself, or holds no push-to-talk key (P4C.6). True by default.
	sending?: boolean;
	// What the person says of themself to everyone else (`status`).
	status?: PeerStatus;
	// Deafened: every stream paused at the service, so this page hears nobody.
	deafened?: boolean;
	bitrate?: Bitrate;
	commitTurnMs?: number;
	iceGiveUpMs?: number;
	connectMs?: number;
	// How long a room that lost the service keeps trying to come back.
	giveUpMs?: number;
	onepoch?: (epoch: Epoch) => void;
	// A stream was added, or ended.
	onheard?: (heard: Heard) => void;
	onended?: (heard: Heard) => void;
	// The room ended: closed here, refused, or lost for good (a code from CLOSE).
	onclose?: (code: number, reason: string) => void;
	// The connection was lost and the room is coming back, or has.
	onreconnecting?: (code: number) => void;
	onreconnected?: () => void;
	// Someone came, went, started or stopped sending, or said they muted
	// themself or deafened: read `people` again.
	onchange?: () => void;
	log?: (line: string) => void;
};

type SessionOptions = Omit<VoiceRoomOptions, 'token'> & { token: string };

// One person this page hears, or would but for a mute.
export type Heard = {
	peer: string;
	leaf: number;
	// Who the leaf is, by this page's own copy of the group.
	player: string | null;
	// Paused at the voice service, so none of their audio reaches this page.
	muted: boolean;
	consumer: msc.Consumer;
	receiver: RTCRtpReceiver | null;
	track: MediaStreamTrack;
};

// Someone else in the room, as this page knows them (P4C.6): the seat and
// player are those their leaf names in this page's own copy of the group, and
// null until they are in it.
export type VoicePerson = {
	peer: string;
	leaf: number | null;
	player: string | null;
	seat: number | null;
	// They send audio: they joined with a microphone, not to listen only.
	sending: boolean;
	muted: boolean;
	deafened: boolean;
};

class VoiceSession {
	#options: SessionOptions;
	#socket: VoiceSocket;
	#welcome: Requests['hello']['response'];
	#identity: Identity;
	#frames = new FrameCrypto();
	#keys: EpochKeys;
	#device!: Device;
	#member: Member | null = null;
	#send: msc.Transport | null = null;
	#recv: msc.Transport | null = null;
	#producer: msc.Producer | null = null;
	#heard = new Map<string, Heard>();
	#muted: Set<string>;
	// What the room knows of everyone else.
	#peers = new Map<string, PeerInfo>();
	// Group changes, notices and media changes, one at a time, in order.
	#queue: Promise<void> = Promise.resolve();
	#commitTimer: ReturnType<typeof setTimeout> | null = null;
	// Each transport that lost its path, with the timer that gives the session up.
	#recovering = new Map<msc.Transport, ReturnType<typeof setTimeout>>();
	// Each transport that is connecting for the first time, with its deadline.
	#connecting = new Map<msc.Transport, ReturnType<typeof setTimeout>>();
	#closed = false;
	#sending: boolean;
	// How many times ICE was started again, for the checks.
	iceRestarts = 0;
	// Whether any transport of this session ever reached the media server, and
	// whether the session ended itself because one did not come back.
	reached = false;
	gaveUp = false;
	#status: PeerStatus;
	#deafened: boolean;
	// Until when this person may not speak (P4C.8), in milliseconds; null when they may.
	#silenced: number | null;
	epoch: Epoch | null = null;
	refused: string[] = [];

	private constructor(
		options: SessionOptions,
		socket: VoiceSocket,
		welcome: Requests['hello']['response']
	) {
		this.#options = options;
		this.#socket = socket;
		this.#welcome = welcome;
		this.#identity = { player: welcome.player, seat: welcome.seat };
		this.#muted = new Set(options.muted ?? []);
		this.#sending = options.sending ?? true;
		this.#status = options.status ?? { muted: false, deafened: false };
		this.#deafened = options.deafened ?? false;
		this.#silenced = welcome.silenced ?? null;
		this.#keys = new EpochKeys(this.#frames);
		this.#keys.seats(options.seated);
		// Someone who left their seat is in the group still, and this page has
		// stopped sending: the table hears of it.
		this.#keys.onseats = (seats) => {
			if (!this.epoch || this.#closed) return;
			this.epoch = { ...this.epoch, seats };
			this.#options.onepoch?.(this.epoch);
			this.#changed();
		};
		this.#frames.onrefused = (asked, error) => this.refused.push(`${asked}: ${error}`);
		for (const peer of welcome.peers) this.#peers.set(peer.peer, peer);
	}

	static async join(options: SessionOptions): Promise<VoiceSession> {
		const socket = await VoiceSocket.open(options.url);
		let welcome: Requests['hello']['response'];
		try {
			welcome = await socket.request('hello', {
				v: VOICE_PROTOCOL,
				table: options.table,
				token: options.token
			});
		} catch (error) {
			socket.close();
			throw error;
		}
		const room = new VoiceSession(options, socket, welcome);
		socket.onnotice = (notice) => room.#later(() => room.#notice(notice));
		socket.onclose = (code, reason) => {
			options.log?.(`voice: the service closed the connection (${code})`);
			try {
				room.#shut();
			} finally {
				options.onclose?.(code, reason);
			}
		};
		try {
			await room.#later(() => room.#start());
		} catch (error) {
			room.close();
			throw error;
		}
		return room;
	}

	get leaf(): number | null {
		return this.#member?.leaf ?? null;
	}

	get handler(): string {
		return this.#device.handlerName;
	}

	get heard(): Heard[] {
		return [...this.#heard.values()];
	}

	get transports(): { send: msc.Transport | null; recv: msc.Transport | null } {
		return { send: this.#send, recv: this.#recv };
	}

	get member(): Member | null {
		return this.#member;
	}

	get producer(): msc.Producer | null {
		return this.#producer;
	}

	// Until when the service refuses this person's audio, after voice reports
	// from other players (P4C.8): milliseconds since the epoch, or null.
	get silencedUntil(): number | null {
		return this.#silenced;
	}

	// Everyone else in this page's group, by its own copy of the tree, with what
	// the service says of their socket. A reloaded page's old leaf, which stays
	// beside its new one until it is removed, is left out: its socket is gone.
	get people(): VoicePerson[] {
		const mine = this.#member?.leaf ?? null;
		const people: VoicePerson[] = [];
		for (const { leaf, identity } of this.#member?.roster() ?? []) {
			if (leaf === mine || !identity) continue;
			const peer = [...this.#peers.values()].find((one) => one.leaf === leaf);
			if (!peer && people.some((one) => one.seat === identity.seat)) continue;
			people.push({
				peer: peer?.peer ?? '',
				leaf,
				player: identity.player,
				seat: identity.seat,
				sending: (peer?.producer ?? null) !== null,
				muted: peer?.muted ?? false,
				deafened: peer?.deafened ?? false
			});
		}
		// The same seat twice: keep the leaf whose socket is still here.
		return people.filter(
			(one) => one.peer !== '' || !people.some((other) => other !== one && other.seat === one.seat)
		);
	}

	tallies(): Promise<Tally[]> {
		return this.#frames.tallies();
	}

	#changed(): void {
		try {
			this.#options.onchange?.();
		} catch (error) {
			this.#log(`voice: ${error}`);
		}
	}

	// Change the microphone, or give it up to listen only (null). A page that
	// joined to listen makes its send transport when it first has one.
	setTrack(track: MediaStreamTrack | null): Promise<void> {
		this.#options.track = track;
		return this.#later(async () => {
			if (this.#producer) {
				await this.#producer.replaceTrack({ track });
				if (!track) await this.#pause(true);
				else if (this.#sending) await this.#pause(false);
				return;
			}
			if (!track) return;
			if (!this.#send) this.#send = await this.#transport('send');
			await this.#produce();
		});
	}

	// Start or stop sending: a mute, or push-to-talk held or let go.
	setSending(sending: boolean): Promise<void> {
		this.#sending = sending;
		return this.#later(() => this.#pause(!sending || !this.#options.track));
	}

	// Tell everyone else this person muted themself or deafened, or no longer.
	setStatus(status: PeerStatus): Promise<void> {
		this.#status = status;
		return this.#later(() => this.#sendStatus());
	}

	// Hear nobody, or everyone again but those this person muted.
	deafen(deafened: boolean): Promise<void> {
		this.#deafened = deafened;
		return this.#later(async () => {
			for (const heard of this.#heard.values()) {
				const paused = deafened || heard.muted;
				const type = paused ? 'consumer.pause' : 'consumer.resume';
				await this.#socket.request(type, { consumer: heard.consumer.id });
			}
		});
	}

	setBitrate(bitrate: Bitrate): Promise<void> {
		this.#options.bitrate = bitrate;
		return this.#later(async () => {
			await this.#producer?.setRtpEncodingParameters({ maxBitrate: bitrate });
		});
	}

	async #pause(paused: boolean): Promise<void> {
		const producer = this.#producer;
		if (!producer || producer.paused === paused) return;
		if (paused) producer.pause();
		else producer.resume();
		await this.#socket.request(paused ? 'producer.pause' : 'producer.resume', {});
	}

	async #sendStatus(): Promise<void> {
		if (!this.#welcome.statuses) return;
		await this.#socket.request('status', this.#status);
	}

	// Mute or unmute someone, by public reference. A mute pauses their audio at
	// the voice service, which then sends this page none of it.
	mute(player: string, muted: boolean): Promise<void> {
		return this.#later(async () => {
			if (muted) this.#muted.add(player);
			else this.#muted.delete(player);
			for (const heard of this.#heard.values()) {
				if (heard.player !== player || heard.muted === muted) continue;
				heard.muted = muted;
				if (this.#deafened) continue;
				const type = muted ? 'consumer.pause' : 'consumer.resume';
				await this.#socket.request(type, { consumer: heard.consumer.id });
			}
		});
	}

	// The table's seats changed.
	seats(seated: Identity[]): void {
		this.#options.seated = seated;
		const seats = this.#keys.seats(seated);
		if (this.epoch) this.epoch = { ...this.epoch, seats };
	}

	close(): void {
		this.#shut();
		this.#socket.close();
	}

	#log(line: string): void {
		this.#options.log?.(line);
	}

	#later(work: () => Promise<void>): Promise<void> {
		const done = this.#queue.then(() => (this.#closed ? undefined : work()));
		this.#queue = done.catch((error: unknown) => this.#log(`voice: ${error}`));
		return done;
	}

	#shut(): void {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#commitTimer) clearTimeout(this.#commitTimer);
		this.#forgetTimers();
		// Each step on its own: one that fails in some browser must not keep the
		// rest, or the room, from hearing that this session is over.
		const steps: (() => void)[] = [
			() => this.#keys.close(),
			...[...this.#heard.values()].map((heard) => () => this.#drop(heard)),
			() => this.#send?.close(),
			() => this.#recv?.close(),
			() => this.#frames.close()
		];
		for (const step of steps) {
			try {
				step();
			} catch (error) {
				this.#log(`voice: closing: ${error}`);
			}
		}
	}

	async #start(): Promise<void> {
		this.#device = await Device.factory();
		await this.#device.load({ routerRtpCapabilities: this.#welcome.routerRtpCapabilities });
		this.#recv = await this.#transport('recv');
		if (this.#options.track) this.#send = await this.#transport('send');
		await this.#joinGroup(this.#welcome.groupInfo);
		await this.#produce();
		if (this.#status.muted || this.#status.deafened) await this.#sendStatus();
		for (const peer of this.#peers.values()) await this.#consume(peer);
		this.#changed();
	}

	async #transport(direction: 'send' | 'recv'): Promise<msc.Transport> {
		const info: TransportInfo = await this.#socket.request('transport.create', { direction });
		const options = {
			id: info.transport,
			iceParameters: info.iceParameters,
			iceCandidates: info.iceCandidates,
			dtlsParameters: info.dtlsParameters
		};
		const made =
			direction === 'send'
				? this.#device.createSendTransport(options)
				: this.#device.createRecvTransport(options);
		made.on('connect', ({ dtlsParameters }, done, failed) => {
			this.#socket
				.request('transport.connect', { transport: made.id, dtlsParameters })
				.then(() => done(), failed);
		});
		made.on('produce', ({ rtpParameters }, done, failed) => {
			this.#socket
				.request('produce', { transport: made.id, rtpParameters })
				.then(({ producer }) => done({ id: producer }), failed);
		});
		made.on('connectionstatechange', (state) => {
			if (state !== 'connecting') {
				clearTimeout(this.#connecting.get(made));
				this.#connecting.delete(made);
			}
			if (state === 'connected') {
				this.reached = true;
				this.#recovered(made);
			} else if (state === 'disconnected' || state === 'failed') {
				this.#recover(made);
			} else if (state === 'connecting' && !this.#connecting.has(made) && !this.reached) {
				// It should not take long: a network that lets no audio through is
				// found out here, sooner than the browser says so.
				const wait = this.#options.connectMs ?? CONNECT_MS;
				this.#connecting.set(
					made,
					setTimeout(() => {
						this.#connecting.delete(made);
						if (made.connectionState !== 'connected') this.#recover(made);
					}, wait)
				);
			}
		});
		return made;
	}

	// The browser says the network came back or changed: every path this page
	// had may be gone, so both transports start ICE again without waiting to
	// find out.
	networkChanged(): void {
		for (const transport of [this.#send, this.#recv]) {
			// One that carries nothing yet has no path to lose.
			if (transport && !transport.closed && transport.connectionState !== 'new') {
				this.#recover(transport);
			}
		}
	}

	// A transport lost its path to the media server. ICE starts again under new
	// credentials; if it is not connected again in time, the session ends and
	// the room makes another.
	#recover(transport: msc.Transport): void {
		if (this.#closed || transport.closed || this.#recovering.has(transport)) return;
		const wait = this.#options.iceGiveUpMs ?? ICE_GIVE_UP_MS;
		this.#recovering.set(
			transport,
			setTimeout(() => {
				this.#recovering.delete(transport);
				if (this.#closed || transport.closed || transport.connectionState === 'connected') return;
				this.#log('voice: the path to the media server did not come back');
				this.gaveUp = true;
				this.#socket.close();
			}, wait)
		);
		if (!this.#welcome.restarts) return;
		void this.#later(async () => {
			if (transport.closed || !this.#recovering.has(transport)) return;
			const { iceParameters } = await this.#socket.request('transport.restart', {
				transport: transport.id
			});
			if (transport.closed) return;
			await transport.restartIce({ iceParameters });
			this.iceRestarts += 1;
			this.#log('voice: started ICE again');
			// A transport that never lost its path says nothing more: it is as it was.
			if (transport.connectionState === 'connected') this.#recovered(transport);
		}).catch(() => {});
	}

	#forgetTimers(): void {
		for (const timer of [...this.#recovering.values(), ...this.#connecting.values()]) {
			clearTimeout(timer);
		}
		this.#recovering.clear();
		this.#connecting.clear();
	}

	#recovered(transport: msc.Transport): void {
		const timer = this.#recovering.get(transport);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.#recovering.delete(transport);
	}

	// Make the group, or join it, starting again from whatever GroupInfo a refusal names.
	async #joinGroup(groupInfo: string | null): Promise<void> {
		const service = fromBase64(this.#welcome.service)!;
		for (let tries = 0; tries < 10; tries += 1) {
			try {
				if (groupInfo === null) {
					const made = await Member.create(
						this.#identity,
						fromBase64(this.#welcome.group)!,
						service
					);
					await this.#socket.request('group.create', { groupInfo: toBase64(made.groupInfo) });
					await this.#enter(made.member);
				} else {
					const candidate = await Member.join(this.#identity, fromBase64(groupInfo)!, service);
					await this.#socket.request('group.commit', {
						commit: toBase64(candidate.commit),
						groupInfo: toBase64(candidate.groupInfo)
					});
					await this.#enter(candidate.member);
				}
				return;
			} catch (error) {
				if (!(error instanceof Refused) || error.groupInfo === undefined) throw error;
				groupInfo = error.groupInfo;
			}
		}
		throw new Error('could not join the voice group');
	}

	async #enter(member: Member): Promise<void> {
		this.#member = member;
		this.epoch = await this.#keys.advance(member);
		this.#options.onepoch?.(this.epoch);
		this.#changed();
	}

	async #produce(): Promise<void> {
		if (!this.#send || !this.#options.track || this.#producer) return;
		// The service would refuse it: this person listens until told otherwise.
		if (this.#silenced !== null) return;
		const bitrate = this.#options.bitrate ?? CODEC_OPTIONS.opusMaxAverageBitrate!;
		this.#producer = await this.#send.produce({
			track: this.#options.track,
			// The microphone outlives this session: the next one sends it again.
			stopTracks: false,
			// A pause sends nothing and leaves the shared track alone.
			disableTrackOnPause: false,
			zeroRtpOnPause: true,
			codecOptions: { ...CODEC_OPTIONS, opusMaxAverageBitrate: bitrate },
			encodings: [{ maxBitrate: bitrate }],
			onRtpSender: (sender) => this.#frames.encrypt(sender)
		});
		if (!this.#sending) await this.#pause(true);
	}

	async #consume(peer: PeerInfo): Promise<void> {
		if (!this.#recv || peer.producer === null || peer.leaf === null) return;
		const existing = this.#heard.get(peer.peer);
		if (existing) {
			if (existing.leaf === peer.leaf && existing.consumer.producerId === peer.producer) return;
			// Someone who joined the group again seals as a new leaf: hear them anew.
			this.#drop(existing);
		}
		const answer = await this.#socket.request('consume', {
			transport: this.#recv.id,
			producer: peer.producer,
			rtpCapabilities: this.#device.recvRtpCapabilities!
		});
		let receiver: RTCRtpReceiver | null = null;
		const leaf = peer.leaf;
		const consumer = await this.#recv.consume({
			id: answer.consumer,
			producerId: answer.producer,
			kind: 'audio',
			rtpParameters: answer.rtpParameters,
			onRtpReceiver: (made) => {
				receiver = made;
				this.#frames.decrypt(made, `recv-${peer.peer}`, leaf);
			}
		});
		const player =
			this.#member?.roster().find((one) => one.leaf === leaf)?.identity?.player ?? null;
		const muted = player !== null && this.#muted.has(player);
		const heard: Heard = {
			peer: peer.peer,
			leaf,
			player,
			muted,
			consumer,
			receiver,
			track: consumer.track
		};
		this.#heard.set(peer.peer, heard);
		// Consumers start paused at the service; a muted person's stays so, and
		// everyone's while this person is deafened.
		if (!muted && !this.#deafened) {
			await this.#socket.request('consumer.resume', { consumer: consumer.id });
		}
		this.#options.onheard?.(heard);
		this.#changed();
	}

	#drop(heard: Heard): void {
		heard.consumer.close();
		this.#heard.delete(heard.peer);
		this.#options.onended?.(heard);
		this.#changed();
	}

	async #notice(notice: Notice): Promise<void> {
		switch (notice.notice) {
			case 'mls':
				await this.#mls(fromBase64(notice.message)!);
				return;
			case 'producer':
				this.#peers.set(notice.peer.peer, notice.peer);
				await this.#consume(notice.peer);
				this.#changed();
				return;
			case 'consumer.closed':
				for (const heard of this.#heard.values()) {
					if (heard.consumer.id === notice.consumer) this.#drop(heard);
				}
				return;
			case 'left': {
				this.#peers.delete(notice.peer);
				const heard = this.#heard.get(notice.peer);
				if (heard) this.#drop(heard);
				this.#changed();
				return;
			}
			case 'peer':
				// The service's whole view of that socket now, someone who only
				// listens included, whom no `producer` notice names.
				this.#peers.set(notice.peer.peer, notice.peer);
				this.#changed();
				return;
			case 'silenced':
				// Suspended from speaking: the service has closed this page's producer,
				// and says when it may send again (`until: null`).
				this.#silenced = notice.until;
				if (notice.until !== null && this.#producer) {
					this.#producer.close();
					this.#producer = null;
				}
				if (notice.until === null) await this.#produce();
				this.#changed();
				return;
			case 'media.reset':
				// Every transport is gone at the service: make them again and send again.
				this.#forgetTimers();
				for (const heard of this.#heard.values()) this.#drop(heard);
				this.#send?.close();
				this.#recv?.close();
				this.#producer = null;
				this.#recv = await this.#transport('recv');
				if (this.#options.track) this.#send = await this.#transport('send');
				await this.#produce();
				this.#changed();
				return;
		}
	}

	async #mls(message: Uint8Array): Promise<void> {
		const member = this.#member;
		if (!member) return;
		const result = await member.receive(message);
		if (result.kind === 'rejected') {
			this.#log('voice: the group refused a message');
			return;
		}
		if (result.kind === 'removed') {
			this.close();
			return;
		}
		if (result.kind === 'commit') await this.#enter(member);
		this.#plan();
	}

	// Whose turn it is to commit the removals waiting: now at rank 0, else after
	// the members ahead have each had their turn.
	#plan(): void {
		if (this.#commitTimer) clearTimeout(this.#commitTimer);
		this.#commitTimer = null;
		const rank = this.#member?.commitRank() ?? null;
		if (rank === null) return;
		const turn = this.#options.commitTurnMs ?? COMMIT_TURN_MS;
		if (rank === 0) {
			void this.#later(() => this.#commit());
			return;
		}
		this.#commitTimer = setTimeout(() => void this.#later(() => this.#commit()), rank * turn);
	}

	async #commit(): Promise<void> {
		const member = this.#member;
		if (!member || member.commitRank() === null) return;
		const candidate = await member.commit();
		try {
			await this.#socket.request('group.commit', {
				commit: toBase64(candidate.commit),
				groupInfo: toBase64(candidate.groupInfo)
			});
		} catch (error) {
			// Another commit took the epoch: the service is passing it on.
			if (error instanceof Refused && error.code === 'epoch-taken') return;
			throw error;
		}
		await this.#enter(candidate.member);
		this.#plan();
	}
}

// Codes after which a room comes back by itself: the service restarted, or
// the connection went (a phone that lost its signal, a server that died).
// Not after it was refused, replaced by another page in the seat, taken out
// for leaving the seat, or closed on purpose. Playwright's WebKit reports the
// service's 1012 (service restart) as 1005 (no status); a room's own close
// never gets here, since it marks itself closed first.
const COME_BACK = new Set([1001, 1005, 1006, 1011, 1012, 1013]);
// How long a room waits before each try at coming back, the last of them for
// every try after, and how long it keeps trying before it ends (P4C.7): a
// service that is down for good is not asked every second by every page.
export const RETRY_MS = [250, 500, 1000, 2000, 4000, 8000];
export const GIVE_UP_MS = 120_000;
// What the service says when it will not have this page back, and the code
// the room then ends with.
const REFUSALS: Partial<Record<VoiceError, number>> = {
	full: CLOSE.full,
	'not-seated': CLOSE.unseated,
	'bad-token': CLOSE.unauthorised,
	'unsupported-version': CLOSE.protocol
};
// How many sessions in a row may end without their audio ever reaching the
// media server before the room ends: the network lets signalling through and
// not the media port, and trying again changes nothing.
export const UNREACHED = 2;

export class VoiceRoom {
	#options: VoiceRoomOptions;
	#session: VoiceSession | null = null;
	#muted: Set<string>;
	#sending: boolean;
	#status: PeerStatus;
	#deafened: boolean;
	#closed = false;
	#tries = 0;
	#lostAt = 0;
	#unreached = 0;
	#retry: ReturnType<typeof setTimeout> | null = null;
	// The browser is back on a network, perhaps another one: a session starts
	// ICE again, and a room waiting to come back tries now.
	#online = () => {
		if (this.#session) this.#session.networkChanged();
		else if (this.#retry) {
			clearTimeout(this.#retry);
			this.#try();
		}
	};

	private constructor(options: VoiceRoomOptions) {
		this.#options = options;
		this.#muted = new Set(options.muted ?? []);
		this.#sending = options.sending ?? true;
		this.#status = options.status ?? { muted: false, deafened: false };
		this.#deafened = options.deafened ?? false;
		// A browser back on a network, perhaps another one.
		globalThis.addEventListener?.('online', this.#online);
	}

	// Join the table's voice room. A first connection that fails throws.
	static async join(options: VoiceRoomOptions): Promise<VoiceRoom> {
		const room = new VoiceRoom(options);
		try {
			await room.#connect();
		} catch (error) {
			room.close();
			throw error;
		}
		return room;
	}

	async #connect(): Promise<void> {
		const given = this.#options.token;
		const token = typeof given === 'string' ? given : await given();
		const session = await VoiceSession.join({
			...this.#options,
			token,
			muted: [...this.#muted],
			sending: this.#sending,
			status: this.#status,
			deafened: this.#deafened,
			onclose: (code, reason) => this.#lost(session, code, reason)
		});
		if (this.#closed) {
			session.close();
			return;
		}
		this.#session = session;
		this.#tries = 0;
	}

	#lost(session: VoiceSession, code: number, reason: string): void {
		// A session that failed before it was taken on is its connect's to report.
		if (this.#session !== session) return;
		this.#session = null;
		if (this.#closed) return;
		if (typeof this.#options.token === 'string' || !COME_BACK.has(code)) {
			this.#end(code, reason);
			return;
		}
		// A session that gave itself up without its audio ever getting through.
		this.#unreached = session.gaveUp && !session.reached ? this.#unreached + 1 : 0;
		if (this.#unreached >= UNREACHED) {
			this.#end(CLOSE.unreachable, 'the media server could not be reached');
			return;
		}
		this.#options.onreconnecting?.(code);
		this.#lostAt = Date.now();
		this.#again();
	}

	#again(): void {
		const wait = RETRY_MS[Math.min(this.#tries, RETRY_MS.length - 1)];
		this.#tries += 1;
		this.#retry = setTimeout(() => this.#try(), wait);
	}

	#try(): void {
		this.#retry = null;
		if (this.#closed) return;
		this.#connect().then(
			() => {
				if (this.#session) this.#options.onreconnected?.();
			},
			(error: unknown) => {
				this.#options.log?.(`voice: coming back: ${error}`);
				if (this.#closed) return;
				// Refused for good, or gone for too long: the room ends, and says why.
				const refusal = error instanceof Refused ? REFUSALS[error.code] : undefined;
				if (refusal !== undefined) this.#end(refusal, 'refused');
				else if (Date.now() - this.#lostAt >= (this.#options.giveUpMs ?? GIVE_UP_MS)) {
					this.#end(1006, 'the voice service did not come back');
				} else this.#again();
			}
		);
	}

	#end(code: number, reason: string): void {
		this.#closed = true;
		globalThis.removeEventListener?.('online', this.#online);
		this.#options.onclose?.(code, reason);
	}

	get connected(): boolean {
		return this.#session !== null;
	}

	get leaf(): number | null {
		return this.#session?.leaf ?? null;
	}

	get epoch(): Epoch | null {
		return this.#session?.epoch ?? null;
	}

	get refused(): string[] {
		return this.#session?.refused ?? [];
	}

	get handler(): string {
		return this.#session?.handler ?? '';
	}

	get heard(): Heard[] {
		return this.#session?.heard ?? [];
	}

	get transports(): { send: msc.Transport | null; recv: msc.Transport | null } {
		return this.#session?.transports ?? { send: null, recv: null };
	}

	get member(): Member | null {
		return this.#session?.member ?? null;
	}

	get producer(): msc.Producer | null {
		return this.#session?.producer ?? null;
	}

	get silencedUntil(): number | null {
		return this.#session?.silencedUntil ?? null;
	}

	get people(): VoicePerson[] {
		return this.#session?.people ?? [];
	}

	// Change the microphone, or give it up to listen only (null).
	async setTrack(track: MediaStreamTrack | null): Promise<void> {
		this.#options.track = track;
		await this.#session?.setTrack(track);
	}

	// Start or stop sending (a mute, or push-to-talk): kept across reconnections.
	async setSending(sending: boolean): Promise<void> {
		this.#sending = sending;
		await this.#session?.setSending(sending);
	}

	// What everyone else is told of this person: muted, deafened.
	async setStatus(status: PeerStatus): Promise<void> {
		this.#status = status;
		await this.#session?.setStatus(status);
	}

	async deafen(deafened: boolean): Promise<void> {
		this.#deafened = deafened;
		await this.#session?.deafen(deafened);
	}

	async setBitrate(bitrate: Bitrate): Promise<void> {
		this.#options.bitrate = bitrate;
		await this.#session?.setBitrate(bitrate);
	}

	async tallies(): Promise<Tally[]> {
		return this.#session ? this.#session.tallies() : [];
	}

	// Mute or unmute someone, by public reference: kept across reconnections.
	async mute(player: string, muted: boolean): Promise<void> {
		if (muted) this.#muted.add(player);
		else this.#muted.delete(player);
		await this.#session?.mute(player, muted);
	}

	// The table's seats changed.
	seats(seated: Identity[]): void {
		this.#options.seated = seated;
		this.#session?.seats(seated);
	}

	// How many times this connection started ICE again (P4C.7), for the checks.
	get iceRestarts(): number {
		return this.#session?.iceRestarts ?? 0;
	}

	close(): void {
		this.#closed = true;
		globalThis.removeEventListener?.('online', this.#online);
		if (this.#retry) clearTimeout(this.#retry);
		this.#session?.close();
		this.#session = null;
	}
}

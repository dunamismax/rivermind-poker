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
import { Device, type types as msc } from 'mediasoup-client';
import { EpochKeys, type Epoch } from './group-keys.ts';
import { Member, type Identity } from './group.ts';
import { FrameCrypto } from './sframe-client.ts';
import type { Tally } from './sframe-transform.ts';
import { Refused, VoiceSocket } from './signalling-client.ts';
import {
	VOICE_PROTOCOL,
	fromBase64,
	toBase64,
	type Notice,
	type PeerInfo,
	type Requests,
	type TransportInfo
} from './signalling.ts';

// How long a member waits for each member ahead of it to commit a removal.
export const COMMIT_TURN_MS = 1000;

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
	token: string;
	// The microphone, or null to listen only.
	track: MediaStreamTrack | null;
	// Who the table shows seated, for the check of the group's members (group-keys.ts).
	seated: Identity[];
	// The public references of the people this person has muted (P4.5): their
	// audio stays paused at the voice service from the start, never sent here.
	muted?: string[];
	commitTurnMs?: number;
	onepoch?: (epoch: Epoch) => void;
	// A stream was added, or ended.
	onheard?: (heard: Heard) => void;
	onended?: (heard: Heard) => void;
	onclose?: (code: number, reason: string) => void;
	log?: (line: string) => void;
};

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

export class VoiceRoom {
	#options: VoiceRoomOptions;
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
	#closed = false;
	epoch: Epoch | null = null;
	refused: string[] = [];

	private constructor(
		options: VoiceRoomOptions,
		socket: VoiceSocket,
		welcome: Requests['hello']['response']
	) {
		this.#options = options;
		this.#socket = socket;
		this.#welcome = welcome;
		this.#identity = { player: welcome.player, seat: welcome.seat };
		this.#muted = new Set(options.muted ?? []);
		this.#keys = new EpochKeys(this.#frames);
		this.#keys.seats(options.seated);
		this.#frames.onrefused = (asked, error) => this.refused.push(`${asked}: ${error}`);
		for (const peer of welcome.peers) this.#peers.set(peer.peer, peer);
	}

	static async join(options: VoiceRoomOptions): Promise<VoiceRoom> {
		const socket = await VoiceSocket.open(options.url);
		const welcome = await socket.request('hello', {
			v: VOICE_PROTOCOL,
			table: options.table,
			token: options.token
		});
		const room = new VoiceRoom(options, socket, welcome);
		socket.onnotice = (notice) => room.#later(() => room.#notice(notice));
		socket.onclose = (code, reason) => {
			room.#shut();
			options.onclose?.(code, reason);
		};
		await room.#later(() => room.#start());
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

	tallies(): Promise<Tally[]> {
		return this.#frames.tallies();
	}

	// Mute or unmute someone, by public reference. A mute pauses their audio at
	// the voice service, which then sends this page none of it.
	mute(player: string, muted: boolean): Promise<void> {
		return this.#later(async () => {
			if (muted) this.#muted.add(player);
			else this.#muted.delete(player);
			for (const heard of this.#heard.values()) {
				if (heard.player !== player || heard.muted === muted) continue;
				const type = muted ? 'consumer.pause' : 'consumer.resume';
				await this.#socket.request(type, { consumer: heard.consumer.id });
				heard.muted = muted;
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
		this.#keys.close();
		this.#send?.close();
		this.#recv?.close();
	}

	async #start(): Promise<void> {
		this.#device = await Device.factory();
		await this.#device.load({ routerRtpCapabilities: this.#welcome.routerRtpCapabilities });
		this.#recv = await this.#transport('recv');
		if (this.#options.track) this.#send = await this.#transport('send');
		await this.#joinGroup(this.#welcome.groupInfo);
		await this.#produce();
		for (const peer of this.#peers.values()) await this.#consume(peer);
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
		return made;
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
	}

	async #produce(): Promise<void> {
		if (!this.#send || !this.#options.track || this.#producer) return;
		this.#producer = await this.#send.produce({
			track: this.#options.track,
			codecOptions: CODEC_OPTIONS,
			onRtpSender: (sender) => this.#frames.encrypt(sender)
		});
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
		// Consumers start paused at the service; a muted person's stays so.
		if (!muted) await this.#socket.request('consumer.resume', { consumer: consumer.id });
		this.#options.onheard?.(heard);
	}

	#drop(heard: Heard): void {
		heard.consumer.close();
		this.#heard.delete(heard.peer);
		this.#options.onended?.(heard);
	}

	async #notice(notice: Notice): Promise<void> {
		switch (notice.notice) {
			case 'mls':
				await this.#mls(fromBase64(notice.message)!);
				return;
			case 'producer':
				this.#peers.set(notice.peer.peer, notice.peer);
				await this.#consume(notice.peer);
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
				return;
			}
			case 'media.reset':
				// Every transport is gone at the service: make them again and send again.
				for (const heard of this.#heard.values()) this.#drop(heard);
				this.#send?.close();
				this.#recv?.close();
				this.#producer = null;
				this.#recv = await this.#transport('recv');
				if (this.#options.track) this.#send = await this.#transport('send');
				await this.#produce();
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

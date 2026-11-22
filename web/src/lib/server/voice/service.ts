// The voice service's rooms (P4C.4): one for each table with people in voice,
// each a mediasoup Router for its audio and the MLS delivery service for its
// group (delivery.ts), behind voice signalling v1 (src/lib/voice/signalling.ts).
//
// A socket's first message is `hello`, with a voice token from the table
// server (tokens.ts). Everything a room does happens in that room's order: its
// sockets' requests and their departures, one at a time, so the delivery
// service sees one commit at a time and every page hears of each change in
// the order it happened. A socket's answers come in the order it asked.
//
// The service keeps everything in memory and nothing after a room empties. It
// logs counts, durations and errors (log.ts), never who.
import { randomBytes } from 'node:crypto';
import type { types as ms } from 'mediasoup';
import { Delivery, type Outcome } from '../../voice/delivery.ts';
import type { Identity } from '../../voice/group.ts';
import {
	CLOSE,
	MAX_MESSAGE_BYTES,
	REQUEST_TYPES,
	VOICE_PROTOCOL,
	fromBase64,
	toBase64,
	type Answer,
	type ClientMessage,
	type Notice,
	type PeerInfo,
	type PeerStatus,
	type RequestType,
	type Requests,
	type VoiceError
} from '../../voice/signalling.ts';
import { redact, type Log } from './log.ts';
import { AUDIO_LEVEL_URI, type Media } from './media.ts';
import type { SeatList } from './seats.ts';
import { TokenLedger, readToken } from './tokens.ts';

// A room holds at most one socket a seat, and a table has nine.
export const MAX_PEERS = 9;
// What one socket may send: a burst, then a steady rate. Joining a full room
// takes about twenty requests; a page then sends almost nothing.
export const RATE = { burst: 60, perSecond: 20 };

// The service's end of one WebSocket.
export interface Transport {
	send(text: string): void;
	close(code: number, reason: string): void;
}

export interface Session {
	receive(text: string): void;
	closed(): void;
}

export type VoiceServiceOptions = {
	// The voice key (tokens.ts `voiceKey`).
	key: Uint8Array;
	media: Media;
	log: Log;
	// Seconds since the epoch.
	now?: () => number;
	rate?: { burst: number; perSecond: number };
};

class Failure extends Error {
	readonly code: VoiceError;
	readonly groupInfo: string | null | undefined;

	constructor(code: VoiceError, groupInfo?: string | null) {
		super(code);
		this.code = code;
		this.groupInfo = groupInfo;
	}
}

function fail(code: VoiceError, groupInfo?: string | null): never {
	throw new Failure(code, groupInfo);
}

type Peer = {
	id: string;
	identity: Identity;
	transport: Transport;
	leaf: number | null;
	send: ms.WebRtcTransport | null;
	recv: ms.WebRtcTransport | null;
	producer: ms.Producer | null;
	consumers: Map<string, ms.Consumer>;
	// What the person last said of themself (`status`, P4C.6).
	status: PeerStatus;
};

type Accepted = Extract<Outcome, { accepted: true }>;

// Who a table lets into its voice room, from its last seat list (seats.ts).
type Allowed = { at: number; seats: Set<string>; blocks: Set<string> };
const seatKey = ({ seat, player }: Identity) => `${seat}:${player}`;
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
// A list that empties a room is kept this long, so a token issued just before
// it cannot open the room again.
const EMPTY_KEPT_MS = 120_000;
type Request = Exclude<ClientMessage, { type: 'hello' }>;
type Reply = (result: object) => void;

class Room {
	readonly table: string;
	readonly number: number;
	readonly opened: number;
	readonly router: ms.Router;
	readonly delivery: Delivery;
	peers = new Map<string, Peer>();
	most = 0;
	#queue: Promise<void> = Promise.resolve();

	constructor(
		table: string,
		number: number,
		opened: number,
		router: ms.Router,
		delivery: Delivery
	) {
		this.table = table;
		this.number = number;
		this.opened = opened;
		this.router = router;
		this.delivery = delivery;
	}

	// Run `work` after everything the room was asked to do before it.
	serial<T>(work: () => Promise<T>): Promise<T> {
		const done = this.#queue.then(work);
		this.#queue = done.then(
			() => {},
			() => {}
		);
		return done;
	}

	tell(peer: Peer, notice: Notice): void {
		peer.transport.send(JSON.stringify(notice));
	}

	tellAll(notice: Notice, except?: Peer): void {
		for (const peer of this.peers.values()) if (peer !== except) this.tell(peer, notice);
	}

	info(peer: Peer): PeerInfo {
		return { peer: peer.id, leaf: peer.leaf, producer: peer.producer?.id ?? null, ...peer.status };
	}

	groupInfo(): string | null {
		const info = this.delivery.groupInfo;
		return info ? toBase64(info) : null;
	}
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= 64;

// A message of this protocol, as far as its id and type. Each request's fields
// are checked where it is handled; mediasoup checks the WebRTC parameters.
function parse(text: string): ClientMessage | null {
	let message: unknown;
	try {
		message = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isObject(message)) return null;
	if (!Number.isSafeInteger(message.id) || (message.id as number) < 0) return null;
	if (!REQUEST_TYPES.includes(message.type as RequestType)) return null;
	return message as ClientMessage;
}

function withoutAudioLevel(capabilities: ms.RtpCapabilities): ms.RtpCapabilities {
	return {
		...capabilities,
		headerExtensions: capabilities.headerExtensions?.filter(({ uri }) => uri !== AUDIO_LEVEL_URI)
	};
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class VoiceService {
	#key: Uint8Array;
	#media: Media;
	#log: Log;
	#now: () => number;
	#rate: { burst: number; perSecond: number };
	#ledger = new TokenLedger();
	#rooms = new Map<string, Room>();
	#opening = new Map<string, Promise<Room>>();
	#allowed = new Map<string, Allowed>();
	#roomsOpened = 0;
	#closing = false;

	constructor({ key, media, log, now, rate }: VoiceServiceOptions) {
		this.#key = key;
		this.#media = media;
		this.#log = (line) => log(redact(line));
		this.#now = now ?? (() => Date.now() / 1000);
		this.#rate = rate ?? RATE;
		media.onreset = () => this.#reset();
	}

	// How many rooms are open and how many people are in them.
	get counts(): { rooms: number; people: number } {
		let people = 0;
		for (const room of this.#rooms.values()) people += room.peers.size;
		return { rooms: this.#rooms.size, people };
	}

	open(transport: Transport): Session {
		let joined: { room: Room; peer: Peer } | null = null;
		let hello: Promise<void> | null = null;
		let tokens = this.#rate.burst;
		let last = this.#now();
		let gone = false;
		let departed = false;
		let queue: Promise<void> = Promise.resolve();

		const answer = (message: Answer) => {
			if (!gone) transport.send(JSON.stringify(message));
		};
		const refuse = (id: number, error: unknown) => {
			if (error instanceof Failure) {
				answer({
					id,
					ok: false,
					error: error.code,
					...(error.groupInfo !== undefined ? { groupInfo: error.groupInfo } : {})
				});
			} else {
				answer({ id, ok: false, error: 'failed' });
			}
		};
		const depart = async () => {
			gone = true;
			if (departed) return;
			departed = true;
			await hello;
			if (joined) {
				const { room, peer } = joined;
				await room.serial(() => this.#depart(room, peer));
			}
		};
		const shut = (code: number, why: string) => {
			if (gone) return;
			gone = true;
			transport.close(code, why);
			void depart();
		};

		const handle = async (message: ClientMessage) => {
			if (gone) return;
			if (message.type === 'hello') {
				if (joined) {
					answer({ id: message.id, ok: false, error: 'bad-request' });
					return;
				}
				try {
					const { room, peer, welcome } = await this.#hello(message, transport);
					joined = { room, peer };
					answer({ ...welcome, id: message.id, ok: true });
				} catch (error) {
					refuse(message.id, error);
					const code = error instanceof Failure ? error.code : 'failed';
					shut(
						code === 'bad-token'
							? CLOSE.unauthorised
							: code === 'not-seated'
								? CLOSE.unseated
								: CLOSE.protocol,
						'hello refused'
					);
				}
				return;
			}
			if (!joined) {
				answer({ id: message.id, ok: false, error: 'bad-request' });
				return;
			}
			const { room, peer } = joined;
			await room.serial(async () => {
				let replied = false;
				const reply: Reply = (result) => {
					replied = true;
					answer({ ...result, id: message.id, ok: true } as Answer);
				};
				try {
					if (room.peers.get(peer.id) !== peer) fail('failed');
					await this.#request(room, peer, message, reply);
				} catch (error) {
					if (!(error instanceof Failure)) {
						this.#log(`room ${room.number}: ${message.type} failed: ${reason(error)}`);
					}
					if (!replied) refuse(message.id, error);
				}
			});
		};

		return {
			receive: (text) => {
				if (gone) return;
				if (text.length > MAX_MESSAGE_BYTES) {
					shut(CLOSE.protocol, 'too large');
					return;
				}
				const now = this.#now();
				tokens = Math.min(this.#rate.burst, tokens + (now - last) * this.#rate.perSecond);
				last = now;
				if (tokens < 1) {
					this.#log('closed a socket that sent too much');
					shut(CLOSE.rate, 'too many messages');
					return;
				}
				tokens -= 1;
				const message = parse(text);
				if (!message || (!joined && !hello && message.type !== 'hello')) {
					shut(CLOSE.protocol, 'not voice signalling v1');
					return;
				}
				const done = queue.then(() => handle(message));
				if (message.type === 'hello' && !hello) hello = done.catch(() => {});
				queue = done.catch((error: unknown) => {
					this.#log(`a request failed: ${reason(error)}`);
				});
			},
			closed: () => {
				void depart();
			}
		};
	}

	// The table's room, opened if nobody is in voice there yet.
	async #roomFor(table: string): Promise<Room> {
		const open = this.#rooms.get(table);
		if (open) return open;
		let opening = this.#opening.get(table);
		if (!opening) {
			opening = (async () => {
				const router = await this.#media.createRouter();
				const delivery = await Delivery.create(randomBytes(16));
				const room = new Room(table, ++this.#roomsOpened, this.#now(), router, delivery);
				this.#rooms.set(table, room);
				this.#log(`room ${room.number} opened`);
				return room;
			})();
			this.#opening.set(table, opening);
			const forget = () => this.#opening.delete(table);
			opening.then(forget, forget);
		}
		return opening;
	}

	async #hello(
		message: Extract<ClientMessage, { type: 'hello' }>,
		transport: Transport
	): Promise<{ room: Room; peer: Peer; welcome: Requests['hello']['response'] }> {
		if (this.#closing) fail('failed');
		if (message.v !== VOICE_PROTOCOL) fail('unsupported-version');
		const now = this.#now();
		const token = readToken(this.#key, message.token, message.table, now);
		if (typeof token === 'string') {
			this.#log(`refused a token: ${token}`);
			fail('bad-token');
		}
		if (!this.#ledger.admit(token, now)) {
			this.#log('refused a token: reused');
			fail('bad-token');
		}
		const identity: Identity = { player: token.player, seat: token.seat };
		// A room can close while someone waits to come in; they open the next one.
		for (;;) {
			const room = await this.#roomFor(token.table);
			const entered = await room.serial(async () => {
				if (this.#rooms.get(token.table) !== room) return null;
				// The table has the last word on who is seated. Before it has said
				// (the voice service has just started), the token alone admits.
				const allowed = this.#allowed.get(token.table);
				if (allowed && !allowed.seats.has(seatKey(identity))) {
					this.#log('refused a socket: not seated');
					fail('not-seated');
				}
				// One socket a seat: a page that comes back, or a new holder of the seat,
				// takes the place of whoever had it.
				for (const other of [...room.peers.values()]) {
					if (other.identity.seat === identity.seat) {
						other.transport.close(CLOSE.replaced, 'the seat joined again');
						await this.#depart(room, other);
					}
				}
				if (this.#rooms.get(token.table) !== room) return null;
				if (room.peers.size >= MAX_PEERS) fail('too-many');
				const peer: Peer = {
					id: randomBytes(9).toString('base64url'),
					identity,
					transport,
					leaf: null,
					send: null,
					recv: null,
					producer: null,
					consumers: new Map(),
					status: { muted: false, deafened: false }
				};
				const peers = [...room.peers.values()].map((other) => room.info(other));
				room.peers.set(peer.id, peer);
				room.most = Math.max(room.most, room.peers.size);
				this.#log(`room ${room.number}: someone joined (${room.peers.size} in voice)`);
				const welcome: Requests['hello']['response'] = {
					v: VOICE_PROTOCOL,
					peer: peer.id,
					seat: identity.seat,
					player: identity.player,
					service: toBase64(room.delivery.servicePublicKey),
					group: toBase64(room.delivery.groupId),
					groupInfo: room.groupInfo(),
					routerRtpCapabilities: withoutAudioLevel(room.router.rtpCapabilities),
					peers,
					statuses: true
				};
				return { room, peer, welcome };
			});
			if (entered) return entered;
		}
	}

	// Someone's socket closed, or another took their seat: their audio stops,
	// everyone hears so, and the group is asked to remove their leaf. The last
	// to leave closes the room.
	async #depart(room: Room, peer: Peer): Promise<void> {
		if (room.peers.get(peer.id) !== peer) return;
		room.peers.delete(peer.id);
		// Their audio ends for everyone now, before anyone hears they left, rather
		// than whenever mediasoup reports the producer closed.
		if (peer.producer) {
			for (const other of room.peers.values()) {
				for (const consumer of [...other.consumers.values()]) {
					if (consumer.producerId !== peer.producer.id) continue;
					other.consumers.delete(consumer.id);
					consumer.close();
					room.tell(other, { notice: 'consumer.closed', consumer: consumer.id });
				}
			}
		}
		peer.send?.close();
		peer.recv?.close();
		room.tellAll({ notice: 'left', peer: peer.id });
		this.#log(`room ${room.number}: someone left (${room.peers.size} in voice)`);
		if (room.peers.size === 0) {
			room.delivery.close();
			room.router.close();
			if (this.#rooms.get(room.table) === room) this.#rooms.delete(room.table);
			const lasted = Math.round(this.#now() - room.opened);
			this.#log(`room ${room.number} closed after ${lasted} s, at most ${room.most} in voice`);
			return;
		}
		if (peer.leaf === null) return;
		// With nobody left in the group, it is gone: the next to join makes a new one.
		if (![...room.peers.values()].some((one) => one.leaf !== null)) {
			room.delivery.close();
			return;
		}
		const proposal = await room.delivery.remove(peer.leaf);
		if (proposal) room.tellAll({ notice: 'mls', message: toBase64(proposal) });
	}

	async #request(room: Room, peer: Peer, message: Request, reply: Reply): Promise<void> {
		switch (message.type) {
			case 'group.create': {
				if (peer.leaf !== null) fail('bad-request');
				const groupInfo = fromBase64(message.groupInfo) ?? fail('malformed');
				const outcome = await room.delivery.open(groupInfo, peer.identity);
				if (!outcome.accepted) fail(outcome.refusal, room.groupInfo());
				peer.leaf = (outcome as Accepted).joined!.leaf;
				reply({ epoch: 0, leaf: peer.leaf });
				return;
			}
			case 'group.commit': {
				const commit = fromBase64(message.commit) ?? fail('malformed');
				const groupInfo = fromBase64(message.groupInfo) ?? fail('malformed');
				const outcome = await room.delivery.submit(commit, groupInfo, peer.identity, peer.leaf);
				if (!outcome.accepted) fail(outcome.refusal, room.groupInfo());
				await this.#accepted(room, peer, commit, outcome as Accepted, reply);
				return;
			}
			case 'transport.create': {
				const direction = message.direction;
				if (direction !== 'send' && direction !== 'recv') fail('bad-request');
				if (peer[direction]) fail('too-many');
				const transport = await room.router.createWebRtcTransport({
					webRtcServer: this.#media.server,
					enableUdp: true,
					enableTcp: true,
					preferUdp: true
				});
				peer[direction] = transport;
				transport.on('listenserverclose', () => {
					if (peer[direction] === transport) peer[direction] = null;
				});
				reply({
					transport: transport.id,
					iceParameters: transport.iceParameters,
					iceCandidates: transport.iceCandidates,
					dtlsParameters: transport.dtlsParameters
				});
				return;
			}
			case 'transport.connect': {
				const transport = this.#transport(peer, message.transport);
				if (!isObject(message.dtlsParameters)) fail('bad-request');
				await transport.connect({
					dtlsParameters: message.dtlsParameters as unknown as ms.DtlsParameters
				});
				reply({});
				return;
			}
			case 'produce': {
				const transport = this.#transport(peer, message.transport);
				if (transport !== peer.send) fail('bad-request');
				if (peer.producer) fail('too-many');
				// Audio leaves a page only sealed under a key of the group, so a page
				// sends nothing until it is in it.
				if (peer.leaf === null) fail('not-allowed');
				const parameters = message.rtpParameters as unknown;
				if (!isObject(parameters)) fail('bad-request');
				const rtpParameters = parameters as unknown as ms.RtpParameters;
				// Audio levels on the wire would tell the server who is speaking.
				if (rtpParameters.headerExtensions?.some(({ uri }) => uri === AUDIO_LEVEL_URI)) {
					fail('not-allowed');
				}
				const producer = await transport.produce({ kind: 'audio', rtpParameters });
				peer.producer = producer;
				producer.on('transportclose', () => {
					if (peer.producer === producer) peer.producer = null;
				});
				reply({ producer: producer.id });
				room.tellAll({ notice: 'producer', peer: room.info(peer) }, peer);
				return;
			}
			case 'producer.pause':
			case 'producer.resume': {
				const producer = peer.producer ?? fail('unknown');
				await (message.type === 'producer.pause' ? producer.pause() : producer.resume());
				reply({});
				return;
			}
			case 'consume': {
				const transport = this.#transport(peer, message.transport);
				if (transport !== peer.recv) fail('bad-request');
				if (!isId(message.producer)) fail('bad-request');
				const owner = [...room.peers.values()].find((one) => one.producer?.id === message.producer);
				if (!owner || owner === peer) fail('unknown');
				// Either of two people who blocked the other never hears the other (P4.5).
				if (this.#blocked(room, peer, owner)) fail('not-allowed');
				if (peer.consumers.size >= MAX_PEERS) fail('too-many');
				for (const one of peer.consumers.values()) {
					if (one.producerId === message.producer) fail('too-many');
				}
				if (!isObject(message.rtpCapabilities)) fail('bad-request');
				const rtpCapabilities = message.rtpCapabilities as unknown as ms.RtpCapabilities;
				if (!room.router.canConsume({ producerId: message.producer, rtpCapabilities })) {
					fail('bad-request');
				}
				const consumer = await transport.consume({
					producerId: message.producer,
					rtpCapabilities,
					paused: true
				});
				peer.consumers.set(consumer.id, consumer);
				consumer.on('producerclose', () => {
					// Unless the service closed it first, as a departure or a block does.
					if (!peer.consumers.delete(consumer.id)) return;
					if (room.peers.get(peer.id) === peer) {
						room.tell(peer, { notice: 'consumer.closed', consumer: consumer.id });
					}
				});
				consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
				reply({
					consumer: consumer.id,
					producer: message.producer,
					rtpParameters: consumer.rtpParameters
				});
				return;
			}
			case 'consumer.pause':
			case 'consumer.resume': {
				if (!isId(message.consumer)) fail('bad-request');
				const consumer = peer.consumers.get(message.consumer) ?? fail('unknown');
				await (message.type === 'consumer.pause' ? consumer.pause() : consumer.resume());
				reply({});
				return;
			}
			case 'status': {
				const { muted, deafened } = message;
				if (typeof muted !== 'boolean' || typeof deafened !== 'boolean') fail('bad-request');
				const changed = muted !== peer.status.muted || deafened !== peer.status.deafened;
				peer.status = { muted, deafened };
				reply({});
				if (changed) room.tellAll({ notice: 'peer', peer: room.info(peer) }, peer);
				return;
			}
		}
		fail('bad-request');
	}

	#transport(peer: Peer, id: unknown): ms.WebRtcTransport {
		if (!isId(id)) fail('bad-request');
		return [peer.send, peer.recv].find((one) => one?.id === id) ?? fail('unknown');
	}

	// A commit the service accepted. Everyone else applies it; its author hears
	// it was accepted; then everyone, the author and a newcomer included, gets
	// the removals still wanted, which nobody can carry out without having seen.
	async #accepted(
		room: Room,
		peer: Peer,
		commit: Uint8Array,
		outcome: Accepted,
		reply: Reply
	): Promise<void> {
		const stale = outcome.joined ? peer.leaf : null;
		if (outcome.joined) peer.leaf = outcome.joined.leaf;
		room.tellAll({ notice: 'mls', message: toBase64(commit) }, peer);
		reply({ epoch: Number(outcome.epoch), leaf: outcome.joined?.leaf ?? null });
		for (const proposal of outcome.proposals) {
			room.tellAll({ notice: 'mls', message: toBase64(proposal) });
		}
		// A page that joined again on the same socket leaves its old leaf behind.
		if (stale !== null) {
			const proposal = await room.delivery.remove(stale);
			if (proposal) room.tellAll({ notice: 'mls', message: toBase64(proposal) });
		}
		if (outcome.joined && peer.producer) {
			room.tellAll({ notice: 'producer', peer: room.info(peer) }, peer);
		}
		// The commit removed someone still connected: they are out of the group.
		for (const leaf of outcome.removed) {
			for (const one of [...room.peers.values()]) {
				if (one.leaf === leaf) {
					one.leaf = null;
					one.transport.close(CLOSE.removed, 'removed from the group');
					await this.#depart(room, one);
				}
			}
		}
	}

	#blocked(room: Room, a: Peer, b: Peer): boolean {
		const allowed = this.#allowed.get(room.table);
		return allowed?.blocks.has(pairKey(a.identity.player, b.identity.player)) ?? false;
	}

	// The table server's list of who may be in a table's voice room (seats.ts).
	// Anyone in the room the list no longer names is taken out at once, and the
	// group is asked to remove their leaf; anyone now blocked by or blocking
	// someone stops hearing them. False when the list is older than one applied.
	async seats(list: SeatList): Promise<boolean> {
		const known = this.#allowed.get(list.table);
		if (known && list.at <= known.at) return false;
		const allowed: Allowed = {
			at: list.at,
			seats: new Set(list.seats.map(seatKey)),
			blocks: new Set(list.blocks.map(([a, b]) => pairKey(a, b)))
		};
		this.#allowed.set(list.table, allowed);
		for (const [table, one] of this.#allowed) {
			if (one.seats.size === 0 && one.at < list.at - EMPTY_KEPT_MS) this.#allowed.delete(table);
		}
		const room = this.#rooms.get(list.table);
		if (!room) return true;
		await room.serial(async () => {
			for (const peer of [...room.peers.values()]) {
				if (allowed.seats.has(seatKey(peer.identity))) continue;
				peer.transport.close(CLOSE.unseated, 'not seated at the table');
				await this.#depart(room, peer);
			}
			for (const peer of room.peers.values()) {
				for (const consumer of [...peer.consumers.values()]) {
					const owner = [...room.peers.values()].find(
						(one) => one.producer?.id === consumer.producerId
					);
					if (!owner || !this.#blocked(room, peer, owner)) continue;
					consumer.close();
					peer.consumers.delete(consumer.id);
					room.tell(peer, { notice: 'consumer.closed', consumer: consumer.id });
				}
			}
		});
		return true;
	}

	// The media server started again: every transport, producer and consumer is gone.
	#reset(): void {
		for (const room of this.#rooms.values()) {
			for (const peer of room.peers.values()) {
				peer.send = null;
				peer.recv = null;
				peer.producer = null;
				peer.consumers.clear();
				room.tell(peer, { notice: 'media.reset' });
			}
		}
		this.#log(`the media server started again, with ${this.counts.rooms} rooms open`);
	}

	// Stop: every socket is told the service is restarting.
	close(): void {
		this.#closing = true;
		for (const room of this.#rooms.values()) {
			for (const peer of room.peers.values()) {
				peer.transport.close(CLOSE.restarting, 'the voice service is restarting');
			}
			room.router.close();
		}
		this.#rooms.clear();
	}
}

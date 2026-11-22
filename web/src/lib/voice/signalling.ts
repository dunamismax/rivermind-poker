// Voice signalling v1 (P4C.4): what a page and the voice service
// (rivermind-poker-voice) say to each other over the `/voice` WebSocket. It is
// apart from table protocol v2, which voice never changes, and carries a
// version from its first message: `hello` names it, and the service answers
// only the version it speaks.
//
// A page sends requests, each with an `id` of its own choosing, and the service
// answers each with the same `id`, in the order they arrived. The service also
// sends notices, which have no `id`. Every message is one JSON text frame.
//
//   1. hello            the table and a voice token from the table server; the
//                       answer holds what a page needs to create or join the
//                       table's MLS group and to load mediasoup-client
//   2. group.create     the first person makes the group (docs/voice.md)
//      group.commit     everyone after joins by external commit, and members
//                       commit the removals the service proposes
//   3. transport.*      a send and a receive WebRTC transport
//      produce          the page's one audio track, once it is in the group
//      consume          another person's track, paused until consumer.resume
//
// MLS messages travel as base64 of their TLS encoding (group.ts). The service
// passes on every commit it accepts, and proposes removals, in `mls` notices.
// It holds no key and can read no frame (delivery.ts).
//
// Nothing here imports `#lib`, so the page, the service and Node all load this
// file as it is. The mediasoup types are mediasoup-client's: the service hands
// what it receives to mediasoup, which checks it.
import type { types as msc } from 'mediasoup-client';

export const VOICE_PROTOCOL = 1;
export const VOICE_PATH = '/voice';

// The largest frame either side sends. A GroupInfo for a table of nine whose
// pages all reloaded at once (eighteen leaves) is about 6 kB, 8 kB in base64.
export const MAX_MESSAGE_BYTES = 32 * 1024;

// An MLS message or GroupInfo, as base64 (RFC 4648 section 4, with padding).
export type Base64 = string;

// What `POST /api/tables/{id}/voice` answers a seated person (P4C.5): a token
// for `hello`, good for one socket within a minute, and the path of the voice
// service on the site's own origin.
export type VoiceTokenResponse = { table: string; seat: number; token: string; url: string };

// Someone else in the room, as the service knows them: a name for their
// socket, the leaf they hold in the group once they are in it, and their
// audio once they send it. Who a leaf is, a page reads from its own copy of
// the group, never from the service (docs/voice.md, threat model).
export type PeerInfo = { peer: string; leaf: number | null; producer: string | null };

// A WebRTC transport, for mediasoup-client's createSendTransport and
// createRecvTransport (which call `transport` its `id`).
export type TransportInfo = {
	transport: string;
	iceParameters: msc.IceParameters;
	iceCandidates: msc.IceCandidate[];
	dtlsParameters: msc.DtlsParameters;
};

export type Requests = {
	hello: {
		request: { v: number; table: string; token: string };
		response: {
			v: typeof VOICE_PROTOCOL;
			// This socket's name in the room.
			peer: string;
			// Who the token says this page is: a leaf's identity must say the same (group.ts).
			seat: number;
			player: string;
			// What Member.create and Member.join need.
			service: Base64;
			group: Base64;
			// The GroupInfo to join from, or null to create the group.
			groupInfo: Base64 | null;
			// The Router's capabilities, without the audio-level extension.
			routerRtpCapabilities: msc.RtpCapabilities;
			peers: PeerInfo[];
		};
	};
	'group.create': {
		request: { groupInfo: Base64 };
		response: { epoch: number; leaf: number };
	};
	'group.commit': {
		request: { commit: Base64; groupInfo: Base64 };
		// `leaf` is the newcomer's own leaf after an external commit, else null.
		response: { epoch: number; leaf: number | null };
	};
	'transport.create': {
		request: { direction: 'send' | 'recv' };
		response: TransportInfo;
	};
	'transport.connect': {
		request: { transport: string; dtlsParameters: msc.DtlsParameters };
		response: Record<string, never>;
	};
	produce: {
		request: { transport: string; rtpParameters: msc.RtpParameters };
		response: { producer: string };
	};
	'producer.pause': { request: Record<string, never>; response: Record<string, never> };
	'producer.resume': { request: Record<string, never>; response: Record<string, never> };
	consume: {
		request: { transport: string; producer: string; rtpCapabilities: msc.RtpCapabilities };
		response: { consumer: string; producer: string; rtpParameters: msc.RtpParameters };
	};
	'consumer.pause': { request: { consumer: string }; response: Record<string, never> };
	'consumer.resume': { request: { consumer: string }; response: Record<string, never> };
};

export type RequestType = keyof Requests;
export const REQUEST_TYPES: readonly RequestType[] = [
	'hello',
	'group.create',
	'group.commit',
	'transport.create',
	'transport.connect',
	'produce',
	'producer.pause',
	'producer.resume',
	'consume',
	'consumer.pause',
	'consumer.resume'
];

export type ClientMessage = {
	[T in RequestType]: { id: number; type: T } & Requests[T]['request'];
}[RequestType];

// Why a request was refused. The MLS ones are delivery.ts's refusals.
export type VoiceError =
	// Not a message of this protocol, or not one that may come now.
	| 'bad-request'
	| 'unsupported-version'
	// The token is not genuine, is for another table, has expired or was used.
	| 'bad-token'
	// The table does not have this person in that seat now (P4C.5).
	| 'not-seated'
	// Something the request names that this socket does not have.
	| 'unknown'
	// More of something than a person may have: transports, producers, consumers.
	| 'too-many'
	// Sending audio before joining the group, or with the audio-level extension,
	// or hearing someone either of you blocked.
	| 'not-allowed'
	// The room is gone, or the media server could not do what was asked.
	| 'failed'
	| 'malformed'
	| 'no-group'
	| 'group-exists'
	| 'epoch-taken'
	| 'bad-group-info';

export type Answer<T extends RequestType = RequestType> =
	| ({ id: number; ok: true } & Requests[T]['response'])
	// A refused group.create or group.commit carries the GroupInfo to start
	// again from: null to create the group, else join it (again).
	| { id: number; ok: false; error: VoiceError; groupInfo?: Base64 | null };

export type Notice =
	// A commit the service accepted, or a removal it proposes: apply it (Member.receive).
	| { notice: 'mls'; message: Base64 }
	// Someone in the room sends audio now.
	| { notice: 'producer'; peer: PeerInfo }
	// A consumer of this page's ended, because its producer did.
	| { notice: 'consumer.closed'; consumer: string }
	// Someone's socket closed. Their leaf, if they had one, is proposed for removal.
	| { notice: 'left'; peer: string }
	// The media server started again (its public address changed): every
	// transport is gone. The group stands; make the transports again.
	| { notice: 'media.reset' };

export type ServerMessage = Answer | Notice;

// Close codes, in the range RFC 6455 leaves to applications.
export const CLOSE = {
	// The service is stopping (a restart or deploy).
	restarting: 1012,
	// Not this protocol, or a frame over the limit.
	protocol: 4400,
	// The hello's token was refused.
	unauthorised: 4401,
	// Too many messages.
	rate: 4429,
	// The same seat joined again from another socket.
	replaced: 4409,
	// The group removed this page's leaf.
	removed: 4410,
	// The table no longer has this person in voice: they stood up, went bust or
	// left, the table closed, or nobody else is seated (P4C.5).
	unseated: 4403
} as const;

// Base64 both ways, in the browser and in Node.
export function toBase64(bytes: Uint8Array): Base64 {
	let text = '';
	for (let at = 0; at < bytes.length; at += 0x8000) {
		text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	}
	return btoa(text);
}

// Null for anything that is not canonical base64 with padding.
export function fromBase64(text: unknown, maxBytes = MAX_MESSAGE_BYTES): Uint8Array | null {
	if (typeof text !== 'string' || text.length === 0 || text.length > (maxBytes / 3) * 4 + 4) {
		return null;
	}
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return null;
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
	return toBase64(bytes) === text ? bytes : null;
}

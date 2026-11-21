// The prototype's signalling (P4C.1): JSON requests with an id, answered in
// order, and notices pushed to the room. Voice signalling v1 (P4C.4) replaces it.
import type { types as mediasoup } from 'mediasoup';

export type PeerInfo = { peerId: string; kid: number; producerId: string | null };

export type TransportInfo = {
	id: string;
	iceParameters: mediasoup.IceParameters;
	iceCandidates: mediasoup.IceCandidate[];
	dtlsParameters: mediasoup.DtlsParameters;
};

export type Requests = {
	join: {
		request: { room: string };
		response: {
			peerId: string;
			kid: number;
			routerRtpCapabilities: mediasoup.RtpCapabilities;
			peers: PeerInfo[];
		};
	};
	createTransport: { request: { direction: 'send' | 'recv' }; response: TransportInfo };
	connectTransport: {
		request: { transportId: string; dtlsParameters: mediasoup.DtlsParameters };
		response: Record<string, never>;
	};
	produce: {
		request: { transportId: string; rtpParameters: mediasoup.RtpParameters };
		response: { id: string };
	};
	consume: {
		request: {
			transportId: string;
			producerId: string;
			rtpCapabilities: mediasoup.RtpCapabilities;
		};
		response: { id: string; producerId: string; rtpParameters: mediasoup.RtpParameters };
	};
	resume: { request: { consumerId: string }; response: Record<string, never> };
};

export type Method = keyof Requests;

export type ClientMessage = {
	[M in Method]: { id: number; method: M; data: Requests[M]['request'] };
}[Method];

export type Notice = { notice: 'producer'; peer: PeerInfo } | { notice: 'left'; peerId: string };

export type ServerMessage =
	{ id: number; ok: true; data: unknown } | { id: number; ok: false; error: string } | Notice;

// What GET /stats answers: the room's size and what the service has cost so far.
export type ServiceStats = {
	rooms: { room: string; peers: number; producers: number; consumers: number }[];
	// Microseconds of CPU and bytes of memory, for the Node process and the mediasoup worker.
	node: { cpuMicros: number; rssBytes: number };
	worker: { cpuMicros: number; rssBytes: number };
	// Bytes through every WebRTC transport, as mediasoup counts them.
	bytesReceived: number;
	bytesSent: number;
	// What a listener attached at the SFU, holding no key, saw of each producer's first packets.
	taps: {
		room: string;
		kid: number;
		packets: number;
		prototypeFrames: number;
		headerExtensionIds: number[];
		audioLevelId: number | null;
	}[];
	producerHeaderExtensions: string[];
	consumerHeaderExtensions: string[];
};

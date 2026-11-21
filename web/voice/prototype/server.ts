// The voice prototype's service (P4C.1): one mediasoup worker with one
// WebRtcServer on a single UDP and TCP port, one Router per room, a WebSocket
// for signalling and the built test page, all on one loopback origin with the
// site's CSP. It checks the design in docs/voice.md; the real service is P4C.4.
//
//   node voice/prototype/server.ts [--port 4390] [--rtc-port 44390]
//                                  [--listen-ip ADDRESS]... [--announced ADDRESS]
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createWorker, type types as mediasoup } from 'mediasoup';
import { build } from 'vite';
import { WebSocketServer, type WebSocket } from 'ws';
import { LAYOUT, decodeHeader, partsOf } from '../../src/lib/voice/sframe.ts';
import {
	AUDIO_LEVEL_URI,
	type ClientMessage,
	type Notice,
	type PeerInfo,
	type Requests,
	type ServerMessage,
	type ServiceStats,
	type TransportInfo
} from './signalling.ts';

const { values: args } = parseArgs({
	options: {
		port: { type: 'string', default: '4390' },
		'rtc-port': { type: 'string', default: '44390' },
		// Default: loopback and this machine's first LAN address.
		'listen-ip': { type: 'string', multiple: true },
		announced: { type: 'string' }
	}
});
const port = Number(args.port);
const rtcPort = Number(args['rtc-port']);
const here = import.meta.dirname;
const dist = path.resolve(here, '../../node_modules/.cache/voice-prototype');

// Opus as docs/voice.md sets it. Bitrate, DTX and the frame length are the
// sender's choice (the client's codec options); FEC is asked of every sender.
const mediaCodecs: mediasoup.RouterRtpCodecCapability[] = [
	{
		kind: 'audio',
		mimeType: 'audio/opus',
		clockRate: 48000,
		channels: 2,
		parameters: { useinbandfec: 1 }
	}
];

// How many of a producer's first packets the keyless listener looks at.
const TAP_PACKETS = 150;

type Tap = ServiceStats['taps'][number];
type Peer = {
	id: string;
	kid: number;
	socket: WebSocket;
	audioLevel: boolean;
	tcpOnly: boolean;
	transports: Map<string, mediasoup.WebRtcTransport>;
	producer: mediasoup.Producer | null;
	consumers: Map<string, mediasoup.Consumer>;
};
type Room = {
	name: string;
	router: mediasoup.Router;
	direct: mediasoup.DirectTransport;
	peers: Map<string, Peer>;
	nextKid: number;
};

await build({
	configFile: false,
	root: here,
	logLevel: 'warn',
	build: { outDir: dist, emptyOutDir: true, minify: false, target: 'es2022' }
});

const worker = await createWorker({ logLevel: 'warn' });
worker.on('died', (error) => {
	console.error('mediasoup worker died', error);
	process.exit(1);
});
// Chromium and WebKit connect to a media address on loopback. Firefox's ICE
// fails against one, so the service also listens on the LAN address.
const lan = Object.values(networkInterfaces())
	.flat()
	.find((address) => address?.family === 'IPv4' && !address.internal)?.address;
const listenIps = args['listen-ip'] ?? ['127.0.0.1', ...(lan ? [lan] : [])];
const webRtcServer = await worker.createWebRtcServer({
	listenInfos: listenIps.flatMap((ip) =>
		(['udp', 'tcp'] as const).map((protocol) => ({
			protocol,
			ip,
			announcedAddress: args.announced,
			port: rtcPort
		}))
	)
});

const rooms = new Map<string, Room>();
const taps: Tap[] = [];
let nextPeer = 1;

async function roomNamed(name: string): Promise<Room> {
	let room = rooms.get(name);
	if (!room) {
		const router = await worker.createRouter({ mediaCodecs });
		room = {
			name,
			router,
			direct: await router.createDirectTransport(),
			peers: new Map(),
			nextKid: 0
		};
		rooms.set(name, room);
	}
	return room;
}

function withoutAudioLevel(capabilities: mediasoup.RtpCapabilities): mediasoup.RtpCapabilities {
	return {
		...capabilities,
		headerExtensions: capabilities.headerExtensions?.filter(
			(extension) => extension.uri !== AUDIO_LEVEL_URI
		)
	};
}

// The header extension ids present in an RTP packet, and its payload.
function parseRtp(packet: Buffer): { extensionIds: number[]; payload: Buffer } {
	const extensionIds: number[] = [];
	let offset = 12 + (packet[0] & 0x0f) * 4;
	if (packet[0] & 0x10) {
		const profile = packet.readUInt16BE(offset);
		const end = offset + 4 + packet.readUInt16BE(offset + 2) * 4;
		let at = offset + 4;
		const twoByte = (profile & 0xfff0) === 0x1000;
		while ((profile === 0xbede || twoByte) && at < end) {
			if (packet[at] === 0) {
				at += 1;
			} else if (twoByte) {
				extensionIds.push(packet[at]);
				at += 2 + packet[at + 1];
			} else {
				if (packet[at] >> 4 === 15) break;
				extensionIds.push(packet[at] >> 4);
				at += 2 + (packet[at] & 0x0f);
			}
		}
		offset = end;
	}
	const end = packet[0] & 0x20 ? packet.length - packet[packet.length - 1] : packet.length;
	return { extensionIds, payload: packet.subarray(offset, end) };
}

// A listener attached at the SFU with no key: it receives what every other
// consumer receives, and records what it can tell about it.
async function tap(room: Room, peer: Peer, producer: mediasoup.Producer): Promise<void> {
	const consumer = await room.direct.consume({
		producerId: producer.id,
		rtpCapabilities: room.router.rtpCapabilities
	});
	const seen: Tap = {
		room: room.name,
		kid: peer.kid,
		packets: 0,
		sframeFrames: 0,
		headerExtensionIds: [],
		audioLevelId:
			consumer.rtpParameters.headerExtensions?.find(({ uri }) => uri === AUDIO_LEVEL_URI)?.id ??
			null
	};
	taps.push(seen);
	consumer.on('rtp', (packet) => {
		const { extensionIds, payload } = parseRtp(packet);
		seen.packets += 1;
		// All the listener can read is the header in the clear: who sealed the frame.
		const header = decodeHeader(payload);
		if (header && partsOf(LAYOUT, header.kid)?.sender === peer.kid) seen.sframeFrames += 1;
		for (const id of extensionIds) {
			if (!seen.headerExtensionIds.includes(id)) seen.headerExtensionIds.push(id);
		}
		if (seen.packets >= TAP_PACKETS) consumer.close();
	});
}

function send(socket: WebSocket, message: ServerMessage): void {
	if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function tell(room: Room, except: Peer, notice: Notice): void {
	for (const peer of room.peers.values()) if (peer !== except) send(peer.socket, notice);
}

function transportInfo(transport: mediasoup.WebRtcTransport): TransportInfo {
	return {
		id: transport.id,
		iceParameters: transport.iceParameters,
		iceCandidates: transport.iceCandidates,
		dtlsParameters: transport.dtlsParameters
	};
}

type Session = { room: Room; peer: Peer };
type Handlers = {
	[M in keyof Requests]: (
		data: Requests[M]['request'],
		session: Session
	) => Promise<Requests[M]['response']>;
};

const handlers: Omit<Handlers, 'join'> = {
	async createTransport(_data, { room, peer }) {
		// Both protocols on the one port, UDP first; `tcp=1` offers TCP alone, as a
		// network that blocks UDP would leave it.
		const transport = await room.router.createWebRtcTransport({
			webRtcServer,
			enableUdp: !peer.tcpOnly,
			enableTcp: true,
			preferUdp: true
		});
		peer.transports.set(transport.id, transport);
		return transportInfo(transport);
	},
	async connectTransport({ transportId, dtlsParameters }, { peer }) {
		await peer.transports.get(transportId)!.connect({ dtlsParameters });
		return {};
	},
	async produce({ transportId, rtpParameters }, { room, peer }) {
		// The service refuses a sender that negotiated audio levels: they would tell it who is speaking.
		const levels = rtpParameters.headerExtensions?.some(({ uri }) => uri === AUDIO_LEVEL_URI);
		if (levels && !peer.audioLevel) throw new Error('audio-level extension refused');
		const producer = await peer.transports
			.get(transportId)!
			.produce({ kind: 'audio', rtpParameters });
		peer.producer = producer;
		await tap(room, peer, producer);
		tell(room, peer, {
			notice: 'producer',
			peer: { peerId: peer.id, kid: peer.kid, producerId: producer.id }
		});
		return { id: producer.id };
	},
	async consume({ transportId, producerId, rtpCapabilities }, { peer }) {
		const consumer = await peer.transports
			.get(transportId)!
			.consume({ producerId, rtpCapabilities, paused: true });
		peer.consumers.set(consumer.id, consumer);
		return { id: consumer.id, producerId, rtpParameters: consumer.rtpParameters };
	},
	async resume({ consumerId }, { peer }) {
		await peer.consumers.get(consumerId)!.resume();
		return {};
	}
};

async function join(
	socket: WebSocket,
	data: Requests['join']['request'],
	{ audioLevel, tcpOnly }: { audioLevel: boolean; tcpOnly: boolean }
) {
	const room = await roomNamed(data.room);
	const peer: Peer = {
		id: `p${nextPeer++}`,
		kid: room.nextKid++,
		socket,
		audioLevel,
		tcpOnly,
		transports: new Map(),
		producer: null,
		consumers: new Map()
	};
	const peers: PeerInfo[] = [...room.peers.values()].map((other) => ({
		peerId: other.id,
		kid: other.kid,
		producerId: other.producer?.id ?? null
	}));
	room.peers.set(peer.id, peer);
	const capabilities = room.router.rtpCapabilities;
	const response: Requests['join']['response'] = {
		peerId: peer.id,
		kid: peer.kid,
		routerRtpCapabilities: audioLevel ? capabilities : withoutAudioLevel(capabilities),
		peers
	};
	return { session: { room, peer }, response };
}

function leave({ room, peer }: Session): void {
	for (const transport of peer.transports.values()) transport.close();
	room.peers.delete(peer.id);
	tell(room, peer, { notice: 'left', peerId: peer.id });
	if (room.peers.size === 0) {
		room.router.close();
		rooms.delete(room.name);
	}
}

function rssBytes(pid: number): number {
	return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })) * 1024;
}

async function stats(): Promise<ServiceStats> {
	const usage = await worker.getResourceUsage();
	const cpu = process.cpuUsage();
	const all = [...rooms.values()];
	const peers = all.flatMap((room) => [...room.peers.values()]);
	let bytesReceived = 0;
	let bytesSent = 0;
	for (const peer of peers) {
		for (const transport of peer.transports.values()) {
			for (const stat of await transport.getStats()) {
				bytesReceived += stat.bytesReceived;
				bytesSent += stat.bytesSent;
			}
		}
	}
	const uris = (parameters: mediasoup.RtpParameters[]) => [
		...new Set(parameters.flatMap((one) => one.headerExtensions?.map(({ uri }) => uri) ?? []))
	];
	return {
		rooms: all.map((room) => ({
			room: room.name,
			peers: room.peers.size,
			producers: [...room.peers.values()].filter((peer) => peer.producer).length,
			consumers: [...room.peers.values()].reduce((sum, peer) => sum + peer.consumers.size, 0)
		})),
		node: { cpuMicros: cpu.user + cpu.system, rssBytes: process.memoryUsage.rss() },
		// mediasoup reports the worker's CPU time in milliseconds.
		worker: {
			cpuMicros: (usage.ru_utime + usage.ru_stime) * 1000,
			rssBytes: rssBytes(worker.pid)
		},
		bytesReceived,
		bytesSent,
		taps,
		producerHeaderExtensions: uris(peers.flatMap((peer) => peer.producer?.rtpParameters ?? [])),
		consumerHeaderExtensions: uris(
			peers.flatMap((peer) => [...peer.consumers.values()].map((one) => one.rtpParameters))
		)
	};
}

const types: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8'
};
const origin = `http://127.0.0.1:${port}`;
// The site's policy (vite.config.ts and src/hooks.server.ts), so the prototype
// shows what voice needs from it: here, nothing.
const csp = [
	"default-src 'self'",
	"img-src 'self' data:",
	"style-src 'self'",
	"script-src 'self'",
	`connect-src 'self' ws://127.0.0.1:${port}`,
	"object-src 'none'",
	"frame-ancestors 'none'",
	"base-uri 'self'",
	"form-action 'self'"
].join('; ');

const http = createServer(async (request, response) => {
	const url = new URL(request.url ?? '/', origin);
	try {
		if (url.pathname === '/healthz') {
			response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
		} else if (url.pathname === '/stats') {
			response
				.writeHead(200, { 'content-type': 'application/json' })
				.end(JSON.stringify(await stats()));
		} else {
			const file = path.join(
				dist,
				path.normalize(url.pathname === '/' ? 'index.html' : url.pathname)
			);
			if (!file.startsWith(dist)) throw new Error('outside the build');
			const body = await readFile(file);
			response
				.writeHead(200, {
					'content-type': types[path.extname(file)] ?? 'application/octet-stream',
					'content-security-policy': csp,
					'permissions-policy': 'microphone=(self), camera=(), geolocation=()',
					'cache-control': 'no-store'
				})
				.end(body);
		}
	} catch {
		response.writeHead(404).end('not found');
	}
});

const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
http.on('upgrade', (request, socket, head) => {
	const url = new URL(request.url ?? '/', origin);
	if (url.pathname !== '/voice' || request.headers.origin !== origin) {
		socket.destroy();
		return;
	}
	sockets.handleUpgrade(request, socket, head, (ws) => {
		let session: Session | null = null;
		// One request at a time, in the order they arrived.
		let queue = Promise.resolve();
		ws.on('message', (raw) => {
			queue = queue.then(async () => {
				const message = JSON.parse(String(raw)) as ClientMessage;
				try {
					let data: unknown;
					if (message.method === 'join') {
						if (session) throw new Error('already joined');
						const joined = await join(ws, message.data, {
							audioLevel: url.searchParams.has('audioLevel'),
							tcpOnly: url.searchParams.has('tcp')
						});
						session = joined.session;
						data = joined.response;
					} else {
						if (!session) throw new Error('join first');
						const handler = handlers[message.method] as (
							data: unknown,
							session: Session
						) => Promise<unknown>;
						data = await handler(message.data, session);
					}
					send(ws, { id: message.id, ok: true, data });
				} catch (error) {
					send(ws, { id: message.id, ok: false, error: String(error) });
				}
			});
		});
		ws.on('close', () => {
			if (session) leave(session);
		});
	});
});

http.listen(port, '127.0.0.1', () => {
	console.log(`voice prototype on ${origin}, media on port ${rtcPort} of ${listenIps.join(', ')}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		worker.close();
		process.exit(0);
	});
}

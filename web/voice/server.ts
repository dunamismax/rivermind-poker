// rivermind-poker-voice, the table voice service (P4C.4, D-15): mediasoup for
// the audio and the MLS delivery service for each table's group, behind voice
// signalling v1 on a loopback WebSocket that Caddy carries as /voice.
// docs/voice.md is the design; src/lib/server/voice/ holds the parts.
//
//   node build/voice/voice.js           after `pnpm build`, which bundles this
//                                       file there with mediasoup's worker beside it
//   node voice/server.ts                from the source
//   node build/voice/voice.js derive-key < SITE_SECRET_FILE > VOICE_KEY_FILE
//                                       the voice key, from the site's secret
//
// Environment:
//   HOST, PORT                signalling, and /healthz (127.0.0.1 and 4323)
//   VOICE_ORIGINS             the origins a page may connect from, comma-separated
//   VOICE_KEY_FILE            the voice key that tokens are signed with, as hex
//                             (`derive-key`); or, outside the live unit,
//   RIVERMIND_SECRET_FILE,    the site's secret, to derive the key from here
//   RIVERMIND_SECRET
//   VOICE_MEDIA_PORT          the UDP and TCP port for audio (3478; 0 picks one)
//   VOICE_LISTEN_IPS          where the media server listens, comma-separated (0.0.0.0)
//   VOICE_ANNOUNCED_HOST      a name whose address the ICE candidates announce,
//                             looked up again every minute (address.ts); or
//   VOICE_ANNOUNCED_ADDRESS   a fixed address to announce; with neither, the
//                             listening addresses are announced as they are
//   VOICE_WORKER_BIN          mediasoup's worker (the one beside this bundle, or
//                             the installed package's)
//   SHUTDOWN_TIMEOUT          seconds a SIGTERM waits for sockets to close (5)
//
// /healthz answers {"status":"ok","revision":"<commit>","media":"ok","address":"ok"},
// and 503 when the media worker is gone or the announced name never resolved.
// POST /seats takes the table server's list of who may be in a table's room,
// signed with the voice key (src/lib/server/voice/seats.ts, P4C.5): 204, or 401.
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { AddressWatch } from '../src/lib/server/voice/address.ts';
import { consoleLog } from '../src/lib/server/voice/log.ts';
import { Media } from '../src/lib/server/voice/media.ts';
import { MAX_SEATS_BYTES, SEATS_PATH, readSeats } from '../src/lib/server/voice/seats.ts';
import { VoiceService } from '../src/lib/server/voice/service.ts';
import { voiceKey } from '../src/lib/server/voice/tokens.ts';
import { CLOSE, MAX_MESSAGE_BYTES, VOICE_PATH } from '../src/lib/voice/signalling.ts';

const here = import.meta.dirname;
const env = process.env;
const log = consoleLog;

function siteSecret(text: string): Uint8Array {
	const secret = Buffer.from(text.trim(), 'utf8');
	if (secret.length === 0) throw new Error('the site secret is empty');
	return secret;
}

if (process.argv[2] === 'derive-key') {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	process.stdout.write(
		`${voiceKey(siteSecret(Buffer.concat(chunks).toString('utf8'))).toString('hex')}\n`
	);
	process.exit(0);
}

function loadKey(): Uint8Array {
	if (env.VOICE_KEY_FILE) {
		const hex = readFileSync(env.VOICE_KEY_FILE, 'utf8').trim();
		if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('VOICE_KEY_FILE does not hold a voice key');
		return Buffer.from(hex, 'hex');
	}
	if (env.RIVERMIND_SECRET) return voiceKey(siteSecret(env.RIVERMIND_SECRET));
	if (env.RIVERMIND_SECRET_FILE) {
		return voiceKey(siteSecret(readFileSync(env.RIVERMIND_SECRET_FILE, 'utf8')));
	}
	throw new Error('no voice key: set VOICE_KEY_FILE (or the site secret)');
}

function readRevision(file: string): string | null {
	if (!existsSync(file)) return null;
	const revision = readFileSync(file, 'utf8').split('\n')[0].trim();
	return /^[0-9a-f]{40}$/.test(revision) ? revision : null;
}

const list = (value: string | undefined) =>
	(value ?? '')
		.split(',')
		.map((one) => one.trim())
		.filter(Boolean);

const host = env.HOST ?? '127.0.0.1';
const port = Number(env.PORT ?? 4323);
const origins = new Set(list(env.VOICE_ORIGINS).map((origin) => new URL(origin).origin));
if (origins.size === 0) throw new Error('VOICE_ORIGINS names no origin');
const key = loadKey();
// Bundled, the worker is beside this file; from the source, mediasoup finds its own.
const bundled = resolve(here, 'mediasoup-worker');
const workerBin = env.VOICE_WORKER_BIN ?? (existsSync(bundled) ? bundled : undefined);
const revision = readRevision(resolve(here, '..', '..', 'REVISION'));

// The address to announce, known before the media server starts. A name that
// does not resolve stops the start-up, and systemd tries again.
let started: Media | null = null;
let watch: AddressWatch | null = null;
let announced = env.VOICE_ANNOUNCED_ADDRESS || null;
if (!announced && env.VOICE_ANNOUNCED_HOST) {
	watch = new AddressWatch({
		host: env.VOICE_ANNOUNCED_HOST,
		log,
		onchange: (address) => started?.announce(address)
	});
	announced = await watch.check();
	if (!announced) throw new Error('the announced name did not resolve');
}

const media = await Media.start({
	listenIps: list(env.VOICE_LISTEN_IPS ?? '0.0.0.0'),
	port: Number(env.VOICE_MEDIA_PORT ?? 3478),
	announced,
	workerBin,
	log
});
started = media;
const service = new VoiceService({ key, media, log });
media.ondied = () => {
	// Nothing can carry audio without the worker. systemd starts the service
	// again, and pages join a new group (P4C.7 makes this quicker).
	log('stopping: the media worker died');
	service.close();
	process.exit(1);
};
watch?.start();

const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
// The table server's seat lists. Only it holds the voice key they are signed with.
function seats(request: IncomingMessage, response: ServerResponse): void {
	const chunks: Buffer[] = [];
	let size = 0;
	request.on('data', (chunk: Buffer) => {
		size += chunk.length;
		if (size > MAX_SEATS_BYTES) request.destroy();
		else chunks.push(chunk);
	});
	request.on('end', () => {
		const header = (name: string) => {
			const value = request.headers[name];
			return Array.isArray(value) ? undefined : value;
		};
		const list = readSeats(
			key,
			Buffer.concat(chunks).toString('utf8'),
			header('x-voice-time'),
			header('x-voice-signature'),
			Date.now()
		);
		if (!list) {
			log('refused a seat list that was not signed with the voice key');
			response.writeHead(401).end();
			return;
		}
		service.seats(list).then(
			() => response.writeHead(204).end(),
			(error: unknown) => {
				log(`a seat list failed: ${error instanceof Error ? error.message : error}`);
				response.writeHead(500).end();
			}
		);
	});
}

const http = createServer((request, response) => {
	const path = (request.url ?? '/').split('?')[0];
	if (path === SEATS_PATH && request.method === 'POST') {
		seats(request, response);
		return;
	}
	if (path !== '/healthz') {
		response.writeHead(404, { 'content-type': 'text/plain' }).end('not found\n');
		return;
	}
	const checks = {
		media: media.alive ? 'ok' : 'error',
		address: !watch || watch.current ? 'ok' : 'error'
	};
	const healthy = Object.values(checks).every((one) => one === 'ok') && !stopping;
	response
		.writeHead(healthy ? 200 : 503, {
			'content-type': 'application/json',
			'cache-control': 'no-store'
		})
		.end(
			`${JSON.stringify({ status: stopping ? 'stopping' : healthy ? 'ok' : 'error', revision, ...checks })}\n`
		);
});

// A browser always sends Origin with a handshake; a page elsewhere is refused before it is accepted.
http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
	const path = (request.url ?? '/').split('?')[0];
	if (stopping || path !== VOICE_PATH) {
		socket.destroy();
		return;
	}
	if (!origins.has(request.headers.origin ?? '')) {
		socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
		return;
	}
	sockets.handleUpgrade(request, socket, head, (ws) => accept(ws));
});

const alive = new WeakMap<WebSocket, boolean>();
function accept(ws: WebSocket): void {
	const session = service.open({
		send: (text) => {
			if (ws.readyState === ws.OPEN) ws.send(text);
		},
		close: (code, reason) => ws.close(code, reason)
	});
	alive.set(ws, true);
	ws.on('pong', () => alive.set(ws, true));
	ws.on('message', (data, binary) => {
		if (binary) ws.close(CLOSE.protocol, 'text frames only');
		else session.receive(data.toString());
	});
	ws.on('close', () => session.closed());
	// A frame over the limit or a broken connection: ws closes the socket itself.
	ws.on('error', () => {});
}

// A page that has gone without closing its socket (a phone that lost its
// signal) is let go after one missed ping, so the group removes its leaf.
const heartbeat = setInterval(() => {
	for (const ws of sockets.clients) {
		if (!alive.get(ws)) {
			ws.terminate();
			continue;
		}
		alive.set(ws, false);
		ws.ping();
	}
}, 15_000);
heartbeat.unref();

let stopping = false;
http.listen(port, host, async () => {
	const ports = await media.ports();
	log(
		`rivermind-poker-voice listening on port ${port}, media on UDP ${ports.udp.join(', ')} and TCP ${ports.tcp.join(', ')}`
	);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
	process.once(signal, () => {
		stopping = true;
		log(`${signal}: stopping`);
		watch?.stop();
		service.close();
		http.close();
		for (const ws of sockets.clients) ws.close(CLOSE.restarting, 'the voice service is restarting');
		const timer = setTimeout(
			() => {
				for (const ws of sockets.clients) ws.terminate();
			},
			Number(env.SHUTDOWN_TIMEOUT ?? 5) * 1000
		);
		timer.unref();
		sockets.close(() => {
			media.close();
			process.exit(0);
		});
	});
}

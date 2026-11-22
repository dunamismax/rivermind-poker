// What full voice rooms cost a machine's media worker (P4C.7): `pnpm voice:load`.
//
//   node scripts/voice-load.ts [--rooms 1,2,4,8] [--people 9] [--talking 9,2]
//                              [--seconds 20] [--worker-bin PATH]
//
// It starts a mediasoup worker as the voice service does (the same codec and
// Router settings, src/lib/server/voice/media.ts) and fills it with rooms of
// `people`, of whom `talking` send audio all the time: 50 packets a second of
// 181 bytes each, the size of a 64 kbps Opus frame sealed with SFrame. Each
// person's audio arrives encrypted (SRTP, AES-128-GCM, as browsers negotiate)
// and is forwarded, encrypted again, to everyone else in the room, which is
// all the work a forwarding server does for a call. Then it reads how much of
// one core and how much memory the worker used.
//
// The people are not browsers: a second mediasoup worker plays them, sending
// each person's packets over UDP on loopback and taking in what the room
// sends back. ICE and DTLS, which cost a connection once, are left out;
// docs/voice.md compares the result with nine real browsers in a room.
//
// Nothing here listens beyond loopback, and nothing is kept.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createWorker, type types as ms } from 'mediasoup';
import { MEDIA_CODECS } from '../src/lib/server/voice/media.ts';

const { values } = parseArgs({
	options: {
		rooms: { type: 'string', default: '1,2,4,8' },
		people: { type: 'string', default: '9' },
		talking: { type: 'string', default: '9,2' },
		seconds: { type: 'string', default: '20' },
		'worker-bin': { type: 'string' }
	}
});
const numbers = (text: string) => text.split(',').map((one) => Number(one.trim()));
const PEOPLE = Number(values.people);
const SECONDS = Number(values.seconds);
const workerBin = values['worker-bin'] ?? process.env.VOICE_WORKER_BIN;

const SUITE = 'AEAD_AES_128_GCM' as const;
const LOOPBACK = { protocol: 'udp', ip: '127.0.0.1' } as const;
const PAYLOAD_TYPE = 111;
// A 20 ms Opus frame at 64 kbps (160 bytes) under SFrame's header and tag (21).
const PAYLOAD_BYTES = 181;
const FRAME_MS = 20;

type Talker = { producer: ms.Producer; ssrc: number; seq: number; timestamp: number };

function rtp(talker: Talker): Buffer {
	const packet = Buffer.allocUnsafe(12 + PAYLOAD_BYTES);
	packet[0] = 0x80;
	packet[1] = PAYLOAD_TYPE;
	packet.writeUInt16BE(talker.seq, 2);
	packet.writeUInt32BE(talker.timestamp, 4);
	packet.writeUInt32BE(talker.ssrc, 8);
	randomBytes(PAYLOAD_BYTES).copy(packet, 12);
	talker.seq = (talker.seq + 1) & 0xffff;
	talker.timestamp = (talker.timestamp + 960) >>> 0;
	return packet;
}

const plain = (router: ms.Router, comedia: boolean) =>
	router.createPlainTransport({
		listenInfo: LOOPBACK,
		rtcpMux: true,
		comedia,
		enableSrtp: true,
		srtpCryptoSuite: SUITE
	});

// One room on the worker under test, its people played by `clients`.
async function room(
	sfu: ms.Worker,
	clients: ms.Router,
	direct: ms.DirectTransport,
	talking: number,
	nextSsrc: () => number
): Promise<{ router: ms.Router; talkers: Talker[]; down: ms.PlainTransport[] }> {
	const router = await sfu.createRouter({ mediaCodecs: MEDIA_CODECS });
	const talkers: Talker[] = [];
	const heard: ms.Producer[] = [];
	const down: ms.PlainTransport[] = [];
	for (let person = 0; person < PEOPLE; person += 1) {
		// What the person says: packets handed to the clients' worker, which
		// sends them on, encrypted, to the room.
		const ssrc = nextSsrc();
		const source = await direct.produce({
			kind: 'audio',
			rtpParameters: {
				codecs: [
					{
						mimeType: 'audio/opus',
						payloadType: PAYLOAD_TYPE,
						clockRate: 48000,
						channels: 2,
						parameters: { useinbandfec: 1, usedtx: 1 }
					}
				],
				encodings: [{ ssrc }],
				rtcp: { cname: `load-${ssrc}` }
			}
		});
		const [up, into] = [await plain(clients, false), await plain(router, true)];
		await up.connect({
			ip: '127.0.0.1',
			port: into.tuple.localPort,
			srtpParameters: into.srtpParameters
		});
		await into.connect({ srtpParameters: up.srtpParameters });
		const sent = await up.consume({
			producerId: source.id,
			rtpCapabilities: clients.rtpCapabilities
		});
		heard.push(await into.produce({ kind: 'audio', rtpParameters: sent.rtpParameters }));
		if (person < talking) talkers.push({ producer: source, ssrc, seq: 0, timestamp: 0 });
		// What the person hears: a transport from the room to the clients' worker.
		const [out, sink] = [await plain(router, false), await plain(clients, false)];
		await out.connect({
			ip: '127.0.0.1',
			port: sink.tuple.localPort,
			srtpParameters: sink.srtpParameters
		});
		await sink.connect({
			ip: '127.0.0.1',
			port: out.tuple.localPort,
			srtpParameters: out.srtpParameters
		});
		down.push(out);
	}
	// Everyone hears everyone else.
	for (const [listener, out] of down.entries()) {
		for (const [speaker, producer] of heard.entries()) {
			if (speaker === listener) continue;
			await out.consume({ producerId: producer.id, rtpCapabilities: router.rtpCapabilities });
		}
	}
	return { router, talkers, down };
}

const cpuMs = async (worker: ms.Worker) => {
	const usage = await worker.getResourceUsage();
	return usage.ru_utime + usage.ru_stime;
};
// Resident memory in MB, as `ps` counts it.
const rssMb = (pid: number) =>
	Math.round(
		Number(
			execFileSync('ps', ['-o', 'rss=', '-p', String(pid)])
				.toString()
				.trim()
		) / 102.4
	) / 10;
const sentBytes = async (transports: ms.PlainTransport[]) => {
	let bytes = 0;
	for (const transport of transports) bytes += (await transport.getStats())[0].bytesSent;
	return bytes;
};

async function run(rooms: number, talking: number): Promise<Record<string, number>> {
	const sfu = await createWorker({ logLevel: 'warn', workerBin });
	// The clients' worker is handed packets for streams it does not know, and
	// says nothing about them.
	const clientWorker = await createWorker({ logLevel: 'none', workerBin });
	const clients = await clientWorker.createRouter({ mediaCodecs: MEDIA_CODECS });
	const direct = await clients.createDirectTransport();
	let ssrc = 1000;
	const built = [];
	for (let at = 0; at < rooms; at += 1) {
		built.push(await room(sfu, clients, direct, talking, () => (ssrc += 1)));
	}
	const talkers = built.flatMap((one) => one.talkers);
	const down = built.flatMap((one) => one.down);

	// Twenty milliseconds of everyone's audio at a time, keeping to the clock.
	const started = performance.now();
	let frames = 0;
	const tick = setInterval(() => {
		const due = Math.floor((performance.now() - started) / FRAME_MS);
		for (; frames < due; frames += 1) {
			for (const talker of talkers) talker.producer.send(rtp(talker));
		}
	}, FRAME_MS / 2);

	await new Promise((resolve) => setTimeout(resolve, 3000));
	const before = {
		at: performance.now(),
		cpu: await cpuMs(sfu),
		node: process.cpuUsage(),
		bytes: await sentBytes(down)
	};
	await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
	const elapsed = performance.now() - before.at;
	const cpu = (await cpuMs(sfu)) - before.cpu;
	const node = process.cpuUsage(before.node);
	const bytes = (await sentBytes(down)) - before.bytes;
	const memory = rssMb(sfu.pid);
	clearInterval(tick);
	sfu.close();
	clientWorker.close();
	const round = (value: number) => Math.round(value * 10) / 10;
	return {
		rooms,
		people: rooms * PEOPLE,
		talking: rooms * talking,
		// Share of one core, in percent.
		workerCpu: round((cpu / elapsed) * 100),
		workerMb: memory,
		// What the room sent everyone, as mediasoup counts it (RTP and SRTP, no UDP or IP headers).
		sentKbps: Math.round((bytes * 8) / elapsed),
		// This script's own share of a core: near 100, it could not keep up and the figures are low.
		generatorCpu: round(((node.user + node.system) / 1000 / elapsed) * 100)
	};
}

console.log(
	`rooms of ${PEOPLE}, ${SECONDS} s each, on ${process.platform} ${process.arch}, Node ${process.version}`
);
for (const talking of numbers(values.talking)) {
	for (const rooms of numbers(values.rooms)) {
		console.log(JSON.stringify(await run(rooms, Math.min(talking, PEOPLE))));
	}
}
process.exit(0);

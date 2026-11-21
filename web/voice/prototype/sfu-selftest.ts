// Does mediasoup run here? (P4C.1) Starts a worker, binds one WebRtcServer on a
// single UDP and TCP port, opens a WebRTC transport on it, and sends RTP
// through a Router from a direct producer to a direct consumer. Prints one line
// of JSON and exits 0 when every packet came back unchanged.
//
//   node voice/prototype/sfu-selftest.ts [--port 44391] [--ip 127.0.0.1]
//
// bundle.ts builds it into one file the way a release is built, to run where
// there is no node_modules: on ubuntu-vm, inside the web unit's sandbox.
import { arch, platform, release } from 'node:os';
import { parseArgs } from 'node:util';
import { createWorker, version } from 'mediasoup';

const { values: args } = parseArgs({
	options: {
		port: { type: 'string', default: '44391' },
		ip: { type: 'string', default: '127.0.0.1' }
	}
});
const port = Number(args.port);
const PACKETS = 250;
const SSRC = 0x1234abcd;

const started = performance.now();
const worker = await createWorker({ logLevel: 'warn' });
const webRtcServer = await worker.createWebRtcServer({
	listenInfos: (['udp', 'tcp'] as const).map((protocol) => ({ protocol, ip: args.ip, port }))
});
const router = await worker.createRouter({
	mediaCodecs: [
		{
			kind: 'audio',
			mimeType: 'audio/opus',
			clockRate: 48000,
			channels: 2,
			parameters: { useinbandfec: 1 }
		}
	]
});
const transport = await router.createWebRtcTransport({
	webRtcServer,
	enableUdp: true,
	enableTcp: true,
	preferUdp: true
});
const direct = await router.createDirectTransport();
const producer = await direct.produce({
	kind: 'audio',
	rtpParameters: {
		codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2 }],
		encodings: [{ ssrc: SSRC }]
	}
});
const consumer = await direct.consume({
	producerId: producer.id,
	rtpCapabilities: router.rtpCapabilities
});

// Twenty bytes after the RTP header that say which packet this is.
const payloadOf = (n: number) => Buffer.from(`rivermind voice ${String(n).padStart(4, '0')}`);
const received: string[] = [];
const done = new Promise<void>((resolve) => {
	consumer.on('rtp', (packet) => {
		received.push(packet.subarray(packet.length - 20).toString());
		if (received.length === PACKETS) resolve();
	});
});
for (let n = 0; n < PACKETS; n++) {
	const header = Buffer.alloc(12);
	header[0] = 0x80;
	header[1] = 111;
	header.writeUInt16BE(n, 2);
	header.writeUInt32BE(n * 960, 4);
	header.writeUInt32BE(SSRC, 8);
	producer.send(Buffer.concat([header, payloadOf(n)]));
}
await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 5000))]);

const usage = await worker.getResourceUsage();
const ok =
	received.length === PACKETS && received.every((one, n) => one === payloadOf(n).toString());
console.log(
	JSON.stringify({
		ok,
		mediasoup: version,
		node: process.version,
		host: `${platform()} ${arch()} ${release()}`,
		uid: process.getuid?.(),
		workerPid: worker.pid,
		workerBin: process.env.MEDIASOUP_WORKER_BIN ?? 'the package default',
		listening: transport.iceCandidates.map((one) => `${one.protocol} ${one.address}:${one.port}`),
		packets: `${received.length}/${PACKETS}`,
		startMs: Math.round(performance.now() - started),
		workerCpuMs: usage.ru_utime + usage.ru_stime,
		nodeRssMb: Math.round(process.memoryUsage.rss() / 1024 / 1024)
	})
);
worker.close();
process.exit(ok ? 0 : 1);

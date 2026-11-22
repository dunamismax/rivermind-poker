// A test build of the voice service (P4C.8): voice/server.ts as it is, with a
// listener attached at the SFU that holds no key, as the operator of the voice
// server could attach one. For every producer on every Router it makes a
// consumer on a DirectTransport of that Router and keeps what arrives: each
// packet's RTP sequence number, the header extensions it carries and its
// payload. A second HTTP server gives the test what it kept. It is only ever
// run from the source by the voice checks (tap.check.ts): nothing bundles,
// builds or deploys it.
//
//   TAP_PORT=4395 PORT=4394 … node voice/check/tap-server.ts
//
// GET /tap answers every producer's capture as JSON (`TapCapture`); DELETE /tap
// forgets them. The rest of the environment is voice/server.ts's.
import { createServer } from 'node:http';
import { observer, type types as ms } from 'mediasoup';
import { toBase64 } from '../../src/lib/voice/signalling.ts';

// What the listener kept of one producer's audio.
export type TapCapture = {
	producer: string;
	// The URIs of the header extensions seen on its packets.
	extensions: string[];
	// Sequence numbers skipped between two packets that arrived.
	gaps: number;
	packets: { seq: number; payload: string }[];
};

// A minute and a half of 20 ms frames a producer is more than any check needs.
const MOST_PACKETS = 4500;

// The header extension ids in an RTP packet (RFC 8285's one- and two-byte
// forms), and where its payload starts and ends.
function parseRtp(packet: Uint8Array): { ids: number[]; payload: Uint8Array } {
	const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
	const ids: number[] = [];
	let offset = 12 + (packet[0] & 0x0f) * 4;
	if (packet[0] & 0x10) {
		const profile = view.getUint16(offset);
		const end = offset + 4 + view.getUint16(offset + 2) * 4;
		const twoByte = (profile & 0xfff0) === 0x1000;
		let at = offset + 4;
		while ((profile === 0xbede || twoByte) && at < end) {
			if (packet[at] === 0) {
				at += 1;
			} else if (twoByte) {
				ids.push(packet[at]);
				at += 2 + packet[at + 1];
			} else {
				if (packet[at] >> 4 === 15) break;
				ids.push(packet[at] >> 4);
				at += 2 + (packet[at] & 0x0f);
			}
		}
		offset = end;
	}
	const end = packet[0] & 0x20 ? packet.length - packet[packet.length - 1] : packet.length;
	return { ids, payload: packet.subarray(offset, end) };
}

const captures = new Map<string, TapCapture>();

async function tap(router: ms.Router, direct: ms.DirectTransport, producer: ms.Producer) {
	// Everything the Router can send, the audio-level extension included: if a
	// page sent levels, this listener would be handed them.
	const consumer = await direct.consume({
		producerId: producer.id,
		rtpCapabilities: router.rtpCapabilities
	});
	// What each extension id names: the consumer's own, then the Router's.
	const uris = new Map<number, string>([
		...(router.rtpCapabilities.headerExtensions ?? [])
			.filter(({ kind }) => kind === 'audio')
			.map(({ preferredId, uri }) => [preferredId, uri] as [number, string]),
		...(consumer.rtpParameters.headerExtensions ?? []).map(
			({ id, uri }) => [id, uri] as [number, string]
		)
	]);
	const capture: TapCapture = { producer: producer.id, extensions: [], gaps: 0, packets: [] };
	captures.set(producer.id, capture);
	let last: number | null = null;
	consumer.on('rtp', (packet) => {
		const seq = packet.readUInt16BE(2);
		if (last !== null) capture.gaps += (seq - last - 1 + 0x10000) % 0x10000;
		last = seq;
		const { ids, payload } = parseRtp(packet);
		for (const id of ids) {
			const uri = uris.get(id) ?? `unknown id ${id}`;
			if (!capture.extensions.includes(uri)) capture.extensions.push(uri);
		}
		if (capture.packets.length < MOST_PACKETS) {
			capture.packets.push({ seq, payload: toBase64(payload) });
		}
	});
}

observer.on('newworker', (worker) => {
	worker.observer.on('newrouter', async (router) => {
		const direct = await router.createDirectTransport();
		router.observer.on('newtransport', (transport) => {
			if (transport === direct) return;
			transport.observer.on('newproducer', (producer) => void tap(router, direct, producer));
		});
	});
});

const port = Number(process.env.TAP_PORT ?? 4395);
createServer((request, response) => {
	if ((request.url ?? '').split('?')[0] !== '/tap') {
		response.writeHead(404).end();
		return;
	}
	if (request.method === 'DELETE') captures.clear();
	response
		.writeHead(request.method === 'DELETE' ? 204 : 200, { 'content-type': 'application/json' })
		.end(request.method === 'DELETE' ? undefined : JSON.stringify([...captures.values()]));
}).listen(port, '127.0.0.1');

await import('../server.ts');

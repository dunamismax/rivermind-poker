// The voice service's media server (P4C.4): one mediasoup worker with one
// WebRtcServer, which carries every room's audio on one UDP port and the same
// port on TCP (ICE-lite), and a Router for each room. docs/voice.md says why.
import { createWorker, setLogEventListeners, type types as ms } from 'mediasoup';
import { redact, type Log } from './log.ts';

// The RTP header extension that would tell the server who is speaking. A Router
// always offers it: the service leaves it out of what it gives a page, and
// refuses a producer that names it.
export const AUDIO_LEVEL_URI = 'urn:ietf:params:rtp-hdrext:ssrc-audio-level';

// Opus as docs/voice.md sets it. Bitrate, DTX and the frame length are each
// sender's (mediasoup-client's codec options); in-band FEC is asked of every
// sender, so it follows the listener losing the most.
export const MEDIA_CODECS: ms.RouterRtpCodecCapability[] = [
	{
		kind: 'audio',
		mimeType: 'audio/opus',
		preferredPayloadType: 111,
		clockRate: 48000,
		channels: 2,
		parameters: { useinbandfec: 1 }
	}
];

export type MediaOptions = {
	// Where the WebRtcServer listens: the port, on each address, for UDP and TCP.
	listenIps: string[];
	// 0 picks a free port for each socket (tests); the live service uses 3478.
	port: number;
	// The public address put in ICE candidates, or null to announce the listening addresses.
	announced: string | null;
	workerBin?: string;
	log: Log;
};

export class Media {
	readonly worker: ms.Worker;
	#server: ms.WebRtcServer;
	#options: MediaOptions;
	#announced: string | null;
	// Told when the WebRtcServer started again and every transport on it closed.
	onreset: () => void = () => {};
	// Told when the worker died: the service can carry no audio until it starts again.
	ondied: () => void = () => {};

	private constructor(worker: ms.Worker, server: ms.WebRtcServer, options: MediaOptions) {
		this.worker = worker;
		this.#server = server;
		this.#options = options;
		this.#announced = options.announced;
	}

	static async start(options: MediaOptions): Promise<Media> {
		// mediasoup's own warnings and errors, through the service's log and its redaction.
		setLogEventListeners({
			onwarn: (namespace, line) => options.log(`mediasoup ${namespace}: ${line}`),
			onerror: (namespace, line, error) =>
				options.log(`mediasoup ${namespace}: ${line}${error ? `: ${error.message}` : ''}`)
		});
		const worker = await createWorker({ logLevel: 'warn', workerBin: options.workerBin });
		const server = await Media.#listen(worker, options, options.announced);
		const media = new Media(worker, server, options);
		worker.on('died', (error) => {
			options.log(`the media worker died: ${redact(error.message)}`);
			media.ondied();
		});
		return media;
	}

	static #listen(
		worker: ms.Worker,
		options: MediaOptions,
		announced: string | null
	): Promise<ms.WebRtcServer> {
		return worker.createWebRtcServer({
			listenInfos: options.listenIps.flatMap((ip) =>
				(['udp', 'tcp'] as const).map((protocol) => ({
					protocol,
					ip,
					announcedAddress: announced ?? undefined,
					...(options.port ? { port: options.port } : {})
				}))
			)
		});
	}

	get server(): ms.WebRtcServer {
		return this.#server;
	}

	get announced(): string | null {
		return this.#announced;
	}

	get alive(): boolean {
		return !this.worker.died && !this.worker.closed;
	}

	createRouter(): Promise<ms.Router> {
		return this.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
	}

	// The public address changed: candidates already given out name the old one,
	// so the server starts again under the new one, which closes every transport.
	// Rooms and their groups stand; pages make their transports again.
	async announce(address: string | null): Promise<void> {
		if (address === this.#announced) return;
		this.#announced = address;
		this.#server.close();
		this.#server = await Media.#listen(this.worker, this.#options, address);
		this.onreset();
	}

	// The ports the server listens on, by protocol.
	async ports(): Promise<{ udp: number[]; tcp: number[] }> {
		const dump = await this.#server.dump();
		return {
			udp: dump.udpSockets.map(({ port }) => port),
			tcp: dump.tcpServers.map(({ port }) => port)
		};
	}

	close(): void {
		this.worker.close();
	}
}

// The voice service's media server (P4C.4): one mediasoup worker with one
// WebRtcServer, which carries every room's audio on one UDP port and the same
// port on TCP (ICE-lite), and a Router for each room. docs/voice.md says why.
// A worker that dies is replaced by another on the same port (P4C.7).
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

// A worker that dies is started again here. One that keeps dying is left dead,
// and the service stops for systemd to start it again: more than this many
// deaths within the window.
export const MAX_DEATHS = 3;
export const DEATHS_WINDOW_MS = 60_000;

export class Media {
	#worker: ms.Worker;
	#server: ms.WebRtcServer;
	#options: MediaOptions;
	#announced: string | null;
	// Settled while a worker is up; pending while one that died is started again.
	#ready: Promise<void> = Promise.resolve();
	#deaths: number[] = [];
	#closed = false;
	// Told when the WebRtcServer started again and every transport on it closed.
	onreset: () => void = () => {};
	// Told when the worker died: every Router, transport and stream went with
	// it. Another worker is being started (P4C.7).
	ondied: () => void = () => {};
	// Told when no worker could be started again: nothing here can carry audio.
	onfailed: () => void = () => {};

	private constructor(worker: ms.Worker, server: ms.WebRtcServer, options: MediaOptions) {
		this.#worker = worker;
		this.#server = server;
		this.#options = options;
		this.#announced = options.announced;
		this.#watch(worker);
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
		return new Media(worker, server, options);
	}

	// A worker that dies takes every room's audio with it. The service is told
	// at once, so it can send every page away to come back, and another worker
	// takes the same port: a page that comes back finds it, or waits for it.
	#watch(worker: ms.Worker): void {
		worker.on('died', (error) => {
			if (this.#closed || worker !== this.#worker) return;
			const log = this.#options.log;
			log(`the media worker died: ${redact(error.message)}`);
			this.ondied();
			const now = Date.now();
			this.#deaths = [...this.#deaths.filter((at) => now - at < DEATHS_WINDOW_MS), now];
			if (this.#deaths.length > MAX_DEATHS) {
				log(`the media worker died ${this.#deaths.length} times in a minute: giving up`);
				this.onfailed();
				return;
			}
			this.#ready = this.#again().catch((failure: unknown) => {
				const why = failure instanceof Error ? failure.message : String(failure);
				log(`the media worker could not be started again: ${redact(why)}`);
				this.onfailed();
			});
		});
	}

	async #again(): Promise<void> {
		const worker = await createWorker({ logLevel: 'warn', workerBin: this.#options.workerBin });
		if (this.#closed) {
			worker.close();
			return;
		}
		this.#server = await Media.#listen(worker, this.#options, this.#announced);
		this.#worker = worker;
		this.#watch(worker);
		this.#options.log('the media worker started again');
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

	get worker(): ms.Worker {
		return this.#worker;
	}

	get server(): ms.WebRtcServer {
		return this.#server;
	}

	get announced(): string | null {
		return this.#announced;
	}

	get alive(): boolean {
		return !this.#worker.died && !this.#worker.closed;
	}

	// A Router on the worker, once one is up.
	async createRouter(): Promise<ms.Router> {
		await this.#ready;
		return this.#worker.createRouter({ mediaCodecs: MEDIA_CODECS });
	}

	// The public address changed: candidates already given out name the old one,
	// so the server starts again under the new one, which closes every transport.
	// Rooms and their groups stand; pages make their transports again.
	async announce(address: string | null): Promise<void> {
		if (address === this.#announced) return;
		this.#announced = address;
		await this.#ready;
		if (!this.alive) return;
		this.#server.close();
		this.#server = await Media.#listen(this.#worker, this.#options, address);
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
		this.#closed = true;
		this.#worker.close();
	}
}

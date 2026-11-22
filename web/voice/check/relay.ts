// A UDP relay between people's pages and a voice service's media port, for the
// checks that need a network that misbehaves (P4C.7): one that goes away and
// comes back as another, loses packets, or delivers them late and out of
// step. The voice service listens on loopback and announces the relay's
// address, so every page's audio passes through here both ways, as it would
// through a home router.
//
// Each page's address gets a socket of its own towards the service, as a NAT
// gives each a mapping: the service sees one address a page and answers it.
// Those sockets are on the relay's own address, never loopback: the service
// tells each page the address it saw, and Firefox's ICE drops a path whose
// address is loopback.
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';

// What the network does to each packet: the share it loses, and how long it
// holds the rest: `delayMs`, give or take `jitterMs`, drawn evenly, as
// `tc netem delay DELAY JITTER` does. `legs` says which way it applies: to
// what pages send (`up`), to what they are sent (`down`), or both.
export type Impairment = {
	loss: number;
	delayMs: number;
	jitterMs: number;
	legs: 'up' | 'down' | 'both';
};

export const CLEAR: Impairment = { loss: 0, delayMs: 0, jitterMs: 0, legs: 'both' };

type Path = { socket: Socket; client: RemoteInfo };

export class Relay {
	#front: Socket;
	#address: string;
	#to: { address: string; port: number };
	#paths = new Map<string, Path>();
	#goneUntil = 0;
	#closed = false;
	impairment: Impairment = CLEAR;
	// Packets passed on towards the service and towards pages, and packets lost here.
	counts = { up: 0, down: 0, lost: 0 };

	private constructor(front: Socket, address: string, to: { address: string; port: number }) {
		this.#front = front;
		this.#address = address;
		this.#to = to;
		front.on('message', (packet, from) => this.#up(packet, from));
		front.on('error', () => {});
	}

	// Listen on `listen` and pass everything on to the media port at `to`.
	static start(
		listen: { address: string; port: number },
		to: { address: string; port: number }
	): Promise<Relay> {
		const front = createSocket('udp4');
		return new Promise((resolve, reject) => {
			front.once('error', reject);
			front.bind(listen.port, listen.address, () => resolve(new Relay(front, listen.address, to)));
		});
	}

	// Whether this packet goes on, and when.
	#carry(leg: 'up' | 'down', send: () => void): void {
		const { legs } = this.impairment;
		const { loss, delayMs, jitterMs } = legs === 'both' || legs === leg ? this.impairment : CLEAR;
		if (performance.now() < this.#goneUntil || Math.random() < loss) {
			this.counts.lost += 1;
			return;
		}
		const wait = Math.max(0, delayMs + (Math.random() * 2 - 1) * jitterMs);
		if (wait < 1) send();
		else setTimeout(send, wait);
	}

	#up(packet: Buffer, from: RemoteInfo): void {
		const key = `${from.address}:${from.port}`;
		let path = this.#paths.get(key);
		if (!path) {
			if (performance.now() < this.#goneUntil) {
				this.counts.lost += 1;
				return;
			}
			const socket = createSocket('udp4');
			const made: Path = { socket, client: from };
			socket.on('message', (answer) => {
				this.#carry('down', () => {
					if (this.#closed || this.#paths.get(key) !== made) return;
					this.counts.down += 1;
					this.#front.send(answer, from.port, from.address);
				});
			});
			socket.on('error', () => {});
			socket.bind(0, this.#address);
			this.#paths.set(key, made);
			path = made;
		}
		const taken = path;
		this.#carry('up', () => {
			if (this.#closed || this.#paths.get(key) !== taken) return;
			this.counts.up += 1;
			taken.socket.send(packet, this.#to.port, this.#to.address, () => {});
		});
	}

	// The network goes away for `ms`, and what comes after is another: nothing
	// passes meanwhile, and every page then reaches the service from an address
	// the service has not seen, as after moving from Wi-Fi to a phone network.
	gap(ms: number): void {
		this.#goneUntil = performance.now() + ms;
		for (const { socket } of this.#paths.values()) socket.close();
		this.#paths.clear();
	}

	close(): void {
		this.#closed = true;
		for (const { socket } of this.#paths.values()) socket.close();
		this.#paths.clear();
		this.#front.close();
	}
}

// A page's end of voice signalling v1 (signalling.ts): requests answered by
// id, and notices handed on as they come, in order.
import type {
	Answer,
	Notice,
	RequestType,
	Requests,
	ServerMessage,
	VoiceError
} from './signalling.ts';

// A request the service refused, with what it said.
export class Refused extends Error {
	readonly code: VoiceError;
	readonly groupInfo: string | null | undefined;

	constructor(type: string, code: VoiceError, groupInfo?: string | null) {
		super(`${type} refused: ${code}`);
		this.code = code;
		this.groupInfo = groupInfo;
	}
}

export class VoiceSocket {
	#socket: WebSocket;
	#nextId = 1;
	#waiting = new Map<number, { resolve(answer: Answer): void; reject(error: Error): void }>();
	onnotice: (notice: Notice) => void = () => {};
	onclose: (code: number, reason: string) => void = () => {};

	private constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.onmessage = ({ data }) => {
			let message: ServerMessage;
			try {
				message = JSON.parse(String(data)) as ServerMessage;
			} catch {
				return;
			}
			if ('notice' in message) {
				this.onnotice(message as Notice);
				return;
			}
			const answer = message as Answer;
			this.#waiting.get(answer.id)?.resolve(answer);
			this.#waiting.delete(answer.id);
		};
		socket.onclose = ({ code, reason }) => {
			for (const { reject } of this.#waiting.values()) reject(new Error(`closed: ${code}`));
			this.#waiting.clear();
			this.onclose(code, reason);
		};
	}

	static open(url: string): Promise<VoiceSocket> {
		const socket = new WebSocket(url);
		return new Promise((resolve, reject) => {
			socket.onopen = () => resolve(new VoiceSocket(socket));
			socket.onerror = () => reject(new Error('the voice service could not be reached'));
		});
	}

	ask<T extends RequestType>(type: T, data: Requests[T]['request']): Promise<Answer<T>> {
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			this.#waiting.set(id, { resolve: resolve as (answer: Answer) => void, reject });
			this.#socket.send(JSON.stringify({ ...data, id, type }));
		});
	}

	// A request that must succeed: a refusal throws `Refused`.
	async request<T extends RequestType>(
		type: T,
		data: Requests[T]['request']
	): Promise<Requests[T]['response']> {
		const answer = await this.ask(type, data);
		if (!answer.ok) throw new Refused(type, answer.error, answer.groupInfo);
		return answer as unknown as Requests[T]['response'];
	}

	get open(): boolean {
		return this.#socket.readyState === WebSocket.OPEN;
	}

	close(): void {
		this.#socket.close();
	}
}

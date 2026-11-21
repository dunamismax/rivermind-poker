// A page's handle on its encoded-transform worker (sframe.worker.ts): it gives
// the worker each epoch's key, says which leaf and epoch to send under, and
// puts the worker between the browser's Opus codec and the network for a
// sender and for each receiver. P4C.3 drives it from the MLS group.
import type { KeyMessage, Tally, TransformOptions, WorkerMessage } from './sframe-transform.ts';

// Whether this browser can encrypt frames at all. Where it cannot, voice does
// not start: there is no unencrypted fallback (D-15).
export function canEncryptFrames(): boolean {
	return (
		typeof Worker === 'function' &&
		typeof RTCRtpScriptTransform === 'function' &&
		typeof globalThis.crypto?.subtle?.deriveKey === 'function'
	);
}

export class FrameCrypto {
	#worker: Worker;
	#asked = new Map<number, (tallies: Tally[]) => void>();
	#nextId = 1;
	// Called when the worker's key store refuses a key or an epoch to send under.
	onrefused: ((asked: KeyMessage['type'], error: string) => void) | null = null;

	constructor() {
		this.#worker = new Worker(new URL('./sframe.worker.ts', import.meta.url), { type: 'module' });
		this.#worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
			if (data.type === 'refused') {
				this.onrefused?.(data.asked, data.error);
				return;
			}
			this.#asked.get(data.id)?.(data.tallies);
			this.#asked.delete(data.id);
		};
	}

	#post(message: KeyMessage): void {
		this.#worker.postMessage(message);
	}

	// A new epoch's base key (sframe.ts's `importBaseKey` makes one from the MLS
	// exporter's output). Frames sealed under it can be opened from now on.
	addEpoch(epoch: bigint, baseKey: CryptoKey): void {
		if (baseKey.extractable) throw new TypeError('an SFrame base key must not be extractable');
		this.#post({ type: 'epoch', epoch, baseKey });
	}

	// Send as this leaf of the group under this epoch.
	sendAs(sender: number, epoch: bigint): void {
		this.#post({ type: 'send', sender, epoch });
	}

	// Forget an epoch: its frames are refused from now on.
	retire(epoch: bigint): void {
		this.#post({ type: 'retire', epoch });
	}

	// Stop sending, or start again: while held, no frame leaves this page.
	hold(held: boolean): void {
		this.#post({ type: 'hold', held });
	}

	// Seal every frame this sender encodes. Set it before the sender negotiates
	// (mediasoup-client's `onRtpSender`), so no frame goes out unsealed.
	encrypt(sender: RTCRtpSender, id = 'send'): void {
		const options: TransformOptions = { id, direction: 'encrypt' };
		sender.transform = new RTCRtpScriptTransform(this.#worker, options);
	}

	// Open every frame this receiver is handed (`onRtpReceiver`). `from` is the
	// leaf the stream belongs to; frames sealed as anyone else are refused.
	decrypt(receiver: RTCRtpReceiver, id: string, from: number | null): void {
		const options: TransformOptions = { id, direction: 'decrypt', from };
		receiver.transform = new RTCRtpScriptTransform(this.#worker, options);
	}

	// What each live transform has sealed, opened and refused so far.
	tallies(): Promise<Tally[]> {
		const id = this.#nextId++;
		return new Promise((resolve) => {
			this.#asked.set(id, resolve);
			this.#post({ type: 'tallies', id });
		});
	}

	close(): void {
		this.#worker.terminate();
	}
}

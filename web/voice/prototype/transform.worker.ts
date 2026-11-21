// The encoded-transform worker (P4C.1): every Opus frame a sender encodes is
// encrypted here before the browser packetises it, and every frame a receiver
// gets is decrypted here before it is decoded. The page hands over
// non-extractable AES-GCM keys in the transform's options; this worker never
// sees the room secret.
import { HEADER_BYTES, nonceFor, readHeader, writeHeader } from './frame.ts';

export type TransformOptions = {
	id: string;
	direction: 'encrypt' | 'decrypt';
	kid: number;
	key: CryptoKey;
	salt: Uint8Array;
};

export type TransformCounts = {
	id: string;
	direction: 'encrypt' | 'decrypt';
	frames: number;
	failed: number;
	// The frame's bytes as the browser handed them over: the Opus payload alone when sending.
	bytes: number;
};

type EncodedFrame = { data: ArrayBuffer };
type Transformer = {
	readable: ReadableStream<EncodedFrame>;
	writable: WritableStream<EncodedFrame>;
	options: TransformOptions;
};
type Scope = {
	onrtctransform: ((event: { transformer: Transformer }) => void) | null;
	postMessage(message: unknown): void;
};

const scope = self as unknown as Scope;
const counts = new Map<string, TransformCounts>();

scope.onrtctransform = ({ transformer }) => {
	const { id, direction, kid, key, salt } = transformer.options;
	const count: TransformCounts = { id, direction, frames: 0, failed: 0, bytes: 0 };
	counts.set(id, count);
	let counter = 0;

	const encrypt = async (frame: EncodedFrame): Promise<boolean> => {
		const header = writeHeader(kid, counter);
		const sealed = await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: nonceFor(salt, counter), additionalData: header },
			key,
			frame.data
		);
		counter = (counter + 1) >>> 0;
		const out = new Uint8Array(HEADER_BYTES + sealed.byteLength);
		out.set(header);
		out.set(new Uint8Array(sealed), HEADER_BYTES);
		frame.data = out.buffer;
		return true;
	};

	const decrypt = async (frame: EncodedFrame): Promise<boolean> => {
		const data = new Uint8Array(frame.data);
		const header = readHeader(data);
		if (!header || header.kid !== kid) return false;
		try {
			frame.data = await crypto.subtle.decrypt(
				{
					name: 'AES-GCM',
					iv: nonceFor(salt, header.counter),
					additionalData: data.subarray(0, HEADER_BYTES)
				},
				key,
				data.subarray(HEADER_BYTES)
			);
			return true;
		} catch {
			return false;
		}
	};

	const step = direction === 'encrypt' ? encrypt : decrypt;
	void transformer.readable
		.pipeThrough(
			new TransformStream<EncodedFrame, EncodedFrame>({
				async transform(frame, controller) {
					count.bytes += frame.data.byteLength;
					// A frame that does not open is dropped, never passed on to the decoder.
					if (await step(frame)) {
						count.frames += 1;
						controller.enqueue(frame);
					} else {
						count.failed += 1;
					}
				}
			})
		)
		.pipeTo(transformer.writable)
		.catch(() => {
			// The sender or receiver went away.
		});
};

setInterval(() => scope.postMessage([...counts.values()]), 250);

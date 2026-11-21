// The encoded-transform worker for table voice: every Opus frame this page's
// sender encodes is sealed here before the browser packetises it, and every
// frame a receiver is handed is opened here before it is decoded (docs/voice.md).
// One worker holds a page's sender and all of its receivers, and so one key
// store. The page posts each epoch's base key as a non-extractable CryptoKey;
// no key crosses as bytes, and none can be read back out of here.
//
// It is a bundled same-origin module (`new Worker(new URL(…, import.meta.url),
// { type: 'module' })` in sframe-client.ts): the site's CSP allows that under
// `script-src 'self'` and would block a `blob:` worker.
import { KeyStore } from './sframe.ts';
import {
	decryptor,
	encryptor,
	newTally,
	type EncodedFrame,
	type KeyMessage,
	type Tally,
	type TransformOptions,
	type WorkerMessage
} from './sframe-transform.ts';

type RtcTransformer = {
	readable: ReadableStream<EncodedFrame>;
	writable: WritableStream<EncodedFrame>;
	options: TransformOptions;
};
type Scope = {
	onrtctransform: ((event: { transformer: RtcTransformer }) => void) | null;
	onmessage: ((event: MessageEvent<KeyMessage>) => void) | null;
	postMessage(message: WorkerMessage): void;
};

const scope = self as unknown as Scope;
const store = new KeyStore();
const tallies = new Map<string, Tally>();

scope.onrtctransform = ({ transformer }) => {
	const options = transformer.options;
	const tally = newTally(options.id, options.direction);
	tallies.set(options.id, tally);
	const step =
		options.direction === 'encrypt'
			? encryptor(store, tally)
			: decryptor(store, tally, options.from);
	void transformer.readable
		.pipeThrough(new TransformStream(step))
		.pipeTo(transformer.writable)
		.catch(() => {
			// The sender or receiver went away.
		})
		.finally(() => {
			if (tallies.get(options.id) === tally) tallies.delete(options.id);
		});
};

scope.onmessage = ({ data }) => {
	try {
		if (data.type === 'epoch') store.add(data.epoch, data.baseKey);
		else if (data.type === 'send') store.sendAs(data.sender, data.epoch);
		else if (data.type === 'retire') store.retire(data.epoch);
		else if (data.type === 'hold') store.hold(data.held);
		else scope.postMessage({ type: 'tallies', id: data.id, tallies: [...tallies.values()] });
	} catch (error) {
		// A key the store will not take: the page hears of it, and nothing is sent under it.
		scope.postMessage({ type: 'refused', asked: data.type, error: String(error) });
	}
};

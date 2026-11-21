// What SFrame costs a page in a full room (P4C.2): one frame sealed and eight
// opened every 20 ms. It runs in a worker, as the real transform does, one
// frame at a time, so each figure includes what WebCrypto's promises cost.
import { KeyStore, importBaseKey, type Bytes } from '../../src/lib/voice/sframe.ts';

export type BenchRequest = { frames: number; bytes: number; others: number };
export type BenchResult = BenchRequest & {
	// Microseconds for one frame, averaged over every frame.
	sealMicros: number;
	openMicros: number;
	// A second of a full room, as a share of one core: 50 frames sealed, 50 opened from each other person.
	roomPercentOfCore: number;
};

self.onmessage = async ({ data }: MessageEvent<BenchRequest>) => {
	const secret = crypto.getRandomValues(new Uint8Array(16));
	const member = async (leaf: number) => {
		const store = new KeyStore();
		store.add(1n, await importBaseKey(secret));
		store.sendAs(leaf, 1n);
		return store;
	};
	const me = await member(0);
	const frame = crypto.getRandomValues(new Uint8Array(data.bytes));

	// What the others send is made first and not timed.
	const arriving: Bytes[] = [];
	for (let leaf = 1; leaf <= data.others; leaf++) {
		const other = await member(leaf);
		for (let n = 0; n < data.frames; n++) arriving.push((await other.seal(frame))!);
	}
	// A turn of each, so key derivation is not in the figures.
	await me.seal(frame);

	let started = performance.now();
	for (let n = 0; n < data.frames; n++) await me.seal(frame);
	const sealMicros = (1000 * (performance.now() - started)) / data.frames;

	started = performance.now();
	let opened = 0;
	for (const one of arriving) if ((await me.open(one)).ok) opened += 1;
	const openMicros = (1000 * (performance.now() - started)) / arriving.length;
	if (opened !== arriving.length) throw new Error(`opened ${opened} of ${arriving.length}`);

	const result: BenchResult = {
		...data,
		sealMicros,
		openMicros,
		roomPercentOfCore: (50 * (sealMicros + data.others * openMicros)) / 10_000
	};
	self.postMessage(result);
};

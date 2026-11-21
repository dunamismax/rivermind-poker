// Compares screenshots from `pnpm visual`, pixel for pixel:
//
//   pnpm visual:compare <before dir>... <after dir> [--diff <dir>]
//
// Every PNG must be in the "after" directory and at least one "before" directory,
// at one size. A pixel of the "after" capture passes when some "before" capture has exactly
// that value there, in every channel. One "before" run is the strict test; more
// than one allows for what a browser does not draw the same way twice (the
// anti-aliased edges of rotated cards), and only at the pixels where the "before"
// runs themselves disagree. For each file that fails it prints how many pixels do
// and the box that holds them, and with --diff writes the "after" capture with
// those pixels in magenta. Exits 1 on any difference.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

// The art tools are plain JavaScript, loaded by URL so svelte-check does not type-check them.
const { encodePng } = (await import(new URL('./pixel-art/png.js', import.meta.url).href)) as {
	encodePng: (image: Image) => Uint8Array;
};

interface Image {
	width: number;
	height: number;
	/** RGBA, a byte a channel. */
	data: Uint8Array;
}

/** Decodes an 8-bit RGB or RGBA PNG without interlacing, as browsers write screenshots. */
export function decodeScreenshot(png: Uint8Array): Image {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	let at = 8;
	let width = 0;
	let height = 0;
	let channels = 4;
	const idat: Uint8Array[] = [];
	while (at < png.length) {
		const length = view.getUint32(at);
		const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
		if (type === 'IHDR') {
			width = view.getUint32(at + 8);
			height = view.getUint32(at + 12);
			const [depth, color, , , interlace] = png.subarray(at + 16, at + 21);
			if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) {
				throw new Error(`unsupported PNG: depth ${depth}, colour type ${color}`);
			}
			channels = color === 2 ? 3 : 4;
		} else if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
		at += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const rows = new Uint8Array(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const row = rows.subarray(y * stride, (y + 1) * stride);
		row.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
		const prior = y ? rows.subarray((y - 1) * stride, y * stride) : null;
		for (let i = 0; i < stride; i++) {
			const a = i >= channels ? row[i - channels] : 0;
			const b = prior ? prior[i] : 0;
			const c = prior && i >= channels ? prior[i - channels] : 0;
			let add = 0;
			if (filter === 1) add = a;
			else if (filter === 2) add = b;
			else if (filter === 3) add = (a + b) >> 1;
			else if (filter === 4) {
				const p = a + b - c;
				const pa = Math.abs(p - a);
				const pb = Math.abs(p - b);
				const pc = Math.abs(p - c);
				add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			} else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
			row[i] = (row[i] + add) & 0xff;
		}
	}
	if (channels === 4) return { width, height, data: rows };
	const data = new Uint8Array(width * height * 4).fill(255);
	for (let i = 0; i < width * height; i++) data.set(rows.subarray(i * 3, i * 3 + 3), i * 4);
	return { width, height, data };
}

function pngsUnder(dir: string): string[] {
	return readdirSync(dir, { recursive: true })
		.map(String)
		.filter((path) => path.endsWith('.png'))
		.sort();
}

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const diffAt = args.indexOf('--diff');
const diffDir = diffAt === -1 ? null : resolve(args.splice(diffAt, 2)[1] ?? 'visual-diff');
if (args.length < 2) {
	console.error('usage: pnpm visual:compare <before dir>... <after dir> [--diff <dir>]');
	process.exit(2);
}
const dirs = args.map((dir) => resolve(dir));
const after = dirs.pop()!;
const names = [...new Set([...dirs, after].flatMap(pngsUnder))].sort();
if (names.length === 0) {
	console.error('No screenshots to compare.');
	process.exit(2);
}

let failed = 0;
let pixels = 0;
let varying = 0;
for (const name of names) {
	// A "before" run may hold only some of the scenes (extra captures of one size, say).
	const read = (dir: string) => {
		try {
			return readFileSync(resolve(dir, name));
		} catch {
			return null;
		}
	};
	const files = [after, ...dirs].map(read);
	if (files[0] === null || files.slice(1).every((file) => file === null)) {
		failed += 1;
		console.log(`${name}: missing ${files[0] === null ? 'after' : 'before'}`);
		continue;
	}
	const second = files[0];
	const firsts = files.slice(1).filter((file) => file !== null);
	const width = second.readUInt32BE(16);
	const height = second.readUInt32BE(20);
	pixels += width * height;
	// The same file is the same picture: only files that differ are decoded.
	if (firsts.some((first) => first.equals(second))) continue;
	if (
		firsts.some((first) => first.readUInt32BE(16) !== width || first.readUInt32BE(20) !== height)
	) {
		failed += 1;
		const sizes = firsts.map((first) => `${first.readUInt32BE(16)}×${first.readUInt32BE(20)}`);
		console.log(`${name}: ${sizes.join(', ')} before, ${width}×${height} after`);
		continue;
	}
	const b = decodeScreenshot(second).data;
	const before = firsts.map((first) => decodeScreenshot(first).data);
	let changed = 0;
	let left = width;
	let top = height;
	let right = -1;
	let bottom = -1;
	const marked = diffDir ? b.slice() : null;
	for (let i = 0; i < width * height; i++) {
		const at = i * 4;
		const same = (a: Uint8Array) =>
			a[at] === b[at] &&
			a[at + 1] === b[at + 1] &&
			a[at + 2] === b[at + 2] &&
			a[at + 3] === b[at + 3];
		if (same(before[0])) continue;
		if (before.some(same)) {
			varying += 1;
			continue;
		}
		changed += 1;
		const x = i % width;
		const y = (i - x) / width;
		left = Math.min(left, x);
		right = Math.max(right, x);
		top = Math.min(top, y);
		bottom = Math.max(bottom, y);
		marked?.set([255, 0, 255, 255], at);
	}
	if (changed === 0) continue;
	failed += 1;
	console.log(
		`${name}: ${changed} of ${width * height} pixels differ, within x ${left}–${right}, y ${top}–${bottom}`
	);
	if (diffDir && marked) {
		const path = resolve(diffDir, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, encodePng({ width, height, data: marked }));
	}
}
const allowed = varying ? ` (${varying} pixels took a value only another "before" run has)` : '';
console.log(
	failed
		? `${failed} of ${names.length} screenshots differ.`
		: `${names.length} screenshots match, ${pixels.toLocaleString('en-US')} pixels in all${allowed}.`
);
process.exit(failed ? 1 : 0);

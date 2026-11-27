// A minimal PNG writer and reader for the pixel art: 8-bit RGBA, no
// interlacing, filter 0 on every row. It never resamples. Only node:zlib.
//
// Adapted from the owner's earlier pixel-art tools.
import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes) {
	let c = 0xffffffff;
	for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	const typed = new TextEncoder().encode(type);
	out.set(typed, 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

/**
 * Encodes an RGBA image as PNG.
 * @param {{ width: number, height: number, data: Uint8Array }} image
 * @returns {Uint8Array}
 */
export function encodePng({ width, height, data }) {
	const ihdr = new Uint8Array(13);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, deflate, filter 0, no interlace
	const raw = new Uint8Array((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0;
		raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
	}
	const idat = new Uint8Array(deflateSync(raw, { level: 9 }));
	const parts = [
		SIGNATURE,
		chunk('IHDR', ihdr),
		chunk('IDAT', idat),
		chunk('IEND', new Uint8Array())
	];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** Undoes PNG row filter `type` in place (bytes per pixel 4). */
function unfilter(type, row, prior) {
	for (let i = 0; i < row.length; i++) {
		const a = i >= 4 ? row[i - 4] : 0;
		const b = prior ? prior[i] : 0;
		const c = prior && i >= 4 ? prior[i - 4] : 0;
		let add = 0;
		if (type === 1) add = a;
		else if (type === 2) add = b;
		else if (type === 3) add = (a + b) >> 1;
		else if (type === 4) {
			const p = a + b - c;
			const pa = Math.abs(p - a);
			const pb = Math.abs(p - b);
			const pc = Math.abs(p - c);
			add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
		} else if (type !== 0) throw new Error(`decodePng: bad filter ${type}`);
		row[i] = (row[i] + add) & 0xff;
	}
}

/**
 * Decodes an 8-bit RGBA PNG without interlacing: the drift check's reader
 * (two PNGs match when their pixels do, whatever zlib produced) and the
 * reader for the imported card sprites in web/art/cards/.
 * @param {Uint8Array} png
 */
export function decodePng(png) {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	let at = 8;
	let width = 0;
	let height = 0;
	const idat = [];
	while (at < png.length) {
		const length = view.getUint32(at);
		const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
		const data = png.subarray(at + 8, at + 8 + length);
		if (type === 'IHDR') {
			width = view.getUint32(at + 8);
			height = view.getUint32(at + 12);
			if (data[8] !== 8 || data[9] !== 6) throw new Error('decodePng: only 8-bit RGBA');
			if (data[12] !== 0) throw new Error('decodePng: no interlacing');
		} else if (type === 'IDAT') idat.push(data);
		at += 12 + length;
	}
	const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
	let o = 0;
	for (const d of idat) {
		joined.set(d, o);
		o += d.length;
	}
	const raw = inflateSync(joined);
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const at = y * (width * 4 + 1);
		const row = raw.slice(at + 1, at + 1 + width * 4);
		unfilter(raw[at], row, y ? data.subarray((y - 1) * width * 4, y * width * 4) : null);
		data.set(row, y * width * 4);
	}
	return { width, height, data };
}

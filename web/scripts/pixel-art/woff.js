// Wraps a TrueType font in the WOFF 1.0 container: the same tables, each
// compressed with zlib. Every browser reads it.
//
// Adapted from the owner's Lorehallow art tools (web/src/lib/woff.ts there).
import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Converts a TrueType (sfnt) font to WOFF.
 * @param {Uint8Array} ttf
 * @returns {Uint8Array}
 */
export function fromSfnt(ttf) {
	const v = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
	const flavor = v.getUint32(0);
	const n = v.getUint16(4);
	let total = 12 + 16 * n;
	const tables = [];
	for (let i = 0; i < n; i++) {
		const rec = 12 + 16 * i;
		const off = v.getUint32(rec + 8);
		const length = v.getUint32(rec + 12);
		const orig = ttf.subarray(off, off + length);
		const z = deflateSync(orig, { level: 9 });
		tables.push({
			tag: ttf.subarray(rec, rec + 4),
			checksum: v.getUint32(rec + 4),
			orig,
			comp: z.length < orig.length ? new Uint8Array(z) : orig
		});
		total += (length + 3) & ~3;
	}
	const hdrLen = 44 + 20 * n;
	let dataLen = 0;
	for (const t of tables) dataLen += (t.comp.length + 3) & ~3;
	const out = new Uint8Array(hdrLen + dataLen);
	const o = new DataView(out.buffer);
	out.set(new TextEncoder().encode('wOFF'), 0);
	o.setUint32(4, flavor);
	o.setUint32(8, out.length);
	o.setUint16(12, n);
	o.setUint32(16, total);
	o.setUint16(20, 1); // font version 1.0
	let at = hdrLen;
	tables.forEach((t, i) => {
		const rec = 44 + 20 * i;
		out.set(t.tag, rec);
		o.setUint32(rec + 4, at);
		o.setUint32(rec + 8, t.comp.length);
		o.setUint32(rec + 12, t.orig.length);
		o.setUint32(rec + 16, t.checksum);
		out.set(t.comp, at);
		at += (t.comp.length + 3) & ~3;
	});
	return out;
}

/**
 * The uncompressed tables of a WOFF file by tag, for comparing two fonts
 * whatever zlib produced.
 * @param {Uint8Array} woff
 * @returns {Map<string, Uint8Array>}
 */
export function woffTables(woff) {
	const v = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
	const n = v.getUint16(12);
	const out = new Map();
	for (let i = 0; i < n; i++) {
		const rec = 44 + 20 * i;
		const tag = String.fromCharCode(...woff.subarray(rec, rec + 4));
		const off = v.getUint32(rec + 4);
		const comp = v.getUint32(rec + 8);
		const orig = v.getUint32(rec + 12);
		const data = woff.subarray(off, off + comp);
		out.set(tag, comp < orig ? new Uint8Array(inflateSync(data)) : data);
	}
	return out;
}

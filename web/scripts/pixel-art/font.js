// RiverMind Pixel, the site's hand-drawn font: read the source
// (web/art/rivermind-pixel.font), compile it into TrueType, and draw text with
// it onto pixel canvases.
//
// The source has one grid of "#" and "." per glyph: capital height 7 rows,
// descenders in rows 8 and 9. One font pixel is 100 units and the em is 10
// pixels, so the font is pixel-exact at 10px multiples (20px is 2x).
//
// Adapted from the owner's earlier pixel-font compiler, which was checked byte
// for byte against an earlier Go compiler.

export const CAP_ROWS = 7;
export const DESCENT_ROWS = 2;
export const ROWS = CAP_ROWS + DESCENT_ROWS;
export const UNIT = 100;
const UNITS_PER_EM = 1000;
const ASCENDER = 800;
const DESCENDER = -200;

/** @typedef {{ codePoint: number, width: number, bits: boolean[][] }} Glyph */

/** @param {Glyph} g */
export const advance = (g) => g.width + 1;

export class PixelFont {
	name = '';
	/** @type {Map<number, Glyph>} */
	glyphs = new Map();

	/** @param {string} src */
	static parse(src) {
		const f = new PixelFont();
		/** @type {Glyph | null} */
		let cur = null;
		/** @type {string[]} */
		let rows = [];
		let start = 0;
		const finish = () => {
			if (cur === null) return;
			const ch = String.fromCodePoint(cur.codePoint);
			if (rows.length !== CAP_ROWS && rows.length !== ROWS) {
				throw new Error(`line ${start}: glyph "${ch}" has ${rows.length} rows; want 7 or 9`);
			}
			cur.width = rows[0]?.length ?? 0;
			for (let i = 0; i < ROWS; i++) {
				const bits = new Array(cur.width).fill(false);
				cur.bits[i] = bits;
				const row = rows[i];
				if (row === undefined) continue;
				if (row.length !== cur.width) {
					throw new Error(
						`line ${start + i + 1}: glyph "${ch}" row is ${row.length} wide; want ${cur.width}`
					);
				}
				[...row].forEach((c, j) => {
					if (c === '#') bits[j] = true;
					else if (c !== '.') throw new Error(`line ${start + i + 1}: glyph "${ch}" has "${c}"`);
				});
			}
			if (f.glyphs.has(cur.codePoint))
				throw new Error(`line ${start}: glyph "${ch}" defined twice`);
			f.glyphs.set(cur.codePoint, cur);
			cur = null;
			rows = [];
		};
		src.split('\n').forEach((raw, i) => {
			const n = i + 1;
			const line = raw.replace(/[ \t\r]+$/, '');
			if (line.startsWith('#') && cur === null) return; // comment
			if (line === '') finish();
			else if (line.startsWith('name: ')) f.name = line.slice(6).trim();
			else if (line.startsWith('glyph ')) {
				finish();
				cur = { codePoint: parseCodePoint(line.slice(6), n), width: 0, bits: [] };
				start = n;
			} else if (cur !== null) rows.push(line);
			else throw new Error(`line ${n}: unexpected "${line}" outside a glyph`);
		});
		finish();
		if (f.name === '') throw new Error('missing "name:" line');
		if (!f.glyphs.has(0x20)) throw new Error('missing a space glyph');
		return f;
	}

	codePoints() {
		return [...this.glyphs.keys()].sort((a, b) => a - b);
	}

	/** @param {string} s */
	measure(s) {
		let w = 0;
		for (const c of s) {
			const g = this.glyphs.get(c.codePointAt(0) ?? 0);
			if (g) w += advance(g);
		}
		return w > 0 ? w - 1 : 0;
	}

	/**
	 * Paints s with its capital top-left at (x, y).
	 * @param {{ px: (x: number, y: number, color: string) => void }} canvas
	 * @param {string} s
	 * @param {number} x
	 * @param {number} y
	 * @param {string} color
	 */
	draw(canvas, s, x, y, color) {
		for (const c of s) {
			const g = this.glyphs.get(c.codePointAt(0) ?? 0);
			if (!g) throw new Error(`no glyph for "${c}"`);
			for (let row = 0; row < ROWS; row++) {
				g.bits[row]?.forEach((on, col) => on && canvas.px(x + col, y + row, color));
			}
			x += advance(g);
		}
	}

	ttf() {
		return compileTtf(this);
	}
}

/** @param {string} s @param {number} line */
function parseCodePoint(s, line) {
	if (s.startsWith('U+')) return Number.parseInt(s.slice(2), 16);
	if ([...s].length !== 1) throw new Error(`line ${line}: glyph name "${s}" must be one character`);
	return s.codePointAt(0) ?? 0;
}

// --- TrueType ---------------------------------------------------------------

/**
 * Traces a glyph's pixels into closed loops: clockwise around filled areas and
 * counter-clockwise around holes (y up), with straight runs merged.
 * @param {Glyph} g
 */
function contours(g) {
	const filled = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < g.width && g.bits[r]?.[c] === true;
	const key = (p) => `${p.x},${p.y}`;
	const next = new Map();
	const add = (a, b) => {
		const k = key(a);
		const list = next.get(k);
		if (list) list.push(b);
		else next.set(k, [b]);
	};
	for (let r = 0; r < ROWS; r++) {
		for (let c = 0; c < g.width; c++) {
			if (!filled(r, c)) continue;
			const tl = { x: c, y: r };
			const tr = { x: c + 1, y: r };
			const bl = { x: c, y: r + 1 };
			const br = { x: c + 1, y: r + 1 };
			if (!filled(r - 1, c)) add(tl, tr);
			if (!filled(r, c + 1)) add(tr, br);
			if (!filled(r + 1, c)) add(br, bl);
			if (!filled(r, c - 1)) add(bl, tl);
		}
	}
	const starts = [...next.keys()]
		.map((k) => {
			const [x, y] = k.split(',').map(Number);
			return { x, y };
		})
		.sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
	const loops = [];
	for (const s of starts) {
		for (;;) {
			const outs0 = next.get(key(s)) ?? [];
			if (outs0.length === 0) break;
			const loop = [s];
			let prev = s;
			let cur = outs0.shift();
			while (cur.x !== s.x || cur.y !== s.y) {
				loop.push(cur);
				const outs = next.get(key(cur)) ?? [];
				let pick = 0;
				if (outs.length > 1) {
					const dx = cur.x - prev.x;
					const dy = cur.y - prev.y;
					outs.forEach((o, i) => {
						if (o.x - cur.x === -dy && o.y - cur.y === dx) pick = i;
					});
				}
				prev = cur;
				cur = outs.splice(pick, 1)[0];
			}
			loops.push(simplify(loop));
		}
	}
	return loops.map((l) => l.map((p) => ({ x: p.x * UNIT, y: (CAP_ROWS - p.y) * UNIT })));
}

function simplify(loop) {
	const n = loop.length;
	return loop.filter((p, i) => {
		const a = loop[(i + n - 1) % n];
		const b = loop[(i + 1) % n];
		return !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y));
	});
}

/** A growable big-endian byte buffer. */
class Bytes {
	#buf = new Uint8Array(256);
	#view = new DataView(this.#buf.buffer);
	length = 0;

	#grow(n) {
		if (this.length + n <= this.#buf.length) return;
		const next = new Uint8Array(Math.max(this.#buf.length * 2, this.length + n));
		next.set(this.#buf);
		this.#buf = next;
		this.#view = new DataView(next.buffer);
	}
	u8(v) {
		this.#grow(1);
		this.#view.setUint8(this.length, v & 0xff);
		this.length += 1;
		return this;
	}
	u16(...vs) {
		for (const v of vs) {
			this.#grow(2);
			this.#view.setUint16(this.length, v & 0xffff);
			this.length += 2;
		}
		return this;
	}
	i16(...vs) {
		for (const v of vs) {
			this.#grow(2);
			this.#view.setInt16(this.length, v);
			this.length += 2;
		}
		return this;
	}
	u32(...vs) {
		for (const v of vs) {
			this.#grow(4);
			this.#view.setUint32(this.length, v >>> 0);
			this.length += 4;
		}
		return this;
	}
	i64(v) {
		this.#grow(8);
		this.#view.setBigInt64(this.length, v);
		this.length += 8;
		return this;
	}
	raw(b) {
		this.#grow(b.length);
		this.#buf.set(b, this.length);
		this.length += b.length;
		return this;
	}
	bytes() {
		return this.#buf.slice(0, this.length);
	}
}

function encodeGlyph(loops, adv) {
	const gd = {
		advance: adv,
		data: new Uint8Array(0),
		xMin: 0,
		bbox: [0, 0, 0, 0],
		points: 0,
		loops: loops.length,
		empty: false
	};
	if (loops.length === 0) {
		gd.empty = true;
		return gd;
	}
	const bb = [2 ** 30, 2 ** 30, -(2 ** 30), -(2 ** 30)];
	for (const l of loops) {
		for (const p of l) {
			bb[0] = Math.min(bb[0], p.x);
			bb[1] = Math.min(bb[1], p.y);
			bb[2] = Math.max(bb[2], p.x);
			bb[3] = Math.max(bb[3], p.y);
			gd.points++;
		}
	}
	gd.bbox = bb;
	gd.xMin = bb[0];
	const b = new Bytes();
	b.i16(loops.length, ...bb);
	let end = -1;
	for (const l of loops) {
		end += l.length;
		b.u16(end);
	}
	b.u16(0);
	for (let i = 0; i < gd.points; i++) b.u8(0x01);
	let px = 0;
	let py = 0;
	const ys = [];
	for (const l of loops) {
		for (const p of l) {
			b.i16(p.x - px);
			ys.push(p.y - py);
			px = p.x;
			py = p.y;
		}
	}
	b.i16(...ys);
	while (b.length % 4 !== 0) b.u8(0);
	gd.data = b.bytes();
	return gd;
}

/** @param {PixelFont} f */
function compileTtf(f) {
	const cps = f.codePoints();
	const notdef = { codePoint: 0, width: 4, bits: [] };
	for (let r = 0; r < ROWS; r++) {
		notdef.bits[r] = [0, 1, 2, 3].map(
			(c) => r < CAP_ROWS && (r === 0 || r === CAP_ROWS - 1 || c === 0 || c === 3)
		);
	}
	const glyphs = [notdef, ...cps.map((c) => f.glyphs.get(c))].map((g) =>
		encodeGlyph(contours(g), advance(g) * UNIT)
	);

	const glyf = new Bytes();
	const loca = new Bytes();
	const bb = [2 ** 30, 2 ** 30, -(2 ** 30), -(2 ** 30)];
	let maxPoints = 0;
	let maxContours = 0;
	let advMax = 0;
	let minLsb = 2 ** 30;
	let minRsb = 2 ** 30;
	let maxExtent = -(2 ** 30);
	let advSum = 0;
	for (const g of glyphs) {
		loca.u32(glyf.length);
		glyf.raw(g.data);
		advMax = Math.max(advMax, g.advance);
		advSum += g.advance;
		if (g.empty) continue;
		bb[0] = Math.min(bb[0], g.bbox[0]);
		bb[1] = Math.min(bb[1], g.bbox[1]);
		bb[2] = Math.max(bb[2], g.bbox[2]);
		bb[3] = Math.max(bb[3], g.bbox[3]);
		maxPoints = Math.max(maxPoints, g.points);
		maxContours = Math.max(maxContours, g.loops);
		minLsb = Math.min(minLsb, g.xMin);
		minRsb = Math.min(minRsb, g.advance - g.bbox[2]);
		maxExtent = Math.max(maxExtent, g.bbox[2]);
	}
	loca.u32(glyf.length);
	const n = glyphs.length;

	const head = new Bytes()
		.u32(0x00010000, 0x00010000, 0, 0x5f0f3cf5)
		.u16(0x0001, UNITS_PER_EM)
		.i64(3_870_000_000n)
		.i64(3_870_000_000n)
		.i16(bb[0], bb[1], bb[2], bb[3])
		.u16(0, 8)
		.i16(2, 1, 0);
	const hhea = new Bytes()
		.u32(0x00010000)
		.i16(ASCENDER, DESCENDER, 0)
		.u16(advMax)
		.i16(minLsb, minRsb, maxExtent, 1, 0, 0, 0, 0, 0, 0, 0)
		.u16(n);
	const maxp = new Bytes()
		.u32(0x00010000)
		.u16(n, maxPoints, maxContours, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0);
	const hmtx = new Bytes();
	for (const g of glyphs) hmtx.u16(g.advance).i16(g.xMin);

	const bmp = cps.filter((c) => c <= 0xffff);
	const first = bmp[0] ?? 0;
	const last = bmp.at(-1) ?? 0;
	const os2 = new Bytes()
		.u16(4)
		.i16(Math.trunc(advSum / n))
		.u16(400, 5, 0)
		.i16(650, 600, 0, 100, 650, 600, 0, 400, UNIT, 300, 0)
		.raw(new Uint8Array(10))
		.u32((1 | (1 << 1) | (1 << 31)) >>> 0, 0, 0, 0)
		.raw(new TextEncoder().encode('RMPK'))
		.u16(0x0040 | 0x0080, first, last)
		.i16(ASCENDER, DESCENDER, 0)
		.u16(ASCENDER, -DESCENDER)
		.u32(1, 0)
		.i16(500, CAP_ROWS * UNIT)
		.u16(0, 0x20, 1);

	// cmap format 4, one segment per character.
	const segs = bmp.length + 1;
	let searchRange = 1;
	let entrySelector = 0;
	while (searchRange * 2 <= segs) {
		searchRange *= 2;
		entrySelector++;
	}
	searchRange *= 2;
	const sub = new Bytes().u16(
		4,
		16 + segs * 8,
		0,
		segs * 2,
		searchRange,
		entrySelector,
		segs * 2 - searchRange
	);
	sub.u16(...bmp, 0xffff, 0);
	sub.u16(...bmp, 0xffff);
	sub.u16(...bmp.map((c) => (cps.indexOf(c) + 1 - c) & 0xffff), 1);
	sub.u16(...new Array(segs).fill(0));
	const cmap = new Bytes().u16(0, 2, 0, 3).u32(20).u16(3, 1).u32(20).raw(sub.bytes());

	const family = f.name;
	const ps = 'RiverMindPixel-Regular';
	const names = [
		[0, 'Hand-drawn for rivermindpoker.com'],
		[1, family],
		[2, 'Regular'],
		[3, `${ps};1.000`],
		[4, `${family} Regular`],
		[5, 'Version 1.000'],
		[6, ps],
		[13, 'GNU General Public License v3.0 or later'],
		[14, 'https://www.gnu.org/licenses/gpl-3.0.html']
	];
	const nameRecs = new Bytes();
	const nameStr = new Bytes();
	for (const [id, s] of names) {
		const units = [];
		for (let i = 0; i < s.length; i++) units.push(s.charCodeAt(i));
		nameRecs.u16(3, 1, 0x0409, id, units.length * 2, nameStr.length);
		nameStr.u16(...units);
	}
	const name = new Bytes()
		.u16(0, names.length, 6 + 12 * names.length)
		.raw(nameRecs.bytes())
		.raw(nameStr.bytes());
	const post = new Bytes().u32(0x00030000, 0).i16(-UNIT, UNIT).u32(0, 0, 0, 0, 0);

	return assemble({
		'OS/2': os2.bytes(),
		cmap: cmap.bytes(),
		glyf: glyf.bytes(),
		head: head.bytes(),
		hhea: hhea.bytes(),
		hmtx: hmtx.bytes(),
		loca: loca.bytes(),
		maxp: maxp.bytes(),
		name: name.bytes(),
		post: post.bytes()
	});
}

function checksum(b) {
	let sum = 0;
	for (let i = 0; i < b.length; i += 4) {
		const w =
			((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0);
		sum = (sum + (w >>> 0)) >>> 0;
	}
	return sum;
}

function assemble(tables) {
	const tags = Object.keys(tables).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const n = tags.length;
	let sr = 1;
	let es = 0;
	while (sr * 2 <= n) {
		sr *= 2;
		es++;
	}
	const hdr = new Uint8Array(12 + 16 * n);
	const hv = new DataView(hdr.buffer);
	hv.setUint32(0, 0x00010000);
	hv.setUint16(4, n);
	hv.setUint16(6, sr * 16);
	hv.setUint16(8, es);
	hv.setUint16(10, n * 16 - sr * 16);
	const body = new Bytes();
	let headAt = 0;
	tags.forEach((t, i) => {
		const data = tables[t];
		const rec = 12 + 16 * i;
		for (let k = 0; k < 4; k++) hdr[rec + k] = t.charCodeAt(k);
		hv.setUint32(rec + 4, checksum(data));
		hv.setUint32(rec + 8, hdr.length + body.length);
		hv.setUint32(rec + 12, data.length);
		if (t === 'head') headAt = hdr.length + body.length;
		body.raw(data);
		while (body.length % 4 !== 0) body.u8(0);
	});
	const out = new Uint8Array(hdr.length + body.length);
	out.set(hdr);
	out.set(body.bytes(), hdr.length);
	new DataView(out.buffer).setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
	return out;
}

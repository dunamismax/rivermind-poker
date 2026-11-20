// Python's `random.Random` in TypeScript (P4B.6): the MT19937 generator with
// CPython's seeding and the methods the bots use, so a bot seeded the same way
// draws the same numbers in both languages.
//
// Bots draw from their own generator. A live table seeds it from the
// operating system's randomness (D-8), as `serve-nl` seeds `random.Random`
// from `secrets.SystemRandom().getrandbits(64)`; tests and the parity check
// pass a fixed seed. This is not a cryptographic generator and never deals.

const N = 624;
const M = 397;
const UPPER = 0x80000000;
const LOWER = 0x7fffffff;
const MATRIX = 0x9908b0df;

export class PythonRandom {
	private readonly mt = new Uint32Array(N);
	private index = N + 1;

	/** Seeded as `random.Random(seed)` with a whole number (its absolute value, as CPython does). */
	constructor(seed: number | bigint = 0n) {
		this.seed(seed);
	}

	seed(seed: number | bigint): void {
		if (typeof seed === 'number' && !Number.isSafeInteger(seed)) {
			throw new RangeError('seed must be a whole number (use a bigint past 2^53)');
		}
		let n = BigInt(seed);
		if (n < 0n) n = -n;
		// CPython splits the seed into 32-bit words, least significant first.
		const key: number[] = [];
		do {
			key.push(Number(n & 0xffffffffn));
			n >>= 32n;
		} while (n > 0n);
		this.initByArray(key);
	}

	private initGenrand(s: number): void {
		const mt = this.mt;
		mt[0] = s >>> 0;
		for (let i = 1; i < N; i++) {
			const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
			mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
		}
		this.index = N;
	}

	private initByArray(key: readonly number[]): void {
		const mt = this.mt;
		this.initGenrand(19650218);
		let i = 1;
		let j = 0;
		for (let k = Math.max(N, key.length); k > 0; k--) {
			const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
			mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
			i++;
			j++;
			if (i >= N) {
				mt[0] = mt[N - 1];
				i = 1;
			}
			if (j >= key.length) j = 0;
		}
		for (let k = N - 1; k > 0; k--) {
			const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
			mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
			i++;
			if (i >= N) {
				mt[0] = mt[N - 1];
				i = 1;
			}
		}
		mt[0] = 0x80000000;
		this.index = N;
	}

	/** The next 32-bit output, as CPython's `genrand_uint32`. */
	uint32(): number {
		const mt = this.mt;
		if (this.index >= N) {
			let kk = 0;
			for (; kk < N - M; kk++) {
				const y = (mt[kk] & UPPER) | (mt[kk + 1] & LOWER);
				mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX : 0);
			}
			for (; kk < N - 1; kk++) {
				const y = (mt[kk] & UPPER) | (mt[kk + 1] & LOWER);
				mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX : 0);
			}
			const y = (mt[N - 1] & UPPER) | (mt[0] & LOWER);
			mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX : 0);
			this.index = 0;
		}
		let y = mt[this.index++];
		y ^= y >>> 11;
		y ^= (y << 7) & 0x9d2c5680;
		y ^= (y << 15) & 0xefc60000;
		y ^= y >>> 18;
		return y >>> 0;
	}

	/** `random()`: a float in [0, 1) with 53 random bits. */
	random(): number {
		const a = this.uint32() >>> 5;
		const b = this.uint32() >>> 6;
		return (a * 67108864 + b) * (1 / 9007199254740992);
	}

	/** `getrandbits(k)` for k from 0 to 53. */
	getrandbits(k: number): number {
		if (!Number.isInteger(k) || k < 0 || k > 53) throw new RangeError('k must be 0 to 53');
		if (k === 0) return 0;
		if (k <= 32) return this.uint32() >>> (32 - k);
		// Words fill from the least significant end; the last keeps its top bits.
		const low = this.uint32();
		const high = this.uint32() >>> (64 - k);
		return high * 4294967296 + low;
	}

	/** `_randbelow(n)`: a uniform whole number below n, by rejection on `n.bit_length()` bits. */
	below(n: number): number {
		if (!Number.isSafeInteger(n) || n <= 0)
			throw new RangeError('n must be a positive whole number');
		const k = bitLength(n);
		let r = this.getrandbits(k);
		while (r >= n) r = this.getrandbits(k);
		return r;
	}

	/** `randint(a, b)`: a uniform whole number from a to b inclusive. */
	randint(a: number, b: number): number {
		if (b < a) throw new RangeError('empty range for randint');
		return a + this.below(b - a + 1);
	}

	/** `choice(items)`. */
	choice<T>(items: readonly T[]): T {
		if (items.length === 0) throw new RangeError('cannot choose from an empty sequence');
		return items[this.below(items.length)];
	}
}

function bitLength(n: number): number {
	return n < 2 ** 32 ? 32 - Math.clz32(n) : 32 + (32 - Math.clz32(Math.floor(n / 2 ** 32)));
}

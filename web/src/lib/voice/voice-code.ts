// The table voice code (docs/voice.md): four words that everyone in one epoch
// of a table's group sees alike, and that change whenever someone joins or
// leaves. People at the table can read it aloud. If the server had put itself
// between two of them, each would be in a different group, and the words
// would differ.
//
// It is made from the MLS epoch authenticator, which every member of the
// epoch holds and nobody outside it does. Four words of the 2,048-word list
// are 44 bits, few enough to say and too few to be safe on their own: someone
// running both halves of a split table could try commits until two groups'
// codes agreed. So the authenticator is first stretched with PBKDF2, which
// makes each try cost them what it costs a player once an epoch.
//
// The stretching is a chain of short rounds, each fed the last one's output,
// not one long call. The work is the same and cannot be done out of order.
// But a browser runs WebCrypto's work in one queue, the same queue the worker
// seals and opens audio frames in: one call of 600,000 iterations held
// Firefox's for some 50 ms and every listener heard the gap. A round is done
// in about a millisecond, and frames go between rounds.
import words from './voice-words.json' with { type: 'json' };

export const CODE_WORDS = 4;
export const CODE_ROUNDS = 60;
export const ITERATIONS_A_ROUND = 10_000;
const SALT = new TextEncoder().encode('RiverMind table voice code 1');
const BITS_A_WORD = 11;

export async function voiceCode(authenticator: Uint8Array): Promise<string[]> {
	let stretched = new Uint8Array(authenticator);
	for (let round = 0; round < CODE_ROUNDS; round++) {
		const key = await crypto.subtle.importKey('raw', stretched, 'PBKDF2', false, ['deriveBits']);
		stretched = new Uint8Array(
			await crypto.subtle.deriveBits(
				{ name: 'PBKDF2', hash: 'SHA-256', salt: SALT, iterations: ITERATIONS_A_ROUND },
				key,
				256
			)
		);
	}
	// The first 44 bits, eleven a word, first word first.
	let value = 0n;
	for (const byte of stretched.subarray(0, 6)) value = (value << 8n) | BigInt(byte);
	value >>= 48n - BigInt(CODE_WORDS * BITS_A_WORD);
	const code: string[] = [];
	for (let n = 0; n < CODE_WORDS; n++) {
		code.unshift(words[Number(value & 2047n)]);
		value >>= BigInt(BITS_A_WORD);
	}
	return code;
}

// Voice tokens (P4C.4): what lets a page into a table's voice room. The table
// server issues one to a seated person (P4C.5), and the voice service admits a
// socket only with one: genuine, for the table the socket asks to join, not
// expired, and never used before.
//
//   v1.<table>.<seat>.<player>.<expires>.<nonce>.<signature>
//
// `player` is the player's public reference (auth.ts `publicRef`), the name the
// group's leaves carry, never the player id behind the session cookie. The
// signature is HMAC-SHA256 over the same fields under the voice key, and the
// signed text starts `voice:v1:`, so no other value the site signs can pass as
// a token.
//
// The voice key is derived from the site's secret (`voiceKey`), so the voice
// service, which faces the internet on a UDP port, never holds the secret that
// signs session cookies: a compromise of it cannot forge a guest's session.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// A token lives at most this long from when it is issued.
export const TOKEN_SECONDS = 60;
const VERSION = 'v1';
const KEY_LABEL = 'rivermind-poker voice token key v1';

const TABLE = /^[A-Za-z0-9_-]{1,64}$/;
const SEAT = /^(0|[1-9][0-9]?)$/;
const PLAYER = /^[0-9a-f]{16}$/;
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;

export type VoiceGrant = { table: string; seat: number; player: string };
export type VoiceToken = VoiceGrant & { expires: number; nonce: string };

export type TokenRefusal = 'malformed' | 'forged' | 'other-table' | 'expired' | 'reused';

// The key tokens are signed with, from the site's secret (the bytes runtime.ts loads).
export function voiceKey(siteSecret: Uint8Array): Buffer {
	return createHmac('sha256', siteSecret).update(KEY_LABEL, 'utf8').digest();
}

function sign(key: Uint8Array, fields: string[]): string {
	return createHmac('sha256', key)
		.update(`voice:${fields.join(':')}`, 'utf8')
		.digest('hex');
}

// A token for one seated person, good for TOKEN_SECONDS from `now` (seconds).
export function issueToken(key: Uint8Array, grant: VoiceGrant, now: number): string {
	if (!TABLE.test(grant.table) || !SEAT.test(String(grant.seat)) || !PLAYER.test(grant.player)) {
		throw new Error('not a table, seat and player a token can name');
	}
	const fields = [
		VERSION,
		grant.table,
		String(grant.seat),
		grant.player,
		String(Math.floor(now) + TOKEN_SECONDS),
		randomBytes(16).toString('base64url')
	];
	return [...fields, sign(key, fields)].join('.');
}

// What a token says, if it is genuine and names `table`, and has not expired by `now`.
export function readToken(
	key: Uint8Array,
	token: unknown,
	table: unknown,
	now: number
): VoiceToken | TokenRefusal {
	if (typeof token !== 'string' || token.length > 256) return 'malformed';
	const parts = token.split('.');
	if (parts.length !== 7) return 'malformed';
	const [version, named, seat, player, expires, nonce, signature] = parts;
	if (
		version !== VERSION ||
		!TABLE.test(named) ||
		!SEAT.test(seat) ||
		!PLAYER.test(player) ||
		!/^[0-9]{1,12}$/.test(expires) ||
		!NONCE.test(nonce) ||
		!SIGNATURE.test(signature)
	) {
		return 'malformed';
	}
	const expected = Buffer.from(sign(key, parts.slice(0, 6)), 'utf8');
	if (!timingSafeEqual(expected, Buffer.from(signature, 'utf8'))) return 'forged';
	if (named !== table) return 'other-table';
	const until = Number(expires);
	// A token that claims a longer life than any the table server issues is not one of ours.
	if (until <= now || until > now + TOKEN_SECONDS + 5) return 'expired';
	return { table: named, seat: Number(seat), player, expires: until, nonce };
}

// The tokens already used, each kept until it would have expired anyway.
export class TokenLedger {
	#used = new Map<string, number>();

	// Admit a token once: false if it was used before.
	admit(token: VoiceToken, now: number): boolean {
		for (const [nonce, until] of this.#used) if (until <= now) this.#used.delete(nonce);
		if (this.#used.has(token.nonce)) return false;
		this.#used.set(token.nonce, token.expires);
		return true;
	}

	get size(): number {
		return this.#used.size;
	}
}

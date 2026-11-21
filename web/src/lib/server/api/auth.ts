/**
 * Player identity (P4.1), ported from `rivermind/server/auth.py` (P4B.5a).
 *
 * A player is identified by a session cookie: the player id and the time it
 * was issued, signed with the server's secret (HMAC-SHA256). No sessions are
 * stored, sessions survive restarts, and a session older than
 * {@link SESSION_SECONDS} is refused. The format, the signed message and the
 * secret are the Python server's, so a guest's cookie keeps working across
 * the P4B.7 cutover; `auth.spec.ts` checks values written by Python.
 *
 * Before P4.1 the client kept a bearer token ({@link issue} and
 * {@link verify}), the player id signed with the same secret. A token is now
 * accepted only once, by `POST /api/session`, to move a player onto a cookie.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

const PREFIX = 'p_';
export const COOKIE_NAME = 'rm_session';
/** How long a session lasts after it was last issued. Each visit renews it. */
export const SESSION_SECONDS = 180 * 24 * 3600;
/** A session older than this is issued again when the player visits. */
export const RENEW_AFTER_SECONDS = 24 * 3600;
const SESSION_VERSION = 's1';

/** The secret as bytes: `RIVERMIND_SECRET`, or the secret file's text without surrounding whitespace. */
export type Secret = Uint8Array;

export function newPlayerId(): string {
	return PREFIX + randomBytes(12).toString('base64url');
}

function hmacHex(secret: Secret, message: string): string {
	return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

/** Constant-time string equality; strings of different lengths are simply unequal. */
export function sameText(a: string, b: string): boolean {
	const left = Buffer.from(a, 'utf8');
	const right = Buffer.from(b, 'utf8');
	return left.length === right.length && timingSafeEqual(left, right);
}

function signature(secret: Secret, playerId: string): string {
	return hmacHex(secret, playerId).slice(0, 43);
}

/** A legacy (Phase 3) bearer token. Only tests and old clients still hold these. */
export function issue(secret: Secret, playerId: string): string {
	return `${playerId}.${signature(secret, playerId)}`;
}

/** The player id a legacy token was issued for, or null if it is not genuine. */
export function verify(secret: Secret, token: unknown): string | null {
	if (typeof token !== 'string' || token.length > 200 || !token.includes('.')) return null;
	const dot = token.lastIndexOf('.');
	const playerId = token.slice(0, dot);
	if (!playerId.startsWith(PREFIX)) return null;
	return sameText(token.slice(dot + 1), signature(secret, playerId)) ? playerId : null;
}

function sessionSignature(secret: Secret, playerId: string, issued: number): string {
	// The version and purpose are signed too, so a legacy token can never pass as a session.
	return hmacHex(secret, `session:${SESSION_VERSION}:${playerId}:${issued}`);
}

/** The session cookie value for `playerId`, issued at `now` (seconds since the epoch). */
export function issueSession(secret: Secret, playerId: string, now: number): string {
	const issued = Math.floor(now);
	return `${SESSION_VERSION}.${playerId}.${issued}.${sessionSignature(secret, playerId, issued)}`;
}

export interface Session {
	playerId: string;
	/** When the cookie was issued, in whole seconds since the epoch. */
	issued: number;
}

/** The player id and issue time of a genuine, unexpired session, else null. */
export function readSession(secret: Secret, value: unknown, now: number): Session | null {
	if (typeof value !== 'string' || value.length > 200) return null;
	const parts = value.split('.');
	if (parts.length !== 4 || parts[0] !== SESSION_VERSION || !parts[1].startsWith(PREFIX)) {
		return null;
	}
	const [, playerId, issuedText, sig] = parts;
	if (!/^[0-9]{1,12}$/.test(issuedText)) return null;
	const issued = Number(issuedText);
	if (!sameText(sig, sessionSignature(secret, playerId, issued))) return null;
	if (issued > now + 300 || now - issued > SESSION_SECONDS) return null;
	return { playerId, issued };
}

/** The name other players know a player by (P4.5): a hash of the id, which it does not reveal. */
export function publicRef(playerId: string): string {
	return createHash('sha256').update(`ref:${playerId}`, 'utf8').digest('hex').slice(0, 16);
}

/** The handle a Phase 3 player had, such as `Guest 4821`, derived from the id. */
export function guestName(playerId: string): string {
	const digest = createHash('sha256').update(playerId, 'utf8').digest('hex');
	return `Guest ${(parseInt(digest.slice(0, 8), 16) % 9000) + 1000}`;
}

function hostName(netloc: string): string {
	const host = netloc.slice(netloc.lastIndexOf('@') + 1);
	if (host.startsWith('[')) {
		const end = host.indexOf(']');
		return end === -1 ? host : host.slice(1, end);
	}
	return host.split(':').length === 2 ? host.slice(0, host.lastIndexOf(':')) : host;
}

/** Whether an IP address is a loopback address (127.0.0.0/8 or ::1, also IPv4-mapped). */
export function isLoopbackAddress(address: string): boolean {
	let host = address;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
	if (mapped) host = mapped[1];
	if (isIPv4(host)) return host.startsWith('127.');
	if (!isIPv6(host)) return false;
	const groups = expandIPv6(host);
	return groups !== null && groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
}

function expandIPv6(address: string): number[] | null {
	if (address.includes('.') || address.includes('%')) return null;
	const [head, tail] = address.includes('::') ? address.split('::') : [address, null];
	const left = head ? head.split(':') : [];
	const right = tail ? tail.split(':') : [];
	const missing = 8 - left.length - right.length;
	if (tail === null ? missing !== 0 : missing < 1) return null;
	return [...left, ...Array<string>(tail === null ? 0 : missing).fill('0'), ...right].map((g) =>
		parseInt(g, 16)
	);
}

/** Whether a `host[:port]` names this machine. */
export function isLoopback(netloc: string): boolean {
	const host = hostName(netloc).toLowerCase();
	if (host === 'localhost' || host.endsWith('.localhost')) return true;
	return isLoopbackAddress(host);
}

/**
 * Whether a request from `origin` may use the session of a request to `host`.
 *
 * Browsers send `Origin` with every WebSocket handshake and every
 * cross-origin or unsafe request, so a page on another site always shows
 * itself. A request without one comes from a non-browser client, which
 * cannot ride on a visitor's cookie. Same host is allowed, as is a loopback
 * page calling a loopback server (the Vite dev proxy), and any origin in
 * `allowed`.
 */
export function originAllowed(
	origin: string | null | undefined,
	host: string | null | undefined,
	allowed: ReadonlySet<string> = new Set()
): boolean {
	if (origin === null || origin === undefined) return true;
	if (allowed.has(origin)) return true;
	if (!origin.includes('://') || !host) return false;
	const netloc = origin.slice(origin.indexOf('://') + 3).replace(/\/+$/, '');
	if (netloc.toLowerCase() === host.toLowerCase()) return true;
	return isLoopback(netloc) && isLoopback(host);
}

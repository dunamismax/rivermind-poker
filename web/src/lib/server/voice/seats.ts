// Who may be in a table's voice room (P4C.5), as the table server tells the
// voice service over loopback each time it changes: the people seated at a
// table that is not a practice table, when there are two or more of them, and
// the pairs of them who must never hear each other because one blocked the
// other (P4.5). The voice service lets nobody else in, and takes out at once
// whoever leaves the list, which starts a new epoch of the group.
//
// The table server signs each list with the voice key, so no other process on
// the host can empty a room or put someone in one.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SEATS_PATH = '/seats';
export const MAX_SEATS_BYTES = 16 * 1024;
// How far the signature's time may be from the voice service's clock.
const SKEW_MS = 30_000;
const TABLE = /^[A-Za-z0-9_-]{1,64}$/;
const PLAYER = /^[0-9a-f]{16}$/;

export type SeatList = {
	table: string;
	// When the table server made the list, in milliseconds: a list older than
	// one already applied for the table is ignored.
	at: number;
	seats: { seat: number; player: string }[];
	// Public references of two people, either of whom blocked the other.
	blocks: [string, string][];
};

const sign = (key: Uint8Array, time: string, body: string) =>
	createHmac('sha256', key).update(`voice-seats:v1:${time}:${body}`, 'utf8').digest('hex');

// The headers a list is sent with.
export function signSeats(key: Uint8Array, body: string, now: number): Record<string, string> {
	const time = String(Math.floor(now));
	return { 'x-voice-time': time, 'x-voice-signature': sign(key, time, body) };
}

// The list a request carries, if the table server signed it lately; else null.
export function readSeats(
	key: Uint8Array,
	body: string,
	time: string | undefined,
	signature: string | undefined,
	now: number
): SeatList | null {
	if (body.length > MAX_SEATS_BYTES || !time || !/^[0-9]{1,15}$/.test(time)) return null;
	if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return null;
	if (Math.abs(Number(time) - now) > SKEW_MS) return null;
	const expected = Buffer.from(sign(key, time, body), 'utf8');
	if (!timingSafeEqual(expected, Buffer.from(signature, 'utf8'))) return null;
	let list: unknown;
	try {
		list = JSON.parse(body);
	} catch {
		return null;
	}
	return isSeatList(list) ? list : null;
}

function isSeatList(value: unknown): value is SeatList {
	if (typeof value !== 'object' || value === null) return false;
	const { table, at, seats, blocks } = value as Record<string, unknown>;
	return (
		typeof table === 'string' &&
		TABLE.test(table) &&
		Number.isSafeInteger(at) &&
		Array.isArray(seats) &&
		seats.length <= 9 &&
		seats.every(
			(one) =>
				typeof one === 'object' &&
				one !== null &&
				Number.isInteger(one.seat) &&
				one.seat >= 0 &&
				one.seat < 100 &&
				typeof one.player === 'string' &&
				PLAYER.test(one.player)
		) &&
		Array.isArray(blocks) &&
		blocks.length <= 36 &&
		blocks.every(
			(pair) =>
				Array.isArray(pair) &&
				pair.length === 2 &&
				pair.every((one) => typeof one === 'string' && PLAYER.test(one))
		)
	);
}

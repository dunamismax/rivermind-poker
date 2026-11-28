// HTTP calls to the no-limit table server (`rivermind-poker serve-nl`,
// protocol v2). Requests are same-origin: Caddy proxies /api in production and
// Vite does in development.

import type {
	ConfigResponse,
	DeleteGuestRequest,
	DeleteGuestResponse,
	HandDetail,
	HandListResponse,
	HttpError,
	NewTableRequest,
	NewTableResponse,
	PracticeResponse,
	QuickSeatRequest,
	RelationKind,
	RelationsResponse,
	ReportReason,
	ReportResponse,
	SeatRequest,
	SeatResponse,
	SessionRequest,
	SessionResponse,
	TableListResponse,
	TableSummary,
	WaitlistResponse,
	WalletResponse
} from '../protocol-v2.ts';
import type { VoiceTokenResponse } from '../voice/signalling.ts';

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'ApiError';
	}
}

async function body(response: Response): Promise<unknown> {
	const value: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const detail = (value as Partial<HttpError> | null)?.detail;
		throw new ApiError(typeof detail === 'string' ? detail : response.statusText, response.status);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export async function fetchConfig(fetcher: typeof fetch = fetch): Promise<ConfigResponse> {
	const value = await body(await fetcher('/api/config'));
	if (
		!isRecord(value) ||
		value.protocol !== 2 ||
		!Array.isArray(value.bots) ||
		!Array.isArray(value.stakes)
	) {
		throw new ApiError('This server does not speak the no-limit protocol', 200);
	}
	return value as unknown as ConfigResponse;
}

/**
 * The player this browser is. The first visit makes one; the server keeps the
 * session in an `HttpOnly` cookie, so the page never sees it. A Phase 3 page
 * kept a bearer token instead; sending it once moves that player onto a cookie.
 */
export async function startSession(
	legacyToken: string | null = null,
	fetcher: typeof fetch = fetch
): Promise<SessionResponse> {
	const request: SessionRequest = legacyToken ? { legacy_token: legacyToken } : {};
	const value = await body(
		await fetcher('/api/session', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request)
		})
	);
	if (!isRecord(value) || typeof value.player_id !== 'string' || typeof value.name !== 'string') {
		throw new ApiError('Unexpected /api/session response', 200);
	}
	return value as unknown as SessionResponse;
}

/**
 * Delete this browser's guest and their data (P5D.11). The server clears the session
 * cookie; the next request makes a new guest.
 */
export async function deleteGuest(fetcher: typeof fetch = fetch): Promise<DeleteGuestResponse> {
	const request: DeleteGuestRequest = { confirm: true };
	const value = await body(
		await fetcher('/api/guest', {
			method: 'DELETE',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request)
		})
	);
	if (!isRecord(value) || typeof value.erased !== 'boolean') {
		throw new ApiError('Unexpected /api/guest response', 200);
	}
	return value as unknown as DeleteGuestResponse;
}

/** Start a table with bots; the session's player takes seat 0. */
export async function createTable(
	request: NewTableRequest,
	fetcher: typeof fetch = fetch
): Promise<NewTableResponse> {
	const value = await body(
		await fetcher('/api/tables', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request)
		})
	);
	if (!isRecord(value) || typeof value.table_id !== 'string') {
		throw new ApiError('Unexpected /api/tables response', 201);
	}
	return value as unknown as NewTableResponse;
}

/**
 * The player's practice table (P6.0b): heads-up against a labelled bot with
 * practice chips, whatever the wallet holds. Asking again returns the same table.
 * `bot` chooses the opponent (P5.7a): RiverMind Easy at a new table when left
 * out, and at a table already running, a change of bot once its hand ends.
 */
export async function startPractice(
	fetcher: typeof fetch = fetch,
	bot: string | null = null
): Promise<PracticeResponse> {
	const init: RequestInit = { method: 'POST', credentials: 'same-origin' };
	if (bot !== null) {
		init.headers = { 'content-type': 'application/json' };
		init.body = JSON.stringify({ bot });
	}
	const value = await body(await fetcher('/api/practice', init));
	if (!isRecord(value) || typeof value.table_id !== 'string' || typeof value.seat !== 'number') {
		throw new ApiError('Unexpected /api/practice response', 200);
	}
	return value as unknown as PracticeResponse;
}

/** The session's play-chip balance and its newest ledger entries. */
export async function fetchWallet(fetcher: typeof fetch = fetch): Promise<WalletResponse> {
	const value = await body(await fetcher('/api/wallet', { credentials: 'same-origin' }));
	if (!isRecord(value) || typeof value.balance !== 'number' || !Array.isArray(value.entries)) {
		throw new ApiError('Unexpected /api/wallet response', 200);
	}
	return value as unknown as WalletResponse;
}

/** The lobby's filters (P4.3). Unset filters match every table. */
export interface TableFilters {
	seats?: number | null;
	big_blind?: number | null;
	/** Only tables with a seat to take. */
	open?: boolean;
}

function isSummary(value: unknown): value is TableSummary {
	return isRecord(value) && typeof value.table_id === 'string' && typeof value.people === 'number';
}

/** The public tables, and private ones this player is at, most people first. */
export async function listTables(
	filters: TableFilters = {},
	fetcher: typeof fetch = fetch
): Promise<TableSummary[]> {
	const query = new URLSearchParams();
	if (filters.seats) query.set('seats', String(filters.seats));
	if (filters.big_blind) query.set('big_blind', String(filters.big_blind));
	if (filters.open) query.set('open', 'true');
	const search = query.size ? `?${query}` : '';
	const value = await body(await fetcher(`/api/tables${search}`, { credentials: 'same-origin' }));
	const tables = isRecord(value) ? (value as Partial<TableListResponse>).tables : undefined;
	if (!Array.isArray(tables) || !tables.every(isSummary)) {
		throw new ApiError('Unexpected /api/tables response', 200);
	}
	return tables;
}

/** The private table an invite code opens. */
export async function fetchInvite(
	code: string,
	fetcher: typeof fetch = fetch
): Promise<TableSummary> {
	const value = await body(
		await fetcher(`/api/invites/${encodeURIComponent(code)}`, { credentials: 'same-origin' })
	);
	if (!isSummary(value)) throw new ApiError('Unexpected /api/invites response', 200);
	return value;
}

function isSeat(value: unknown): value is SeatResponse {
	return isRecord(value) && typeof value.table_id === 'string' && typeof value.seated === 'boolean';
}

async function post(path: string, request: unknown, fetcher: typeof fetch): Promise<unknown> {
	return body(
		await fetcher(path, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(request)
		})
	);
}

/** Hold a seat at a table and, unless `hold_only`, buy in and sit in it. */
export async function takeSeat(
	tableId: string,
	request: SeatRequest,
	fetcher: typeof fetch = fetch
): Promise<SeatResponse> {
	const value = await post(`/api/tables/${encodeURIComponent(tableId)}/seat`, request, fetcher);
	if (!isSeat(value)) throw new ApiError('Unexpected seat response', 200);
	return value;
}

/** A seat at the busiest matching table, or a new table with bots. */
export async function quickSeat(
	request: QuickSeatRequest,
	fetcher: typeof fetch = fetch
): Promise<SeatResponse> {
	const value = await post('/api/quick-seat', request, fetcher);
	if (!isSeat(value)) throw new ApiError('Unexpected /api/quick-seat response', 200);
	return value;
}

export async function joinWaitlist(
	tableId: string,
	invite: string | null = null,
	fetcher: typeof fetch = fetch
): Promise<WaitlistResponse> {
	const value = await post(
		`/api/tables/${encodeURIComponent(tableId)}/waitlist`,
		invite ? { invite } : {},
		fetcher
	);
	if (!isRecord(value) || typeof value.position !== 'number') {
		throw new ApiError('Unexpected waitlist response', 200);
	}
	return value as unknown as WaitlistResponse;
}

async function remove(path: string, fetcher: typeof fetch): Promise<void> {
	const response = await fetcher(path, { method: 'DELETE', credentials: 'same-origin' });
	if (!response.ok) await body(response);
}

export function leaveWaitlist(tableId: string, fetcher: typeof fetch = fetch): Promise<void> {
	return remove(`/api/tables/${encodeURIComponent(tableId)}/waitlist`, fetcher);
}

/** Give up a held seat. */
export function giveUpSeat(tableId: string, fetcher: typeof fetch = fetch): Promise<void> {
	return remove(`/api/tables/${encodeURIComponent(tableId)}/seat`, fetcher);
}

// Safety (P4.5): reports, mutes and blocks, by the seat a person sits in.

/** Report the person in a seat for review. Resolves to false if the same report was already made today. */
export async function reportSeat(
	tableId: string,
	seat: number,
	reason: ReportReason,
	fetcher: typeof fetch = fetch
): Promise<boolean> {
	const value = await post('/api/reports', { table_id: tableId, seat, reason }, fetcher);
	if (!isRecord(value) || typeof value.recorded !== 'boolean') {
		throw new ApiError('Unexpected /api/reports response', 201);
	}
	return (value as unknown as ReportResponse).recorded;
}

function relationList(value: unknown, path: string): RelationsResponse['players'] {
	const players = isRecord(value) ? (value as Partial<RelationsResponse>).players : undefined;
	if (!Array.isArray(players)) throw new ApiError(`Unexpected ${path} response`, 200);
	return players;
}

/** Everyone this player muted or blocked. */
export async function fetchRelations(
	fetcher: typeof fetch = fetch
): Promise<RelationsResponse['players']> {
	const value = await body(await fetcher('/api/relations', { credentials: 'same-origin' }));
	return relationList(value, '/api/relations');
}

/** Mute or block the person in a seat. */
export async function setRelation(
	tableId: string,
	seat: number,
	kind: RelationKind,
	fetcher: typeof fetch = fetch
): Promise<RelationsResponse['players']> {
	const value = await body(
		await fetcher('/api/relations', {
			method: 'PUT',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ table_id: tableId, seat, kind })
		})
	);
	return relationList(value, '/api/relations');
}

/** Unmute or unblock someone, by their public reference. */
export async function removeRelation(
	ref: string,
	fetcher: typeof fetch = fetch
): Promise<RelationsResponse['players']> {
	const value = await body(
		await fetcher(`/api/relations/${encodeURIComponent(ref)}`, {
			method: 'DELETE',
			credentials: 'same-origin'
		})
	);
	return relationList(value, '/api/relations');
}

// Hand histories (P4.6): the hands this player was dealt into.

/** This player's finished hands, newest first; `before` (a hand id) asks for the next page. */
export async function fetchHands(
	before: string | null = null,
	fetcher: typeof fetch = fetch
): Promise<HandListResponse> {
	const query = new URLSearchParams({ limit: '20' });
	if (before) query.set('before', before);
	const value = await body(await fetcher(`/api/hands?${query}`, { credentials: 'same-origin' }));
	if (!isRecord(value) || !Array.isArray(value.hands) || typeof value.more !== 'boolean') {
		throw new ApiError('Unexpected /api/hands response', 200);
	}
	return value as unknown as HandListResponse;
}

/** One hand this player played, with every card they may see. */
export async function fetchHand(
	handId: string,
	fetcher: typeof fetch = fetch
): Promise<HandDetail> {
	const value = await body(
		await fetcher(`/api/hands/${encodeURIComponent(handId)}`, { credentials: 'same-origin' })
	);
	if (!isRecord(value) || !isRecord(value.hand) || typeof value.text !== 'string') {
		throw new ApiError('Unexpected hand response', 200);
	}
	return value as unknown as HandDetail;
}

/**
 * The id of a hand the player played at a table: hand `handNo` there, or with
 * null their newest one. Null when they were not dealt into it, or it is older
 * than the last sixty hands they played anywhere.
 */
export async function findHand(
	tableId: string,
	handNo: number | null,
	fetcher: typeof fetch = fetch
): Promise<string | null> {
	let before: string | null = null;
	for (let page = 0; page < 3; page += 1) {
		const { hands, more } = await fetchHands(before, fetcher);
		for (const hand of hands) {
			if (hand.table_id !== tableId) continue;
			if (handNo === null || hand.hand_no === handNo) return hand.hand_id;
			// Newest first: past its number, the hand is not there.
			if (hand.hand_no < handNo) return null;
		}
		if (!more || hands.length === 0) return null;
		before = hands[hands.length - 1].hand_id;
	}
	return null;
}

/** Whether pages offer table voice here (P4C.6). */
export async function fetchVoiceOffer(fetcher: typeof fetch = fetch): Promise<boolean> {
	const value = await body(await fetcher('/api/voice'));
	return isRecord(value) && value.offered === true;
}

/** A voice token for the viewer's seat at a table (P4C.5), good once within a minute. */
export async function fetchVoiceToken(
	tableId: string,
	fetcher: typeof fetch = fetch
): Promise<VoiceTokenResponse> {
	const response = await fetcher(`/api/tables/${encodeURIComponent(tableId)}/voice`, {
		method: 'POST'
	});
	const value = await body(response);
	if (!isRecord(value) || typeof value.token !== 'string' || typeof value.url !== 'string') {
		throw new ApiError('The server did not give a voice token', 200);
	}
	return value as VoiceTokenResponse;
}

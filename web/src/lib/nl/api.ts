// HTTP calls to the no-limit table server (`rivermind-poker serve-nl`,
// protocol v2). Requests are same-origin: Caddy proxies /api in production and
// Vite does in development.

import type {
	ConfigResponse,
	HttpError,
	NewTableRequest,
	NewTableResponse,
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

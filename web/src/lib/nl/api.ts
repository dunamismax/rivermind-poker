// HTTP calls to the no-limit table server (`rivermind-poker serve-nl`,
// protocol v2). Requests are same-origin: Caddy proxies /api in production and
// Vite does in development.

import type {
	ConfigResponse,
	HttpError,
	NewTableRequest,
	NewTableResponse,
	SessionRequest,
	SessionResponse
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

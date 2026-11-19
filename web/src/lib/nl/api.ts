// HTTP calls to the no-limit table server (`rivermind-poker serve-nl`,
// protocol v2). Requests are same-origin: Caddy proxies /api in production and
// Vite does in development.

import type {
	ConfigResponse,
	HttpError,
	NewPlayerResponse,
	NewTableRequest,
	NewTableResponse
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

/** A new anonymous player. Keep the token: it is the player. */
export async function createPlayer(fetcher: typeof fetch = fetch): Promise<NewPlayerResponse> {
	const value = await body(await fetcher('/api/players', { method: 'POST' }));
	if (!isRecord(value) || typeof value.token !== 'string' || typeof value.player_id !== 'string') {
		throw new ApiError('Unexpected /api/players response', 201);
	}
	return value as unknown as NewPlayerResponse;
}

/** Start a table with bots; the player takes seat 0. */
export async function createTable(
	token: string,
	request: NewTableRequest,
	fetcher: typeof fetch = fetch
): Promise<NewTableResponse> {
	const value = await body(
		await fetcher('/api/tables', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
			body: JSON.stringify(request)
		})
	);
	if (!isRecord(value) || typeof value.table_id !== 'string') {
		throw new ApiError('Unexpected /api/tables response', 201);
	}
	return value as unknown as NewTableResponse;
}

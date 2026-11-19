// HTTP calls to the table server. Requests are same-origin: Caddy proxies
// /api in production and Vite does in development.

import type {
	ConfigResponse,
	HttpError,
	NewTableRequest,
	NewTableResponse,
	OpponentKind
} from './protocol.ts';

export type ServerConfig = ConfigResponse;

const OPPONENT_KINDS: readonly string[] = ['random', 'checkpoint'] satisfies OpponentKind[];

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
		this.name = 'ApiError';
	}
}

function isServerConfig(value: unknown): value is ServerConfig {
	if (typeof value !== 'object' || value === null) return false;
	const opponents = (value as { opponents?: unknown }).opponents;
	return (
		Array.isArray(opponents) &&
		opponents.every((o) => typeof o === 'string' && OPPONENT_KINDS.includes(o))
	);
}

export async function fetchConfig(fetcher: typeof fetch = fetch): Promise<ServerConfig> {
	const response = await fetcher('/api/config');
	if (!response.ok) throw new ApiError(`GET /api/config failed`, response.status);
	const body: unknown = await response.json();
	if (!isServerConfig(body)) throw new ApiError('Unexpected /api/config response', response.status);
	return body;
}

function isNewTable(value: unknown): value is NewTableResponse {
	if (typeof value !== 'object' || value === null) return false;
	const body = value as Record<string, unknown>;
	return typeof body.table_id === 'string' && typeof body.token === 'string';
}

/** Start a table against `opponents` and return the seat to join. */
export async function createTable(
	opponents: OpponentKind,
	fetcher: typeof fetch = fetch
): Promise<NewTableResponse> {
	const request: NewTableRequest = { opponents };
	const response = await fetcher('/api/tables', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(request)
	});
	const body: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const detail = (body as Partial<HttpError> | null)?.detail;
		throw new ApiError(typeof detail === 'string' ? detail : response.statusText, response.status);
	}
	if (!isNewTable(body)) throw new ApiError('Unexpected /api/tables response', response.status);
	return body;
}

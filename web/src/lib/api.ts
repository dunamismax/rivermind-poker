// HTTP calls to the table server. Requests are same-origin: Caddy proxies
// /api in production and Vite does in development.

export interface ServerConfig {
	opponents: string[];
}

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
	return Array.isArray(opponents) && opponents.every((o) => typeof o === 'string');
}

export async function fetchConfig(fetcher: typeof fetch = fetch): Promise<ServerConfig> {
	const response = await fetcher('/api/config');
	if (!response.ok) throw new ApiError(`GET /api/config failed`, response.status);
	const body: unknown = await response.json();
	if (!isServerConfig(body)) throw new ApiError('Unexpected /api/config response', response.status);
	return body;
}

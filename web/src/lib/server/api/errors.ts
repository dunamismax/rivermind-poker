/** Errors the HTTP API and the socket answer with (P4B.5a, P4B.5b). */
import type * as p from '../../protocol-v2.ts';

/** An HTTP error answered as `{"detail": message}`. */
export class HttpError extends Error {
	override name = 'HttpError';
	readonly status: number;
	readonly headers: Record<string, string>;

	constructor(status: number, detail: string, headers: Record<string, string> = {}) {
		super(detail);
		this.status = status;
		this.headers = headers;
	}
}

/** A socket request refused before it reached a table. */
export class RequestError extends Error {
	override name = 'RequestError';
	readonly code: p.ErrorCode;

	constructor(code: p.ErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

/**
 * Times on the wire are seconds since the epoch, as the Python server's
 * `datetime.timestamp()` gives them. PostgreSQL keeps microseconds, which a
 * JavaScript `Date` would round to milliseconds, so stored times are read as
 * `extract(epoch …)::float8`: the same double Python computes.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/** A timestamp column as seconds since the epoch, or null. */
export function epochOf(column: PgColumn): SQL<number> {
	return sql<number>`extract(epoch from ${column})::float8`.mapWith(Number);
}

/** The wall clock in seconds since the epoch. */
export const wallClock = (): number => Date.now() / 1000;

/** `20000` as `20,000`, as Python's `f"{n:,}"` writes whole numbers. */
export function commas(n: number): string {
	const sign = n < 0 ? '-' : '';
	return sign + String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

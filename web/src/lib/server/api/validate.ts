/**
 * Runtime validation of what clients send, with the rules and messages of
 * the Python server's Pydantic models (P4B.5a): unknown fields are refused,
 * `StrictInt` fields take only whole JSON numbers, booleans take what
 * Pydantic's lax mode takes, and each problem is reported with its location
 * and Pydantic's wording, such as `seats: Input should be greater than or
 * equal to 2`. The schemas themselves are in `protocol.ts`.
 */

export interface Issue {
	/** Where the problem is: field names and array indexes from the top. */
	loc: (string | number)[];
	msg: string;
}

export class Invalid extends Error {
	readonly issues: Issue[];

	constructor(issues: Issue[]) {
		super(issues.map((i) => `${i.loc.join('.') || 'body'}: ${i.msg}`).join('; '));
		this.issues = issues;
	}
}

const FAILED: unique symbol = Symbol('invalid');
type Failed = typeof FAILED;

/** Checks one value, adding any issues, and returns the value or {@link FAILED}. */
export type Schema<T> = (value: unknown, loc: (string | number)[], issues: Issue[]) => T | Failed;

export type Infer<S> = S extends Schema<infer T> ? T : never;

function fail(issues: Issue[], loc: (string | number)[], msg: string): Failed {
	issues.push({ loc, msg });
	return FAILED;
}

/** Validate `value` against `schema`, or throw {@link Invalid}. */
export function parse<T>(schema: Schema<T>, value: unknown): T {
	const issues: Issue[] = [];
	const result = schema(value, [], issues);
	if (result === FAILED || issues.length) throw new Invalid(issues);
	return result;
}

/**
 * Where JSON.parse gave up, as the character offset FastAPI reports for a body
 * it cannot decode. V8 names the offset in most messages; at the end of the
 * text it is the length, and otherwise 0, as for a body that is not JSON at all.
 */
function jsonErrorPosition(error: unknown, text: string): number {
	const message = error instanceof Error ? error.message : '';
	const at = /at position (\d+)/.exec(message);
	if (at) return Number(at[1]);
	return /end of JSON input/.test(message) ? text.length : 0;
}

/** Parse JSON text, reporting bad JSON the way FastAPI does. */
export function parseJson<T>(schema: Schema<T>, text: string): T {
	let value: unknown;
	try {
		value = strictJson(text);
	} catch (error) {
		throw new Invalid([{ loc: [jsonErrorPosition(error, text)], msg: 'JSON decode error' }]);
	}
	return parse(schema, value);
}

export interface IntOptions {
	ge?: number;
	le?: number;
}

/** A `StrictInt`: a whole JSON number, never a string, a boolean or `6.0`. */
export function int({ ge, le }: IntOptions = {}): Schema<number> {
	return (value, loc, issues) => {
		// `strictJson` turns `6.0` into NaN, which fails here.
		if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
			return fail(issues, loc, 'Input should be a valid integer');
		}
		if (ge !== undefined && value < ge) {
			return fail(issues, loc, `Input should be greater than or equal to ${ge}`);
		}
		if (le !== undefined && value > le) {
			return fail(issues, loc, `Input should be less than or equal to ${le}`);
		}
		return value;
	};
}

export interface StrOptions {
	maxLength?: number;
}

export function str({ maxLength }: StrOptions = {}): Schema<string> {
	return (value, loc, issues) => {
		if (typeof value !== 'string') return fail(issues, loc, 'Input should be a valid string');
		if (maxLength !== undefined && [...value].length > maxLength) {
			return fail(issues, loc, `String should have at most ${maxLength} characters`);
		}
		return value;
	};
}

const TRUE = new Set(['1', 'on', 't', 'true', 'y', 'yes']);
const FALSE = new Set(['0', 'off', 'f', 'false', 'n', 'no']);

/** A boolean as Pydantic's lax mode reads it: also 0 and 1, and words like `yes` and `off`. */
export function bool(): Schema<boolean> {
	return (value, loc, issues) => {
		if (typeof value === 'boolean') return value;
		if (value === 0 || value === 1) return value === 1;
		if (typeof value === 'string') {
			const word = value.toLowerCase();
			if (TRUE.has(word)) return true;
			if (FALSE.has(word)) return false;
			return fail(issues, loc, 'Input should be a valid boolean, unable to interpret input');
		}
		if (typeof value === 'number') {
			return fail(issues, loc, 'Input should be a valid boolean, unable to interpret input');
		}
		return fail(issues, loc, 'Input should be a valid boolean');
	};
}

function quoted(values: readonly (string | number)[]): string {
	const items = values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v)));
	return items.length > 1
		? `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
		: items[0];
}

/** One of a string enum's values. */
export function oneOf<const T extends string>(values: readonly T[]): Schema<T> {
	const allowed = new Set<string>(values);
	return (value, loc, issues) =>
		typeof value === 'string' && allowed.has(value)
			? (value as T)
			: fail(issues, loc, `Input should be ${quoted(values)}`);
}

/** Exactly this value, as a `Literal`. */
export function literal<const T extends string | number>(expected: T): Schema<T> {
	return (value, loc, issues) =>
		value === expected ? (value as T) : fail(issues, loc, `Input should be ${quoted([expected])}`);
}

export function nullable<T>(schema: Schema<T>): Schema<T | null> {
	return (value, loc, issues) => (value === null ? null : schema(value, loc, issues));
}

/** A field with a default: used when the field is missing. */
export interface Optional<T> {
	schema: Schema<T>;
	default: T;
}

export function optional<T>(schema: Schema<T>, fallback: T): Optional<T> {
	return { schema, default: fallback };
}

type Field = Schema<unknown> | Optional<unknown>;
type Shape = Record<string, Field>;
type ObjectOf<S extends Shape> = {
	[K in keyof S]: S[K] extends Optional<infer T> ? T : S[K] extends Schema<infer T> ? T : never;
};

/** A model with `extra="forbid"`: every field is checked, in order, and unknown ones are refused. */
export function object<S extends Shape>(shape: S): Schema<ObjectOf<S>> {
	const names = Object.keys(shape);
	return (value, loc, issues) => {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			return fail(
				issues,
				loc,
				'Input should be a valid dictionary or object to extract fields from'
			);
		}
		const input = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		let ok = true;
		for (const name of names) {
			const field = shape[name];
			const where = [...loc, name];
			if (!Object.hasOwn(input, name)) {
				if (typeof field === 'function') {
					ok = fail(issues, where, 'Field required') !== FAILED;
				} else {
					out[name] = field.default;
				}
				continue;
			}
			const schema = typeof field === 'function' ? field : field.schema;
			const result = schema(input[name], where, issues);
			if (result === FAILED) ok = false;
			else out[name] = result;
		}
		for (const name of Object.keys(input)) {
			if (!Object.hasOwn(shape, name)) {
				ok = fail(issues, [...loc, name], 'Extra inputs are not permitted') !== FAILED;
			}
		}
		return ok ? (out as ObjectOf<S>) : FAILED;
	};
}

/** A union told apart by its `type` field, as Pydantic's discriminated unions are. */
export function tagged<M extends Record<string, Schema<unknown>>>(
	members: M
): Schema<{ [K in keyof M]: Infer<M[K]> }[keyof M]> {
	const tags = Object.keys(members);
	return (value, loc, issues) => {
		const tag =
			typeof value === 'object' && value !== null && !Array.isArray(value)
				? (value as Record<string, unknown>).type
				: undefined;
		if (tag === undefined) {
			return fail(issues, loc, "Unable to extract tag using discriminator 'type'");
		}
		if (typeof tag !== 'string' || !Object.hasOwn(members, tag)) {
			return fail(
				issues,
				loc,
				`Input tag '${String(tag)}' found using 'type' does not match any of the expected tags: ${tags.map((t) => `'${t}'`).join(', ')}`
			);
		}
		return members[tag](value, [...loc, tag], issues) as never;
	};
}

/**
 * JSON.parse, except that whole numbers written as floats (`6.0`, `1e2`)
 * become `NaN`, so no {@link int} or {@link literal} check accepts them, as
 * Pydantic's strict integers refuse them. Every other value is unchanged.
 */
export function strictJson(text: string): unknown {
	return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
		typeof value === 'number' && Number.isInteger(value) && /[.eE]/.test(context?.source ?? '')
			? Number.NaN
			: value
	);
}

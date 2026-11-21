/**
 * Runtime checks for everything a client sends in protocol v2 (P4B.5a):
 * the HTTP request bodies and the socket messages, with the rules of the
 * Pydantic models in `rivermind/server/protocol.py`.
 *
 * `protocol-v2.ts` is the protocol's source (P4B.5b). Each schema here is
 * checked against its type there at compile time (`pnpm check`), so the two
 * cannot drift apart: a field added on one side and not the other fails
 * the type check.
 */
import type * as p from '../../protocol-v2.ts';
import { REACTIONS, RELATION_KINDS, REPORT_REASONS } from './safety.ts';
import {
	bool,
	int,
	literal,
	nullable,
	object,
	oneOf,
	optional,
	str,
	tagged,
	type Infer
} from './validate.ts';

export const PROTOCOL_VERSION = 2;

const REACTION_KINDS = Object.keys(REACTIONS) as (keyof typeof REACTIONS)[];
const ACTIONS = ['fold', 'check', 'call', 'bet', 'raise'] as const;

// HTTP

export const SessionRequest = object({
	legacy_token: optional(nullable(str({ maxLength: 200 })), null)
});

export const NewTableRequest = object({
	seats: optional(int({ ge: 2, le: 9 }), 6),
	bots: optional(nullable(str()), 'heuristic' as string | null),
	big_blind: optional(int(), 100),
	buy_in: optional(nullable(int()), null),
	private: optional(bool(), false)
});

export const PracticeRequest = object({
	bot: optional(nullable(str({ maxLength: 40 })), null)
});

export const SeatRequest = object({
	seat: optional(nullable(int()), null),
	buy_in: optional(nullable(int()), null),
	hold_only: optional(bool(), false),
	invite: optional(nullable(str({ maxLength: 100 })), null)
});

export const WaitlistRequest = object({
	invite: optional(nullable(str({ maxLength: 100 })), null)
});

export const QuickSeatRequest = object({
	seats: optional(nullable(int({ ge: 2, le: 9 })), null),
	big_blind: optional(nullable(int()), null),
	buy_in: optional(nullable(int()), null)
});

export const ReportRequest = object({
	table_id: str({ maxLength: 64 }),
	seat: int({ ge: 0, le: 8 }),
	reason: oneOf(REPORT_REASONS)
});

export const RelationRequest = object({
	table_id: str({ maxLength: 64 }),
	seat: int({ ge: 0, le: 8 }),
	kind: oneOf(RELATION_KINDS)
});

// WebSocket, client to server

export const HelloMessage = object({ type: literal('hello'), protocol: literal(2) });

export const ClientMessage = tagged({
	join_table: object({ type: literal('join_table'), table_id: str() }),
	leave_table: object({ type: literal('leave_table'), table_id: str() }),
	sit: object({ type: literal('sit'), table_id: str(), seat: int(), buy_in: int() }),
	sit_out: object({ type: literal('sit_out'), table_id: str() }),
	sit_in: object({ type: literal('sit_in'), table_id: str() }),
	rebuy: object({ type: literal('rebuy'), table_id: str(), amount: int() }),
	act: object({
		type: literal('act'),
		table_id: str(),
		seq: int(),
		action: oneOf(ACTIONS),
		amount: optional(nullable(int()), null)
	}),
	refresh: object({ type: literal('refresh'), table_id: str() }),
	react: object({ type: literal('react'), table_id: str(), reaction: oneOf(REACTION_KINDS) })
});

// Each schema produces exactly its generated type, with defaults filled in.

type Same<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Filled<T> = { [K in keyof T]-?: Exclude<T[K], undefined> };
type Check<T extends true> = T;

export type Checks = [
	Check<Same<Infer<typeof SessionRequest>, Filled<p.SessionRequest>>>,
	Check<Same<Infer<typeof NewTableRequest>, Filled<p.NewTableRequest>>>,
	Check<Same<Infer<typeof PracticeRequest>, Filled<p.PracticeRequest>>>,
	Check<Same<Infer<typeof SeatRequest>, Filled<p.SeatRequest>>>,
	Check<Same<Infer<typeof WaitlistRequest>, Filled<p.WaitlistRequest>>>,
	Check<Same<Infer<typeof QuickSeatRequest>, Filled<p.QuickSeatRequest>>>,
	Check<Same<Infer<typeof ReportRequest>, Filled<p.ReportRequest>>>,
	Check<Same<Infer<typeof RelationRequest>, Filled<p.RelationRequest>>>,
	Check<Same<Infer<typeof HelloMessage>, p.HelloMessage>>,
	Check<Same<Infer<typeof ClientMessage>, Filled<p.ClientMessage>>>
];

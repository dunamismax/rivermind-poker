// The no-limit table protocol, version 2: every HTTP body and WebSocket message
// between the client and the table server. This file is the source of truth
// (P4B.5b); src/lib/server/api/protocol.ts checks what clients send against it.
// Until the Python server is removed (P4B.8), test/server/test_protocol_v2.py
// fails if its Pydantic models (rivermind/server/protocol.py) stop describing
// exactly these types, so change both together and keep this layout.

/** Protocol version 2. */

export interface ActMessage {
	type: 'act';
	table_id: string;
	/** The seq of the view acted on. */
	seq: number;
	action: ActionKind;
	/** The street total, for a bet or raise only. */
	amount?: number | null;
}

export type ActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise';

export interface ActionRecord {
	seat: number;
	street: Street;
	action: ActionKind;
	/** The seat's street total after the action. */
	to: number;
	/** Chips the action put in. */
	added: number;
	all_in: boolean;
}

/** The promoted model a trained bot plays, with the evaluation its label links to (D-7). */
export interface BotChampion {
	/** Its name in the model registry (docs/models.md). */
	name: string;
	/** The date it was promoted. */
	promoted: string;
	/** Training iterations. */
	iterations: number;
	/** The stacks the results were played at, in big blinds. */
	stack_bb: number;
	/** The promotion gate's matchups, for the strategy the site serves. */
	results: BotResult[];
}

export interface BotOption {
	kind: string;
	label: string;
	/** The table sizes this bot plays; every size when missing. */
	seats?: number[] | null;
	/** For a trained bot: the model it plays. */
	champion?: BotChampion | null;
}

/** One matchup of a trained bot's published evaluation. */
export interface BotResult {
	/** A bot kind, or `champion` for the champion this one replaced. */
	opponent: string;
	label: string;
	hands: number;
	/** Big blinds won per 100 hands. */
	bb_per_100: number;
	/** The two bounds of the 95% interval. */
	ci95: number[];
}

export interface Card {
	/** 2 to 10, then 11 to 14 for J, Q, K, A. */
	rank: number;
	suit: Suit;
}

/** Any message after the hello. */
export type ClientMessage = JoinTableMessage | LeaveTableMessage | SitMessage | SitOutMessage | SitInMessage | RebuyMessage | ActMessage | RefreshMessage | ReactMessage;

/** `GET /api/config`. */
export interface ConfigResponse {
	protocol: number;
	bots: BotOption[];
	seat_counts: number[];
	stakes: Stakes[];
	/** The preset reactions, in the order to offer them. */
	reactions: ReactionOption[];
	/** The chips `POST /api/practice` gives, and gives again whenever the guest runs out. */
	practice_stack?: number;
}

/** Stable codes clients branch on. */
export type ErrorCode = 'bad_request' | 'unauthorized' | 'stale' | 'illegal_action' | 'not_your_turn' | 'hand_over' | 'hand_in_progress' | 'unknown_table' | 'unknown_seat' | 'seat_taken' | 'already_seated' | 'not_seated' | 'bad_buy_in' | 'not_subscribed' | 'insufficient_chips' | 'rate_limited';

/** A refused message. The table and the view are unchanged. */
export interface ErrorMessage {
	type: 'error';
	code: ErrorCode;
	message: string;
	table_id: string | null;
}

/** What a `TableEvent` reports. The fields it sets are listed per kind. */
export type EventKind = 'seated' | 'left' | 'leaving' | 'sat_out' | 'sitting_out_next' | 'sat_in' | 'rebuy_pending' | 'rebought' | 'rebuy_dropped' | 'connected' | 'disconnected' | 'hand_started' | 'turn' | 'timed_out' | 'action' | 'board' | 'hand_ended' | 'reserved' | 'reservation_ended' | 'waitlist';

/** `GET /api/hands/{hand_id}`: a hand the viewer played, with every card they may see. */
export interface HandDetail {
	hand: HandSummary;
	button: number;
	seats: HandSeat[];
	posts: Post[];
	actions: ActionRecord[];
	pots: PotResult[];
	uncalled: Uncalled | null;
	/** The readable hand history, as the viewer may see it. */
	text: string;
}

/** The current hand, or the last one until the next starts. */
export interface HandInfo {
	hand_no: number;
	button: number;
	small_blind_seat: number;
	big_blind_seat: number;
	street: Street;
	board: Card[];
	/** Everything put in so far, including this street's bets. */
	pot: number;
	current_bet: number;
	to_act: number | null;
	posts: Post[];
	actions: ActionRecord[];
	/** Set once the hand is over. */
	result: HandResult | null;
}

/** `GET /api/hands`, with optional `limit` (1 to 50) and `before` (a hand id, for the next page). */
export interface HandListResponse {
	hands: HandSummary[];
	/** Whether older hands follow; ask again with `before` set to the last hand id. */
	more: boolean;
}

export interface HandResult {
	pots: PotResult[];
	/** An uncalled bet returned before the pots were formed. */
	uncalled: Uncalled | null;
	/** False when everyone else folded. */
	showdown: boolean;
	/** Seats whose cards were shown, in showing order. */
	shown: number[];
	/** Seats that mucked without showing. */
	mucked: number[];
	/** Chips won from the pots per seat. */
	winnings: number[];
	/** Chips won or lost in the hand per seat (0 for seats not dealt in). */
	net: number[];
}

/** A seat dealt into the hand. Cards are set only for the viewer and for hands shown at showdown. */
export interface HandSeat {
	seat: number;
	name: string;
	kind: SeatKind;
	bot: string | null;
	you: boolean;
	cards: Card[] | null;
	shown: boolean;
	net: number;
}

/** A finished hand the viewer played, as the hand history lists it. */
export interface HandSummary {
	hand_id: string;
	table_id: string;
	table_name: string;
	hand_no: number;
	/** When the hand ended, in seconds since the epoch. */
	at: number;
	/** The viewer's seat. */
	seat: number;
	seat_count: number;
	small_blind: number;
	big_blind: number;
	/** The viewer's hole cards. */
	cards: Card[];
	board: Card[];
	/** Chips in the pots at the end. */
	pot: number;
	/** Chips the viewer won (positive) or lost. */
	net: number;
	showdown: boolean;
	/** Played with practice chips; left out of competitive stats. */
	practice?: boolean;
}

/** Must be the first message on a socket. */
export interface HelloMessage {
	type: 'hello';
	protocol: 2;
}

/** Any HTTP error response. */
export interface HttpError {
	detail: string;
}

/** Follow a table. Rejoining after a reconnect is the same message. */
export interface JoinTableMessage {
	type: 'join_table';
	table_id: string;
}

/** Stop following a table and give up the seat (at the end of the hand if in one). */
export interface LeaveTableMessage {
	type: 'leave_table';
	table_id: string;
}

/** One change to the wallet. */
export interface LedgerItem {
	kind: LedgerKind;
	/** Positive for chips paid in, negative for chips paid out. */
	amount: number;
	balance_after: number;
	table_id: string | null;
	/** Seconds since the epoch. */
	at: number;
}

export type LedgerKind = 'grant' | 'top_up' | 'buy_in' | 'rebuy' | 'cash_out' | 'refund';

export interface LeftTableMessage {
	type: 'left_table';
	table_id: string;
}

/** What the viewer may do now (rule 7.7). */
export interface Legal {
	can_fold: boolean;
	can_check: boolean;
	/** Chips a call adds; 0 when there is nothing to call. */
	call: number;
	raise_kind: RaiseKind | null;
	/** Smallest bet or raise, as a street total. */
	min_to: number;
	/** Largest bet or raise (all-in), as a street total. */
	max_to: number;
}

/** `POST /api/tables` with the session cookie. The player takes seat 0. */
export interface NewTableRequest {
	seats?: number;
	/** The kind of bot in every other seat, which gives up its seat when a person wants it; null leaves the seats for people. */
	bots?: string | null;
	/** One of the config's stakes. */
	big_blind?: number;
	/** Defaults to as much of the maximum as the wallet holds. */
	buy_in?: number | null;
	/** Unlisted; people join with the invite code. */
	private?: boolean;
}

/** `POST /api/tables`, status 201. */
export interface NewTableResponse {
	table_id: string;
	seat: number;
	/** A private table's invite code. */
	invite?: string | null;
}

export interface Post {
	seat: number;
	kind: PostKind;
	amount: number;
	all_in: boolean;
}

export type PostKind = 'ante' | 'small_blind' | 'big_blind';

export interface PotResult {
	amount: number;
	eligible: number[];
	winners: number[];
	/** Chips each winner took, in the order of winners. */
	shares: number[];
}

/** `POST /api/practice`, with an optional body. */
export interface PracticeRequest {
	/** The bot to practise against, one that plays two seats. Missing: the table's bot, or RiverMind Easy at a new table. */
	bot?: string | null;
}

/**
 * `POST /api/practice`: the guest's practice table, heads-up against a labelled bot (P6.0b).
 *
 * The guest sits with a practice stack that never comes from or goes back to the wallet.
 * Asking again while seated there returns the same table. Asking for another bot
 * changes the opponent, at once between hands and otherwise when the hand ends (P5.7a).
 */
export interface PracticeResponse {
	table_id: string;
	seat: number;
	/** False when the guest's practice table was already running. */
	created: boolean;
	/** The kind of bot in the other seat. */
	bot: string;
	/** The practice stack, given again whenever the guest runs out. */
	stack: number;
	/** The kind that takes the bot's seat when the hand in progress ends. */
	next_bot?: string | null;
}

/** `POST /api/quick-seat`: a seat at the busiest matching public table, or a new table with bots. */
export interface QuickSeatRequest {
	seats?: number | null;
	big_blind?: number | null;
	/** Defaults to as much of the maximum as the wallet holds. */
	buy_in?: number | null;
}

export type RaiseKind = 'bet' | 'raise';

/** A preset reaction from a seated person (P4.5). */
export interface ReactMessage {
	type: 'react';
	table_id: string;
	reaction: Reaction;
}

/** Preset reactions (Q-4: no free-text chat in 1.0). */
export type Reaction = 'hello' | 'nice_hand' | 'well_played' | 'good_game' | 'unlucky' | 'thanks' | 'wow' | 'thinking';

/** A seated person's reaction, not sent to anyone who muted or blocked them. */
export interface ReactionMessage {
	type: 'reaction';
	table_id: string;
	seat: number;
	name: string;
	ref: string;
	reaction: Reaction;
	text: string;
}

export interface ReactionOption {
	kind: Reaction;
	text: string;
}

export interface RebuyMessage {
	type: 'rebuy';
	table_id: string;
	amount: number;
}

export interface RefreshMessage {
	type: 'refresh';
	table_id: string;
}

export interface RelationItem {
	ref: string;
	name: string;
	kind: RelationKind;
}

export type RelationKind = 'mute' | 'block';

/** `PUT /api/relations`: mute or block the person in a seat. */
export interface RelationRequest {
	table_id: string;
	seat: number;
	kind: RelationKind;
}

/** `GET /api/relations`, and `PUT` and `DELETE /api/relations/{ref}`: everyone the viewer muted or blocked. */
export interface RelationsResponse {
	players: RelationItem[];
}

/** `voice` is something said in table voice (P4C.8), of which no recording exists. */
export type ReportReason = 'handle' | 'abuse' | 'collusion' | 'other' | 'voice';

/** `POST /api/reports`: report the person in a seat, for review. */
export interface ReportRequest {
	table_id: string;
	seat: number;
	reason: ReportReason;
}

/** `POST /api/reports`, status 201. */
export interface ReportResponse {
	/** False when the same report was already made today; it counts once. */
	recorded: boolean;
}

/** A seat held for a player while they buy in (rule 2.4). */
export interface SeatHold {
	seat: number;
	name: string;
	/** False while a bot plays out the hand before giving up the seat. */
	ready: boolean;
	/** When the hold runs out; null until it is ready. */
	until: number | null;
}

/** An occupied seat as the viewer may see it. */
export interface SeatInfo {
	seat: number;
	name: string;
	kind: SeatKind;
	/** A person's public reference, the same at every table, for mutes and blocks; null for bots. */
	ref: string | null;
	/** The bot kind for a bot seat (bots are always labelled). */
	bot: string | null;
	/** Chips behind right now. */
	stack: number;
	/** Chips put in on the current street. */
	bet: number;
	/** Dealt into the hand in progress and not folded. */
	in_hand: boolean;
	folded: boolean;
	all_in: boolean;
	sitting_out: boolean;
	leaving: boolean;
	connected: boolean;
	/** Holds cards in the hand in progress, shown or not. */
	has_cards: boolean;
	/** The viewer's own cards, or cards shown at showdown; null when hidden. */
	cards: Card[] | null;
}

export type SeatKind = 'human' | 'bot';

/** `POST /api/tables/{table_id}/seat`: hold a seat and, unless `hold_only`, buy in and sit in it. */
export interface SeatRequest {
	/** A seat to take; by default the server picks one. */
	seat?: number | null;
	/** Defaults to as much of the maximum as the wallet holds. */
	buy_in?: number | null;
	/** Only hold the seat, to buy in later with a `sit` message. */
	hold_only?: boolean;
	/** Needed for a private table. */
	invite?: string | null;
}

/** `POST /api/tables/{table_id}/seat` and `POST /api/quick-seat`. */
export interface SeatResponse {
	table_id: string;
	seat: number;
	/** True when the player now sits at the table. */
	seated: boolean;
	/** When not seated: the held seat. Sit in it with a `sit` message once it is ready. */
	hold: SeatHold | null;
}

/** Any message the server sends. */
export type ServerMessage = WelcomeMessage | TableMessage | LeftTableMessage | TableClosedMessage | ReactionMessage | ErrorMessage;

/** `POST /api/session`, with an optional body. */
export interface SessionRequest {
	/** The bearer token a Phase 3 client kept, to move that player onto a session cookie. */
	legacy_token?: string | null;
}

/** `POST /api/session`: the player this browser is. The session itself is in an `HttpOnly` cookie. */
export interface SessionResponse {
	player_id: string;
	name: string;
	/** Whether this request made a new player. */
	created: boolean;
	/** Play chips in the wallet, after any grant or top-up this visit paid. */
	balance: number;
}

export interface SitInMessage {
	type: 'sit_in';
	table_id: string;
}

export interface SitMessage {
	type: 'sit';
	table_id: string;
	seat: number;
	buy_in: number;
}

export interface SitOutMessage {
	type: 'sit_out';
	table_id: string;
}

export interface Stakes {
	small_blind: number;
	big_blind: number;
}

export type Street = 'pre-flop' | 'flop' | 'turn' | 'river';

export type Suit = 'spades' | 'hearts' | 'diamonds' | 'clubs';

export interface TableClosedMessage {
	type: 'table_closed';
	table_id: string;
	message: string;
}

/** A public change at a table. */
export interface TableEvent {
	/** Increases by one per event at a table. */
	seq: number;
	kind: EventKind;
	seat?: number | null;
	name?: string | null;
	amount?: number | null;
	added?: number | null;
	all_in?: boolean | null;
	action?: ActionKind | null;
	street?: Street | null;
	cards?: Card[] | null;
	reason?: string | null;
	hand_no?: number | null;
	count?: number | null;
}

/**
 * `GET /api/tables`, with optional filters `seats`, `big_blind` and `open` (only tables with a seat to take).
 *
 * Public tables, and private ones the viewer is at, most people first.
 */
export interface TableListResponse {
	tables: TableSummary[];
}

/** A table's view after a change, with the events since the last one sent. */
export interface TableMessage {
	type: 'table';
	table_id: string;
	view: TableView;
	events: TableEvent[];
}

export interface TableSettings {
	seat_count: number;
	small_blind: number;
	big_blind: number;
	ante: number;
	min_buy_in: number;
	max_buy_in: number;
	action_seconds: number;
	time_bank_seconds: number;
}

/** A table as the lobby lists it. */
export interface TableSummary {
	table_id: string;
	name: string;
	seat_count: number;
	small_blind: number;
	big_blind: number;
	min_buy_in: number;
	max_buy_in: number;
	private: boolean;
	/** People seated. */
	people: number;
	/** Bots seated. */
	bots: number;
	/** Empty seats nobody holds. */
	free_seats: number;
	/** Bots' seats a person can claim; the bot leaves when its hand ends. */
	bot_seats: number;
	/** Seats held for players buying in. */
	holds: number;
	waitlist: number;
	/** Hands dealt so far. */
	hand_no: number;
	/** Whether the viewer has a seat here. */
	seated: boolean;
	/** The seat held for the viewer here, if any. */
	hold: SeatHold | null;
	/** The viewer's place on the waitlist here, from 1. */
	waitlist_position: number | null;
	/** Someone the viewer blocked, or who blocked the viewer, is seated here. */
	blocked: boolean;
}

/** Everything one player may see at a table. */
export interface TableView {
	table_id: string;
	name: string;
	/** The seq of the last event at the table. */
	seq: number;
	/** The server's clock when the view was made, for the timers. */
	server_time: number;
	settings: TableSettings;
	/** One entry per seat; null for an empty seat. */
	seats: (SeatInfo | null)[];
	hand: HandInfo | null;
	turn: Turn | null;
	you: You;
	private: boolean;
	/** A private table's invite code, for its people to share. */
	invite: string | null;
	holds: SeatHold[];
	/** Players waiting for a seat. */
	waitlist: number;
	/** A practice table (P6.0b): its chips are not from the wallet, and a player who runs out gets a fresh practice stack with a `rebuy` message. */
	practice?: boolean;
}

/** The clock of the seat to act, in seconds since the epoch on the server. */
export interface Turn {
	seat: number;
	/** The seq of this turn's event; an act must carry at least this. */
	seq: number;
	started: number;
	/** When the action time runs out and the time bank starts. */
	deadline: number;
	/** When the seat is timed out. */
	final: number;
}

export interface Uncalled {
	seat: number;
	amount: number;
}

/** `POST /api/tables/{table_id}/waitlist`: wait for a seat at a full table. */
export interface WaitlistRequest {
	/** Needed for a private table. */
	invite?: string | null;
}

export interface WaitlistResponse {
	table_id: string;
	/** The player's place in line, from 1. */
	position: number;
}

/** `GET /api/wallet` with the session cookie: the balance and the newest entries first. */
export interface WalletResponse {
	balance: number;
	/** The play-money statement (D-1), to show with the chips. */
	notice: string;
	entries: LedgerItem[];
}

export interface WelcomeMessage {
	type: 'welcome';
	protocol: number;
	player_id: string;
	name: string;
}

export interface You {
	player_id: string;
	/** The viewer's seat, or null when not seated. */
	seat: number | null;
	/** The seat held for the viewer, if any. */
	hold: SeatHold | null;
	/** The viewer's place on the waitlist, from 1. */
	waitlist_position: number | null;
	/** Set when it is the viewer's turn. */
	legal: Legal | null;
	time_bank: number | null;
	pending_rebuy: number;
	sitting_out: boolean;
	sitting_out_next: boolean;
}

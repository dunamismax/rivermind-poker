// The lobby's words and what it works out only to show them: bot notes, the
// practice and wallet notes, a listed table's seats, and the buy-ins a wallet
// covers. NlLobby.svelte and LobbyTables.svelte show them, and the iPhone app's
// lobby (P5D.6) shows the same, held to this file by `pnpm ios:fixtures`
// (ios-display.spec.ts, DisplayParityTests.swift). A change to either side lands
// in both in the same commit.

import type { BotOption, TableSummary } from '../protocol-v2.ts';
import { seatsNote } from './faces.ts';

/** What each bot is, in a few words, on the new-table form. */
export const BOT_NOTES: Record<string, string> = {
	heuristic: 'Plays its cards with a plan.',
	medium: 'Half Hard, half Easy.',
	hard: 'Trained by self-play.',
	calling_station: 'Calls almost anything.',
	random: 'Does whatever it likes.'
};

/** A bot's note, with the table sizes it plays when it does not play them all. */
export function botNote(bot: BotOption): string {
	const note = BOT_NOTES[bot.kind] ?? '';
	return bot.seats ? `${note} ${seatsNote(bot.seats)}`.trim() : note;
}

/** What a trained bot is, before its published result (D-7). */
const TRAINED_NOTES: Record<string, string> = {
	medium: 'plays half its hands as RiverMind Hard and half as RiverMind Easy.',
	hard: 'is a trained bot.'
};

/** The words after a trained bot's name, before its published result (D-7). */
export function trainedNote(kind: string): string {
	return TRAINED_NOTES[kind] ?? TRAINED_NOTES.hard;
}

/** The trained bots to practise against: those that play two seats, from the easiest up. */
export function practiceBots(bots: readonly BotOption[]): BotOption[] {
	return bots.filter((b) => b.champion && (!b.seats || b.seats.includes(2)));
}

/** The bots that play a table of `seats` seats. */
export function botsFor(bots: readonly BotOption[], seats: number): BotOption[] {
	return bots.filter((b) => !b.seats || b.seats.includes(seats));
}

/** The note under the practice button. */
export function practiceNote(stack: number | undefined): string {
	return (
		`Heads-up against the RiverMind Easy bot with ${(stack ?? 10000).toLocaleString('en-US')} ` +
		'practice chips. Your wallet is not touched, and you get a fresh stack whenever you run out.'
	);
}

/** The wallet's top-up rules (`wallet.ts`). */
export const WALLET_HINT =
	'New players start with 20,000; below 10,000, a visit tops you up once a day.';

/** Buy-ins run from 40 to 100 big blinds, the server's default range. */
export const BUY_INS = [40, 70, 100];

/** The buy-ins, in big blinds, that a wallet of `balance` covers at `bigBlind` (all while unknown). */
export function affordableBuyIns(bigBlind: number, balance: number | null): number[] {
	return BUY_INS.filter((blinds) => balance === null || blinds * bigBlind <= balance);
}

/** A buy-in's choice on the form: "4000 (40 big blinds)". */
export function buyInLabel(blinds: number, bigBlind: number): string {
	return `${blinds * bigBlind} (${blinds} big blinds)`;
}

/** Who sits at a listed table: "2 people · 3 bots · 1 empty · 1 waiting". */
export function seatsText(t: TableSummary): string {
	const parts = [`${t.people} ${t.people === 1 ? 'person' : 'people'}`];
	if (t.bots) parts.push(`${t.bots} ${t.bots === 1 ? 'bot' : 'bots'}`);
	if (t.free_seats) parts.push(`${t.free_seats} empty`);
	if (t.waitlist) parts.push(`${t.waitlist} waiting`);
	return parts.join(' · ');
}

export type Pip = 'person' | 'bot' | 'held' | 'empty';

/** One pip per seat: people, bots (a bot finishing its hand for a held seat included), held empty seats, empty seats. */
export function pips(t: TableSummary): Pip[] {
	const held = Math.max(0, t.seat_count - t.people - t.bots - t.free_seats);
	return [
		...Array<'person'>(t.people).fill('person'),
		...Array<'bot'>(t.bots).fill('bot'),
		...Array<'held'>(held).fill('held'),
		...Array<'empty'>(t.free_seats).fill('empty')
	];
}

/** A listed table's stakes: "Blinds 50/100 · buy-in 4,000 to 10,000". */
export function tableDetail(t: TableSummary): string {
	return (
		`Blinds ${t.small_blind}/${t.big_blind} · buy-in ${t.min_buy_in.toLocaleString('en-US')} to ` +
		t.max_buy_in.toLocaleString('en-US')
	);
}

/** Whether a listed table has a seat a person can take: an empty one, or a bot's. */
export function hasRoom(t: TableSummary): boolean {
	return t.free_seats + t.bot_seats > 0;
}

/** What the viewer can do at a listed table, and what its row says about them. */
export type TableChoice =
	| { kind: 'seated' }
	| { kind: 'ready'; note: string }
	| { kind: 'held'; note: string }
	| { kind: 'waiting'; note: string }
	| { kind: 'sit'; afford: boolean }
	| { kind: 'waitlist'; afford: boolean };

export function tableChoice(t: TableSummary, balance: number | null): TableChoice {
	if (t.seated) return { kind: 'seated' };
	if (t.hold?.ready) return { kind: 'ready', note: 'Your seat is ready' };
	if (t.hold) return { kind: 'held', note: 'Seat held: a bot is finishing its hand' };
	if (t.waitlist_position !== null)
		return { kind: 'waiting', note: `Number ${t.waitlist_position} in line` };
	const afford = balance === null || balance >= t.min_buy_in;
	return hasRoom(t) ? { kind: 'sit', afford } : { kind: 'waitlist', afford };
}

/** An invite's table, as the lobby offers it: "Ann's table: blinds 50/100, 1 person seated." */
export function inviteLine(t: TableSummary): string {
	return (
		`${t.name}: blinds ${t.small_blind}/${t.big_blind}, ${t.people} ` +
		`${t.people === 1 ? 'person' : 'people'} seated.`
	);
}

/** A private table's invite link on the server at `origin`. */
export function inviteLink(origin: string, code: string): string {
	return `${origin}/?invite=${encodeURIComponent(code)}`;
}

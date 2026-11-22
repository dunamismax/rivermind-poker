// Who sits where: each seat's avatar and the label every bot wears (D-7).

import type { BotChampion } from '../protocol-v2.ts';

const BOT_LABELS: Record<string, string> = {
	heuristic: 'RiverMind Easy',
	medium: 'RiverMind Medium',
	hard: 'RiverMind Hard',
	random: 'Random',
	calling_station: 'Calling'
};

const BOT_AVATARS: Record<string, string> = {
	heuristic: 'avatar-heuristic',
	medium: 'avatar-medium',
	hard: 'avatar-hard',
	random: 'avatar-random',
	calling_station: 'avatar-calling-station'
};

export const PERSON_AVATARS = 6;

/** A win rate in big blinds per 100 hands, signed. */
export function winRate(value: number): string {
	return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}`;
}

/** One sentence on a trained bot's published evaluation: its result against RiverMind Easy (D-7). */
export function championLine(champion: BotChampion): string {
	const easy = champion.results.find((r) => r.opponent === 'heuristic') ?? champion.results[0];
	if (!easy) return '';
	const [low, high] = easy.ci95;
	return (
		`Over ${easy.hands.toLocaleString('en-US')} hands it won ${winRate(easy.bb_per_100)} big blinds ` +
		`per 100 hands against ${easy.label} (95% interval ${winRate(low)} to ${winRate(high)}).`
	);
}

export function botLabel(kind: string | null): string {
	if (!kind) return 'Bot';
	return BOT_LABELS[kind] ?? kind.replace(/_/g, ' ');
}

/**
 * A bot's name for a phone's pod, which has room for about eight letters: the part
 * that tells it from the others. "RiverMind Easy 4" is "Easy 4" there and "Calling
 * bot 2" is "Calling 2", under the "Bot" tag every bot wears (D-7). Each part says
 * whether a pod shows it; together they are the whole name.
 */
export function podName(name: string): { text: string; pod: boolean }[] {
	const match = /^(RiverMind )?(.+?)( bot)?( \d+)?$/.exec(name);
	if (!match) return [{ text: name, pod: true }];
	const [, house = '', core, bot = '', number = ''] = match;
	return [
		{ text: house, pod: false },
		{ text: core, pod: true },
		{ text: bot, pod: false },
		{ text: number, pod: true }
	].filter((part) => part.text !== '');
}

/** A stable pick from the six people for a name, so a player keeps a face. */
export function personAvatar(name: string): number {
	let hash = 0;
	for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
	return hash % PERSON_AVATARS;
}

export function avatarClass(seat: { kind: string; bot: string | null; name: string }): string {
	if (seat.kind === 'bot') return BOT_AVATARS[seat.bot ?? ''] ?? 'avatar-bot';
	return `avatar-person-${personAvatar(seat.name)}`;
}

/** A chip color for a bet, by its size in big blinds. */
export function chipFor(amount: number, bigBlind: number): string {
	const blinds = amount / Math.max(1, bigBlind);
	if (blinds < 1) return 'chip-white';
	if (blinds < 3) return 'chip-red';
	if (blinds < 10) return 'chip-blue';
	if (blinds < 25) return 'chip-green';
	if (blinds < 60) return 'chip-black';
	return 'chip-violet';
}

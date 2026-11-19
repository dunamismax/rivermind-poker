// Who sits where: each seat's avatar and the label every bot wears (D-7).

const BOT_LABELS: Record<string, string> = {
	heuristic: 'RiverMind Easy',
	random: 'Random',
	calling_station: 'Calling'
};

const BOT_AVATARS: Record<string, string> = {
	heuristic: 'avatar-heuristic',
	random: 'avatar-random',
	calling_station: 'avatar-calling-station'
};

export const PERSON_AVATARS = 6;

export function botLabel(kind: string | null): string {
	if (!kind) return 'Bot';
	return BOT_LABELS[kind] ?? kind.replace(/_/g, ' ');
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

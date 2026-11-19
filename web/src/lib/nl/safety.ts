// Preset reactions and the words for reports (P4.5). There is no free-text
// chat (Q-4); the server sends each reaction's text too, and refuses any
// reaction not in its list, which the generated `Reaction` type mirrors.

import type { Reaction, RelationKind, ReportReason } from '../protocol-v2.ts';

export const REACTIONS: ReadonlyArray<{ kind: Reaction; text: string }> = [
	{ kind: 'hello', text: 'Hi!' },
	{ kind: 'nice_hand', text: 'Nice hand' },
	{ kind: 'well_played', text: 'Well played' },
	{ kind: 'good_game', text: 'Good game' },
	{ kind: 'unlucky', text: 'Unlucky' },
	{ kind: 'thanks', text: 'Thanks' },
	{ kind: 'wow', text: 'Wow' },
	{ kind: 'thinking', text: 'Thinking…' }
];

/** How long a reaction shows beside its seat. */
export const REACTION_MS = 4000;

export const REPORT_REASONS: ReadonlyArray<{ reason: ReportReason; text: string }> = [
	{ reason: 'handle', text: 'Offensive name' },
	{ reason: 'abuse', text: 'Spam or abuse' },
	{ reason: 'collusion', text: 'Playing as a team' },
	{ reason: 'other', text: 'Something else' }
];

export function relationText(kind: RelationKind | null): string {
	return kind === 'block' ? 'Blocked' : kind === 'mute' ? 'Muted' : '';
}

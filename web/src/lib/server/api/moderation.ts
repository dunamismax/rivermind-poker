/**
 * The moderator's commands (P4.5, P4B.8a): list the newest reports and
 * collusion signals, give a reported player a new random handle, and list or
 * lift the speaking suspensions that voice reports make (P4C.8).
 *
 * They replace `rivermind-poker moderation`, which went with the Python table
 * server at P4B.8, and print what it printed, with the reporter's handle
 * added. `scripts/moderation.ts` runs them against `DATABASE_URL`.
 *
 * Kept free of `$lib` imports, so Node runs the script directly.
 */
import type { PlayerStore } from './players.ts';
import type { SafetyStore } from './safety.ts';

export const USAGE = `Usage: moderation <command>

  reports [--limit N]   the newest reports, newest first (50 by default)
  signals [--limit N]   the newest collusion signals, newest first (50 by default)
  rename PLAYER_ID      give a player a new random handle
  suspensions           players who may not speak in voice now, and until when
  lift PLAYER_ID        let a player speak in voice again

Reads DATABASE_URL. Tables a renamed player sits at show the new handle after
they sit down again. A lifted player speaks again when they next join voice.`;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

/** A command the moderator got wrong, or one that cannot be done; its message is for them. */
export class ModerationError extends Error {}

export interface ModerationStores {
	players: PlayerStore;
	safety: SafetyStore;
}

/** “2026-11-21 16:05 UTC”. */
export function when(at: number): string {
	return `${new Date(at * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The `--limit N` of a listing; nothing else may follow the command. */
function limitOf(args: readonly string[]): number {
	if (args.length === 0) return DEFAULT_LIMIT;
	const [flag, value, ...rest] = args;
	const limit = Number(value);
	if (flag !== '--limit' || rest.length > 0 || !Number.isInteger(limit) || limit < 1) {
		throw new ModerationError(USAGE);
	}
	return Math.min(limit, MAX_LIMIT);
}

/** Run one command and return the lines to print. */
export async function moderate(
	args: readonly string[],
	{ players, safety }: ModerationStores
): Promise<string[]> {
	const [command, ...rest] = args;
	switch (command) {
		case 'reports': {
			const reports = await safety.reports(limitOf(rest));
			const handles = new Map<string, string | null>();
			for (const { reporterId } of reports) {
				if (!handles.has(reporterId)) {
					handles.set(reporterId, (await players.get(reporterId))?.handle ?? null);
				}
			}
			return reports.map((report) => {
				const reporter = handles.get(report.reporterId);
				const by = reporter ? `${reporter} (${report.reporterId})` : report.reporterId;
				const where = report.tableId ? ` at table ${report.tableId}` : '';
				const hand = report.handNo ? `, hand ${report.handNo}` : '';
				return `${when(report.at)}  ${report.reason.padEnd(9)}  ${report.targetHandle} (${report.targetId})  by ${by}${where}${hand}`;
			});
		}
		case 'signals': {
			const signals = await safety.signals(limitOf(rest));
			return signals.map(
				(signal) =>
					`${when(signal.at)}  ${signal.kind}  table ${signal.tableId ?? '-'}  ${signal.playerIds.join(', ')}  ${JSON.stringify(signal.detail)}`
			);
		}
		case 'rename': {
			if (rest.length !== 1 || rest[0].startsWith('-')) throw new ModerationError(USAGE);
			const [playerId] = rest;
			const before = await players.get(playerId);
			if (!before) throw new ModerationError(`No player ${playerId}.`);
			const after = await players.rename(playerId);
			return [`${playerId}: ${before.handle} -> ${after.handle}`];
		}
		case 'suspensions': {
			if (rest.length) throw new ModerationError(USAGE);
			const now = Date.now() / 1000;
			const lines: string[] = [];
			for (const { playerId, until } of await safety.suspensions(now)) {
				const handle = (await players.get(playerId))?.handle ?? '?';
				lines.push(`until ${when(until)}  ${handle} (${playerId})`);
			}
			return lines;
		}
		case 'lift': {
			if (rest.length !== 1 || rest[0].startsWith('-')) throw new ModerationError(USAGE);
			const [playerId] = rest;
			if (!(await safety.liftSuspension(playerId))) {
				throw new ModerationError(`${playerId} may already speak in voice.`);
			}
			return [`${playerId} may speak in voice again.`];
		}
		default:
			throw new ModerationError(USAGE);
	}
}

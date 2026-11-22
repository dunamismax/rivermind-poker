// Table voice from the table server's side (P4C.5): who at a table may be in
// its voice room, the tokens that let them in, and the seat lists that tell
// the voice service whenever that changes (src/lib/server/voice/seats.ts).
//
// Voice is for the people seated at a table where someone else is too (Q-10):
// never a spectator, someone holding a seat they have not taken, a bot (D-7)
// or a practice table, and not someone who has gone bust. When the people a
// table has in voice change (someone stands up, busts, leaves, a table
// closes, or one of them blocks another), the table server sends the voice
// service the new list at once, and the voice service takes out whoever is
// no longer on it, which starts a new epoch of the group. A list also names
// whoever may not speak, because voice reports suspended them (P4C.8).
import { publicRef } from './auth.ts';
import { HttpError } from './errors.ts';
import type { Log, TableRunner } from '../table/runner.ts';
import { SEATS_PATH, signSeats, type SeatList } from '../voice/seats.ts';
import { issueToken, voiceKey } from '../voice/tokens.ts';

export interface VoiceLink {
	send(list: SeatList): Promise<void>;
}

// The voice service on loopback. A list that does not arrive is logged; the
// next change sends the whole list again.
export function httpVoiceLink(base: string, key: Uint8Array, log: Log): VoiceLink {
	const url = new URL(SEATS_PATH, base);
	return {
		async send(list) {
			const body = JSON.stringify(list);
			try {
				const response = await fetch(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json', ...signSeats(key, body, Date.now()) },
					body,
					signal: AbortSignal.timeout(2000)
				});
				if (response.status !== 204)
					log.warn(`The voice service refused a seat list: ${response.status}`);
			} catch (error) {
				log.warn(`Could not reach the voice service: ${(error as Error).message}`);
			}
		}
	};
}

export type VoicePerson = { seat: number; playerId: string };

// The people a table has in voice now: those seated who are not bots and not
// bust, at a table that is not a practice table, when there are two or more.
export function voicePeople(runner: TableRunner): VoicePerson[] {
	if (runner.practice !== null || runner.closed) return [];
	const table = runner.table;
	const people = table
		.players()
		.filter(
			([seat, player]) =>
				player.bot === null &&
				!(player.stack === 0 && player.pendingRebuy === 0 && !table.inHand(seat))
		)
		.map(([seat, player]) => ({ seat, playerId: player.playerId }));
	return people.length >= 2 ? people : [];
}

export type VoiceOptions = {
	// The site's session secret: tokens are signed under the voice key derived from it.
	secret: Uint8Array;
	link: VoiceLink;
	// The people a player has blocked or been blocked by (SafetyStore.blocksInvolving).
	blocksOf: (playerId: string) => Promise<Set<string>>;
	// When a player's speaking suspension ends, in seconds since the epoch, or
	// null without one (SafetyStore.speakingSuspendedUntil, P4C.8).
	silencedUntil?: (playerId: string) => Promise<number | null>;
	// Seconds since the epoch, for tokens; milliseconds order the lists.
	now: () => number;
	log: Log;
};

export class Voice {
	#key: Buffer;
	#link: VoiceLink;
	#blocksOf: (playerId: string) => Promise<Set<string>>;
	#silencedUntil: (playerId: string) => Promise<number | null>;
	#now: () => number;
	// The people each table last sent, so a change of stacks or turns sends nothing.
	#sent = new Map<string, string>();
	// Each table's lists go out one at a time, in the order they were made.
	#queues = new Map<string, Promise<void>>();
	#at = 0;

	constructor({ secret, link, blocksOf, silencedUntil, now }: VoiceOptions) {
		this.#key = voiceKey(secret);
		this.#link = link;
		this.#blocksOf = blocksOf;
		this.#silencedUntil = silencedUntil ?? (async () => null);
		this.#now = now;
	}

	// Follow a table from its first change: each change that alters who is in
	// voice sends the voice service the new list.
	watch(runner: TableRunner): void {
		runner.listeners.push((changed) => {
			this.#changed(changed, false);
		});
	}

	// Send the table's list again, as after a block or an unblock, whose pairs it carries.
	refresh(runner: TableRunner): Promise<void> {
		return this.#changed(runner, true);
	}

	// The table closed: nobody is in its voice room any more.
	closed(tableId: string): Promise<void> {
		if (!this.#sent.has(tableId)) return Promise.resolve();
		this.#sent.delete(tableId);
		return this.#send(tableId, () => this.#list(tableId, []));
	}

	// Resolves once every list made so far has been sent (for tests).
	async settled(): Promise<void> {
		while (this.#queues.size) await Promise.all([...this.#queues.values()]);
	}

	// A token for a person in the table's voice: the voice service admits it once,
	// within a minute. The table's list goes first, so a voice service that has
	// just started knows the room's people before the token reaches it.
	async token(runner: TableRunner, playerId: string): Promise<{ token: string; seat: number }> {
		if (runner.practice !== null) {
			throw new HttpError(403, 'Practice tables have no voice.');
		}
		const seat = runner.table.seatOf(playerId);
		if (seat === null) {
			throw new HttpError(403, 'Only people seated at the table can join its voice.');
		}
		const people = voicePeople(runner);
		if (!people.some((one) => one.playerId === playerId)) {
			throw new HttpError(409, 'Voice starts when someone else is seated and you have chips.');
		}
		await this.#changed(runner, true);
		const grant = { table: runner.tableId, seat, player: publicRef(playerId) };
		return { token: issueToken(this.#key, grant, this.#now()), seat };
	}

	#changed(runner: TableRunner, always: boolean): Promise<void> {
		const people = voicePeople(runner);
		const shape = JSON.stringify(people);
		if (!always && this.#sent.get(runner.tableId) === (people.length ? shape : '[]')) {
			return Promise.resolve();
		}
		if (!always && !people.length && !this.#sent.has(runner.tableId)) return Promise.resolve();
		this.#sent.set(runner.tableId, people.length ? shape : '[]');
		return this.#send(runner.tableId, () => this.#list(runner.tableId, people));
	}

	#send(tableId: string, make: () => Promise<SeatList>): Promise<void> {
		const before = this.#queues.get(tableId) ?? Promise.resolve();
		const sent = before.then(async () => this.#link.send(await make()));
		const queued = sent.catch(() => {});
		this.#queues.set(tableId, queued);
		void queued.then(() => {
			if (this.#queues.get(tableId) === queued) this.#queues.delete(tableId);
		});
		return queued;
	}

	async #list(tableId: string, people: VoicePerson[]): Promise<SeatList> {
		const blocks: [string, string][] = [];
		for (const [at, one] of people.entries()) {
			const theirs = await this.#blocksOf(one.playerId);
			for (const other of people.slice(at + 1)) {
				if (theirs.has(other.playerId)) {
					blocks.push([publicRef(one.playerId), publicRef(other.playerId)]);
				}
			}
		}
		// Whoever may not speak, and until when: the voice service refuses their
		// audio until then by itself, so the end needs no list of its own.
		const silenced: [string, number][] = [];
		for (const one of people) {
			const until = await this.#silencedUntil(one.playerId);
			if (until !== null) silenced.push([publicRef(one.playerId), Math.ceil(until * 1000)]);
		}
		// Lists are ordered by when they were made, never twice at the same instant.
		this.#at = Math.max(this.#at + 1, Math.floor(this.#now() * 1000));
		return {
			table: tableId,
			at: this.#at,
			seats: people.map(({ seat, playerId }) => ({ seat, player: publicRef(playerId) })),
			blocks,
			...(silenced.length ? { silenced } : {})
		};
	}
}

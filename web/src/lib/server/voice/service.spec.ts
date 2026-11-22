// The voice service (P4C.4) with a real mediasoup worker, driven over voice
// signalling v1 by pages that hold real MLS members (group.ts): who it lets
// in, how it carries the group, how it carries audio, and what it logs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guestName, publicRef } from '../api/auth.ts';
import { Player, SECRET, TestServer, quietLog } from '../api/tables.testing.ts';
import { Voice } from '../api/voice.ts';
import { Member, type Identity } from '../../voice/group.ts';
import {
	CLOSE,
	MAX_MESSAGE_BYTES,
	fromBase64,
	toBase64,
	type Answer,
	type Notice,
	type RequestType,
	type Requests,
	type ServerMessage
} from '../../voice/signalling.ts';
import { Media, AUDIO_LEVEL_URI } from './media.ts';
import { MAX_PEERS, VoiceService, type Session } from './service.ts';
import { issueToken, voiceKey } from './tokens.ts';

const key = voiceKey(new TextEncoder().encode('the voice service tests'));
const TABLE = 'Tb1x-2_yZ0aQ';
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const playerId = (seat: number) => `p_seat-${seat}-player-id`;
const who = (seat: number): Identity => ({ player: publicRef(playerId(seat)), seat });

let media: Media;
let lines: string[] = [];
let clock = 1_800_000_000;
const service = () =>
	new VoiceService({
		key,
		media,
		log: (line) => lines.push(line),
		now: () => clock
	});

beforeAll(async () => {
	media = await Media.start({
		listenIps: ['127.0.0.1'],
		port: 0,
		announced: null,
		log: (line) => lines.push(line)
	});
});
afterAll(() => media.close());

// Opus as a browser sends it, for a producer that needs no real connection.
const OPUS = (ssrc: number, extensions: { uri: string; id: number }[] = []) => ({
	codecs: [
		{
			mimeType: 'audio/opus',
			payloadType: 111,
			clockRate: 48000,
			channels: 2,
			parameters: { useinbandfec: 1, usedtx: 1 }
		}
	],
	headerExtensions: [{ uri: 'urn:ietf:params:rtp-hdrext:sdes:mid', id: 1 }, ...extensions],
	encodings: [{ ssrc }],
	rtcp: { cname: `c${ssrc}` },
	mid: '0'
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

// One page's socket to the service, and the group member it holds.
class Page {
	sent: ServerMessage[] = [];
	closed: { code: number; reason: string } | null = null;
	member: Member | null = null;
	welcome: Requests['hello']['response'] | null = null;
	identity: Identity;
	#nextId = 1;
	#waiting = new Map<number, (answer: Answer) => void>();
	#notices: Notice[] = [];
	#noticeWaiters: (() => void)[] = [];
	session: Session;

	constructor(service: VoiceService, seat: number, identity: Identity = who(seat)) {
		this.identity = identity;
		this.session = service.open({
			send: (text) => {
				const message = JSON.parse(text) as ServerMessage;
				this.sent.push(message);
				if ('id' in message) {
					this.#waiting.get(message.id)?.(message);
					this.#waiting.delete(message.id);
				} else {
					this.#notices.push(message);
					for (const wake of this.#noticeWaiters.splice(0)) wake();
				}
			},
			close: (code, reason) => {
				this.closed ??= { code, reason };
				this.session.closed();
			}
		});
	}

	raw(text: string): void {
		this.session.receive(text);
	}

	ask<T extends RequestType>(type: T, data: Requests[T]['request']): Promise<Answer<T>> {
		const id = this.#nextId++;
		const answered = new Promise<Answer>((resolve) => this.#waiting.set(id, resolve));
		this.session.receive(JSON.stringify({ id, type, ...data }));
		return answered as Promise<Answer<T>>;
	}

	async ok<T extends RequestType>(
		type: T,
		data: Requests[T]['request']
	): Promise<Requests[T]['response']> {
		const answer = await this.ask(type, data);
		if (!answer.ok) throw new Error(`${type} refused: ${answer.error}`);
		return answer as unknown as Requests[T]['response'];
	}

	token(table = TABLE, seat = this.identity.seat): string {
		return issueToken(key, { table, seat, player: this.identity.player }, clock);
	}

	async hello(token = this.token(), table = TABLE): Promise<Answer<'hello'>> {
		const answer = await this.ask('hello', { v: 1, table, token });
		if (answer.ok) this.welcome = answer as unknown as Requests['hello']['response'];
		return answer;
	}

	// The notices the page has not looked at yet, waiting for at least `count`.
	async notices(count = 1): Promise<Notice[]> {
		for (let tries = 0; this.#notices.length < count; tries += 1) {
			if (tries > 200) throw new Error(`waited for ${count} notices, have ${this.#notices.length}`);
			await new Promise<void>((resolve) => {
				this.#noticeWaiters.push(resolve);
				setTimeout(resolve, 20);
			});
		}
		return this.#notices.splice(0);
	}

	pending(): Notice[] {
		return this.#notices.splice(0);
	}

	// Make the group, or join it by external commit, starting again from the
	// GroupInfo a refusal carries.
	async joinGroup(): Promise<number> {
		const service = fromBase64(this.welcome!.service)!;
		let groupInfo = this.welcome!.groupInfo;
		for (let tries = 0; tries < 5; tries += 1) {
			if (groupInfo === null) {
				const made = await Member.create(this.identity, fromBase64(this.welcome!.group)!, service);
				const answer = await this.ask('group.create', { groupInfo: toBase64(made.groupInfo) });
				if (answer.ok) {
					this.member = made.member;
					return (answer as unknown as { leaf: number }).leaf;
				}
				groupInfo = answer.groupInfo ?? null;
				continue;
			}
			const candidate = await Member.join(this.identity, fromBase64(groupInfo)!, service);
			const answer = await this.ask('group.commit', {
				commit: toBase64(candidate.commit),
				groupInfo: toBase64(candidate.groupInfo)
			});
			if (answer.ok) {
				this.member = candidate.member;
				return (answer as unknown as { leaf: number }).leaf;
			}
			groupInfo = answer.groupInfo ?? null;
		}
		throw new Error('could not join the group');
	}

	// Apply every MLS notice so far, in order; the rest are returned.
	async apply(notices: Notice[]): Promise<Notice[]> {
		const rest: Notice[] = [];
		for (const notice of notices) {
			if (notice.notice === 'mls') await this.member!.receive(fromBase64(notice.message)!);
			else rest.push(notice);
		}
		return rest;
	}

	async commit(): Promise<Answer<'group.commit'>> {
		const candidate = await this.member!.commit();
		const answer = await this.ask('group.commit', {
			commit: toBase64(candidate.commit),
			groupInfo: toBase64(candidate.groupInfo)
		});
		if (answer.ok) this.member = candidate.member;
		return answer;
	}

	leave(): void {
		this.session.closed();
	}
}

async function agree(pages: Page[]): Promise<string> {
	const key = hex(await pages[0].member!.baseKey());
	for (const page of pages) {
		expect(page.member!.epoch).toBe(pages[0].member!.epoch);
		expect(hex(await page.member!.baseKey())).toBe(key);
		expect(page.member!.pendingRemovals()).toEqual([]);
	}
	return key;
}

describe('who the voice service lets in', () => {
	it('welcomes a token for the table, with what a page needs to join the group', async () => {
		const voice = service();
		const page = new Page(voice, 2);
		const answer = await page.hello();
		expect(answer.ok).toBe(true);
		const welcome = page.welcome!;
		expect(welcome).toMatchObject({ v: 1, seat: 2, player: who(2).player, groupInfo: null });
		expect(fromBase64(welcome.service)).toHaveLength(32);
		expect(fromBase64(welcome.group)).toHaveLength(16);
		expect(welcome.peers).toEqual([]);
		const opus = welcome.routerRtpCapabilities.codecs!.filter((c) => c.mimeType === 'audio/opus');
		expect(opus).toHaveLength(1);
		expect(opus[0].parameters).toMatchObject({ useinbandfec: 1 });
		expect(welcome.routerRtpCapabilities.codecs!.every((c) => c.kind === 'audio')).toBe(true);
		const uris = welcome.routerRtpCapabilities.headerExtensions!.map(({ uri }) => uri);
		expect(uris).not.toContain(AUDIO_LEVEL_URI);
		expect(uris).toContain('urn:ietf:params:rtp-hdrext:sdes:mid');
		page.leave();
	});

	it('refuses forged, expired, reused and other-table tokens, and closes the socket', async () => {
		const voice = service();
		const genuine = new Page(voice, 0);
		const token = genuine.token();
		const forged = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
		const cases: [string, string, string][] = [
			['forged', forged, TABLE],
			['another table', genuine.token('another-tab'), TABLE],
			['another table asked', token, 'another-tab'],
			[
				'signed with another key',
				issueToken(voiceKey(new Uint8Array(8)), { table: TABLE, ...who(0) }, clock),
				TABLE
			]
		];
		for (const [label, value, table] of cases) {
			const page = new Page(voice, 0);
			const answer = await page.hello(value, table);
			expect(answer, label).toEqual({ id: 1, ok: false, error: 'bad-token' });
			expect(page.closed?.code, label).toBe(CLOSE.unauthorised);
		}
		// An expired one: issued, then used a minute later.
		const late = new Page(voice, 0);
		const old = late.token();
		clock += 60;
		expect((await late.hello(old)).ok).toBe(false);
		expect(late.closed?.code).toBe(CLOSE.unauthorised);
		// Reused: the first socket gets in, a second with the same token does not.
		const first = new Page(voice, 1);
		const once = first.token();
		expect((await first.hello(once)).ok).toBe(true);
		const second = new Page(voice, 1);
		expect(await second.hello(once)).toEqual({ id: 1, ok: false, error: 'bad-token' });
		expect(second.closed?.code).toBe(CLOSE.unauthorised);
		expect(first.closed).toBeNull();
		first.leave();
		expect(lines).toContain('refused a token: forged');
		expect(lines).toContain('refused a token: other-table');
		expect(lines).toContain('refused a token: expired');
		expect(lines).toContain('refused a token: reused');
	});

	it('speaks one version, and nothing before hello', async () => {
		const voice = service();
		const old = new Page(voice, 0);
		expect(await old.ask('hello', { v: 2, table: TABLE, token: old.token() })).toEqual({
			id: 1,
			ok: false,
			error: 'unsupported-version'
		});
		expect(old.closed?.code).toBe(CLOSE.protocol);
		const early = new Page(voice, 0);
		early.raw(JSON.stringify({ id: 1, type: 'transport.create', direction: 'send' }));
		expect(early.closed?.code).toBe(CLOSE.protocol);
		for (const text of [
			'not json',
			'[]',
			'{"id":1,"type":"teleport"}',
			'{"id":-1,"type":"hello"}'
		]) {
			const page = new Page(voice, 0);
			page.raw(text);
			expect(page.closed?.code, text).toBe(CLOSE.protocol);
		}
	});

	it('limits the size and rate of what a socket sends', async () => {
		const voice = service();
		const big = new Page(voice, 0);
		await big.hello();
		big.raw(
			JSON.stringify({ id: 9, type: 'consumer.resume', consumer: 'x'.repeat(MAX_MESSAGE_BYTES) })
		);
		expect(big.closed?.code).toBe(CLOSE.protocol);
		const flood = new Page(voice, 1);
		await flood.hello();
		for (let n = 0; n < 100 && !flood.closed; n += 1) {
			void flood.ask('consumer.resume', { consumer: 'nobody' });
		}
		expect(flood.closed?.code).toBe(CLOSE.rate);
		expect(lines).toContain('closed a socket that sent too much');
		// The rate refills: a socket that waits may go on.
		const patient = new Page(voice, 2);
		await patient.hello();
		for (let n = 0; n < 200; n += 1) {
			if (n % 50 === 49) clock += 3;
			expect((await patient.ask('consumer.resume', { consumer: 'nobody' })).ok).toBe(false);
		}
		expect(patient.closed).toBeNull();
		patient.leave();
	});

	it('holds one socket a seat, and no more people than a table has seats', async () => {
		const voice = service();
		const first = new Page(voice, 0);
		await first.hello();
		const other = new Page(voice, 1);
		await other.hello();
		// The same seat again, from a reloaded page.
		const again = new Page(voice, 0);
		await again.hello();
		expect(first.closed?.code).toBe(CLOSE.replaced);
		expect(other.pending()).toContainEqual({ notice: 'left', peer: first.welcome!.peer });
		expect(again.welcome!.peers.map(({ peer }) => peer)).toEqual([other.welcome!.peer]);
		const pages = [again, other];
		for (let seat = 2; seat < MAX_PEERS; seat += 1) {
			const page = new Page(voice, seat);
			expect((await page.hello()).ok).toBe(true);
			pages.push(page);
		}
		const tenth = new Page(voice, MAX_PEERS);
		expect(await tenth.hello()).toEqual({ id: 1, ok: false, error: 'too-many' });
		for (const page of pages) page.leave();
		await settle();
		expect(voice.counts).toEqual({ rooms: 0, people: 0 });
	});
});

describe('the group, over the wire', () => {
	it('lets people make the group, join it and leave it, everyone agreeing at each step', async () => {
		const voice = service();
		const [a, b, c] = [new Page(voice, 0), new Page(voice, 4), new Page(voice, 7)];
		await a.hello();
		expect(await a.joinGroup()).toBe(0);
		await b.hello();
		expect(b.welcome!.groupInfo).not.toBeNull();
		expect(await b.joinGroup()).toBe(1);
		// The first page applies the newcomer's commit.
		expect(await a.apply(await a.notices())).toEqual([]);
		const two = await agree([a, b]);
		await c.hello();
		expect(await c.joinGroup()).toBe(2);
		await a.apply(await a.notices());
		await b.apply(await b.notices());
		const three = await agree([a, b, c]);
		expect(three).not.toBe(two);
		expect(a.member!.roster().map(({ identity }) => identity)).toEqual([who(0), who(4), who(7)]);

		// b leaves: the service proposes their removal, and the lowest leaf commits it.
		const left = b.member!;
		b.leave();
		for (const page of [a, c]) {
			const rest = await page.apply(await page.notices(2));
			expect(rest).toEqual([{ notice: 'left', peer: b.welcome!.peer }]);
			expect(page.member!.pendingRemovals()).toEqual([1]);
		}
		expect(a.member!.commitRank()).toBe(0);
		expect(c.member!.commitRank()).toBe(1);
		const committed = await a.commit();
		expect(committed).toMatchObject({ ok: true, epoch: 3, leaf: null });
		await c.apply(await c.notices());
		const after = await agree([a, c]);
		expect(after).not.toBe(three);
		expect(hex(await left.baseKey())).not.toBe(after);
		a.leave();
		c.leave();
	});

	it('accepts the first commit for an epoch and gives the loser what to start again from', async () => {
		const voice = service();
		const pages = [0, 1, 2, 3].map((seat) => new Page(voice, seat));
		for (const page of pages) {
			await page.hello();
			await page.joinGroup();
			for (const other of pages)
				if (other !== page && other.member) await other.apply(other.pending());
		}
		await settle();
		for (const page of pages) await page.apply(page.pending());
		await agree(pages);
		// Seat 1 goes, and the two members ahead of everyone both commit at once.
		pages[1].leave();
		const [a, c, d] = [pages[0], pages[2], pages[3]];
		for (const page of [a, c, d]) await page.apply(await page.notices(2));
		const answers = await Promise.all([a.commit(), c.commit()]);
		expect(answers.filter(({ ok }) => ok)).toHaveLength(1);
		const lost = answers.find(({ ok }) => !ok)!;
		expect(lost).toMatchObject({ ok: false, error: 'epoch-taken' });
		expect((lost as { groupInfo: string }).groupInfo).toBeTruthy();
		// The loser applies the winner's commit, which the service passed on.
		for (const page of [a, c, d]) await page.apply(page.pending());
		await agree([a, c, d]);
		// Two newcomers at once: one wins the epoch, the other joins again from the next.
		const [e, f] = [new Page(voice, 5), new Page(voice, 6)];
		await e.hello();
		await f.hello();
		const leaves = await Promise.all([e.joinGroup(), f.joinGroup()]);
		expect(leaves.sort()).toEqual([1, 4]);
		await settle();
		for (const page of [a, c, d, e, f]) await page.apply(page.pending());
		await agree([a, c, d, e, f]);
		for (const page of [a, c, d, e, f]) page.leave();
	});

	it('proposes the removal of a reloaded page’s old leaf', async () => {
		const voice = service();
		const a = new Page(voice, 0);
		const b = new Page(voice, 1);
		await a.hello();
		await a.joinGroup();
		await b.hello();
		await b.joinGroup();
		await a.apply(await a.notices());
		// a's page reloads: a new socket for seat 0, a new member under a new key.
		const back = new Page(voice, 0);
		await back.hello();
		expect(a.closed?.code).toBe(CLOSE.replaced);
		expect(await b.apply(await b.notices(2))).toEqual([{ notice: 'left', peer: a.welcome!.peer }]);
		expect(b.member!.pendingRemovals()).toEqual([0]);
		expect(await back.joinGroup()).toBe(2);
		// The join took the epoch, so the service proposed the removal again, to the newcomer too.
		await b.apply(await b.notices(2));
		await back.apply(back.pending());
		expect(b.member!.pendingRemovals()).toEqual([0]);
		expect(back.member!.pendingRemovals()).toEqual([0]);
		expect(b.member!.commitRank()).toBe(0);
		expect(back.member!.commitRank()).toBe(1);
		const answer = await b.commit();
		expect(answer.ok).toBe(true);
		await back.apply(await back.notices());
		await agree([b, back]);
		expect(back.member!.roster().map(({ leaf }) => leaf)).toEqual([1, 2]);
		b.leave();
		back.leave();
	});

	it('starts a new group when everyone in the old one has gone', async () => {
		const voice = service();
		const a = new Page(voice, 0);
		await a.hello();
		await a.joinGroup();
		const b = new Page(voice, 1);
		await b.hello();
		const old = b.welcome!.groupInfo;
		expect(old).not.toBeNull();
		a.leave();
		await b.notices();
		// b's join from the old GroupInfo finds no group, and b makes the next one.
		expect(await b.joinGroup()).toBe(0);
		expect(b.member!.roster().map(({ identity }) => identity)).toEqual([who(1)]);
		b.leave();
	});
});

describe('audio, through the room', () => {
	it('carries a member’s audio to the others, and nobody else’s', async () => {
		const voice = service();
		const [a, b] = [new Page(voice, 0), new Page(voice, 1)];
		await a.hello();
		const send = await a.ok('transport.create', { direction: 'send' });
		expect(send.iceCandidates.length).toBeGreaterThan(0);
		expect(send.iceCandidates.every(({ address }) => address === '127.0.0.1')).toBe(true);
		expect(new Set(send.iceCandidates.map(({ protocol }) => protocol))).toEqual(
			new Set(['udp', 'tcp'])
		);
		expect((await a.ask('transport.create', { direction: 'send' })).ok).toBe(false);
		// Nothing is sent before the page is in the group.
		expect(
			await a.ask('produce', { transport: send.transport, rtpParameters: OPUS(1111) as never })
		).toMatchObject({
			ok: false,
			error: 'not-allowed'
		});
		const leaf = await a.joinGroup();
		// Nor with audio levels on the wire.
		expect(
			await a.ask('produce', {
				transport: send.transport,
				rtpParameters: OPUS(1111, [{ uri: AUDIO_LEVEL_URI, id: 10 }]) as never
			})
		).toMatchObject({ ok: false, error: 'not-allowed' });
		const { producer } = await a.ok('produce', {
			transport: send.transport,
			rtpParameters: OPUS(1111) as never
		});
		expect(
			(await a.ask('produce', { transport: send.transport, rtpParameters: OPUS(2222) as never })).ok
		).toBe(false);

		await b.hello();
		expect(b.welcome!.peers).toEqual([{ peer: a.welcome!.peer, leaf, producer }]);
		const recv = await b.ok('transport.create', { direction: 'recv' });
		const consumed = await b.ok('consume', {
			transport: recv.transport,
			producer,
			rtpCapabilities: b.welcome!.routerRtpCapabilities
		});
		expect(consumed.producer).toBe(producer);
		expect(consumed.rtpParameters.codecs[0].mimeType).toBe('audio/opus');
		expect(consumed.rtpParameters.headerExtensions!.map(({ uri }) => uri)).not.toContain(
			AUDIO_LEVEL_URI
		);
		await b.ok('consumer.resume', { consumer: consumed.consumer });
		await b.ok('consumer.pause', { consumer: consumed.consumer });
		// A page cannot consume the same audio twice, or what nobody sends.
		expect(
			(
				await b.ask('consume', {
					transport: recv.transport,
					producer,
					rtpCapabilities: b.welcome!.routerRtpCapabilities
				})
			).ok
		).toBe(false);
		expect(
			(
				await b.ask('consume', {
					transport: recv.transport,
					producer: 'nobody',
					rtpCapabilities: b.welcome!.routerRtpCapabilities
				})
			).ok
		).toBe(false);
		expect((await b.ask('consumer.resume', { consumer: 'nobody' })).ok).toBe(false);
		expect(
			(await b.ask('transport.connect', { transport: 'nobody', dtlsParameters: {} as never })).ok
		).toBe(false);

		// b joins the group and sends: a hears of it, with b's leaf.
		const bLeaf = await b.joinGroup();
		const bSend = await b.ok('transport.create', { direction: 'send' });
		const bProducer = (
			await b.ok('produce', { transport: bSend.transport, rtpParameters: OPUS(3333) as never })
		).producer;
		const told = (await a.notices(2)).filter((n) => n.notice === 'producer');
		expect(told).toEqual([
			{ notice: 'producer', peer: { peer: b.welcome!.peer, leaf: bLeaf, producer: bProducer } }
		]);
		await a.ok('producer.pause', {});
		await a.ok('producer.resume', {});

		// a leaves: b's consumer of a's audio ends, then b hears a has gone.
		a.leave();
		const notices = await b.notices(2);
		expect(notices.slice(0, 2)).toEqual([
			{ notice: 'consumer.closed', consumer: consumed.consumer },
			{ notice: 'left', peer: a.welcome!.peer }
		]);
		await settle();
		expect(b.pending().filter(({ notice }) => notice === 'consumer.closed')).toEqual([]);
		b.leave();
	});

	it('starts the media server again under a new public address, keeping the group', async () => {
		const voice = service();
		const a = new Page(voice, 0);
		await a.hello();
		await a.joinGroup();
		const before = await a.ok('transport.create', { direction: 'send' });
		await media.announce('192.0.2.10');
		expect(await a.notices()).toEqual([{ notice: 'media.reset' }]);
		expect(
			(
				await a.ask('transport.connect', {
					transport: before.transport,
					dtlsParameters: {} as never
				})
			).ok
		).toBe(false);
		const after = await a.ok('transport.create', { direction: 'send' });
		expect(after.iceCandidates.every(({ address }) => address === '192.0.2.10')).toBe(true);
		expect(a.member!.epoch).toBe(0n);
		await media.announce(null);
		a.leave();
	});
});

describe("the table's word on who is in voice (P4C.5)", () => {
	const listOf = (at: number, seats: number[], blocks: [number, number][] = []) => ({
		table: TABLE,
		at,
		seats: seats.map((seat) => ({ seat, player: who(seat).player })),
		blocks: blocks.map(([a, b]) => [who(a).player, who(b).player] as [string, string])
	});

	it('lets in only who the table lists, and takes out at once whoever leaves the list', async () => {
		const voice = service();
		const [a, b, c] = [new Page(voice, 0), new Page(voice, 1), new Page(voice, 2)];
		for (const page of [a, b, c]) {
			await page.hello();
			await page.joinGroup();
			for (const other of [a, b, c])
				if (other !== page && other.member) await other.apply(other.pending());
		}
		await settle();
		for (const page of [a, b, c]) await page.apply(page.pending());
		const before = await agree([a, b, c]);
		expect(await voice.seats(listOf(1, [0, 1, 2]))).toBe(true);
		// Someone the list does not name is refused, though their token is genuine.
		const stranger = new Page(voice, 5);
		expect(await stranger.hello()).toEqual({ id: 1, ok: false, error: 'not-seated' });
		expect(stranger.closed?.code).toBe(CLOSE.unseated);
		// c stands up: the table's next list leaves them out, and they are taken out.
		expect(await voice.seats(listOf(2, [0, 1]))).toBe(true);
		expect(c.closed?.code).toBe(CLOSE.unseated);
		for (const page of [a, b]) {
			const rest = await page.apply(await page.notices(2));
			expect(rest).toEqual([{ notice: 'left', peer: c.welcome!.peer }]);
		}
		expect((await a.commit()).ok).toBe(true);
		await b.apply(await b.notices());
		const after = await agree([a, b]);
		expect(after).not.toBe(before);
		expect(hex(await c.member!.baseKey())).not.toBe(after);
		// An older list changes nothing.
		expect(await voice.seats(listOf(1, [0, 1, 2]))).toBe(false);
		const again = new Page(voice, 2);
		expect(await again.hello()).toMatchObject({ ok: false, error: 'not-seated' });
		// The list that empties the room takes out everyone.
		expect(await voice.seats(listOf(3, []))).toBe(true);
		expect([a.closed?.code, b.closed?.code]).toEqual([CLOSE.unseated, CLOSE.unseated]);
		await settle();
		expect(voice.counts).toEqual({ rooms: 0, people: 0 });
		expect(lines).toContain('refused a socket: not seated');
	});

	it('never lets two people hear each other once either has blocked the other', async () => {
		const voice = service();
		await voice.seats(listOf(clock * 1000, [0, 1, 2]));
		const [a, b, c] = [new Page(voice, 0), new Page(voice, 1), new Page(voice, 2)];
		const producers: string[] = [];
		const receivers: string[] = [];
		for (const page of [a, b, c]) {
			await page.hello();
			await page.joinGroup();
			const send = await page.ok('transport.create', { direction: 'send' });
			producers.push(
				(
					await page.ok('produce', {
						transport: send.transport,
						rtpParameters: OPUS(7000 + page.identity.seat) as never
					})
				).producer
			);
			receivers.push((await page.ok('transport.create', { direction: 'recv' })).transport);
		}
		const consume = (page: Page, index: number, from: number) =>
			page.ask('consume', {
				transport: receivers[index],
				producer: producers[from],
				rtpCapabilities: page.welcome!.routerRtpCapabilities
			});
		const heard = (await consume(b, 1, 0)) as unknown as { consumer: string };
		expect((await consume(c, 2, 0)).ok).toBe(true);
		b.pending();
		// b blocks a: b stops hearing a at once, and neither can hear the other again.
		expect(await voice.seats(listOf(clock * 1000 + 1, [0, 1, 2], [[1, 0]]))).toBe(true);
		expect(b.pending()).toContainEqual({ notice: 'consumer.closed', consumer: heard.consumer });
		expect(await consume(b, 1, 0)).toMatchObject({ ok: false, error: 'not-allowed' });
		expect(await consume(a, 0, 1)).toMatchObject({ ok: false, error: 'not-allowed' });
		// Everyone else hears both, and nobody left the room.
		expect((await consume(c, 2, 1)).ok).toBe(true);
		expect((await consume(a, 0, 2)).ok).toBe(true);
		expect([a, b, c].map((page) => page.closed)).toEqual([null, null, null]);
		for (const page of [a, b, c]) page.leave();
	});
});

describe('the table server and the voice service together (P4C.5)', () => {
	it('takes someone who stands up out of the room within a second, and the rest move on', async () => {
		const voice = new VoiceService({
			key: voiceKey(SECRET),
			media,
			log: (line) => lines.push(line),
			now: () => clock
		});
		let server: TestServer | null = null;
		const tableVoice = new Voice({
			secret: SECRET,
			link: { send: async (list) => void (await voice.seats(list)) },
			blocksOf: (playerId) => server!.site.safety.blocksInvolving(playerId),
			now: () => clock,
			log: quietLog()
		});
		server = await new TestServer({ tables: { voice: tableVoice } }).start();
		const players = [
			await Player.create(server),
			await Player.create(server),
			await Player.create(server)
		];
		const tableId = await players[0].newTable(3, null);
		for (const seat of [1, 2]) {
			const response = await players[seat].request('POST', `/api/tables/${tableId}/seat`, { seat });
			expect(response.status).toBe(200);
		}
		await server.settle();
		const pages: Page[] = [];
		for (const [seat, player] of players.entries()) {
			const response = await player.request('POST', `/api/tables/${tableId}/voice`);
			const { token } = (await response.json()) as { token: string };
			const page = new Page(voice, seat, { seat, player: publicRef(player.playerId) });
			expect((await page.hello(token, tableId)).ok).toBe(true);
			await page.joinGroup();
			for (const other of pages) await other.apply(other.pending());
			pages.push(page);
		}
		await settle();
		for (const page of pages) await page.apply(page.pending());
		const before = await agree(pages);
		// The third person stands up.
		const started = performance.now();
		await server.runner(tableId).leave(players[2].playerId);
		await server.settle();
		await tableVoice.settled();
		expect(pages[2].closed?.code).toBe(CLOSE.unseated);
		expect(performance.now() - started).toBeLessThan(1000);
		const [a, b] = pages;
		for (const page of [a, b]) await page.apply(await page.notices(2));
		expect((await a.commit()).ok).toBe(true);
		await b.apply(await b.notices());
		expect(await agree([a, b])).not.toBe(before);
		// A token for the seat they left is no use to them now.
		const late = await players[2].request('POST', `/api/tables/${tableId}/voice`);
		expect(late.status).toBe(403);
		for (const page of [a, b]) page.leave();
		await server.stop();
	});
});

describe('what the voice service logs', () => {
	it('says how many and how long, and never who or where', async () => {
		lines = [];
		const voice = service();
		const pages = [0, 3, 8].map((seat) => new Page(voice, seat));
		const tokens: string[] = [];
		for (const page of pages) {
			const token = page.token();
			tokens.push(token);
			await page.hello(token);
			await page.joinGroup();
			const send = await page.ok('transport.create', { direction: 'send' });
			await page.ok('produce', {
				transport: send.transport,
				rtpParameters: OPUS(5000 + page.identity.seat) as never
			});
		}
		const refused = new Page(voice, 5);
		const genuine = refused.token();
		const forged = genuine.slice(0, -1) + (genuine.endsWith('0') ? '1' : '0');
		tokens.push(forged);
		await refused.hello(forged);
		clock += 125;
		for (const page of pages) page.leave();
		await settle();

		const log = lines.join('\n');
		expect(lines).toContain('room 1 opened');
		expect(lines).toContain('room 1: someone joined (3 in voice)');
		expect(lines).toContain('room 1 closed after 125 s, at most 3 in voice');
		const secrets = [
			TABLE,
			...[0, 3, 5, 8].flatMap((seat) => [
				playerId(seat),
				publicRef(playerId(seat)),
				guestName(playerId(seat))
			]),
			...tokens,
			...tokens.map((token) => token.split('.')[5]),
			...pages.map((page) => page.welcome!.peer),
			'127.0.0.1',
			'::1'
		];
		for (const secret of secrets) expect(log).not.toContain(secret);
	});
});

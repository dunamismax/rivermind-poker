// The table server on PostgreSQL (P4B.5b): the session recorded from serve-nl
// replays with every store in the database, random play keeps every ledger
// balanced there (test/db/test_wallet.py), and a real serve-nl process and
// this server take over each other's tables in one database: the cutover
// (P4B.7) and its rollback, rehearsed on every run.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type * as p from '../../protocol-v2.ts';
import { createDatabase, createPool, type Database } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';
import { resetDatabase, testDatabaseUrl } from '../db/testing.ts';
import { replayRecord } from '../engine/history.ts';
import { SystemClock } from '../table/clock.ts';
import { TableStore } from '../table/store.ts';
import { COOKIE_NAME } from './auth.ts';
import { checkOutcome, randomPlay } from './random-play.testing.ts';
import { contractServer, Replay } from './table-contract.testing.ts';
import { Player, TestServer, type TableMessage } from './tables.testing.ts';

const url = testDatabaseUrl();
const REPO = resolve(import.meta.dirname, '../../../../..');
const hasUv = spawnSync('uv', ['--version']).status === 0;
if (!hasUv && process.env.CI) throw new Error('uv must be installed in CI: serve-nl is needed');

describe.skipIf(!url)('the table server on PostgreSQL', () => {
	const database = url as string;
	let pool: ReturnType<typeof createPool>;
	let db: Database;
	const servers: TestServer[] = [];
	const cleanup: (() => void | Promise<void>)[] = [];

	beforeAll(async () => {
		await resetDatabase(database);
		await migrate(database);
		pool = createPool(database, { max: 16 });
		db = createDatabase(pool);
	});

	afterAll(async () => {
		await pool?.end();
	});

	beforeEach(async () => {
		await db.execute(
			sql`TRUNCATE players, ledger_entries, player_reports, player_relations, safety_signals, poker_tables RESTART IDENTITY CASCADE`
		);
	});

	afterEach(async () => {
		while (servers.length) await servers.pop()!.stop();
		while (cleanup.length) await cleanup.pop()!();
	});

	/** Every ledger in the database, checked in one snapshot as test/db/test_wallet.py does. */
	async function checkEveryLedger(): Promise<void> {
		const found = await db.execute(sql`
			SELECT p.id, p.balance::text AS balance,
				coalesce((SELECT sum(amount) FROM ledger_entries e WHERE e.player_id = p.id), 0)::text AS total,
				coalesce((SELECT bool_and(ok) FROM (
					SELECT balance_after = sum(amount) OVER (ORDER BY id) AND balance_after >= 0 AS ok
					FROM ledger_entries e WHERE e.player_id = p.id) runs), true) AS running
			FROM players p`);
		expect(found.rows.length).toBeGreaterThan(0);
		for (const row of found.rows) {
			expect(row.total, String(row.id)).toBe(row.balance);
			expect(row.running, String(row.id)).toBe(true);
		}
	}

	it(
		'answers the session recorded from serve-nl with every store in the database',
		{
			timeout: 120_000
		},
		async () => {
			const options = {
				site: { db },
				store: new TableStore(db),
				// The database stamps ledger entries and finished hands with its own clock.
				// It also numbers a hand when it is dealt, not when it ends, so hand ids run ahead
				// of the recording's wherever a hand was under way; `before` pages by those ids.
				ignore: (path: string, body: string) =>
					path.includes('before=')
						? ''
						: body.replace(/"at":[0-9.e+]+/g, '"at":0').replace(/"hand_id":"\d+"/g, '"hand_id":"*"')
			};
			const server = await contractServer(options);
			servers.push(server);
			await new Replay(server, options).playAll();
			expect(server.tables.manager.tables.size).toBe(0);
			const open = await db.execute(sql`SELECT id FROM poker_tables WHERE status = 'open'`);
			expect(open.rows).toEqual([]);
			// Every hand of the session is stored with who played it, and replays to its result.
			const stored = await db.execute(sql`
			SELECT hh.record, (SELECT count(*) FROM hand_players hp WHERE hp.hand_id = h.id)::int AS seats
			FROM hands h JOIN hand_histories hh ON hh.hand_id = h.id`);
			expect(stored.rows.length).toBeGreaterThan(25);
			for (const row of stored.rows) {
				expect(replayRecord(row.record).result).not.toBeNull();
				expect(row.seats).toBeGreaterThanOrEqual(2);
			}
			const practice = await db.execute(
				sql`SELECT count(*)::int AS n FROM poker_tables WHERE practice`
			);
			expect(practice.rows[0].n).toBe(1);
			await checkEveryLedger();
		}
	);

	it('balances every ledger through random play', { timeout: 300_000 }, async () => {
		const server = await new TestServer({
			seed: 30,
			site: { db },
			store: new TableStore(db),
			tables: { maxTables: 50, idleSeconds: 1e9 }
		}).start();
		servers.push(server);
		checkOutcome(await randomPlay(server, 3, 300, checkEveryLedger));
		const open = await db.execute(sql`SELECT id FROM poker_tables WHERE status = 'open'`);
		expect(open.rows).toEqual([]);
	});

	// A real serve-nl process on the same database and secret.

	async function freePort(): Promise<number> {
		return new Promise((done, fail) => {
			const probe = createServer();
			probe.once('error', fail);
			probe.listen(0, '127.0.0.1', () => {
				const { port } = probe.address() as { port: number };
				probe.close(() => done(port));
			});
		});
	}

	class ServeNl {
		readonly base: string;
		private readonly process: ChildProcess;
		private output = '';

		constructor(port: number, secretFile: string) {
			this.base = `http://127.0.0.1:${port}`;
			const args = ['run', '--locked', 'rivermind-poker', 'serve-nl', '--port', String(port)];
			args.push('--secret_file', secretFile, '--hand_pause', '0', '--bot_delay', '0');
			const env = { ...process.env, DATABASE_URL: database, PYTHONUNBUFFERED: '1' };
			delete (env as Record<string, unknown>).RIVERMIND_SECRET;
			// In its own group, so a kill reaches the Python process under `uv run` as well.
			this.process = spawn('uv', args, {
				cwd: REPO,
				env,
				stdio: ['ignore', 'pipe', 'pipe'],
				detached: true
			});
			this.process.stdout?.on('data', (chunk) => (this.output += chunk));
			this.process.stderr?.on('data', (chunk) => (this.output += chunk));
		}

		async ready(): Promise<this> {
			for (let i = 0; i < 600; i++) {
				if (this.process.exitCode !== null) break;
				try {
					if ((await fetch(`${this.base}/api/config`)).ok) return this;
				} catch {
					// not listening yet
				}
				await new Promise((r) => setTimeout(r, 100));
			}
			throw new Error(`serve-nl did not start:\n${this.output}`);
		}

		/** No shutdown and no last save, as a crash or `kill -9`. */
		async kill(): Promise<void> {
			const { exitCode, signalCode, pid } = this.process;
			if (exitCode !== null || signalCode !== null || pid === undefined) return;
			const exited = new Promise((r) => this.process.once('exit', r));
			process.kill(-pid, 'SIGKILL');
			await exited;
			// The port is free again once nothing answers on it.
			for (let i = 0; i < 100; i++) {
				try {
					await fetch(`${this.base}/api/config`);
				} catch {
					return;
				}
				await new Promise((r) => setTimeout(r, 50));
			}
			throw new Error('serve-nl is still answering after being killed');
		}
	}

	/** A browser's socket to a real server: plays check, call up to ten big blinds, or fold. */
	class LiveSocket {
		readonly messages: TableMessage[] = [];
		private answered = 0;
		private waiting: (() => void) | null = null;
		private readonly ws: WebSocket;

		constructor(
			base: string,
			cookie: string,
			private readonly tableId: string
		) {
			this.ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { cookie } });
			this.ws.on('message', (data) => {
				const message = JSON.parse(String(data)) as TableMessage;
				if (message.type === 'table') this.messages.push(message);
				this.waiting?.();
			});
			this.ws.on('error', () => this.waiting?.());
			this.ws.on('open', () => {
				this.ws.send(JSON.stringify({ type: 'hello', protocol: 2 }));
				this.ws.send(JSON.stringify({ type: 'join_table', table_id: tableId }));
			});
		}

		get latest(): TableMessage | undefined {
			return this.messages[this.messages.length - 1];
		}

		/** The first view, already received or still to come, that matches. */
		async view(matches: (view: p.TableView) => boolean): Promise<p.TableView> {
			const deadline = Date.now() + 30_000;
			for (;;) {
				const found = this.messages.find((m) => matches(m.view));
				if (found) return found.view;
				if (Date.now() > deadline) throw new Error('the view never came');
				await new Promise<void>((resolve) => {
					this.waiting = resolve;
					setTimeout(resolve, 200);
				});
			}
		}

		/** The view of the next turn not yet acted on. */
		async myTurn(): Promise<p.TableView> {
			const deadline = Date.now() + 30_000;
			for (;;) {
				const view = this.latest?.view;
				if (view?.you.legal && (view.turn?.seq ?? 0) > this.answered) return view;
				if (Date.now() > deadline) throw new Error('the turn never came');
				await new Promise<void>((resolve) => {
					this.waiting = resolve;
					setTimeout(resolve, 200);
				});
			}
		}

		act(view: p.TableView): void {
			this.answered = view.turn?.seq ?? 0;
			const legal = view.you.legal as p.Legal;
			const action = legal.can_check ? 'check' : legal.call <= 1_000 ? 'call' : 'fold';
			this.ws.send(JSON.stringify({ type: 'act', table_id: this.tableId, seq: view.seq, action }));
		}

		send(message: Record<string, unknown>): void {
			this.ws.send(JSON.stringify(message));
		}

		close(): void {
			this.ws.terminate();
		}
	}

	it.skipIf(!hasUv)(
		'takes over a table serve-nl was killed on mid-hand, and hands it back',
		{ timeout: 180_000 },
		async () => {
			const scratch = mkdtempSync(join(tmpdir(), 'rivermind-handover-'));
			cleanup.push(() => rmSync(scratch, { recursive: true, force: true }));
			const secretFile = join(scratch, 'secret');
			const port = await freePort();

			// serve-nl: a guest, a table with bots, a few hands, then a kill mid-hand.
			const python = await new ServeNl(port, secretFile).ready();
			cleanup.push(() => python.kill());
			const visit = await fetch(`${python.base}/api/session`, { method: 'POST' });
			const cookie = (visit.headers.get('set-cookie') ?? '').split(';')[0];
			expect(cookie.startsWith(`${COOKIE_NAME}=`)).toBe(true);
			const me = (await visit.json()) as p.SessionResponse;
			const made = await fetch(`${python.base}/api/tables`, {
				method: 'POST',
				headers: { cookie, 'content-type': 'application/json' },
				body: JSON.stringify({ seats: 3, bots: 'calling_station', buy_in: 6_000 })
			});
			expect(made.status).toBe(201);
			const tableId = ((await made.json()) as p.NewTableResponse).table_id;
			let live = new LiveSocket(python.base, cookie, tableId);
			for (let i = 0; i < 7; i++) live.act(await live.myTurn());
			const before = await live.myTurn(); // mid-hand, waiting for us
			const handNo = before.hand!.hand_no;
			expect(before.hand!.result).toBeNull();
			await python.kill(); // no shutdown, no last save
			live.close();
			const saved = await db.execute(sql`SELECT state FROM poker_tables WHERE id = ${tableId}`);
			expect((saved.rows[0].state as { seq: number }).seq).toBe(before.seq);

			// The TypeScript server on the same database and secret: the cutover.
			const secret = Buffer.from(readFileSync(secretFile, 'utf8').trim(), 'utf8');
			// On the wall clock, as serve-nl is: turn deadlines mean the same moment in both.
			const node = await new TestServer({
				seed: 77,
				site: { db, secret },
				store: new TableStore(db),
				runner: { clock: new SystemClock() }
			}).start();
			servers.push(node);
			const runner = node.runner(tableId);
			expect(runner.fill).toBe('calling_station');
			const guest = Player.from(node, {
				playerId: me.player_id,
				name: me.name,
				session: cookie.slice(COOKIE_NAME.length + 1)
			} as Player);
			// The guest's cookie, balance and name carried over.
			const session = await guest.json<p.SessionResponse>('POST', '/api/session');
			expect(session).toMatchObject({ player_id: me.player_id, name: me.name, created: false });
			expect(session.balance).toBe(20_000 - 6_000);
			const socket = await guest.socket();
			const again = (await socket.join(tableId)).view;
			// The same hand, the same cards, the same choices.
			expect(again.hand).toEqual(before.hand);
			expect(again.settings).toEqual(before.settings);
			const connected = (seats: (p.SeatInfo | null)[]) =>
				seats.map((s) => s && { ...s, connected: true });
			expect(connected(again.seats)).toEqual(connected(before.seats));
			expect(again.you.legal).toEqual(before.you.legal);
			await socket.playUntil(tableId, (m) => (m.view.hand?.hand_no ?? 0) >= handNo + 3);
			// The guest sits out, so the table goes quiet between hands: nothing is on a clock
			// while one server stops and the other starts.
			socket.send({ type: 'sit_out', table_id: tableId });
			const quiet = await socket.playUntil(
				tableId,
				(m) => m.view.you.sitting_out && m.view.hand?.result !== null
			);
			await node.settle();
			const last = node.runner(tableId).table;
			expect(last.handInProgress).toBe(false);
			// "Your hands" lists the hands serve-nl stored and the ones finished here, all replayable.
			const listed = await guest.json<p.HandListResponse>('GET', '/api/hands?limit=50');
			expect(listed.hands.map((h) => h.hand_no)).toEqual(
				Array.from({ length: last.handNo }, (_, i) => last.handNo - i)
			);
			for (const hand of listed.hands) {
				const detail = await guest.json<p.HandDetail>('GET', `/api/hands/${hand.hand_id}`);
				expect(detail.text).toContain(me.name);
			}
			socket.close();
			await node.settle();
			expect(node.log.lines.filter((line) => !line.startsWith('info:'))).toEqual([]);
			await node.stop();
			servers.length = 0;

			// serve-nl again on the tables this server saved: the rollback.
			const back = await new ServeNl(port, secretFile).ready();
			cleanup.push(() => back.kill());
			live = new LiveSocket(back.base, cookie, tableId);
			const restored = await live.view((view) => view.you.seat === 0);
			expect(restored.hand!.hand_no).toBe(last.handNo);
			expect(restored.hand!.result).toEqual(quiet.view.hand!.result);
			expect(restored.you.sitting_out).toBe(true);
			expect(restored.seats.map((s) => s && [s.name, s.stack])).toEqual(
				quiet.view.seats.map((s) => s && [s.name, s.stack])
			);
			live.send({ type: 'sit_in', table_id: tableId });
			for (let i = 0; i < 5; i++) live.act(await live.myTurn());
			live.send({ type: 'leave_table', table_id: tableId });
			// The bots finish the hand, the seat frees and the table closes.
			for (let i = 0; i < 300; i++) {
				const open = await db.execute(
					sql`SELECT 1 FROM poker_tables WHERE id = ${tableId} AND status = 'open'`
				);
				if (!open.rows.length) break;
				await new Promise((r) => setTimeout(r, 100));
			}
			live.close();
			const wallet = (await (
				await fetch(`${back.base}/api/wallet`, { headers: { cookie } })
			).json()) as p.WalletResponse;
			expect(wallet.entries[0].kind).toBe('cash_out');
			expect(wallet.entries.reduce((total, e) => total + e.amount, 0)).toBe(wallet.balance);
			await back.kill();
			await checkEveryLedger();
		}
	);
});

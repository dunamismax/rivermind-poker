<script lang="ts">
	import type { ConfigResponse, TableSummary } from '../protocol-v2.ts';
	import { listTables } from './api.ts';
	import type { NlConnection } from './connection.svelte.ts';

	// The live table list (P4.3): public tables, and private ones the player
	// is at, most people first, refreshed every few seconds. Quick seat uses
	// the same filters.
	let {
		connection,
		config,
		balance = null
	}: {
		connection: NlConnection;
		config: ConfigResponse | null;
		balance?: number | null;
	} = $props();

	const REFRESH_MS = 3000;
	let seats = $state<number | null>(null);
	let bigBlind = $state<number | null>(null);
	let openOnly = $state(false);
	let tables = $state<TableSummary[] | null>(null);
	let busy = $state<string | null>(null);
	let error = $state('');

	async function refresh(): Promise<void> {
		const filters = { seats, big_blind: bigBlind, open: openOnly };
		try {
			const listed = await listTables(filters);
			// Ignore an answer to filters that have changed since.
			if (filters.seats === seats && filters.big_blind === bigBlind && filters.open === openOnly) {
				tables = listed;
			}
		} catch (e) {
			error = `Could not load the tables: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	$effect(() => {
		void [seats, bigBlind, openOnly];
		void refresh();
		const timer = setInterval(() => void refresh(), REFRESH_MS);
		return () => clearInterval(timer);
	});

	async function run(key: string, task: () => Promise<unknown>): Promise<void> {
		busy = key;
		error = '';
		try {
			await task();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = null;
			void refresh();
		}
	}

	const canAfford = (t: TableSummary) => balance === null || balance >= t.min_buy_in;
	const hasRoom = (t: TableSummary) => t.free_seats + t.bot_seats > 0;

	/** One pip per seat: people, bots (a bot finishing its hand for a held seat included), held empty seats, empty seats. */
	function pips(t: TableSummary): string[] {
		const held = Math.max(0, t.seat_count - t.people - t.bots - t.free_seats);
		return [
			...Array<string>(t.people).fill('person'),
			...Array<string>(t.bots).fill('bot'),
			...Array<string>(held).fill('held'),
			...Array<string>(t.free_seats).fill('empty')
		];
	}

	function seatsText(t: TableSummary): string {
		const parts = [`${t.people} ${t.people === 1 ? 'person' : 'people'}`];
		if (t.bots) parts.push(`${t.bots} ${t.bots === 1 ? 'bot' : 'bots'}`);
		if (t.free_seats) parts.push(`${t.free_seats} empty`);
		if (t.waitlist) parts.push(`${t.waitlist} waiting`);
		return parts.join(' · ');
	}
</script>

<section class="tables px-panel" aria-labelledby="tables-title">
	<div class="head">
		<h2 id="tables-title">Tables</h2>
		<button
			type="button"
			class="px-btn amber quick"
			disabled={busy !== null}
			onclick={() =>
				run('quick', () => connection.quickSeat({ seats, big_blind: bigBlind, buy_in: null }))}
		>
			{busy === 'quick' ? 'Finding a seat…' : 'Quick seat'}
		</button>
	</div>
	<p class="hint">
		Quick seat joins the busiest table that fits your filters, or starts one with bots. Bots give up
		their seats to people.
	</p>

	<div class="filters" role="group" aria-label="Filters">
		<label>
			<span class="field-label">Seats</span>
			<select class="px-field" bind:value={seats}>
				<option value={null}>Any</option>
				{#each config?.seat_counts ?? [] as count (count)}
					<option value={count}>{count}</option>
				{/each}
			</select>
		</label>
		<label>
			<span class="field-label">Blinds</span>
			<select class="px-field" bind:value={bigBlind}>
				<option value={null}>Any</option>
				{#each config?.stakes ?? [] as stakes (stakes.big_blind)}
					<option value={stakes.big_blind}>{stakes.small_blind}/{stakes.big_blind}</option>
				{/each}
			</select>
		</label>
		<label class="check">
			<input type="checkbox" bind:checked={openOnly} />
			<span>Has a seat</span>
		</label>
	</div>

	{#if tables === null}
		<p class="empty-list" role="status">Looking for tables…</p>
	{:else if tables.length === 0}
		<p class="empty-list" role="status">
			No tables match. Quick seat starts one, or set up your own below.
		</p>
	{:else}
		<ul class="list" aria-label="Open tables">
			{#each tables as t (t.table_id)}
				<li class="row px-inset" data-table={t.table_id}>
					<div class="info">
						<span class="name">
							{t.name}{#if t.private}<span class="tag">Private</span>{/if}
						</span>
						<span class="detail">
							Blinds {t.small_blind}/{t.big_blind} · buy-in {t.min_buy_in.toLocaleString('en-US')} to
							{t.max_buy_in.toLocaleString('en-US')}
						</span>
						<span class="seats">
							<span class="pips" aria-hidden="true">
								{#each pips(t) as pip, i (i)}<span class="pip {pip}"></span>{/each}
							</span>
							<span>{seatsText(t)}</span>
						</span>
					</div>
					<div class="actions">
						{#if t.seated}
							<button
								type="button"
								class="px-btn small green"
								onclick={() => connection.watch(t.table_id)}
							>
								Back to your seat
							</button>
						{:else if t.hold?.ready}
							<span class="state">Your seat is ready</span>
							<button
								type="button"
								class="px-btn small amber"
								disabled={busy !== null}
								onclick={() => run(t.table_id, () => connection.takeSeat(t.table_id))}
							>
								Sit down
							</button>
							<button
								type="button"
								class="px-btn small"
								disabled={busy !== null}
								onclick={() => run(t.table_id, () => connection.giveUpHold(t.table_id))}
							>
								Give up
							</button>
						{:else if t.hold}
							<span class="state">Seat held: a bot is finishing its hand</span>
							<button
								type="button"
								class="px-btn small"
								onclick={() => run(t.table_id, () => connection.takeSeat(t.table_id))}
							>
								Go to the table
							</button>
						{:else if t.waitlist_position !== null}
							<span class="state">Number {t.waitlist_position} in line</span>
							<button
								type="button"
								class="px-btn small"
								disabled={busy !== null}
								onclick={() => run(t.table_id, () => connection.leaveWaitlist(t.table_id))}
							>
								Leave the line
							</button>
						{:else}
							{#if hasRoom(t)}
								<button
									type="button"
									class="px-btn small amber"
									disabled={busy !== null || !canAfford(t)}
									onclick={() => run(t.table_id, () => connection.takeSeat(t.table_id))}
								>
									{busy === t.table_id ? 'Seating…' : 'Sit down'}
								</button>
							{:else}
								<button
									type="button"
									class="px-btn small amber"
									disabled={busy !== null || !canAfford(t)}
									onclick={() => run(t.table_id, () => connection.joinWaitlist(t.table_id))}
								>
									Join the waitlist
								</button>
							{/if}
							<button
								type="button"
								class="px-btn small"
								onclick={() => connection.watch(t.table_id)}
							>
								Watch
							</button>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
	.tables {
		padding: 12px 14px 14px;
		display: grid;
		gap: 12px;
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}
	h2 {
		font-size: var(--fs-l);
		color: var(--gold);
		text-shadow: var(--shadow-text);
	}
	.quick {
		min-height: 48px;
		padding-inline: 18px;
	}
	.hint,
	.empty-list {
		color: var(--mist);
		font-size: var(--fs-s);
	}
	.filters {
		display: grid;
		grid-template-columns: 1fr 1fr auto;
		gap: 12px;
		align-items: end;
	}
	.filters select {
		width: 100%;
	}
	.field-label {
		display: block;
		margin-bottom: 6px;
		color: var(--gold);
		text-shadow: var(--shadow-text);
	}
	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		color: var(--paper-shade);
		cursor: pointer;
	}
	.check input {
		width: 20px;
		height: 20px;
		accent-color: var(--gold);
	}
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 8px;
		max-height: 520px;
		overflow: auto;
	}
	.row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 10px;
		align-items: center;
		padding: 8px 10px;
	}
	.info {
		display: grid;
		gap: 4px;
		min-width: 0;
	}
	.name {
		color: var(--paper);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tag {
		margin-left: 8px;
		padding: 0 6px;
		color: var(--ink);
		background: var(--gold);
		font-size: var(--fs-s);
	}
	.detail,
	.seats {
		color: var(--mist);
		font-size: var(--fs-s);
	}
	.seats {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 8px;
	}
	.pips {
		display: flex;
		gap: 2px;
	}
	.pip {
		width: 10px;
		height: 10px;
		box-shadow: inset 0 0 0 var(--px) var(--ink);
	}
	.pip.person {
		background: var(--gold);
	}
	.pip.bot {
		background: var(--blue-light);
	}
	.pip.held {
		background: var(--amber);
		opacity: 0.6;
	}
	.pip.empty {
		background: transparent;
		box-shadow: inset 0 0 0 var(--px) var(--haze);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		align-items: center;
		gap: 6px;
	}
	.state {
		color: var(--green-light);
		font-size: var(--fs-s);
		text-shadow: var(--shadow-text);
	}
	.error {
		color: var(--danger);
	}

	@media (max-width: 459px) {
		.filters {
			grid-template-columns: 1fr 1fr;
		}
		.check {
			grid-column: 1 / -1;
		}
		.row {
			grid-template-columns: minmax(0, 1fr);
		}
		.actions {
			justify-content: flex-start;
		}
		.quick {
			padding-inline: 10px;
		}
	}
</style>

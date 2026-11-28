<script lang="ts">
	import type { ConfigResponse, TableSummary } from '../protocol-v2.ts';
	import { listTables } from './api.ts';
	import type { NlConnection } from './connection.svelte.ts';
	import { pips, seatsText, tableChoice, tableDetail, type Pip } from './lobby.ts';

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

	const fieldLabel = 'field-label mb-3 block text-gold text-shadow-ink';
	const seatState = 'state text-s text-green-light text-shadow-ink';
	/** A pip's colour by who has the seat; each is a dot. */
	const PIPS: Record<Pip, string> = {
		person: 'person bg-gold',
		bot: 'bot bg-blue-light',
		held: 'held bg-amber opacity-60',
		empty: 'empty bg-transparent [box-shadow:inset_0_0_0_2px_var(--color-haze)]'
	};
</script>

<section class="tables ui-panel grid gap-6 px-7 pt-6 pb-7" aria-labelledby="tables-title">
	<div class="head flex items-center justify-between gap-6">
		<h2 id="tables-title" class="text-l text-gold text-shadow-ink">Tables</h2>
		<button
			type="button"
			class="ui-btn amber quick min-h-24 px-9 lt-460:px-5"
			disabled={busy !== null}
			onclick={() =>
				run('quick', () => connection.quickSeat({ seats, big_blind: bigBlind, buy_in: null }))}
		>
			{busy === 'quick' ? 'Finding a seat…' : 'Quick seat'}
		</button>
	</div>
	<p class="hint text-s text-mist">
		Quick seat joins the busiest table that fits your filters, or starts one with bots. Bots give up
		their seats to people.
	</p>

	<div
		class="filters grid grid-cols-[1fr_1fr_auto] items-end gap-6 lt-460:grid-cols-[1fr_1fr]"
		role="group"
		aria-label="Filters"
	>
		<label>
			<span class={fieldLabel}>Seats</span>
			<select class="ui-field w-full" bind:value={seats}>
				<option value={null}>Any</option>
				{#each config?.seat_counts ?? [] as count (count)}
					<option value={count}>{count}</option>
				{/each}
			</select>
		</label>
		<label>
			<span class={fieldLabel}>Blinds</span>
			<select class="ui-field w-full" bind:value={bigBlind}>
				<option value={null}>Any</option>
				{#each config?.stakes ?? [] as stakes (stakes.big_blind)}
					<option value={stakes.big_blind}>{stakes.small_blind}/{stakes.big_blind}</option>
				{/each}
			</select>
		</label>
		<label
			class="check flex min-h-20 cursor-pointer items-center gap-4 text-paper-shade lt-460:col-span-full"
		>
			<input type="checkbox" class="size-10 accent-gold" bind:checked={openOnly} />
			<span>Has a seat</span>
		</label>
	</div>

	{#if tables === null}
		<p class="empty-list text-s text-mist" role="status">Looking for tables…</p>
	{:else if tables.length === 0}
		<p class="empty-list text-s text-mist" role="status">
			No tables match. Quick seat starts one, or set up your own below.
		</p>
	{:else}
		<ul class="list grid max-h-[520px] gap-4 overflow-auto" aria-label="Open tables">
			{#each tables as t (t.table_id)}
				{@const choice = tableChoice(t, balance)}
				<li
					class="row ui-inset grid grid-cols-[minmax(0,1fr)_auto] items-center gap-5 px-5 py-4 lt-460:grid-cols-1"
					data-table={t.table_id}
				>
					<div class="info grid min-w-0 gap-2">
						<span class="name truncate text-paper">
							{t.name}{#if t.private}<span class="tag ml-4 bg-gold px-3 text-s text-ink">
									Private
								</span>{/if}{#if t.blocked}<span
									class="tag blocked ml-4 bg-red-dark px-3 text-s text-white"
									title="Someone you blocked, or who blocked you, sits here"
								>
									Blocked player
								</span>{/if}
						</span>
						<span class="detail text-s text-mist">{tableDetail(t)}</span>
						<span class="seats flex flex-wrap items-center gap-4 text-s text-mist">
							<span class="pips flex gap-1" aria-hidden="true">
								{#each pips(t) as pip, i (i)}<span class="pip size-5 rounded-full {PIPS[pip]}"
									></span>{/each}
							</span>
							<span>{seatsText(t)}</span>
						</span>
					</div>
					<div class="actions flex flex-wrap items-center justify-end gap-3 lt-460:justify-start">
						{#if choice.kind === 'seated'}
							<button
								type="button"
								class="ui-btn small green"
								onclick={() => connection.watch(t.table_id)}
							>
								Back to your seat
							</button>
						{:else if choice.kind === 'ready'}
							<span class={seatState}>{choice.note}</span>
							<button
								type="button"
								class="ui-btn small amber"
								disabled={busy !== null}
								onclick={() => run(t.table_id, () => connection.takeSeat(t.table_id))}
							>
								Sit down
							</button>
							<button
								type="button"
								class="ui-btn small"
								disabled={busy !== null}
								onclick={() => run(t.table_id, () => connection.giveUpHold(t.table_id))}
							>
								Give up
							</button>
						{:else if choice.kind === 'held'}
							<span class={seatState}>{choice.note}</span>
							<button
								type="button"
								class="ui-btn small"
								onclick={() => run(t.table_id, () => connection.takeSeat(t.table_id))}
							>
								Go to the table
							</button>
						{:else if choice.kind === 'waiting'}
							<span class={seatState}>{choice.note}</span>
							<button
								type="button"
								class="ui-btn small"
								disabled={busy !== null}
								onclick={() => run(t.table_id, () => connection.leaveWaitlist(t.table_id))}
							>
								Leave the line
							</button>
						{:else}
							{#if choice.kind === 'sit'}
								<button
									type="button"
									class="ui-btn small amber"
									disabled={busy !== null || !choice.afford}
									onclick={() => run(t.table_id, () => connection.takeSeat(t.table_id))}
								>
									{busy === t.table_id ? 'Seating…' : 'Sit down'}
								</button>
							{:else}
								<button
									type="button"
									class="ui-btn small amber"
									disabled={busy !== null || (choice.kind === 'waitlist' && !choice.afford)}
									onclick={() => run(t.table_id, () => connection.joinWaitlist(t.table_id))}
								>
									Join the waitlist
								</button>
							{/if}
							<button
								type="button"
								class="ui-btn small"
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
	{#if error}<p class="error text-red-light" role="alert">{error}</p>{/if}
</section>

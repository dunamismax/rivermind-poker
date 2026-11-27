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

	const fieldLabel = 'field-label mb-3 block text-gold text-shadow-ink';
	const seatState = 'state text-s text-green-light text-shadow-ink';
	/** A pip's colour by who has the seat; each is a square with an inset edge, or in the clean look a dot. */
	const PIPS = {
		person: 'person bg-gold [box-shadow:inset_0_0_0_2px_var(--color-ink)] clean:[box-shadow:none]',
		bot: 'bot bg-blue-light [box-shadow:inset_0_0_0_2px_var(--color-ink)] clean:[box-shadow:none]',
		held: 'held bg-amber opacity-60 [box-shadow:inset_0_0_0_2px_var(--color-ink)] clean:[box-shadow:none]',
		empty: 'empty bg-transparent [box-shadow:inset_0_0_0_2px_var(--color-haze)]'
	};

	/** One pip per seat: people, bots (a bot finishing its hand for a held seat included), held empty seats, empty seats. */
	function pips(t: TableSummary): (keyof typeof PIPS)[] {
		const held = Math.max(0, t.seat_count - t.people - t.bots - t.free_seats);
		return [
			...Array<'person'>(t.people).fill('person'),
			...Array<'bot'>(t.bots).fill('bot'),
			...Array<'held'>(held).fill('held'),
			...Array<'empty'>(t.free_seats).fill('empty')
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

<section class="tables px-panel grid gap-6 px-7 pt-6 pb-7" aria-labelledby="tables-title">
	<div class="head flex items-center justify-between gap-6">
		<h2 id="tables-title" class="text-l text-gold text-shadow-ink">Tables</h2>
		<button
			type="button"
			class="px-btn amber quick min-h-24 px-9 lt-460:px-5"
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
			<select class="px-field w-full" bind:value={seats}>
				<option value={null}>Any</option>
				{#each config?.seat_counts ?? [] as count (count)}
					<option value={count}>{count}</option>
				{/each}
			</select>
		</label>
		<label>
			<span class={fieldLabel}>Blinds</span>
			<select class="px-field w-full" bind:value={bigBlind}>
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
				<li
					class="row px-inset grid grid-cols-[minmax(0,1fr)_auto] items-center gap-5 px-5 py-4 lt-460:grid-cols-1"
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
						<span class="detail text-s text-mist">
							Blinds {t.small_blind}/{t.big_blind} · buy-in {t.min_buy_in.toLocaleString('en-US')} to
							{t.max_buy_in.toLocaleString('en-US')}
						</span>
						<span class="seats flex flex-wrap items-center gap-4 text-s text-mist">
							<span class="pips flex gap-1" aria-hidden="true">
								{#each pips(t) as pip, i (i)}<span class="pip size-5 clean:rounded-full {PIPS[pip]}"
									></span>{/each}
							</span>
							<span>{seatsText(t)}</span>
						</span>
					</div>
					<div class="actions flex flex-wrap items-center justify-end gap-3 lt-460:justify-start">
						{#if t.seated}
							<button
								type="button"
								class="px-btn small green"
								onclick={() => connection.watch(t.table_id)}
							>
								Back to your seat
							</button>
						{:else if t.hold?.ready}
							<span class={seatState}>Your seat is ready</span>
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
							<span class={seatState}>Seat held: a bot is finishing its hand</span>
							<button
								type="button"
								class="px-btn small"
								onclick={() => run(t.table_id, () => connection.takeSeat(t.table_id))}
							>
								Go to the table
							</button>
						{:else if t.waitlist_position !== null}
							<span class={seatState}>Number {t.waitlist_position} in line</span>
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
	{#if error}<p class="error text-red-light" role="alert">{error}</p>{/if}
</section>

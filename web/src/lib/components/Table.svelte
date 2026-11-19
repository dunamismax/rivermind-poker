<script lang="ts">
	import type { TableConnection } from '../table-connection.svelte.ts';
	import type { SeatView } from '../protocol.ts';
	import { STAGE_NAMES, lastActions, payoutOf } from '../wording.ts';
	import ActionBar from './ActionBar.svelte';
	import Board from './Board.svelte';
	import HandLog from './HandLog.svelte';
	import ResultBanner from './ResultBanner.svelte';
	import Seat from './Seat.svelte';

	let {
		view,
		connection,
		onleave
	}: { view: SeatView; connection: TableConnection; onleave: () => void } = $props();

	const last = $derived(lastActions(view));
	const hero = $derived(view.seats.find((s) => s.seat === view.seat));
	const opponents = $derived(view.seats.filter((s) => s.seat !== view.seat));
</script>

<section class="table" aria-label="Table">
	<div class="opponents-row">
		{#each opponents as seat (seat.seat)}
			<Seat {seat} hand={view.hand} last={last.get(seat.seat)} payout={payoutOf(view, seat.seat)} />
		{/each}
	</div>

	<div class="felt">
		<div class="stage">{STAGE_NAMES[view.stage]}</div>
		<Board cards={view.board} />
		<div class="pot">Pot {view.pot}</div>
		<ResultBanner {view} />
	</div>

	{#if hero}
		<Seat
			seat={hero}
			hand={view.hand}
			last={last.get(hero.seat)}
			payout={payoutOf(view, hero.seat)}
			hero
		/>
	{/if}

	<ActionBar
		{view}
		connected={connection.connected}
		pending={connection.pending}
		onact={(action) => connection.act(action)}
		onnext={() => connection.nextHand()}
	/>

	<HandLog {view} />

	<button class="link" type="button" onclick={onleave}>Leave table</button>
</section>

<style>
	.table {
		display: grid;
		gap: 12px;
	}
	.opponents-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
	.felt {
		background: radial-gradient(ellipse at center, var(--felt) 0%, var(--felt-edge) 100%);
		border-radius: 80px;
		padding: 18px 16px;
		display: grid;
		gap: 10px;
		justify-items: center;
		border: 6px solid #3b2a1a;
	}
	.stage {
		color: var(--muted);
		font-size: 0.85rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.pot {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.link {
		background: none;
		border: 0;
		color: var(--muted);
		text-decoration: underline;
		padding: 8px 0;
		justify-self: start;
	}
	@media (max-width: 420px) {
		.felt {
			border-radius: 40px;
			padding: 14px 10px;
		}
	}
</style>

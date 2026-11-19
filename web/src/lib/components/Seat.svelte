<script lang="ts">
	import type { SeatState, TableEvent } from '../protocol.ts';
	import { POSITION_BADGES, capitalize, describe, signed } from '../wording.ts';
	import PlayingCard from './PlayingCard.svelte';

	let {
		seat,
		hand,
		last,
		payout,
		hero = false
	}: {
		seat: SeatState;
		hand: number;
		/** The seat's latest action on this street, with its index in the hand. */
		last: { event: TableEvent; index: number } | undefined;
		/** Net chips for the finished hand, or null while it is played. */
		payout: number | null;
		hero?: boolean;
	} = $props();

	const cards = $derived(seat.cards ?? [null, null]);
	const lastKey = $derived(last ? `${hand}:${last.index}` : null);

	// Briefly highlight a bot's new action so it is noticed.
	let flashKey = $state<string | null>(null);
	let previousKey: string | null = null;
	$effect.pre(() => {
		const key = lastKey;
		if (key && previousKey && key !== previousKey && seat.kind === 'bot') flashKey = key;
		if (key) previousKey = key;
	});
</script>

<section
	class="seat"
	class:hero
	class:turn={seat.is_turn}
	class:folded={seat.folded}
	class:winner={(payout ?? 0) > 0}
	data-seat={seat.seat}
	aria-label={hero ? 'Your seat' : seat.name}
>
	<div class="head">
		<span class="name">{seat.name}</span>
		{#if seat.kind === 'bot'}<span class="bot-label">Bot</span>{/if}
		<span class="badge {seat.position}" title={seat.position.replace('_', ' ')}>
			{POSITION_BADGES[seat.position]}
		</span>
	</div>
	<div class="cards">
		{#each cards as card, i (i)}
			<PlayingCard {card} large={hero} />
		{/each}
	</div>
	<div class="chips">
		<span>Stack {seat.stack}</span>
		<span class="bet">{seat.bet ? `In ${seat.bet}` : ''}</span>
	</div>
	{#if payout !== null}
		<div class="last payout" class:up={payout > 0} class:down={payout < 0}>{signed(payout)}</div>
	{:else if seat.folded}
		<div class="last">Folded</div>
	{:else if last}
		{#key lastKey}
			<div class="last" class:flash={flashKey === lastKey}>{capitalize(describe(last.event))}</div>
		{/key}
	{:else}
		<div class="last"></div>
	{/if}
</section>

<style>
	.seat {
		background: var(--panel);
		border: 2px solid transparent;
		border-radius: var(--radius);
		padding: 10px 12px;
		display: grid;
		gap: 6px;
		min-width: 0;
		transition:
			border-color 0.2s,
			opacity 0.2s;
	}
	.turn {
		border-color: var(--accent);
	}
	.folded {
		opacity: 0.45;
	}
	.winner {
		border-color: var(--win);
	}
	.head {
		display: flex;
		gap: 8px;
		align-items: baseline;
	}
	.name {
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1 1 auto;
		min-width: 0;
	}
	.bot-label {
		font-size: 0.7rem;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.badge {
		font-size: 0.72rem;
		padding: 1px 7px;
		border-radius: 999px;
		background: var(--panel-2);
		color: var(--muted);
		white-space: nowrap;
	}
	.badge.button {
		background: var(--text);
		color: var(--bg);
	}
	.cards {
		display: flex;
		gap: 6px;
		min-height: 58px;
	}
	.chips {
		display: flex;
		justify-content: space-between;
		color: var(--muted);
		font-size: 0.88rem;
		font-variant-numeric: tabular-nums;
	}
	.bet {
		color: var(--accent);
	}
	.last {
		font-size: 0.85rem;
		color: var(--accent);
		min-height: 1.2em;
	}
	.flash {
		animation: flash 0.9s ease-out;
	}
	.payout {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--text);
	}
	.payout.up {
		color: var(--win);
	}
	.payout.down {
		color: var(--danger);
	}
	@keyframes flash {
		from {
			background: rgb(242 193 78 / 0.25);
		}
		to {
			background: transparent;
		}
	}
	@media (max-width: 420px) {
		.seat {
			padding: 8px 10px;
		}
		.cards {
			min-height: 48px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.seat {
			transition: none;
		}
		.flash {
			animation: none;
		}
	}
</style>

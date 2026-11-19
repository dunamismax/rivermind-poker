<script lang="ts">
	import PlayingCard from '../components/PlayingCard.svelte';
	import type { SeatInfo, Turn } from '../protocol-v2.ts';
	import { clockLeft } from './layout.ts';

	let {
		info,
		place,
		me = false,
		button = false,
		turn = null,
		now,
		won = 0
	}: {
		info: SeatInfo;
		place: string;
		me?: boolean;
		button?: boolean;
		turn?: Turn | null;
		/** The server's time now, for the turn clock. */
		now: number;
		won?: number;
	} = $props();

	const RING = 2 * Math.PI * 46;
	const acting = $derived(turn !== null && turn.seat === info.seat);
	const clock = $derived(acting && turn ? clockLeft(turn, now) : null);
	const status = $derived(
		info.leaving
			? 'Leaving'
			: info.sitting_out
				? 'Sitting out'
				: info.folded
					? 'Folded'
					: info.all_in
						? 'All-in'
						: !info.connected && info.kind === 'human'
							? 'Away'
							: ''
	);
	const label = $derived(
		`${me ? 'Your seat' : `Seat ${info.seat + 1}`}: ${info.name}${info.kind === 'bot' ? ' (bot)' : ''}`
	);
</script>

<div
	class="seat {place}"
	class:me
	class:acting
	class:dim={info.folded || info.sitting_out}
	role="group"
	aria-label={label}
	data-seat={info.seat}
>
	{#if clock}
		<svg class="ring" class:bank={clock.bank} viewBox="0 0 100 100" aria-hidden="true">
			<circle class="track" cx="50" cy="50" r="46" />
			<circle
				class="left"
				cx="50"
				cy="50"
				r="46"
				stroke-dasharray={RING}
				stroke-dashoffset={RING * (1 - clock.fraction)}
			/>
		</svg>
	{/if}
	{#if button}<span class="dealer" title="Dealer button">D</span>{/if}
	<div class="name">{info.name}</div>
	{#if info.kind === 'bot'}
		<div class="bot">
			Bot<span class="kind">{info.bot ? ` · ${info.bot.replace('_', ' ')}` : ''}</span>
		</div>
	{/if}
	{#if info.cards || info.has_cards}
		<div class="cards">
			{#if info.cards}
				{#each info.cards as card (`${card.rank}${card.suit}`)}
					<PlayingCard {card} />
				{/each}
			{:else}
				<PlayingCard card={null} />
				<PlayingCard card={null} />
			{/if}
		</div>
	{/if}
	<div class="stack">{info.stack}</div>
	{#if info.bet > 0}<div class="bet">Bet {info.bet}</div>{/if}
	{#if won > 0}<div class="won">Won {won}</div>{/if}
	{#if status}<div class="status">{status}</div>{/if}
	{#if clock}
		<div class="clock" class:bank={clock.bank}>
			{clock.bank ? 'Time bank ' : ''}{clock.seconds}s
		</div>
	{/if}
</div>

<style>
	.seat {
		position: absolute;
		transform: translate(-50%, -50%);
		width: 116px;
		padding: 6px 6px 8px;
		background: var(--panel);
		border: 2px solid var(--panel-2);
		border-radius: var(--radius);
		text-align: center;
		font-size: 0.85rem;
		z-index: 1;
	}
	.seat.me {
		border-color: var(--accent);
	}
	.seat.acting {
		border-color: var(--win);
		box-shadow: 0 0 0 3px rgb(111 220 140 / 0.25);
	}
	.dim {
		opacity: 0.6;
	}
	/* The ring and the dealer button stay within the seat's width, so seats at
	   the edges of a phone never push the page sideways. */
	.ring {
		position: absolute;
		top: -16px;
		left: 50%;
		width: 30px;
		height: 30px;
		transform: translateX(-50%) rotate(-90deg);
	}
	.ring circle {
		fill: var(--panel);
		stroke-width: 10;
	}
	.ring .track {
		stroke: var(--panel-2);
	}
	.ring .left {
		stroke: var(--win);
		fill: none;
		transition: stroke-dashoffset 0.25s linear;
	}
	.ring.bank .left {
		stroke: var(--accent);
	}
	.name {
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.dealer {
		position: absolute;
		top: -9px;
		left: 4px;
		text-align: center;
		background: #fff;
		color: #111;
		border-radius: 50%;
		width: 1.3em;
		height: 1.3em;
		line-height: 1.3em;
		font-size: 0.75em;
		font-weight: 700;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.5);
	}
	.bot {
		color: var(--muted);
		font-size: 0.75rem;
		text-transform: capitalize;
	}
	.cards {
		display: flex;
		justify-content: center;
		gap: 3px;
		min-height: 58px;
		margin: 4px 0 2px;
	}
	.stack {
		font-variant-numeric: tabular-nums;
	}
	.bet {
		color: var(--accent);
		font-variant-numeric: tabular-nums;
	}
	.won {
		color: var(--win);
		font-weight: 600;
	}
	.status,
	.clock {
		color: var(--muted);
		font-size: 0.75rem;
	}
	.clock.bank {
		color: var(--accent);
	}
	@media (prefers-reduced-motion: reduce) {
		.ring .left {
			transition: none;
		}
	}
	@media (max-width: 600px) {
		.seat {
			width: 78px;
			padding: 4px 3px 5px;
			font-size: 0.72rem;
			border-radius: 9px;
		}
		.cards {
			min-height: 48px;
			gap: 2px;
		}
		.seat:not(.me) .cards :global(.card) {
			width: 26px;
			height: 37px;
			border-radius: 4px;
		}
		.seat:not(.me) .cards {
			min-height: 37px;
		}
		.bot {
			font-size: 0.65rem;
		}
		.kind {
			display: none;
		}
	}
</style>

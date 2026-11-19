<script lang="ts">
	import PlayingCard from '../components/PlayingCard.svelte';
	import type { SeatInfo, Turn } from '../protocol-v2.ts';
	import { avatarClass, botLabel } from './faces.ts';
	import { clockLeft } from './layout.ts';

	let {
		info,
		place,
		side = 'bottom',
		me = false,
		button = false,
		turn = null,
		now,
		won = 0
	}: {
		info: SeatInfo;
		place: string;
		/** Which way the seat faces the middle (see layout.ts sideOf). */
		side?: string;
		me?: boolean;
		button?: boolean;
		turn?: Turn | null;
		/** The server's time now, for the turn clock. */
		now: number;
		won?: number;
	} = $props();

	const SEGMENTS = 12;
	const segments = Array.from({ length: SEGMENTS }, (_, i) => i);
	const acting = $derived(turn !== null && turn.seat === info.seat);
	const clock = $derived(acting && turn ? clockLeft(turn, now) : null);
	const lit = $derived(clock ? Math.ceil(clock.fraction * SEGMENTS) : 0);
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
	const frame = $derived(acting ? 'px-glow' : me ? 'px-gold' : 'px-panel');
</script>

<div
	class="seat {place} {side}"
	class:me
	class:acting
	class:dim={info.folded || info.sitting_out}
	role="group"
	aria-label={label}
	data-seat={info.seat}
>
	<div class="hand" class:backs={!info.cards}>
		{#if info.cards}
			{#each info.cards as card (`${card.rank}${card.suit}`)}
				<PlayingCard {card} />
			{/each}
		{:else if info.has_cards}
			<PlayingCard card={null} />
			<PlayingCard card={null} />
		{/if}
	</div>
	<div class="plate {frame}">
		<span class="sprite avatar {avatarClass(info)}" aria-hidden="true"></span>
		<div class="who">
			<div class="name" title={info.name}>{info.name}</div>
			<div class="stack">
				<span class="sprite chip chip-gold" aria-hidden="true"></span>{info.stack}
			</div>
		</div>
		{#if button}<span class="sprite dealer-button dealer" title="Dealer button"></span>{/if}
		{#if info.has_cards && !info.cards}
			<span class="sprite mini-cards" aria-hidden="true"></span>
		{/if}
	</div>
	<div class="below">
		<div class="tags">
			{#if info.kind === 'bot'}
				<span class="bot">
					Bot{#if !info.name.startsWith(botLabel(info.bot))}<span class="kind">
							· {botLabel(info.bot)}
						</span>{/if}
				</span>
			{/if}
			{#if status}<span class="status">{status}</span>{/if}
		</div>
		{#if clock}
			<div class="clock" class:bank={clock.bank} class:low={!clock.bank && clock.fraction < 0.3}>
				<svg viewBox="0 0 {SEGMENTS * 3 + 1} 4" aria-hidden="true" shape-rendering="crispEdges">
					<rect class="groove" x="0" y="0" width={SEGMENTS * 3 + 1} height="4" />
					{#each segments as i (i)}
						<rect class:on={i < lit} x={1 + i * 3} y="1" width="2" height="2" />
					{/each}
				</svg>
				<span class="secs">{clock.bank ? 'Bank ' : ''}{clock.seconds}s</span>
			</div>
		{/if}
	</div>
	{#if won > 0}<div class="won" role="status">+{won}</div>{/if}
</div>

<style>
	.seat {
		--k: 2;
		position: absolute;
		transform: translate(-50%, -50%);
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		justify-items: center;
		width: 176px;
		z-index: 1;
		font-size: var(--fs);
		line-height: 1.2;
	}
	.seat.me {
		--k: 3;
		width: 200px;
		z-index: 2;
	}
	.hand {
		display: flex;
		justify-content: center;
		min-height: calc(45px * var(--k) * 0.55);
		margin-bottom: calc(-45px * var(--k) * 0.3);
	}
	.hand :global(.card + .card) {
		margin-left: calc(-12px * var(--k));
		transform: rotate(4deg) translateY(calc(var(--k) * 1px));
		transform-origin: bottom left;
	}
	.hand :global(.card:first-child:not(:last-child)) {
		transform: rotate(-4deg);
		transform-origin: bottom right;
	}
	.plate {
		position: relative;
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 2px 4px;
		min-height: 52px;
	}
	.who {
		min-width: 0;
		flex: 1;
	}
	.name {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		text-shadow: var(--shadow-text);
	}
	.me .name {
		color: var(--gold);
	}
	.stack {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--gold-light);
		text-shadow: var(--shadow-text);
	}
	.stack .chip {
		width: 14px;
		height: 14px;
	}
	.dealer {
		position: absolute;
		top: -14px;
		right: -10px;
	}
	.mini-cards {
		display: none;
	}
	.below {
		display: grid;
		justify-items: center;
	}
	.tags {
		display: flex;
		gap: 6px;
		justify-content: center;
		min-height: 0;
	}
	.bot,
	.status {
		margin-top: 2px;
		padding: 0 6px;
		font-size: var(--fs-s);
		line-height: 20px;
		background: var(--ink);
		color: var(--mist);
		white-space: nowrap;
	}
	.bot {
		color: var(--violet-light);
	}
	.status {
		color: var(--paper-shade);
	}
	.clock {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 4px;
		font-size: var(--fs-s);
		color: var(--green-light);
		text-shadow: var(--shadow-text);
	}
	.clock svg {
		width: calc(37 * var(--px));
		height: calc(4 * var(--px));
		display: block;
	}
	.clock .groove {
		fill: var(--ink);
	}
	.clock rect:not(.groove) {
		fill: var(--deep-slate);
	}
	.clock rect.on {
		fill: var(--green-light);
	}
	.clock.low,
	.clock.low rect.on {
		color: var(--gold);
		fill: var(--gold);
	}
	.clock.bank,
	.clock.bank rect.on {
		color: var(--red-light);
		fill: var(--red-light);
	}
	.won {
		position: absolute;
		top: 0;
		left: 50%;
		transform: translate(-50%, -60%);
		font-size: var(--fs-l);
		color: var(--gold);
		text-shadow:
			0 var(--px) 0 var(--ink),
			var(--px) 0 0 var(--ink),
			calc(-1 * var(--px)) 0 0 var(--ink),
			0 calc(-1 * var(--px)) 0 var(--ink);
		animation: rise 0.6s steps(6, end);
		z-index: 3;
		pointer-events: none;
	}
	.dim .plate,
	.dim .hand {
		opacity: 0.55;
	}
	.acting .plate {
		animation: nudge 1.2s steps(2, end) infinite;
	}
	@keyframes nudge {
		50% {
			transform: translateY(calc(-1 * var(--px)));
		}
	}
	@keyframes rise {
		from {
			transform: translate(-50%, 0);
			opacity: 0;
		}
	}

	/* Tablets: smaller seats around the same wide oval. */
	@media (max-width: 1279px) {
		.seat {
			width: 150px;
		}
		.seat.me {
			--k: 2;
			width: 172px;
		}
		.avatar {
			width: 24px;
			height: 24px;
		}
	}

	/* Phones: opponents are compact pods centred on their place, with a small
	   card-back badge; cards they show fan out towards the middle. The viewer
	   keeps a full seat with large cards. */
	@media (max-width: 639px), (max-width: 1099px) and (orientation: portrait) {
		.seat {
			--k: 1;
			width: 84px;
			font-size: var(--fs-s);
		}
		.seat.me {
			--k: 2;
			width: 220px;
			font-size: var(--fs);
		}
		.plate {
			gap: 4px;
			min-height: 0;
			padding: 0 2px;
		}
		.seat:not(.me) .plate {
			display: block;
			text-align: center;
			padding-top: 2px;
		}
		.seat:not(.me) .avatar {
			display: none;
		}
		.seat:not(.me) .stack {
			justify-content: center;
			gap: 4px;
		}
		.seat:not(.me) .hand {
			position: absolute;
			z-index: 2;
			min-height: 0;
			margin: 0;
		}
		.seat:not(.me) .hand.backs {
			display: none;
		}
		.side-left:not(.me) .hand {
			left: calc(100% + 2px);
			top: 50%;
			transform: translateY(-50%);
		}
		.side-right:not(.me) .hand {
			right: calc(100% + 2px);
			top: 50%;
			transform: translateY(-50%);
		}
		.side-top:not(.me) .hand {
			top: calc(100% + 20px);
			left: 50%;
			transform: translateX(-50%);
		}
		.seat:not(.me) .below {
			position: absolute;
			top: 100%;
			left: 0;
			right: 0;
		}
		.seat:not(.me) .mini-cards {
			display: block;
			position: absolute;
			top: -24px;
			width: 28px;
			height: 26px;
			z-index: -1;
		}
		.side-left .mini-cards,
		.side-top .mini-cards {
			right: -8px;
		}
		.side-right .mini-cards {
			left: -8px;
		}
		.stack .chip {
			width: 11px;
			height: 11px;
		}
		.kind {
			display: none;
		}
		.bot,
		.status {
			font-size: 10px;
			line-height: 14px;
			padding: 0 4px;
		}
		.clock {
			margin-top: 2px;
			gap: 4px;
		}
		.clock svg {
			width: 74px;
			height: 8px;
		}
		.seat:not(.me) .secs {
			display: none;
		}
		.dealer {
			width: 18px;
			height: 18px;
			top: -10px;
			left: -6px;
			right: auto;
		}
		.me .dealer {
			left: auto;
			right: -8px;
		}
		.won {
			font-size: var(--fs);
		}
	}
	@media (min-width: 640px) and (max-width: 1099px) and (orientation: portrait) {
		.seat {
			width: 150px;
			font-size: var(--fs);
		}
		.seat.me {
			--k: 3;
			width: 240px;
		}
		.seat:not(.me) .hand {
			--k: 2;
		}
		.bot,
		.status {
			font-size: var(--fs-s);
			line-height: 20px;
		}
	}
</style>

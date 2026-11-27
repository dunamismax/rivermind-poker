<script lang="ts">
	import { CARD_SLOT, cardBackPath, cardFacePath, type CardBack } from '../card-assets.ts';
	import type { Card } from '../protocol.ts';
	import { cardName } from '../wording.ts';

	/**
	 * A card face, `null` for a face-down card, `undefined` for an empty slot.
	 * The art is 71 × 95; `--k` on any parent asks for a size (1 is 71 CSS
	 * pixels wide), and the card snaps to the nearest whole number of device
	 * pixels per art pixel, so it stays crisp on every screen. `--card-min`
	 * sets the fewest device pixels per art pixel, for cards that must stay legible.
	 */
	let {
		card,
		large = false,
		back
	}: {
		card: Card | null | undefined;
		/** Older layouts: half a size up. */
		large?: boolean;
		back?: CardBack;
	} = $props();
</script>

{#if card === undefined}
	<img class="card slot" class:large src={CARD_SLOT} alt="" aria-hidden="true" draggable="false" />
{:else if card === null}
	<img
		class="card back"
		class:large
		src={cardBackPath(back)}
		alt="Face-down card"
		draggable="false"
	/>
{:else}
	<img
		class="card face"
		class:large
		src={cardFacePath(card)}
		alt={cardName(card)}
		draggable="false"
	/>
{/if}

<style>
	.card {
		--card-k: var(--k, 1);
		/* Device pixels per art pixel: the size asked for, rounded, but at least
		   --card-min where the screen has that many device pixels per CSS pixel.
		   Then one art pixel in CSS pixels. */
		--card-s: max(
			min(var(--card-min, 1), round(down, var(--dpr, 1), 1)),
			round(nearest, calc(var(--card-k) * var(--dpr, 1)), 1)
		);
		--card-a: calc(1px * var(--card-s) / var(--dpr, 1));
		display: block;
		flex: none;
		max-width: none;
		width: calc(71 * var(--card-a));
		height: calc(95 * var(--card-a));
		user-select: none;
		-webkit-user-select: none;
	}
	/* The pixel look's deck (Phase 5C): hard edges, a hard shadow and a stepped deal.
	   The size above is shared, so a card takes the same room in either look. */
	:global(:where([data-look='pixel'])) .card {
		image-rendering: pixelated;
		filter: drop-shadow(0 calc(2 * var(--card-a)) 0 rgb(0 0 0 / 0.4));
		animation: deal 0.24s steps(4, end);
	}
	:global(:where([data-look='pixel'])) .slot {
		filter: none;
		animation: none;
	}
	.large {
		--card-k: calc(var(--k, 1) + 0.5);
	}
	@keyframes deal {
		from {
			transform: translateY(calc(-12 * var(--card-a))) rotate(-4deg);
			opacity: 0;
		}
	}
</style>

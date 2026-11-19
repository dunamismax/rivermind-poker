<script lang="ts">
	import {
		CARD_SLOT,
		cardBackPath,
		cardFacePath,
		type CardBack,
		type CardTreatment
	} from '../card-assets.ts';
	import type { Card } from '../protocol.ts';
	import { cardName } from '../wording.ts';

	/**
	 * A card face, `null` for a face-down card, `undefined` for an empty slot.
	 * Its size is 33 × 45 art pixels times `--k` (2 unless a parent sets it).
	 */
	let {
		card,
		large = false,
		treatment,
		back
	}: {
		card: Card | null | undefined;
		/** Older layouts: one size up. */
		large?: boolean;
		treatment?: CardTreatment;
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
		src={cardFacePath(card, treatment)}
		alt={cardName(card)}
		draggable="false"
	/>
{/if}

<style>
	.card {
		--card-k: var(--k, 2);
		display: block;
		flex: none;
		width: calc(33px * var(--card-k));
		height: calc(45px * var(--card-k));
		image-rendering: pixelated;
		filter: drop-shadow(0 calc(1px * var(--card-k)) 0 rgb(0 0 0 / 0.4));
		animation: deal 0.24s steps(4, end);
		user-select: none;
		-webkit-user-select: none;
	}
	.slot {
		filter: none;
		animation: none;
	}
	.large {
		--card-k: calc(var(--k, 2) + 1);
	}
	@keyframes deal {
		from {
			transform: translateY(calc(-6px * var(--card-k))) rotate(-4deg);
			opacity: 0;
		}
	}
</style>

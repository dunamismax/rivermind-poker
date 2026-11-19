<script lang="ts">
	import { asset } from '$app/paths';
	import { cardBackPath, cardFacePath, type CardBack, type CardTreatment } from '../card-assets.ts';
	import type { Card } from '../protocol.ts';
	import { cardName } from '../wording.ts';

	/** A card face, `null` for a face-down card, `undefined` for an empty slot. */
	let {
		card,
		large = false,
		treatment,
		back
	}: {
		card: Card | null | undefined;
		large?: boolean;
		treatment?: CardTreatment;
		back?: CardBack;
	} = $props();
</script>

{#if card === undefined}
	<div class="card slot" class:large aria-hidden="true"></div>
{:else if card === null}
	<img class="card back" class:large src={asset(cardBackPath(back))} alt="Face-down card" />
{:else}
	<img class="card" class:large src={asset(cardFacePath(card, treatment))} alt={cardName(card)} />
{/if}

<style>
	.card {
		width: 42px;
		height: 58px;
		border-radius: 6px;
		display: block;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.4);
		flex: none;
	}
	.slot {
		border: 2px dashed rgb(255 255 255 / 0.18);
		box-shadow: none;
	}
	.large {
		width: 54px;
		height: 74px;
	}

	@media (max-width: 420px) {
		.card {
			width: 34px;
			height: 48px;
		}
		.large {
			width: 46px;
			height: 64px;
		}
	}
</style>

<script lang="ts">
	import type { Card } from '../protocol.ts';
	import { SUIT_SYMBOLS, cardName, isRed, rankLabel } from '../wording.ts';

	/** A card face, `null` for a face-down card, `undefined` for an empty slot. */
	let { card, large = false }: { card: Card | null | undefined; large?: boolean } = $props();
</script>

{#if card === undefined}
	<div class="card slot" class:large aria-hidden="true"></div>
{:else if card === null}
	<div class="card back" class:large role="img" aria-label="Face-down card"></div>
{:else}
	<div class="card" class:large class:red={isRed(card)} role="img" aria-label={cardName(card)}>
		<span aria-hidden="true">{rankLabel(card.rank)}</span>
		<span class="suit" aria-hidden="true">{SUIT_SYMBOLS[card.suit]}</span>
	</div>
{/if}

<style>
	.card {
		width: 42px;
		height: 58px;
		border-radius: 6px;
		background: var(--card);
		color: var(--card-black);
		display: grid;
		place-content: center;
		justify-items: center;
		font-weight: 700;
		font-size: 1.05rem;
		line-height: 1;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.4);
		flex: none;
	}
	.suit {
		font-size: 1.1rem;
	}
	.red {
		color: var(--card-red);
	}
	.back {
		background: repeating-linear-gradient(45deg, #23506b 0 6px, #1b3f55 6px 12px);
		border: 2px solid #e8eef2;
	}
	.slot {
		background: transparent;
		border: 2px dashed rgb(255 255 255 / 0.18);
		box-shadow: none;
	}
	.large {
		width: 54px;
		height: 74px;
		font-size: 1.3rem;
	}
	.large .suit {
		font-size: 1.4rem;
	}

	@media (max-width: 420px) {
		.card {
			width: 34px;
			height: 48px;
			font-size: 0.9rem;
		}
		.suit {
			font-size: 0.95rem;
		}
		.large {
			width: 46px;
			height: 64px;
			font-size: 1.15rem;
		}
	}
</style>

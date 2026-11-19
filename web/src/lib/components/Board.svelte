<script lang="ts">
	import type { Card } from '../protocol.ts';
	import PlayingCard from './PlayingCard.svelte';

	let { cards }: { cards: Card[] } = $props();
	const slots = $derived(Array.from({ length: 5 }, (_, i) => cards[i]));
</script>

<div class="board" role="group" aria-label="Board">
	{#each slots as card, i (i)}
		<PlayingCard {card} />
	{/each}
</div>

<style>
	.board {
		display: flex;
		gap: 6px;
	}
	@media (max-width: 420px) {
		.board {
			gap: 4px;
		}
	}
</style>

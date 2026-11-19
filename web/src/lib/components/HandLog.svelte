<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { SeatView } from '../protocol.ts';
	import { EVENT_DELAY_MS, logEntries } from '../wording.ts';

	let { view }: { view: SeatView } = $props();

	const entries = $derived(logEntries(view));
	let visible = $state(0);
	let list: HTMLOListElement | undefined = $state();

	// Plain bookkeeping, not rendered.
	let hand = 0;
	let scheduled = 0;
	let timers: ReturnType<typeof setTimeout>[] = [];

	function reset() {
		timers.forEach(clearTimeout);
		timers = [];
		scheduled = 0;
		visible = 0;
	}

	$effect(() => {
		const current = entries;
		if (view.hand !== hand || current.length < scheduled) {
			hand = view.hand;
			reset();
		}
		let delay = 0;
		for (let i = scheduled; i < current.length; i += 1) {
			const count = i + 1;
			timers.push(
				setTimeout(() => {
					if (count > visible) visible = count;
				}, delay)
			);
			if (current[i].pauseAfter) delay += EVENT_DELAY_MS;
		}
		scheduled = current.length;
	});

	$effect(() => {
		if (visible && list) list.scrollTop = list.scrollHeight;
	});

	onDestroy(reset);
</script>

<details class="log" open>
	<summary>Hand log</summary>
	<ol bind:this={list} aria-live="polite">
		{#each entries as entry, i (i)}
			<li class={entry.kind} class:shown={i < visible} aria-hidden={i >= visible}>{entry.text}</li>
		{/each}
	</ol>
</details>

<style>
	.log {
		background: var(--panel);
		border-radius: var(--radius);
		padding: 8px 12px;
	}
	summary {
		color: var(--muted);
		cursor: pointer;
	}
	ol {
		list-style: none;
		margin: 8px 0 0;
		padding: 0;
		display: grid;
		gap: 3px;
		font-size: 0.9rem;
		max-height: 220px;
		overflow-y: auto;
	}
	li {
		opacity: 0;
		transform: translateY(4px);
		transition:
			opacity 0.25s,
			transform 0.25s;
	}
	li.shown {
		opacity: 1;
		transform: none;
	}
	.street {
		color: var(--muted);
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		margin-top: 4px;
	}
	.mine {
		color: var(--accent);
	}
	@media (prefers-reduced-motion: reduce) {
		li {
			transition: none;
			transform: none;
		}
	}
</style>

<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Snippet } from 'svelte';

	/** The site's top bar: the RiverMind mark, and whatever the page adds on the right. */
	let { children }: { children?: Snippet } = $props();
</script>

<header class="topbar">
	<a class="brand" href={resolve('/')}>
		<span class="sprite emblem" aria-hidden="true"></span>
		<h1>RiverMind <span class="poker">Poker</span></h1>
	</a>
	<div class="right">{@render children?.()}</div>
</header>

<style>
	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 16px;
		background: var(--ink);
		border-bottom: var(--px) solid var(--deep-slate);
		box-shadow: 0 var(--px) 0 var(--night);
		min-height: 60px;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
		text-decoration: none;
		color: inherit;
	}
	h1 {
		font-size: var(--fs-l);
		color: var(--gold);
		text-shadow:
			0 var(--px) 0 var(--amber-deep),
			0 calc(2 * var(--px)) 0 var(--ink);
		white-space: nowrap;
	}
	.poker {
		color: var(--paper);
		text-shadow: 0 var(--px) 0 var(--ink);
	}
	.right {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}
	@media (max-width: 639px) {
		.topbar {
			padding: 6px 10px;
			min-height: 52px;
		}
		h1 {
			font-size: var(--fs);
		}
		.brand .emblem {
			width: 22px;
			height: 26px;
		}
	}
	@media (max-width: 359px) {
		.poker {
			display: none;
		}
	}
</style>

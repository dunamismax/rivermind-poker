<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Snippet } from 'svelte';
	import LookSwitch from './LookSwitch.svelte';

	/**
	 * The site's top bar: the RiverMind mark, whatever the page adds on the right, and
	 * the look switch at the far end (P5C.5), where switching moves nothing else.
	 * At a table a phone leaves it out (`atTable`): the screen is the table's, whose own
	 * bar leads back to the lobby and carries the connection lamp.
	 */
	let { children, atTable = false }: { children?: Snippet; atTable?: boolean } = $props();
</script>

<header
	class={[
		'topbar flex min-h-30 items-center justify-between gap-6 border-b-2 border-deep-slate bg-ink px-8 py-4 [box-shadow:0_2px_0_var(--color-night)] lt-640:min-h-26 lt-640:px-5 lt-640:py-3',
		atTable && 'pocket:hidden'
	]}
>
	<a class="brand flex items-center gap-5 text-inherit no-underline" href={resolve('/')}>
		<span class="sprite emblem lt-640:h-13 lt-640:w-11" aria-hidden="true"></span>
		<h1 class="text-l whitespace-nowrap text-gold text-shadow-title lt-640:text-m">
			RiverMind <span class="poker text-paper text-shadow-ink lt-460:hidden">Poker</span>
		</h1>
	</a>
	<div class="right flex min-w-0 items-center gap-6">
		{@render children?.()}
		<LookSwitch />
	</div>
</header>

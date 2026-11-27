<script lang="ts">
	import { LOOKS, LOOK_NAMES, look } from '#lib/look.svelte.ts';

	/**
	 * The look switch (P5C.5): Clean or Pixel, at once and kept in this browser. It is
	 * the same size in both looks, label and buttons alike, so switching moves nothing
	 * beside it. On a phone the label is not shown, to leave the header room for the
	 * player's name.
	 *
	 * The group is named by aria-label, and the visible label is hidden from assistive
	 * technology. Named by aria-labelledby instead, the group crashed Firefox's page at a
	 * nine-seat table in Playwright, every time, as soon as a test looked up a group by
	 * its name (`table.e2e.ts`, "rejoins the same table after a reload").
	 *
	 * `labelled` keeps the label on a phone too, where the switch has a row of its own:
	 * the table bar's menu (P5C.6).
	 */
	let { labelled = false }: { labelled?: boolean } = $props();
</script>

<div class="look-switch flex flex-none items-center gap-3" role="group" aria-label="Look">
	<span
		aria-hidden="true"
		class={['w-16 text-right text-s text-mist', !labelled && 'lt-640:hidden']}
	>
		Look
	</span>
	<span class="flex gap-2">
		{#each LOOKS as name (name)}
			<button
				type="button"
				class="px-btn small choice w-32 px-0 lt-640:min-h-19 lt-640:w-24 lt-640:text-xs"
				aria-pressed={look.current === name}
				onclick={() => look.set(name)}
			>
				{LOOK_NAMES[name]}
			</button>
		{/each}
	</span>
</div>

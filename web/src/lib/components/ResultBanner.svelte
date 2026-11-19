<script lang="ts">
	import type { SeatView } from '../protocol.ts';
	import { resultLine } from '../wording.ts';

	let { view }: { view: SeatView } = $props();
	const line = $derived(resultLine(view));
</script>

<p class="result" role="status">{line ?? ''}</p>

<style>
	.result {
		text-align: center;
		font-weight: 600;
		margin: 0;
		min-height: 1.4em;
	}
</style>

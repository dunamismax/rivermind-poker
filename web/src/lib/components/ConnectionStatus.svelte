<script lang="ts">
	import type { ConnectionStatus } from '../table-connection.svelte.ts';

	let { status }: { status: ConnectionStatus } = $props();
	const LABELS: Record<ConnectionStatus, string> = {
		idle: 'Not connected',
		connecting: 'Connecting',
		open: 'Connected',
		closed: 'Connection lost, reconnecting'
	};
</script>

<!-- A square signal lamp, outlined in ink, lit from the top-left; in the clean look a round one with a faint halo. -->
<span class="status group inline-flex items-center" data-state={status} title={LABELS[status]}>
	<span
		class="light size-5 bg-haze [box-shadow:0_0_0_2px_var(--color-ink),inset_2px_2px_0_rgb(255_255_255/0.35)] group-data-[state=closed]:animate-blink group-data-[state=closed]:bg-red group-data-[state=connecting]:animate-blink group-data-[state=connecting]:bg-gold group-data-[state=open]:bg-green clean:rounded-full clean:[box-shadow:0_0_0_3px_rgb(255_255_255/0.07)]"
		aria-hidden="true"
	></span>
	<span class="sr-only">{LABELS[status]}</span>
</span>

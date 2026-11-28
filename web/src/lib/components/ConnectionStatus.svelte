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

<!-- A round signal lamp with a faint halo. -->
<span class="status group inline-flex items-center" data-state={status} title={LABELS[status]}>
	<span
		class="light size-5 bg-haze group-data-[state=closed]:animate-blink group-data-[state=closed]:bg-red group-data-[state=connecting]:animate-blink group-data-[state=connecting]:bg-gold group-data-[state=open]:bg-green rounded-full [box-shadow:0_0_0_3px_rgb(255_255_255/0.07)]"
		aria-hidden="true"
	></span>
	<span class="sr-only">{LABELS[status]}</span>
</span>

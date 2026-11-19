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

<span class="status" data-state={status} title={LABELS[status]}>
	<span class="visually-hidden">{LABELS[status]}</span>
</span>

<style>
	.status {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--muted);
		display: inline-block;
	}
	.status[data-state='open'] {
		background: var(--win);
	}
	.status[data-state='connecting'] {
		background: var(--accent);
	}
	.status[data-state='closed'] {
		background: var(--danger);
	}
</style>

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
	<span class="light" aria-hidden="true"></span>
	<span class="visually-hidden">{LABELS[status]}</span>
</span>

<style>
	.status {
		display: inline-flex;
		align-items: center;
	}
	/* A square signal lamp, outlined in ink, lit from the top-left. */
	.light {
		width: calc(5 * var(--px));
		height: calc(5 * var(--px));
		background: var(--color-haze);
		box-shadow:
			0 0 0 var(--px) var(--color-ink),
			inset var(--px) var(--px) 0 rgb(255 255 255 / 0.35);
	}
	[data-state='open'] .light {
		background: var(--color-green);
	}
	[data-state='connecting'] .light {
		background: var(--color-gold);
		animation: blink 0.8s steps(2, end) infinite;
	}
	[data-state='closed'] .light {
		background: var(--color-red);
		animation: blink 0.8s steps(2, end) infinite;
	}
	@keyframes blink {
		50% {
			opacity: 0.35;
		}
	}
</style>

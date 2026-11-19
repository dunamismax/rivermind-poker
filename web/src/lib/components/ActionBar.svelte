<script lang="ts">
	import type { Action, SeatView } from '../protocol.ts';
	import { buttonLabel } from '../wording.ts';

	let {
		view,
		connected,
		pending,
		onact,
		onnext
	}: {
		view: SeatView;
		connected: boolean;
		pending: boolean;
		onact: (action: Action) => void;
		onnext: () => void;
	} = $props();

	const disabled = $derived(pending || !connected);
</script>

<div class="controls" role="group" aria-label="Actions">
	{#if view.result}
		<button type="button" class="next" {disabled} onclick={onnext}>Next hand</button>
	{:else if !view.your_turn}
		<p class="waiting" role="status">{connected ? 'Waiting for the bots…' : 'Reconnecting…'}</p>
	{:else}
		{#each view.legal_actions as action (action)}
			<button type="button" class={action} {disabled} onclick={() => onact(action)}>
				{buttonLabel(action, view.action_amounts)}
			</button>
		{/each}
	{/if}
</div>

<style>
	.controls {
		display: grid;
		grid-auto-flow: column;
		grid-auto-columns: 1fr;
		gap: 10px;
		min-height: 52px;
	}
	button {
		border: 0;
		border-radius: var(--radius);
		padding: 14px 8px;
		font-weight: 600;
		background: var(--panel-2);
		color: var(--text);
		min-width: 0;
	}
	.call {
		background: #2f6f4f;
	}
	.raise,
	.next {
		background: var(--accent);
		color: var(--accent-text);
	}
	.waiting {
		grid-column: 1 / -1;
		text-align: center;
		color: var(--muted);
		align-self: center;
		margin: 0;
	}
</style>

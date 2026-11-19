<script lang="ts">
	import { onMount } from 'svelte';
	import ConnectionStatus from '#lib/components/ConnectionStatus.svelte';
	import Lobby from '#lib/components/Lobby.svelte';
	import Table from '#lib/components/Table.svelte';
	import { TableConnection } from '#lib/table-connection.svelte.ts';
	import { signed } from '#lib/wording.ts';

	const connection = new TableConnection();
	let ready = $state(false);

	const me = $derived(connection.view?.seats.find((s) => s.seat === connection.view?.seat));

	// Errors show briefly as a toast; a repeat of the same text restarts it.
	let toast = $state<string | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const notice = connection.notice;
		if (!notice) return;
		toast = notice.text;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 3500);
	});

	onMount(() => {
		connection.resume();
		ready = true;
		return () => {
			clearTimeout(toastTimer);
			connection.leave();
		};
	});
</script>

<header class="topbar">
	<h1>RiverMind Poker</h1>
	<div class="topbar-right">
		{#if connection.seat && me}
			<span class="balance" class:up={me.balance > 0} class:down={me.balance < 0}>
				Session {signed(me.balance)}
			</span>
		{/if}
		<ConnectionStatus status={connection.status} />
	</div>
</header>

<main>
	{#if !ready}
		<!-- Deciding between the lobby and a saved seat. -->
	{:else if connection.seat}
		{#if connection.view}
			<Table view={connection.view} {connection} onleave={() => connection.leave()} />
		{:else}
			<p class="joining" role="status">Joining your table…</p>
		{/if}
	{:else}
		<Lobby message={connection.closedMessage ?? ''} onseat={(seat) => connection.join(seat)} />
	{/if}
</main>

{#if toast}
	<div class="toast" role="alert">{toast}</div>
{/if}

<style>
	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid var(--panel-2);
	}
	h1 {
		font-size: 1.1rem;
		margin: 0;
		letter-spacing: 0.02em;
	}
	.topbar-right {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.balance {
		font-variant-numeric: tabular-nums;
		color: var(--muted);
	}
	.balance.up {
		color: var(--win);
	}
	.balance.down {
		color: var(--danger);
	}
	main {
		max-width: 760px;
		margin: 0 auto;
		padding: 16px;
	}
	.joining {
		color: var(--muted);
		text-align: center;
		margin-top: 8vh;
	}
	.toast {
		position: fixed;
		left: 50%;
		bottom: calc(20px + env(safe-area-inset-bottom));
		transform: translateX(-50%);
		background: var(--danger);
		color: #fff;
		padding: 10px 16px;
		border-radius: var(--radius);
		max-width: calc(100vw - 32px);
	}
	@media (max-width: 420px) {
		main {
			padding: 12px;
		}
	}
</style>

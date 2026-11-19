<script lang="ts">
	import { onMount } from 'svelte';
	import ConnectionStatus from '#lib/components/ConnectionStatus.svelte';
	import { NlConnection } from '#lib/nl/connection.svelte.ts';
	import NlLobby from '#lib/nl/NlLobby.svelte';
	import NlTable from '#lib/nl/NlTable.svelte';

	// The no-limit table on protocol v2 (P3.6). It needs `rivermind-poker
	// serve-nl`; the live site moves to it at the Phase 3 cutover (P3.7).
	const connection = new NlConnection();
	let ready = $state(false);

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
			connection.disconnect();
		};
	});
</script>

<svelte:head>
	<title>No-limit hold’em · RiverMind Poker</title>
</svelte:head>

<header class="topbar">
	<h1>RiverMind Poker</h1>
	<div class="topbar-right">
		{#if connection.player}<span class="me">{connection.player.name}</span>{/if}
		<ConnectionStatus status={connection.status} />
	</div>
</header>

<main>
	{#if !ready}
		<!-- Deciding between the lobby and a saved table. -->
	{:else if connection.tableId}
		{#if connection.view}
			<NlTable view={connection.view} {connection} />
		{:else}
			<p class="joining" role="status">Joining your table…</p>
		{/if}
	{:else}
		<NlLobby
			message={connection.closedMessage ?? ''}
			onstart={(request) => connection.newTable(request)}
		/>
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
	.me {
		color: var(--muted);
	}
	main {
		max-width: 960px;
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
		z-index: 2;
	}
	@media (max-width: 420px) {
		main {
			padding: 12px 8px;
		}
	}
</style>

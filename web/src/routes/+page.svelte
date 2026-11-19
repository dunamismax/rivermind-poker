<script lang="ts">
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import ConnectionStatus from '#lib/components/ConnectionStatus.svelte';
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import { NlConnection } from '#lib/nl/connection.svelte.ts';
	import NlLobby from '#lib/nl/NlLobby.svelte';
	import NlTable from '#lib/nl/NlTable.svelte';

	// The no-limit table on protocol v2, served by `rivermind-poker serve-nl`.
	// It replaced the short-deck prototype at the Phase 3 cutover (P3.7, D-11).
	const connection = new NlConnection();
	let ready = $state(false);
	/** A private table's invite code, from a link such as `/?invite=…` (P4.3). */
	let invite = $state<string | null>(null);

	function inviteUsed() {
		invite = null;
		replaceState(resolve('/'), {});
	}

	let toast = $state<string | null>(null);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		const notice = connection.notice;
		if (!notice) return;
		toast = notice.text;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 3500);
	});

	// In the lobby, keep the wallet current: leaving mid-hand cashes out
	// only when that hand ends, a moment after the page is back here.
	$effect(() => {
		if (!ready || connection.tableId !== null) return;
		void connection.refreshBalance();
		const timer = setInterval(() => void connection.refreshBalance(), 3000);
		return () => clearInterval(timer);
	});

	onMount(() => {
		invite = new URLSearchParams(location.search).get('invite');
		void connection.start().finally(() => (ready = true));
		return () => {
			clearTimeout(toastTimer);
			connection.disconnect();
		};
	});
</script>

<svelte:head>
	<title>No-limit hold’em · RiverMind Poker</title>
</svelte:head>

<SiteHeader>
	{#if connection.player}<span class="me">{connection.player.name}</span>{/if}
	<ConnectionStatus status={connection.status} />
</SiteHeader>

<main class:at-table={connection.tableId !== null}>
	{#if !ready}
		<p class="joining" role="status">Shuffling up…</p>
	{:else if connection.tableId}
		{#if connection.view}
			<NlTable view={connection.view} {connection} />
		{:else}
			<p class="joining" role="status">Joining your table…</p>
		{/if}
	{:else}
		<NlLobby
			{connection}
			message={connection.closedMessage ?? ''}
			{invite}
			oninvited={inviteUsed}
		/>
	{/if}
</main>

{#if toast}
	<div class="toast px-danger" role="alert">{toast}</div>
{/if}

<style>
	.me {
		color: var(--paper-shade);
		text-shadow: var(--shadow-text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	main {
		max-width: 1080px;
		margin: 0 auto;
		padding: 16px;
	}
	main.at-table {
		max-width: 1440px;
	}
	.joining {
		color: var(--mist);
		text-align: center;
		margin-top: 12vh;
		text-shadow: var(--shadow-text);
		animation: blink 1s steps(2, end) infinite;
	}
	@keyframes blink {
		50% {
			opacity: 0.5;
		}
	}
	.toast {
		position: fixed;
		left: 50%;
		bottom: calc(20px + env(safe-area-inset-bottom));
		transform: translateX(-50%);
		padding: 6px 12px;
		max-width: calc(100vw - 32px);
		z-index: 20;
		text-shadow: var(--shadow-text);
		animation: drop 0.2s steps(3, end);
	}
	@keyframes drop {
		from {
			transform: translate(-50%, 12px);
			opacity: 0;
		}
	}
	@media (max-width: 639px) {
		main {
			padding: 8px 8px 12px;
		}
		main.at-table {
			padding: 4px 4px 0;
		}
		.me {
			font-size: var(--fs-s);
			max-width: 46vw;
		}
	}
</style>

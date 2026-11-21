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

	const joining = 'joining mt-[12vh] animate-wait text-center text-mist text-shadow-ink';

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
	{#if connection.player}
		<span
			class="me overflow-hidden text-ellipsis whitespace-nowrap text-paper-shade text-shadow-ink lt-640:max-w-[46vw] lt-640:text-s"
		>
			{connection.player.name}
		</span>
	{/if}
	<ConnectionStatus status={connection.status} />
</SiteHeader>

<main
	class={[
		'mx-auto p-8',
		connection.tableId !== null
			? 'at-table max-w-[1440px] lt-640:px-2 lt-640:pt-2 lt-640:pb-0'
			: 'max-w-[1080px] lt-640:px-4 lt-640:pt-4 lt-640:pb-6'
	]}
>
	{#if !ready}
		<p class={joining} role="status">Shuffling up…</p>
	{:else if connection.tableId}
		{#if connection.view}
			<NlTable view={connection.view} {connection} />
		{:else}
			<p class={joining} role="status">Joining your table…</p>
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
	<div
		class="toast px-danger fixed bottom-[calc(20px+env(safe-area-inset-bottom))] left-1/2 z-20 max-w-[calc(100vw-32px)] -translate-x-1/2 animate-drop px-6 py-3 text-shadow-ink"
		role="alert"
	>
		{toast}
	</div>
{/if}

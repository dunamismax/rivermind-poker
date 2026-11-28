<script lang="ts">
	// Your guest (P5D.11): who this browser plays as, and how to delete that guest
	// and their data, as App Review's guideline 5.1.1(v) asks of the app and the
	// site alike. The server ends the session at once and erases the rest once no
	// hand under way holds the guest's seat (`DELETE /api/guest`).
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import SiteHeader from '#lib/components/SiteHeader.svelte';
	import { deleteGuest, startSession } from '#lib/nl/api.ts';
	import type { SessionResponse } from '#lib/protocol-v2.ts';

	let guest = $state<SessionResponse | null>(null);
	let error = $state<string | null>(null);
	/** The first press asks again; the second deletes. */
	let confirming = $state(false);
	let deleting = $state(false);
	/** What the server said once the guest was deleted: erased, or waiting on a hand. */
	let done = $state<{ erased: boolean } | null>(null);

	const heading = 'mt-8 mb-3 text-m text-gold-light';
	const list = 'list-disc pl-10 [&>li+li]:mt-2';

	onMount(async () => {
		try {
			guest = await startSession();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	});

	async function remove() {
		deleting = true;
		error = null;
		try {
			done = await deleteGuest();
			guest = null;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			deleting = false;
			confirming = false;
		}
	}
</script>

<svelte:head>
	<title>Your guest · RiverMind Poker</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<SiteHeader>
	<a class="ui-btn small" href={resolve('/')}>Play</a>
</SiteHeader>

<main class="page mx-auto max-w-[860px] p-8 lt-600:p-4">
	<article class="ui-panel px-10 pt-8 pb-10 text-mist lt-600:px-6">
		<h2 class="mb-5 text-l text-gold text-shadow-ink">Your guest</h2>
		{#if done}
			<div class="deleted" role="status">
				<p class="text-paper">Your guest has been deleted.</p>
				<p class="mt-3">
					{#if done.erased}
						Its chips, its hands and everything else it had are gone.
					{:else}
						It was in a hand that is still being played. It checks or folds until the hand ends, and
						then its chips and everything else it had are gone.
					{/if}
				</p>
				<p class="mt-6">
					<a class="ui-btn gold" href={resolve('/')}>Play as a new guest</a>
				</p>
			</div>
		{:else}
			<p class="lead text-paper">
				You play as a guest, with no account and no sign-in. This browser keeps your guest in a
				cookie; another browser, or the iPhone app, is a guest of its own.
			</p>
			{#if guest}
				<p class="who ui-inset mt-6 grid gap-1 px-6 py-4">
					<span class="text-s text-haze">You play as</span>
					<strong class="name text-m text-gold">{guest.name}</strong>
					<span class="text-s text-haze">
						with {guest.balance.toLocaleString('en-US')} play chips
					</span>
				</p>
			{:else if !error}
				<p class="mt-6" role="status">Loading your guest…</p>
			{/if}

			<section aria-labelledby="delete">
				<h3 id="delete" class={heading}>Delete your guest</h3>
				<p>Deleting your guest removes it and everything it has, for good:</p>
				<ul class="{list} my-4">
					<li>its name, its play chips and their history;</li>
					<li>the hands it played, from your list of hands;</li>
					<li>the people it muted or blocked, and its reports.</li>
				</ul>
				<p>
					In the hands of the others who played with it, its seat shows as “Former guest”, so they
					can still replay their own hands. If it is in a hand when you delete it, it checks or
					folds until that hand ends. Afterwards this browser starts again as a new guest.
				</p>
				{#if error}<p class="error mt-4 text-red-light" role="alert">{error}</p>{/if}
				<div class="actions mt-6 flex flex-wrap gap-4">
					{#if confirming}
						<button type="button" class="ui-btn red confirm" disabled={deleting} onclick={remove}>
							Delete it for good
						</button>
						<button
							type="button"
							class="ui-btn keep"
							disabled={deleting}
							onclick={() => (confirming = false)}
						>
							Keep my guest
						</button>
					{:else}
						<button
							type="button"
							class="ui-btn red start"
							disabled={guest === null}
							onclick={() => (confirming = true)}
						>
							Delete my guest
						</button>
					{/if}
				</div>
			</section>
		{/if}
	</article>
</main>

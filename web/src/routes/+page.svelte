<script lang="ts">
	import { fetchConfig } from '#lib/api.ts';

	// Placeholder until the table UI is ported (P1.3): proves the client
	// reaches the server through the same-origin /api path.
	const config = fetchConfig();
</script>

<main>
	<h1>RiverMind Poker</h1>
	<p>Play-money poker against bots. The new client is under construction.</p>
	{#await config}
		<p role="status">Contacting the table server…</p>
	{:then { opponents }}
		<p role="status" data-testid="config">Opponents available: {opponents.join(', ')}</p>
	{:catch error}
		<p role="alert" data-testid="config-error">Could not reach the table server: {error.message}</p>
	{/await}
</main>

<script lang="ts">
	import PlayingCard from '../components/PlayingCard.svelte';
	import type { TableView } from '../protocol-v2.ts';
	import ActionPanel from './ActionPanel.svelte';
	import { describeEvent } from './bet.ts';
	import type { NlConnection } from './connection.svelte.ts';
	import { placeClass } from './layout.ts';
	import NlSeat from './NlSeat.svelte';
	import './seat-places.css';

	let { view, connection }: { view: TableView; connection: NlConnection } = $props();

	// The turn clocks tick on the local clock, shifted to the server's.
	let localNow = $state(Date.now() / 1000);
	$effect(() => {
		const timer = setInterval(() => (localNow = Date.now() / 1000), 250);
		return () => clearInterval(timer);
	});
	const now = $derived(localNow - connection.clockOffset);

	const count = $derived(view.settings.seat_count);
	const mine = $derived(view.you.seat);
	const me = $derived(mine === null ? null : view.seats[mine]);
	const hand = $derived(view.hand);
	const result = $derived(hand?.result ?? null);
	const inHand = $derived(hand !== null && result === null);
	const nameOf = (seat: number) => view.seats[seat]?.name ?? `Seat ${seat + 1}`;
	const board = $derived(Array.from({ length: 5 }, (_, i) => hand?.board[i]));
	const lines = $derived(
		connection.log
			.map((event) => ({ seq: event.seq, text: describeEvent(event, nameOf) }))
			.filter((line): line is { seq: number; text: string } => line.text !== null)
			.slice(-12)
			.reverse()
	);
	const winners = $derived(
		result
			? result.pots.map((pot, i) => ({
					key: i,
					text: `${pot.winners.map(nameOf).join(' and ')} ${pot.winners.length > 1 ? 'split' : 'wins'} ${pot.amount}${result.pots.length > 1 ? (i === 0 ? ' (main pot)' : ' (side pot)') : ''}`
				}))
			: []
	);
	const waitingFor = $derived(view.turn && view.turn.seat !== mine ? nameOf(view.turn.seat) : null);

	let rebuyAmount = $state(0);
	const rebuyRoom = $derived(me ? view.settings.max_buy_in - me.stack - view.you.pending_rebuy : 0);
	$effect.pre(() => {
		if (rebuyAmount <= 0 || rebuyAmount > rebuyRoom) rebuyAmount = Math.max(0, rebuyRoom);
	});
	const busted = $derived(me !== null && me.stack === 0 && !inHand);
</script>

<section class="nl-table" aria-label="Table">
	<div class="arena seats-{count}">
		<div class="felt">
			<div class="centre">
				<div class="meta">
					{#if hand}Hand #{hand.hand_no} · {hand.street}{:else}Waiting for players{/if}
				</div>
				<div class="board" aria-label="Board">
					{#each board as card, i (i)}
						<PlayingCard {card} />
					{/each}
				</div>
				{#if hand && !result}<div class="pot">Pot {hand.pot}</div>{/if}
				{#if result}
					<div class="result" role="status">
						{#each winners as line (line.key)}<div>{line.text}</div>{/each}
					</div>
				{/if}
			</div>
		</div>
		<div class="ring">
			{#each view.seats as info, seat (seat)}
				{#if info}
					<NlSeat
						{info}
						place={placeClass(seat, mine, count)}
						me={seat === mine}
						button={hand?.button === seat}
						turn={inHand ? view.turn : null}
						{now}
						won={result ? (result.winnings[seat] ?? 0) : 0}
					/>
				{:else}
					<div class="empty {placeClass(seat, mine, count)}" aria-hidden="true">Empty</div>
				{/if}
			{/each}
		</div>
	</div>

	{#if view.you.legal && hand && view.turn}
		<ActionPanel
			legal={view.you.legal}
			{hand}
			turnSeq={view.turn.seq}
			disabled={!connection.connected || connection.pending}
			onact={(action, amount) => connection.act(action, amount)}
		/>
	{:else}
		<p class="waiting" role="status">
			{#if busted}
				You are out of chips. Rebuy to keep playing.
			{:else if view.you.sitting_out}
				You are sitting out.
			{:else if waitingFor}
				Waiting for {waitingFor}…
			{:else if result}
				Next hand soon…
			{:else}
				&nbsp;
			{/if}
		</p>
	{/if}

	{#if me}
		<div class="controls">
			{#if view.you.sitting_out || view.you.sitting_out_next}
				<button type="button" onclick={() => connection.sitIn()}>I’m back</button>
			{:else}
				<button type="button" onclick={() => connection.sitOut()}>Sit out next hand</button>
			{/if}
			{#if rebuyRoom > 0 && !me.leaving}
				<form
					class="rebuy"
					onsubmit={(e) => {
						e.preventDefault();
						connection.rebuy(Math.floor(rebuyAmount));
					}}
				>
					<label>
						<span class="visually-hidden">Rebuy amount</span>
						<input type="number" min="1" max={rebuyRoom} step="1" bind:value={rebuyAmount} />
					</label>
					<button type="submit">Rebuy</button>
				</form>
			{/if}
			{#if view.you.pending_rebuy}
				<span class="note">+{view.you.pending_rebuy} after this hand</span>
			{/if}
			<button type="button" class="leave" onclick={() => connection.leave()}>Leave table</button>
		</div>
	{/if}

	<section class="log" aria-label="Hand log">
		<h2 class="visually-hidden">Hand log</h2>
		<ol>
			{#each lines as line (line.seq)}<li>{line.text}</li>{/each}
		</ol>
	</section>
</section>

<style>
	.nl-table {
		display: grid;
		gap: 14px;
	}
	.arena {
		position: relative;
		padding: 76px 70px;
	}
	.felt {
		aspect-ratio: 16 / 9;
		border-radius: 50%;
		background: radial-gradient(ellipse at center, var(--felt) 55%, var(--felt-edge) 100%);
		border: 10px solid #3b2a1a;
		box-shadow: inset 0 0 30px rgb(0 0 0 / 0.45);
		display: grid;
		place-items: center;
	}
	.ring {
		position: absolute;
		inset: 76px 70px;
	}
	.centre {
		display: grid;
		justify-items: center;
		gap: 6px;
		text-align: center;
	}
	.meta {
		color: var(--muted);
		font-size: 0.85rem;
		text-transform: capitalize;
	}
	.board {
		display: flex;
		gap: 4px;
	}
	.pot {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.result {
		color: var(--win);
		font-size: 0.9rem;
	}
	.empty {
		position: absolute;
		transform: translate(-50%, -50%);
		color: var(--muted);
		font-size: 0.75rem;
		border: 1px dashed var(--panel-2);
		border-radius: 9px;
		padding: 6px 10px;
	}
	.waiting {
		text-align: center;
		color: var(--muted);
		margin: 0;
		min-height: 1.4em;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		justify-content: center;
	}
	.controls button {
		padding: 8px 12px;
		border-radius: 8px;
		border: 1px solid var(--panel-2);
		background: var(--panel);
		color: var(--text);
	}
	.rebuy {
		display: flex;
		gap: 6px;
	}
	.rebuy input {
		width: 96px;
		padding: 8px;
		border-radius: 8px;
		border: 1px solid var(--panel-2);
		background: var(--bg);
		color: var(--text);
		font: inherit;
	}
	.note {
		color: var(--muted);
		font-size: 0.85rem;
	}
	.log ol {
		list-style: none;
		margin: 0;
		padding: 0;
		color: var(--muted);
		font-size: 0.85rem;
		display: grid;
		gap: 2px;
	}
	@media (max-width: 600px) {
		.arena {
			padding: 60px 40px;
		}
		.ring {
			inset: 60px 40px;
		}
		.felt {
			aspect-ratio: 2 / 3;
			border-width: 7px;
		}
		.board {
			display: grid;
			grid-template-columns: repeat(3, auto);
			justify-content: center;
		}
	}
</style>

<script lang="ts">
	import { onMount } from 'svelte';
	import { tableCardUrls } from '../card-assets.ts';
	import PlayingCard from '../components/PlayingCard.svelte';
	import type { RelationKind, ReportReason, TableView } from '../protocol-v2.ts';
	import ActionPanel from './ActionPanel.svelte';
	import { describeEvent } from './bet.ts';
	import type { NlConnection } from './connection.svelte.ts';
	import { chipFor } from './faces.ts';
	import { betClass, placeClass, sideClass } from './layout.ts';
	import NlSeat from './NlSeat.svelte';
	import { REACTIONS, REPORT_REASONS, relationText } from './safety.ts';
	import './seat-places.css';

	let { view, connection }: { view: TableView; connection: NlConnection } = $props();

	// Fetch the faces and the back once, so no card pops in mid-deal.
	onMount(() => {
		for (const src of tableCardUrls()) new Image().src = src;
	});

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
			.map((event) => ({
				seq: event.seq,
				text: describeEvent(event, (seat) => event.who ?? nameOf(seat))
			}))
			.filter((line): line is { seq: number; text: string } => line.text !== null)
			.slice(-30)
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
	const myTurn = $derived(Boolean(view.you.legal && hand && view.turn));

	let rebuyAmount = $state(0);
	const rebuyRoom = $derived(me ? view.settings.max_buy_in - me.stack - view.you.pending_rebuy : 0);
	$effect.pre(() => {
		if (rebuyAmount <= 0 || rebuyAmount > rebuyRoom) rebuyAmount = Math.max(0, rebuyRoom);
	});
	const busted = $derived(me !== null && me.stack === 0 && !inHand);

	// Seating from the table (P4.3): a spectator can hold an empty seat, take
	// any seat, or wait in line; a held seat waits for its player to buy in.
	const hold = $derived(view.you.hold);
	const holdAt = $derived(new Map(view.holds.map((h) => [h.seat, h])));
	const room = $derived(
		view.seats.some((info, seat) => !holdAt.has(seat) && (info === null || info.kind === 'bot'))
	);
	const holdLeft = $derived(hold?.until ? Math.max(0, Math.ceil(hold.until - now)) : null);
	const most = $derived(Math.min(view.settings.max_buy_in, connection.balance ?? Infinity));
	let buyIn = $state(0);
	$effect.pre(() => {
		const low = view.settings.min_buy_in;
		if (buyIn < low || buyIn > view.settings.max_buy_in) buyIn = Math.max(low, most);
	});
	const short = $derived(
		connection.balance !== null && connection.balance < view.settings.min_buy_in
	);
	let seating = $state(false);

	async function seatTask(task: () => Promise<unknown>) {
		seating = true;
		try {
			await task();
		} catch (e) {
			connection.notify(e instanceof Error ? e.message : String(e));
		} finally {
			seating = false;
		}
	}

	// Safety (P4.5): the menu for another person's seat, and the reactions row.
	let picked = $state<number | null>(null);
	const pickedInfo = $derived(picked === null ? null : view.seats[picked]);
	const pickedRelation = $derived(connection.relationOf(pickedInfo?.ref ?? null));
	let reason = $state<ReportReason>('abuse');
	let reported = $state<string | null>(null);
	let busy = $state(false);
	let reacting = $state(false);
	$effect.pre(() => {
		// The menu closes when its player leaves the seat.
		if (picked !== null && (!pickedInfo || pickedInfo.kind !== 'human')) picked = null;
	});

	function pick(seat: number) {
		reported = null;
		picked = picked === seat ? null : seat;
	}

	async function safetyTask(task: () => Promise<void>) {
		busy = true;
		try {
			await task();
		} catch (e) {
			connection.notify(e instanceof Error ? e.message : String(e));
		} finally {
			busy = false;
		}
	}

	function toggle(kind: RelationKind) {
		const seat = picked;
		const ref = pickedInfo?.ref;
		if (seat === null || !ref) return;
		void safetyTask(() =>
			pickedRelation === kind ? connection.unrelate(ref) : connection.relate(seat, kind)
		);
	}

	function sendReport() {
		const seat = picked;
		if (seat === null) return;
		void safetyTask(async () => {
			const recorded = await connection.report(seat, reason);
			reported = recorded
				? 'Thanks: the report was sent for review.'
				: 'You already reported this today; it counts once.';
		});
	}

	let sharing = $state(false);
	let copied = $state(false);
	const inviteLink = $derived(
		view.invite ? `${location.origin}/?invite=${encodeURIComponent(view.invite)}` : null
	);
	async function copyInvite() {
		if (!inviteLink) return;
		try {
			await navigator.clipboard.writeText(inviteLink);
			copied = true;
			setTimeout(() => (copied = false), 2000);
		} catch {
			// The field shows the link to copy by hand.
		}
	}
</script>

<section class="nl-table" class:my-turn={myTurn} aria-label="Table">
	<div class="bar">
		{#if me}
			<button type="button" class="px-btn small leave" onclick={() => connection.leave()}>
				<span aria-hidden="true">←</span> Leave table
			</button>
		{:else}
			<button type="button" class="px-btn small leave" onclick={() => connection.leave()}>
				<span aria-hidden="true">←</span> Lobby
			</button>
		{/if}
		{#if inviteLink}
			<button
				type="button"
				class="px-btn small"
				aria-expanded={sharing}
				onclick={() => (sharing = !sharing)}
			>
				Invite
			</button>
		{/if}
		<div class="meta">
			{#if hand}Hand #{hand.hand_no} · {hand.street}{:else}Waiting for players{/if}
		</div>
		<div class="stakes" aria-label="Blinds">
			<span class="sprite chip chip-red" aria-hidden="true"></span>{view.settings.small_blind}/{view
				.settings.big_blind}
		</div>
		{#if sharing && inviteLink}
			<div class="share px-inset" role="group" aria-label="Invite link">
				<label>
					<span class="visually-hidden">Invite link</span>
					<input
						class="px-field"
						type="text"
						readonly
						value={inviteLink}
						onfocus={(e) => e.currentTarget.select()}
					/>
				</label>
				<button type="button" class="px-btn small amber" onclick={copyInvite}>
					{copied ? 'Copied' : 'Copy'}
				</button>
				<span class="note">This private table is not listed: anyone with the link can join.</span>
			</div>
		{/if}
		{#if picked !== null && pickedInfo}
			<div class="player-menu px-inset" role="dialog" aria-label="Player {pickedInfo.name}">
				<p class="who-menu">
					<strong>{pickedInfo.name}</strong>{#if pickedRelation}<span class="note">
							{` · ${relationText(pickedRelation)}`}
						</span>{/if}
				</p>
				<div class="menu-row">
					<button
						type="button"
						class="px-btn small"
						aria-pressed={pickedRelation === 'mute'}
						disabled={busy}
						onclick={() => toggle('mute')}
					>
						{pickedRelation === 'mute' ? 'Unmute' : 'Mute'}
					</button>
					<button
						type="button"
						class="px-btn small red"
						aria-pressed={pickedRelation === 'block'}
						disabled={busy}
						onclick={() => toggle('block')}
					>
						{pickedRelation === 'block' ? 'Unblock' : 'Block'}
					</button>
					<button type="button" class="px-btn small" onclick={() => (picked = null)}>Close</button>
				</div>
				<p class="hint">
					Muting hides their reactions. Blocking also keeps quick seat from seating you together.
				</p>
				<form
					class="menu-row"
					onsubmit={(e) => {
						e.preventDefault();
						sendReport();
					}}
				>
					<label>
						<span class="visually-hidden">Reason</span>
						<select class="px-field" bind:value={reason}>
							{#each REPORT_REASONS as option (option.reason)}
								<option value={option.reason}>{option.text}</option>
							{/each}
						</select>
					</label>
					<button type="submit" class="px-btn small amber" disabled={busy}>Report</button>
				</form>
				{#if reported}<p class="note" role="status">{reported}</p>{/if}
			</div>
		{/if}
	</div>

	<div class="arena seats-{count}">
		<div class="stage">
			<div class="felt" aria-hidden="true"></div>
			<div class="centre">
				<div class="pot-line">
					{#if hand && !result}
						<span class="sprite pot-pile" aria-hidden="true"></span>
						<span class="pot">Pot {hand.pot}</span>
					{/if}
				</div>
				<div class="board" aria-label="Board">
					{#each board as card, i (i)}
						<PlayingCard {card} />
					{/each}
				</div>
				<div class="result" role="status">
					{#each winners as line (line.key)}<div>{line.text}</div>{/each}
				</div>
			</div>
			{#each view.seats as info, seat (seat)}
				{#if info}
					<NlSeat
						{info}
						place={placeClass(seat, mine, count)}
						side={sideClass(seat, mine, count)}
						me={seat === mine}
						button={hand?.button === seat}
						turn={inHand ? view.turn : null}
						{now}
						won={result ? (result.winnings[seat] ?? 0) : 0}
						reaction={connection.reactions[seat]?.text ?? null}
						relation={relationText(connection.relationOf(info.ref))}
						onselect={info.kind === 'human' && seat !== mine ? () => pick(seat) : undefined}
					/>
					{#if info.bet > 0 && !result}
						<div class="bet {betClass(seat, mine, count)}">
							<span
								class="sprite chip {chipFor(info.bet, view.settings.big_blind)}"
								aria-hidden="true"
							></span>
							<span>Bet {info.bet}</span>
						</div>
					{/if}
				{:else if holdAt.has(seat)}
					<div class="empty held {placeClass(seat, mine, count)}">
						{hold?.seat === seat ? 'Your seat' : 'Held'}
					</div>
				{:else if mine === null && !hold && view.you.waitlist_position === null}
					<button
						type="button"
						class="empty open {placeClass(seat, mine, count)}"
						disabled={seating || short}
						onclick={() => seatTask(() => connection.holdSeat(seat))}
					>
						Sit here<span class="visually-hidden">, seat {seat + 1}</span>
					</button>
				{:else}
					<div class="empty {placeClass(seat, mine, count)}" aria-hidden="true">Empty</div>
				{/if}
			{/each}
		</div>
	</div>

	<div class="dock">
		{#if !me}
			<div class="join px-inset" role="group" aria-label="Take a seat">
				{#if hold?.ready}
					<p role="status">
						Seat {hold.seat + 1} is held for you{holdLeft !== null ? ` for ${holdLeft}s` : ''}. Buy
						in to sit down.
					</p>
					<form
						class="buy-in"
						onsubmit={(e) => {
							e.preventDefault();
							connection.sit(hold!.seat, Math.floor(buyIn));
						}}
					>
						<label>
							<span class="visually-hidden">Buy-in</span>
							<input
								class="px-field"
								type="number"
								inputmode="numeric"
								min={view.settings.min_buy_in}
								max={view.settings.max_buy_in}
								step="1"
								bind:value={buyIn}
							/>
						</label>
						<button type="submit" class="px-btn amber" disabled={short || !connection.connected}>
							Sit down
						</button>
						<button
							type="button"
							class="px-btn small"
							disabled={seating}
							onclick={() => seatTask(() => connection.giveUpHold())}
						>
							Give up
						</button>
					</form>
					<p class="hint">
						Buy in for {view.settings.min_buy_in.toLocaleString('en-US')} to {view.settings.max_buy_in.toLocaleString(
							'en-US'
						)} play chips.
					</p>
				{:else if hold}
					<p role="status">Seat {hold.seat + 1} is yours when the bot there finishes this hand.</p>
					<button
						type="button"
						class="px-btn small"
						disabled={seating}
						onclick={() => seatTask(() => connection.giveUpHold())}
					>
						Give up the seat
					</button>
				{:else if view.you.waitlist_position !== null}
					<p role="status">
						You are number {view.you.waitlist_position} in line. A seat is held for you when one opens.
					</p>
					<button
						type="button"
						class="px-btn small"
						disabled={seating}
						onclick={() => seatTask(() => connection.leaveWaitlist(view.table_id))}
					>
						Leave the line
					</button>
				{:else}
					<p role="status">
						You are watching.{short ? ' You need more play chips to sit at this table.' : ''}
					</p>
					{#if room}
						<button
							type="button"
							class="px-btn amber"
							disabled={seating || short}
							onclick={() => seatTask(() => connection.takeSeat(view.table_id))}
						>
							Sit down
						</button>
					{:else}
						<button
							type="button"
							class="px-btn amber"
							disabled={seating || short}
							onclick={() => seatTask(() => connection.joinWaitlist(view.table_id))}
						>
							Join the waitlist
						</button>
					{/if}
				{/if}
			</div>
		{:else if view.you.legal && hand && view.turn}
			<ActionPanel
				legal={view.you.legal}
				{hand}
				turnSeq={view.turn.seq}
				disabled={!connection.connected || connection.pending}
				onact={(action, amount) => connection.act(action, amount)}
			/>
		{:else}
			<p class="waiting px-inset" role="status">
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
	</div>

	{#if me}
		<div class="tools">
			{#if view.you.sitting_out || view.you.sitting_out_next}
				<button type="button" class="px-btn small green" onclick={() => connection.sitIn()}>
					I’m back
				</button>
			{:else}
				<button type="button" class="px-btn small" onclick={() => connection.sitOut()}>
					Sit out next hand
				</button>
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
						<input
							class="px-field"
							type="number"
							inputmode="numeric"
							min="1"
							max={rebuyRoom}
							step="1"
							bind:value={rebuyAmount}
						/>
					</label>
					<button type="submit" class="px-btn small">Rebuy</button>
				</form>
			{/if}
			{#if view.you.pending_rebuy}
				<span class="note">+{view.you.pending_rebuy} after this hand</span>
			{/if}
			<button
				type="button"
				class="px-btn small"
				aria-expanded={reacting}
				aria-controls="reactions"
				onclick={() => (reacting = !reacting)}
			>
				React
			</button>
			{#if reacting}
				<div id="reactions" class="reactions" role="group" aria-label="Reactions">
					{#each REACTIONS as option (option.kind)}
						<button
							type="button"
							class="px-btn small"
							disabled={!connection.connected}
							onclick={() => connection.react(option.kind)}
						>
							{option.text}
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	<section class="log px-inset" aria-label="Hand log">
		<h2>Hand log</h2>
		<ol>
			{#each lines as line (line.seq)}<li>{line.text}</li>{/each}
		</ol>
	</section>
	<p class="play-money">Play chips only: they can never be bought, sold or cashed out.</p>
</section>

<style>
	/* Wide screens: the table on the left; the action dock, the seat tools and
	   the hand log in a column on the right. */
	.nl-table {
		display: grid;
		column-gap: 16px;
		row-gap: 12px;
		grid-template-columns: minmax(0, 1fr) 360px;
		grid-template-rows: auto auto auto 1fr auto;
		grid-template-areas:
			'bar bar'
			'arena dock'
			'arena tools'
			'arena log'
			'money money';
		align-items: start;
	}
	.bar {
		grid-area: bar;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
		min-height: 48px;
	}
	.meta {
		flex: 1;
		text-align: center;
		text-transform: capitalize;
		color: var(--mist);
		text-shadow: var(--shadow-text);
	}
	.stakes {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--paper-shade);
		text-shadow: var(--shadow-text);
		margin-left: auto;
	}
	.stakes .chip {
		width: 14px;
		height: 14px;
	}

	/* The arena leaves room around the felt for the seats on its rail. */
	.arena {
		grid-area: arena;
		padding: 64px 74px 108px;
	}
	.stage {
		position: relative;
		width: min(100%, calc((100dvh - 340px) * 2.1));
		min-width: min(100%, 560px);
		aspect-ratio: 21 / 10;
		margin: 0 auto;
	}
	.felt {
		--table-px: 3px;
		position: absolute;
		inset: 0;
		border: calc(48 * var(--table-px)) solid transparent;
		border-image: url('../art/ui/table.png') 48 fill stretch;
		image-rendering: pixelated;
		display: grid;
		place-items: center;
		filter: drop-shadow(0 calc(3 * var(--table-px)) 0 rgb(0 0 0 / 0.45));
	}
	.centre {
		position: absolute;
		left: 50%;
		top: 48%;
		transform: translate(-50%, -50%);
		display: grid;
		justify-items: center;
		gap: 8px;
		text-align: center;
		z-index: 1;
		--k: 1.4;
	}
	.pot-line {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 32px;
	}
	.pot {
		color: var(--gold-light);
		text-shadow: var(--shadow-text);
	}
	.board {
		display: flex;
		gap: 8px;
	}
	.result {
		min-height: 28px;
		color: var(--gold);
		text-shadow: var(--shadow-text);
	}
	.bet {
		position: absolute;
		transform: translate(-50%, -50%);
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 2px 8px 2px 4px;
		background: rgb(12 13 21 / 0.72);
		color: var(--paper);
		font-size: var(--fs-s);
		white-space: nowrap;
		z-index: 2;
		animation: pop 0.2s steps(3, end);
	}
	.bet .chip {
		width: 22px;
		height: 22px;
	}
	.empty {
		position: absolute;
		transform: translate(-50%, -50%);
		padding: 4px 10px;
		color: var(--haze);
		font-size: var(--fs-s);
		border: var(--px) dashed var(--felt-light);
		background: rgb(12 13 21 / 0.35);
	}
	.empty.held {
		color: var(--amber);
		border-color: var(--amber-dark);
	}
	button.empty.open {
		font: inherit;
		font-size: var(--fs-s);
		color: var(--gold-light);
		border-color: var(--gold);
		cursor: pointer;
		z-index: 3;
	}
	button.empty.open:hover:not(:disabled),
	button.empty.open:focus-visible {
		background: rgb(12 13 21 / 0.7);
		outline: var(--px) solid var(--gold-light);
	}
	button.empty.open:disabled {
		cursor: default;
		opacity: 0.6;
	}
	.share {
		flex: 1 1 100%;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		padding: 8px;
	}
	.player-menu {
		flex: 1 1 100%;
		display: grid;
		gap: 8px;
		padding: 8px;
		color: var(--mist);
	}
	.player-menu p {
		margin: 0;
	}
	.who-menu strong {
		color: var(--gold-light);
		font-weight: normal;
	}
	.menu-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
	}
	.player-menu .hint {
		font-size: var(--fs-s);
		color: var(--paper-shade);
	}
	.reactions {
		flex: 1 1 100%;
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.share label {
		flex: 1 1 260px;
		min-width: 0;
	}
	.share input {
		width: 100%;
	}
	.join {
		display: grid;
		gap: 10px;
		justify-items: center;
		text-align: center;
		padding: 10px 12px 12px;
		color: var(--mist);
	}
	.buy-in {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: center;
		gap: 8px;
	}
	.buy-in input {
		width: 130px;
		text-align: right;
	}
	.join .hint {
		color: var(--haze);
		font-size: var(--fs-s);
	}
	@keyframes pop {
		from {
			transform: translate(-50%, -50%) scale(0.6);
			opacity: 0;
		}
	}

	/* The dock keeps its height whether or not it is the viewer's turn, so
	   nothing below it moves when the action panel opens. */
	.dock {
		grid-area: dock;
		min-height: 196px;
		display: grid;
		align-content: start;
	}
	.waiting {
		min-height: 64px;
		display: grid;
		place-items: center;
		text-align: center;
		color: var(--mist);
		padding: 0 12px;
	}
	.tools {
		grid-area: tools;
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: center;
		justify-content: center;
	}
	.rebuy {
		display: flex;
		gap: 6px;
		align-items: center;
	}
	.rebuy input {
		width: 120px;
		text-align: right;
	}
	.note {
		color: var(--green-light);
		text-shadow: var(--shadow-text);
	}
	.log {
		grid-area: log;
		align-self: stretch;
		padding: 8px;
		min-height: 120px;
		max-height: 440px;
		overflow: auto;
	}
	.log h2 {
		font-size: var(--fs);
		color: var(--gold);
		text-shadow: var(--shadow-text);
		margin-bottom: 6px;
	}
	.log ol {
		list-style: none;
		margin: 0;
		padding: 0;
		color: var(--mist);
		font-size: var(--fs-s);
		display: grid;
		gap: 4px;
	}
	.log li:first-child {
		color: var(--paper);
	}
	.play-money {
		grid-area: money;
		color: var(--haze);
		font-size: var(--fs-s);
		text-align: center;
	}

	/* Smaller landscape screens (a laptop, a tablet held sideways): the same
	   side column, narrower, around a smaller table. */
	@media (max-width: 1279px) {
		.nl-table {
			grid-template-columns: minmax(0, 1fr) 300px;
		}
		.arena {
			padding: 60px 66px 96px;
		}
		.stage {
			width: min(100%, calc((100dvh - 330px) * 1.8));
			min-width: min(100%, 480px);
			aspect-ratio: 18 / 10;
		}
		.felt {
			--table-px: 2px;
		}
		.centre {
			--k: 1;
		}
		.log {
			max-height: 360px;
		}
	}

	/* Upright and narrow screens: one column, the seat tools above the table
	   (so they never move), and the dock pinned to the bottom of the screen. */
	@media (max-width: 899px), (max-width: 1279px) and (orientation: portrait) {
		.nl-table {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: none;
			grid-template-areas: 'bar' 'tools' 'arena' 'dock' 'log' 'money';
		}
		.tools {
			justify-content: flex-start;
		}
		.stage {
			width: min(100%, calc((100dvh - 520px) * 1.6));
			min-width: min(100%, 520px);
			aspect-ratio: 16 / 10;
		}
		.dock {
			position: sticky;
			bottom: 0;
			z-index: 5;
			min-height: 0;
			padding-bottom: env(safe-area-inset-bottom);
		}
		.my-turn .dock {
			background: linear-gradient(to bottom, transparent, var(--night) 12px);
		}
		.log {
			max-height: 220px;
		}
	}

	/* Tablets held upright: the tall table with roomier seats and big cards. */
	@media (min-width: 640px) and (max-width: 1099px) and (orientation: portrait) {
		.centre {
			--k: 1.4;
		}
		.board {
			gap: 6px;
		}
		.board :global(.card + .card) {
			margin-left: 0;
		}
		.stage {
			max-height: calc(100dvh - 540px);
		}
	}

	/* Phones: a tall table that fills the width, the dock pinned to the bottom. */
	@media (max-width: 639px), (max-width: 1099px) and (orientation: portrait) {
		.nl-table {
			gap: 8px;
		}
		.tools {
			gap: 6px;
		}
		.rebuy input {
			width: 84px;
			min-height: 40px;
		}
		.bar {
			gap: 8px;
			min-height: 40px;
		}
		.meta {
			font-size: var(--fs-s);
		}
		.stakes {
			font-size: var(--fs-s);
		}
		.arena {
			padding: 0 0 64px;
		}
		.stage {
			width: 100%;
			min-width: 0;
			aspect-ratio: 3 / 4;
			max-height: calc(100dvh - 380px);
			min-height: 420px;
		}
		.felt {
			--table-px: 2px;
		}
		.centre {
			top: 50%;
			gap: 6px;
		}
		.board {
			gap: 0;
		}
		.board :global(.card + .card) {
			margin-left: -6px;
		}
		.result {
			font-size: var(--fs-s);
			max-width: 300px;
		}
		.bet {
			font-size: 10px;
			padding: 0 4px 0 2px;
			gap: 3px;
		}
		.bet .chip {
			width: 14px;
			height: 14px;
		}
		.empty {
			font-size: 10px;
			padding: 2px 6px;
		}
		.waiting {
			min-height: 56px;
			font-size: var(--fs-s);
		}
		.leave {
			padding: 0 2px;
		}
	}
</style>

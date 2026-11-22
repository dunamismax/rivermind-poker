<script lang="ts">
	// Table voice in the table's bar (P4C.6): the button that offers it, and in
	// voice the microphone (mute, or hold to talk), deafen, the mark that the
	// microphone is live, and the panel. The card and the panel open over the
	// table from the bar, never pushing the table or the action panel.
	import { BITRATES, type Bitrate } from '../voice/settings.ts';
	import type { TableVoice } from './voice.svelte.ts';

	let { voice }: { voice: TableVoice } = $props();

	const open = $derived(
		voice.phase === 'offer' || voice.phase === 'failed' || (voice.inVoice && voice.panelOpen)
	);
	const BITRATE_TEXT: Record<Bitrate, string> = {
		32000: 'Saver (32 kbps)',
		64000: 'Standard (64 kbps)',
		96000: 'High (96 kbps)'
	};
	const QUALITY_TEXT = {
		good: 'Good connection',
		fair: 'Fair connection',
		poor: 'Poor connection'
	};
	const SEGMENTS = 12;
	const segments = Array.from({ length: SEGMENTS }, (_, i) => i);
	// The input's level on a scale of decibels, from -60 dB to 0.
	const lit = $derived(
		voice.level > 0
			? Math.max(
					0,
					Math.min(SEGMENTS, Math.round(((20 * Math.log10(voice.level) + 60) / 60) * SEGMENTS))
				)
			: 0
	);
	const micGlyph = $derived(
		voice.deafened ? 'voice-phones-muted' : voice.live ? 'voice-mic' : 'voice-mic-muted'
	);

	let opener = $state<HTMLButtonElement>();
	// The live mark follows the person down the page once the bar has scrolled away.
	let barShown = $state(true);
	$effect(() => {
		if (!opener || typeof IntersectionObserver === 'undefined') return;
		const watcher = new IntersectionObserver(([entry]) => (barShown = entry.isIntersecting));
		watcher.observe(opener);
		return () => watcher.disconnect();
	});

	function togglePanel() {
		if (voice.inVoice) voice.panelOpen = !voice.panelOpen;
		else if (voice.phase === 'offer') voice.choose('not-now');
		else voice.offer();
	}

	function close() {
		if (voice.phase === 'offer' || voice.phase === 'failed') voice.choose('not-now');
		voice.panelOpen = false;
		opener?.focus({ preventScroll: true });
	}

	function keydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.stopPropagation();
			close();
		}
	}

	// Hold to talk on a button: pointer or Space and Enter.
	function holdKey(event: KeyboardEvent, down: boolean) {
		if (event.key !== ' ' && event.key !== 'Enter') return;
		event.preventDefault();
		if (down && !event.repeat) voice.press();
		else if (!down) voice.release();
	}

	function select(event: Event): string | null {
		const value = (event.currentTarget as HTMLSelectElement).value;
		return value === '' ? null : value;
	}
</script>

<span class="voice-bar [display:contents]">
	{#if voice.inVoice}
		{#if voice.mode === 'talk' && voice.settings.pushToTalk}
			<button
				type="button"
				class={['px-btn small talk phone:px-1', voice.talking && 'green']}
				aria-pressed={voice.talking}
				disabled={voice.deafened}
				onpointerdown={(e) => {
					e.preventDefault();
					(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
					voice.press();
				}}
				onpointerup={() => voice.release()}
				onpointercancel={() => voice.release()}
				onlostpointercapture={() => voice.release()}
				onkeydown={(e) => holdKey(e, true)}
				onkeyup={(e) => holdKey(e, false)}
				oncontextmenu={(e) => e.preventDefault()}
				title="Hold to talk (or hold V)"
			>
				<span class="sprite voice-glyph {micGlyph} size-11" aria-hidden="true"></span>
				<span class="pocket:sr-only">Hold to talk</span>
			</button>
		{:else if voice.mode === 'talk'}
			<button
				type="button"
				class={['px-btn small mute phone:px-1', voice.selfMuted && 'red']}
				aria-pressed={voice.selfMuted}
				aria-keyshortcuts="M"
				disabled={voice.deafened}
				title="Mute your microphone (M)"
				onclick={() => voice.toggleSelfMute()}
			>
				<span class="sprite voice-glyph {micGlyph} size-11" aria-hidden="true"></span>
				<span class="pocket:sr-only">Mute</span>
			</button>
		{/if}
		<button
			type="button"
			class={['px-btn small deafen phone:px-1 pocket:hidden', voice.deafened && 'red']}
			aria-pressed={voice.deafened}
			aria-keyshortcuts="D"
			title="Hear nobody (D)"
			onclick={() => voice.toggleDeafen()}
		>
			<span
				class="sprite voice-glyph {voice.deafened ? 'voice-phones-muted' : 'voice-phones'} size-11"
				aria-hidden="true"
			></span>
			<span class="lap:sr-only">Deafen</span>
		</button>
		{#if voice.live}
			<span
				class="mic-live flex items-center gap-2 text-s whitespace-nowrap text-red-light text-shadow-ink"
				role="img"
				aria-label="Microphone live"
				title="Your microphone is live"
			>
				<span class="size-4 bg-red-light [box-shadow:0_0_0_2px_var(--color-ink)]"></span>
				<span class="pocket:hidden" aria-hidden="true">Live</span>
			</span>
		{/if}
	{/if}
	<button
		type="button"
		class={['px-btn small voice-open phone:px-1', voice.phase === 'reconnecting' && 'animate-wait']}
		aria-expanded={open}
		aria-controls="voice-popover"
		disabled={voice.phase === 'joining'}
		bind:this={opener}
		onclick={togglePanel}
	>
		{#if voice.inVoice}
			<!-- A phone's bar has room for one line: in voice, the button is its glyph alone. -->
			<span
				class="sprite voice-glyph {voice.deafened
					? 'voice-phones-muted'
					: 'voice-phones'} hidden size-11 pocket:inline-block"
				aria-hidden="true"
			></span>
		{:else}
			<span class="sprite voice-glyph voice-mic size-11 pocket:hidden" aria-hidden="true"></span>
		{/if}
		<span class={voice.inVoice ? 'pocket:sr-only' : ''}>
			{voice.phase === 'joining' ? 'Voice…' : 'Voice'}
		</span>
		{#if voice.quality}<span
				class={[
					'size-3',
					voice.quality === 'good'
						? 'bg-green-light'
						: voice.quality === 'fair'
							? 'bg-gold'
							: 'bg-red-light'
				]}
				aria-hidden="true"
			></span><span class="sr-only">, {QUALITY_TEXT[voice.quality]}</span>{/if}
	</button>
</span>

<!-- Your own state, for screen readers; the live mark for everyone once the bar has scrolled away. -->
<span class="sr-only" role="status" aria-live="polite">{voice.announcement}</span>
{#if voice.live && !barShown}
	<span
		class="mic-live-pinned px-inset fixed top-2 right-2 z-8 flex items-center gap-2 px-3 py-1 text-s text-red-light"
		role="img"
		aria-label="Microphone live"
	>
		<span class="size-4 bg-red-light"></span><span aria-hidden="true">Live</span>
	</span>
{/if}

{#if open}
	<div
		id="voice-popover"
		class="voice-panel px-inset absolute top-[calc(100%+4px)] left-0 z-7 grid max-h-[calc(100svh-120px)] phone:max-h-[calc(100svh_-_var(--above)_-_var(--zone)_-_8px)] w-[min(100%,460px)] gap-4 overflow-auto p-4 text-mist phone:inset-x-0 phone:w-auto"
		role="dialog"
		aria-label="Table voice"
		tabindex="-1"
		onkeydown={keydown}
	>
		<div class="flex items-center justify-between gap-4">
			<h2 class="text-m text-gold text-shadow-ink">Table voice</h2>
			<button type="button" class="px-btn small" onclick={close}>Close</button>
		</div>

		{#if !voice.inVoice}
			{#if voice.failure}<p class="text-s text-red-light" role="alert">{voice.failure}</p>{/if}
			<p class="text-s">
				Talk with the people at this table. Voice is end-to-end encrypted: not even this site can
				listen, and nothing is recorded. Voice is for adults (18+).
			</p>
			<div class="flex flex-wrap gap-4" role="group" aria-label="Join table voice">
				<button type="button" class="px-btn amber" onclick={() => voice.choose('join')}>
					Join voice
				</button>
				<button type="button" class="px-btn" onclick={() => voice.choose('listen')}>
					Listen only
				</button>
				<button type="button" class="px-btn small" onclick={() => voice.choose('not-now')}>
					Not now
				</button>
			</div>
			<label class="flex items-center gap-3 text-s">
				<input
					type="checkbox"
					class="size-10 accent-gold"
					checked={voice.settings.ask}
					onchange={(e) => voice.set('ask', e.currentTarget.checked)}
				/>
				Ask each time (otherwise this browser remembers your choice)
			</label>
		{:else}
			{#if voice.phase === 'reconnecting'}
				<p class="text-s text-gold" role="status">Voice was cut off. Coming back…</p>
			{:else if voice.quality}
				<p class="text-s" role="status">{QUALITY_TEXT[voice.quality]}</p>
			{/if}
			{#if voice.strangers}
				<p class="px-danger p-3 text-s text-paper" role="alert">
					Someone who is not seated at this table is in the voice group. Your microphone is off
					until they are gone.
				</p>
			{/if}
			{#if voice.needsGesture}
				<div class="flex flex-wrap items-center gap-4" role="alert">
					<span class="text-s text-gold">Your browser is holding the sound back.</span>
					<button type="button" class="px-btn small amber" onclick={() => voice.resumeSound()}>
						Turn on sound
					</button>
				</div>
			{/if}
			{#if voice.notice}<p class="text-s text-gold" role="status">{voice.notice}</p>{/if}
			{#if voice.micProblem}<p class="text-s text-red-light" role="alert">
					{voice.micProblem}
				</p>{/if}

			{#if voice.code}
				<div class="code grid gap-1">
					<p class="text-s text-paper-shade">
						Voice code. Read it aloud: everyone here should see the same four words.
					</p>
					<p
						class="voice-code text-m text-gold-light"
						aria-label="Voice code {voice.code.join(' ')}"
					>
						{voice.code.join(' · ')}
					</p>
				</div>
			{/if}

			<div class="flex flex-wrap gap-3" role="group" aria-label="Your voice">
				{#if voice.mode === 'talk'}
					<button
						type="button"
						class={['px-btn small', voice.selfMuted && 'red']}
						aria-pressed={voice.selfMuted}
						aria-keyshortcuts="M"
						disabled={voice.deafened}
						onclick={() => voice.toggleSelfMute()}
					>
						Mute (M)
					</button>
				{/if}
				<button
					type="button"
					class={['px-btn small', voice.deafened && 'red']}
					aria-pressed={voice.deafened}
					aria-keyshortcuts="D"
					onclick={() => voice.toggleDeafen()}
				>
					Deafen (D)
				</button>
				{#if voice.mode === 'talk'}
					<button type="button" class="px-btn small" onclick={() => voice.listenOnly()}>
						Listen only
					</button>
				{:else}
					<button type="button" class="px-btn small amber" onclick={() => voice.speak()}>
						Use my microphone
					</button>
				{/if}
				<button type="button" class="px-btn small red" onclick={() => voice.leave()}>
					Leave voice
				</button>
			</div>

			{#if voice.mode === 'talk'}
				<div class="flex items-center gap-4 text-s">
					<span>Input</span>
					<svg
						class="block h-6 w-73"
						viewBox="0 0 {SEGMENTS * 6 + 1} 6"
						role="meter"
						aria-label="Microphone level"
						aria-valuemin="0"
						aria-valuemax={SEGMENTS}
						aria-valuenow={lit}
						shape-rendering="crispEdges"
					>
						<rect class="fill-ink" x="0" y="0" width={SEGMENTS * 6 + 1} height="6" />
						{#each segments as i (i)}
							<rect
								class={i < lit
									? i >= SEGMENTS - 2
										? 'fill-red-light'
										: i >= SEGMENTS - 4
											? 'fill-gold'
											: 'fill-green-light'
									: 'fill-deep-slate'}
								x={1 + i * 6}
								y="1"
								width="5"
								height="4"
							/>
						{/each}
					</svg>
				</div>
			{/if}

			<details class="settings grid gap-3 text-s">
				<summary class="cursor-pointer text-gold-light">Voice settings</summary>
				<div class="mt-3 grid gap-3">
					<label class="flex items-center gap-3">
						<input
							type="checkbox"
							class="size-10 accent-gold"
							checked={voice.settings.pushToTalk}
							onchange={(e) => voice.set('pushToTalk', e.currentTarget.checked)}
						/>
						Push to talk (hold V, or hold the talk button)
					</label>
					{#if voice.inputs.length}
						<label class="grid gap-1">
							Microphone
							<select
								class="px-field"
								value={voice.settings.input ?? ''}
								onchange={(e) => voice.set('input', select(e))}
							>
								<option value="">The browser's default</option>
								{#each voice.inputs as input (input.id)}
									<option value={input.id}>{input.label}</option>
								{/each}
							</select>
						</label>
					{/if}
					{#if voice.canChooseOutput && voice.outputs.length}
						<label class="grid gap-1">
							Speakers
							<select
								class="px-field"
								value={voice.settings.output ?? ''}
								onchange={(e) => voice.set('output', select(e))}
							>
								<option value="">The browser's default</option>
								{#each voice.outputs as output (output.id)}
									<option value={output.id}>{output.label}</option>
								{/each}
							</select>
						</label>
					{/if}
					<fieldset class="grid gap-2">
						<legend class="mb-1">The microphone's processing</legend>
						<label class="flex items-center gap-3">
							<input
								type="checkbox"
								class="size-10 accent-gold"
								checked={voice.settings.echoCancellation}
								onchange={(e) => voice.set('echoCancellation', e.currentTarget.checked)}
							/>
							Echo cancellation
						</label>
						<label class="flex items-center gap-3">
							<input
								type="checkbox"
								class="size-10 accent-gold"
								checked={voice.settings.noiseSuppression}
								onchange={(e) => voice.set('noiseSuppression', e.currentTarget.checked)}
							/>
							Noise suppression
						</label>
						<label class="flex items-center gap-3">
							<input
								type="checkbox"
								class="size-10 accent-gold"
								checked={voice.settings.autoGainControl}
								onchange={(e) => voice.set('autoGainControl', e.currentTarget.checked)}
							/>
							Automatic gain
						</label>
						<label class="flex items-center gap-3">
							<input
								type="checkbox"
								class="size-10 accent-gold"
								checked={voice.settings.denoise}
								onchange={(e) => voice.set('denoise', e.currentTarget.checked)}
							/>
							Stronger noise suppression (RNNoise)
						</label>
						{#if voice.settings.denoise && voice.denoiseProblem}
							<p class="text-paper-shade" role="status">{voice.denoiseProblem}</p>
						{/if}
					</fieldset>
					<label class="grid gap-1">
						Quality
						<select
							class="px-field"
							value={voice.settings.bitrate}
							onchange={(e) => voice.set('bitrate', Number(e.currentTarget.value) as Bitrate)}
						>
							{#each BITRATES as rate (rate)}
								<option value={rate}>{BITRATE_TEXT[rate]}</option>
							{/each}
						</select>
					</label>
					<label class="flex items-center gap-3">
						<input
							type="checkbox"
							class="size-10 accent-gold"
							checked={voice.settings.spatial}
							onchange={(e) => voice.set('spatial', e.currentTarget.checked)}
						/>
						Each voice from its seat's side of the table
					</label>
					<label class="flex items-center gap-3">
						<input
							type="checkbox"
							class="size-10 accent-gold"
							checked={voice.settings.ask}
							onchange={(e) => voice.set('ask', e.currentTarget.checked)}
						/>
						Ask before joining voice at each table
					</label>
					<p class="text-paper-shade">
						Keys: M mutes you, D deafens you{voice.settings.pushToTalk
							? ', and holding V talks'
							: ''}. Each player's mute and volume are on their seat's menu.
					</p>
				</div>
			</details>
		{/if}
	</div>
{/if}

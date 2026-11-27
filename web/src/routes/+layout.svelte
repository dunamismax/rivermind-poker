<script lang="ts">
	import '../app.css';
	import { look } from '#lib/look.svelte.ts';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// The look this browser chose (Phase 5C), on <html> before anything renders.
	look.start();
</script>

{@render children()}

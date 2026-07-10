<script lang="ts">
	import type { Snippet } from 'svelte';

	let { title, subtitle, children }: { title: string; subtitle?: string; children: Snippet } =
		$props();
</script>

<div class="wrap">
	<div class="card">
		<h1>{title}</h1>
		{#if subtitle}<p class="subtitle">{subtitle}</p>{/if}
		{@render children()}
	</div>
</div>

<style>
	.wrap {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		background: #f4f5f7;
		padding: 1rem;
	}

	.card {
		width: 100%;
		max-width: 22rem;
		background: #fff;
		border: 1px solid #e2e4e8;
		border-radius: 10px;
		padding: 2rem;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.06);
	}

	h1 {
		margin: 0 0 0.25rem;
		font-size: 1.25rem;
		font-weight: 600;
	}

	.subtitle {
		margin: 0 0 1.25rem;
		color: #667;
		font-size: 0.875rem;
	}

	/* Shared form styling for the auth screens rendered inside the card. */
	.card :global(form) {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.card :global(label) {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.8125rem;
		font-weight: 500;
		color: #445;
	}

	.card :global(input) {
		padding: 0.5rem 0.625rem;
		border: 1px solid #cfd3da;
		border-radius: 6px;
		font-size: 0.9375rem;
		font-family: inherit;
	}

	.card :global(input:focus) {
		outline: 2px solid #4a6cf7;
		outline-offset: -1px;
		border-color: #4a6cf7;
	}

	.card :global(input.code) {
		font-size: 1.375rem;
		letter-spacing: 0.5em;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	.card :global(button[type='submit']) {
		margin-top: 0.25rem;
		padding: 0.5625rem;
		border: none;
		border-radius: 6px;
		background: #4a6cf7;
		color: #fff;
		font-size: 0.9375rem;
		font-weight: 600;
		font-family: inherit;
		cursor: pointer;
	}

	.card :global(button[type='submit']:hover) {
		background: #3a5ae0;
	}

	.card :global(button[type='submit']:disabled) {
		background: #a9b4d8;
		cursor: default;
	}

	.card :global(.error) {
		margin: 0;
		padding: 0.5rem 0.625rem;
		border-radius: 6px;
		background: #fdecec;
		color: #b3261e;
		font-size: 0.8125rem;
	}

	.card :global(.signout) {
		margin: 1rem 0 0;
		text-align: center;
		font-size: 0.8125rem;
	}

	.card :global(.signout button) {
		border: none;
		background: none;
		padding: 0;
		color: #667;
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
</style>

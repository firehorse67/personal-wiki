<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const updated = $derived(
		new Date(data.updatedAt).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'long',
			day: 'numeric'
		})
	);
</script>

<svelte:head>
	<title>{data.title} — Personal Wiki</title>
	<meta name="robots" content="noindex" />
	<meta property="og:title" content={data.title} />
	<meta property="og:type" content="article" />
</svelte:head>

<div class="page">
	<article>
		<h1>{data.title}</h1>
		<div class="content">
			<!-- eslint-disable-next-line svelte/no-at-html-tags — sanitized server-side -->
			{@html data.html}
		</div>
		<footer>
			<span>Updated {updated}</span>
			<span class="brand">Personal Wiki</span>
		</footer>
	</article>
</div>

<style>
	.page {
		min-height: 100dvh;
		background: #f4f5f7;
		padding: 2rem 1rem;
	}

	article {
		max-width: 46rem;
		margin: 0 auto;
		background: #ffffff;
		border: 1px solid #e2e4e8;
		border-radius: 10px;
		padding: 2.5rem 3rem;
		color: #1d2129;
		font-family:
			system-ui,
			-apple-system,
			'Segoe UI',
			Roboto,
			sans-serif;
	}

	h1 {
		margin: 0 0 1.5rem;
		font-size: 1.875rem;
		line-height: 1.25;
		color: #00361f;
	}

	.content {
		line-height: 1.7;
		font-size: 1rem;
		overflow-wrap: break-word;
	}

	.content :global(img) {
		max-width: 100%;
		height: auto;
		border-radius: 6px;
	}

	.content :global(pre) {
		background: #f0f2f5;
		border-radius: 6px;
		padding: 0.75rem 1rem;
		overflow-x: auto;
	}

	.content :global(blockquote) {
		border-left: 3px solid #c66930;
		margin-left: 0;
		padding-left: 1rem;
		color: #4c525d;
	}

	.content :global(a) {
		color: #c66930;
	}

	footer {
		display: flex;
		justify-content: space-between;
		margin-top: 2.5rem;
		padding-top: 1rem;
		border-top: 1px solid #e2e4e8;
		font-size: 0.8125rem;
		color: #99a;
	}

	.brand {
		font-weight: 600;
		color: #c66930;
	}

	@media (max-width: 640px) {
		article {
			padding: 1.5rem 1.25rem;
		}
	}
</style>

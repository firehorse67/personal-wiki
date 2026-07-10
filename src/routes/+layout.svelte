<script lang="ts">
	import { auth, initAuth } from '$lib/auth.svelte';
	import LoginForm from '$lib/components/LoginForm.svelte';
	import MfaEnroll from '$lib/components/MfaEnroll.svelte';
	import MfaChallenge from '$lib/components/MfaChallenge.svelte';

import { dev } from '$app/environment';
	import { page } from '$app/state';

	let { children } = $props();

	// Public routes render outside the auth gate; /share/[id] does its own
	// authorization server-side (the isShared attribute check).
	const isPublicRoute = $derived(page.url.pathname.startsWith('/share/'));

	$effect(() => {
		initAuth();
		if ('serviceWorker' in navigator && !dev) {
			navigator.serviceWorker.register('/service-worker.js', {
				type: 'module'
			}).catch((err) => {
				console.error('Service worker registration failed:', err);
			});
		}
	});
</script>

<svelte:head>
	<link rel="icon" href="/favicon.ico" sizes="48x48" />
	<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
	<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
	<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
	<link rel="manifest" href="/manifest.json" />
</svelte:head>

{#if isPublicRoute}
	{@render children()}
{:else if auth.stage === 'loading'}
	<div class="loading" aria-busy="true"></div>
{:else if auth.stage === 'signed_out'}
	<LoginForm />
{:else if auth.stage === 'mfa_enroll'}
	<MfaEnroll />
{:else if auth.stage === 'mfa_challenge'}
	<MfaChallenge />
{:else}
	{@render children()}
{/if}

<style>
	:global(body) {
		margin: 0;
		font-family:
			system-ui,
			-apple-system,
			'Segoe UI',
			Roboto,
			sans-serif;
		color: #1d2129;
	}

	.loading {
		min-height: 100dvh;
		background: #f4f5f7;
	}
</style>

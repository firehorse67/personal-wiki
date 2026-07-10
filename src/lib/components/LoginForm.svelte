<script lang="ts">
	import AuthShell from '$lib/components/AuthShell.svelte';
	import { auth } from '$lib/auth.svelte';

	let email = $state('');
	let password = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = null;
		error = await auth.signIn(email, password);
		busy = false;
	}
</script>

<AuthShell title="Personal Wiki" subtitle="Sign in to continue">
	<form onsubmit={submit}>
		<label>
			Email
			<input type="email" autocomplete="email" required bind:value={email} />
		</label>
		<label>
			Password
			<input type="password" autocomplete="current-password" required bind:value={password} />
		</label>
		{#if error}<p class="error">{error}</p>{/if}
		<button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
	</form>
</AuthShell>

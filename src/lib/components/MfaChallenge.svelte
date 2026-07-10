<script lang="ts">
	import AuthShell from '$lib/components/AuthShell.svelte';
	import { auth } from '$lib/auth.svelte';

	let code = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = null;
		error = await auth.verifyChallenge(code);
		busy = false;
	}
</script>

<AuthShell
	title="Two-factor verification"
	subtitle="Enter the 6-digit code from your authenticator app."
>
	<form onsubmit={submit}>
		<label>
			Verification code
			<input
				class="code"
				type="text"
				inputmode="numeric"
				autocomplete="one-time-code"
				pattern="[0-9]{'{'}6{'}'}"
				maxlength="6"
				required
				bind:value={code}
			/>
		</label>
		{#if error}<p class="error">{error}</p>{/if}
		<button type="submit" disabled={busy || code.length !== 6}>
			{busy ? 'Verifying…' : 'Verify'}
		</button>
	</form>
	<p class="signout"><button type="button" onclick={() => auth.signOut()}>Sign out</button></p>
</AuthShell>

<script lang="ts">
	import AuthShell from '$lib/components/AuthShell.svelte';
	import { auth, type TotpEnrolment } from '$lib/auth.svelte';

	let enrolment = $state<TotpEnrolment | null>(null);
	let code = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);

	$effect(() => {
		auth.enrollTotp().then((result) => {
			if ('error' in result) error = result.error;
			else enrolment = result;
		});
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (!enrolment) return;
		busy = true;
		error = null;
		error = await auth.challengeAndVerify(enrolment.factorId, code);
		busy = false;
	}
</script>

<AuthShell
	title="Set up two-factor auth"
	subtitle="Scan the QR code with your authenticator app, then enter the 6-digit code it shows."
>
	{#if enrolment}
		<img class="qr" src={enrolment.qrCode} alt="TOTP enrolment QR code" />
		<p class="secret">Can't scan? Enter this secret manually: <code>{enrolment.secret}</code></p>
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
				{busy ? 'Verifying…' : 'Verify & enable'}
			</button>
		</form>
	{:else if error}
		<p class="error">{error}</p>
	{:else}
		<p class="loading">Generating your enrolment QR code…</p>
	{/if}
	<p class="signout"><button type="button" onclick={() => auth.signOut()}>Sign out</button></p>
</AuthShell>

<style>
	.qr {
		display: block;
		width: 11rem;
		height: 11rem;
		margin: 0 auto 0.75rem;
		border: 1px solid #e2e4e8;
		border-radius: 6px;
	}

	.secret {
		margin: 0 0 1rem;
		font-size: 0.75rem;
		color: #667;
		overflow-wrap: anywhere;
	}

	.secret code {
		user-select: all;
	}

	.loading {
		margin: 0;
		color: #667;
		font-size: 0.875rem;
	}
</style>

import { supabase } from '$lib/supabaseClient';
import type { Session } from '@supabase/supabase-js';

/**
 * Auth gate states, one per UI screen:
 *  - loading:       initial session lookup in flight
 *  - signed_out:    State A — email/password form
 *  - mfa_enroll:    State B — aal1 session, no verified TOTP factor yet
 *  - mfa_challenge: State C — aal1 session, TOTP enrolled, needs a code
 *  - verified:      State D — aal2, wiki shell may render
 */
export type AuthStage = 'loading' | 'signed_out' | 'mfa_enroll' | 'mfa_challenge' | 'verified';

let stage = $state<AuthStage>('loading');
let session = $state<Session | null>(null);

/** Re-derive the stage from the current session and its assurance level. */
async function refresh(): Promise<void> {
	const { data } = await supabase.auth.getSession();
	session = data.session;
	if (!session) {
		stage = 'signed_out';
		return;
	}

	const { data: aal, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
	if (error) {
		console.error('Failed to read assurance level:', error.message);
		stage = 'signed_out';
		return;
	}

	if (aal.currentLevel === 'aal2') {
		stage = 'verified';
	} else if (aal.nextLevel === 'aal2') {
		// A verified TOTP factor exists but this session hasn't passed it yet.
		stage = 'mfa_challenge';
	} else {
		stage = 'mfa_enroll';
	}
}

/**
 * Start watching auth state. Returns an unsubscribe function, so it can be
 * used directly as an $effect body in the root layout.
 */
export function initAuth(): () => void {
	void refresh();
	const {
		data: { subscription }
	} = supabase.auth.onAuthStateChange(() => {
		// Awaiting other supabase.auth calls inside this callback deadlocks
		// (the client holds an internal lock while dispatching); defer instead.
		setTimeout(() => void refresh(), 0);
	});
	return () => subscription.unsubscribe();
}

/** State A: password sign-in. Returns an error message, or null on success. */
async function signIn(email: string, password: string): Promise<string | null> {
	const { error } = await supabase.auth.signInWithPassword({ email, password });
	return error ? error.message : null;
}

async function signOut(): Promise<void> {
	await supabase.auth.signOut();
}

export interface TotpEnrolment {
	factorId: string;
	/** SVG data URI, ready for an <img src>. */
	qrCode: string;
	/** Plain-text secret for manual entry into an authenticator app. */
	secret: string;
}

/** State B: begin TOTP enrolment. Returns QR details or an error message. */
async function enrollTotp(): Promise<TotpEnrolment | { error: string }> {
	// An abandoned enrolment leaves an unverified factor behind that blocks
	// re-enrolment, so clear those out before asking for a fresh one.
	const { data: factors } = await supabase.auth.mfa.listFactors();
	for (const factor of factors?.all ?? []) {
		if (factor.status === 'unverified') {
			await supabase.auth.mfa.unenroll({ factorId: factor.id });
		}
	}

	const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
	if (error || !data.totp) return { error: error?.message ?? 'Enrolment failed' };
	return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}

/** States B and C share this: challenge the factor, verify the 6-digit code. */
async function challengeAndVerify(factorId: string, code: string): Promise<string | null> {
	const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
		factorId
	});
	if (challengeError) return challengeError.message;

	const { error: verifyError } = await supabase.auth.mfa.verify({
		factorId,
		challengeId: challenge.id,
		code
	});
	if (verifyError) return verifyError.message;

	await refresh();
	return null;
}

/** State C: verify against the already-enrolled TOTP factor. */
async function verifyChallenge(code: string): Promise<string | null> {
	const { data: factors, error } = await supabase.auth.mfa.listFactors();
	if (error) return error.message;

	const totpFactor = factors.totp[0]; // listFactors().totp only contains verified factors
	if (!totpFactor) return 'No enrolled authenticator found. Try signing out and back in.';

	return challengeAndVerify(totpFactor.id, code);
}

export const auth = {
	get stage() {
		return stage;
	},
	get session() {
		return session;
	},
	signIn,
	signOut,
	enrollTotp,
	challengeAndVerify,
	verifyChallenge
};

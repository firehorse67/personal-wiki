import { supabase } from '$lib/supabaseClient';
import { db } from '$lib/db';
import { syncNow } from '$lib/sync';

const INBOX_ID_KEY = 'wiki:inbox-note-id';

/** The seeded Inbox note id, once known on this device. */
export function inboxNoteId(): string | null {
	return localStorage.getItem(INBOX_ID_KEY);
}

const SEEDS = [
	{ title: 'Inbox', content: 'Clipped pages and quick captures land here.' },
	{ title: 'Journal', content: '' },
	{ title: 'Root', content: '' }
];

/**
 * Provision the baseline workspace (Inbox / Journal / Root) for an empty
 * account. Zero local branches is not enough to decide — a fresh browser is
 * empty before its first pull — so an aal2 server count confirms the account
 * is genuinely blank before seeding. Rows are written dirty so the existing
 * sync loop registers them on Supabase on the next pass.
 *
 * Returns true if the workspace was seeded.
 */
export async function maybeSeedWorkspace(): Promise<boolean> {
	if ((await db.branches.count()) > 0) {
		await rememberInboxId();
		return false;
	}

	const { count, error } = await supabase
		.from('branches')
		.select('id', { count: 'exact', head: true });
	if (error) {
		// Offline or unauthorized: can't verify the account is empty, so
		// don't risk seeding duplicates. Next page load tries again.
		console.warn('Workspace seed skipped, server unreachable:', error.message);
		return false;
	}
	if ((count ?? 0) > 0) return false; // data exists, first pull will bring it

	const now = Date.now();
	const provisionalClock = new Date().toISOString(); // replaced by server value on next pull
	await db.transaction('rw', db.notes, db.branches, async () => {
		for (const seed of SEEDS) {
			const noteId = crypto.randomUUID();
			await db.notes.put({
				id: noteId,
				title: seed.title,
				content: seed.content,
				is_shared: false,
				updated_at: provisionalClock,
				dirty: 1,
				modified_at: now
			});
			await db.branches.put({
				id: crypto.randomUUID(),
				note_id: noteId,
				parent_id: null,
				updated_at: provisionalClock,
				dirty: 1,
				modified_at: now
			});
			if (seed.title === 'Inbox') localStorage.setItem(INBOX_ID_KEY, noteId);
		}
	});
	void syncNow();
	return true;
}

/** Self-heal the stored Inbox id on devices that pulled an existing workspace. */
async function rememberInboxId(): Promise<void> {
	if (inboxNoteId()) return;
	const candidates = await db.notes.where('title').equals('Inbox').primaryKeys();
	for (const noteId of candidates) {
		const isRoot = (await db.branches.where('note_id').equals(noteId).toArray()).some(
			(branch) => branch.parent_id === null
		);
		if (isRoot) {
			localStorage.setItem(INBOX_ID_KEY, noteId);
			return;
		}
	}
}

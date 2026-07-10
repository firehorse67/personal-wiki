import { supabase } from '$lib/supabaseClient';
import {
	db,
	mergeNotesFromServer,
	mergeBranchesFromServer,
	mergeAttributesFromServer,
	mergeAttachmentsFromServer,
	pendingNotes,
	pendingBranches,
	pendingAttributes,
	pendingAttachments
} from '$lib/db';

const NOTES_SYNC_KEY = 'wiki:last-sync:notes';
const BRANCHES_SYNC_KEY = 'wiki:last-sync:branches';
const ATTRIBUTES_SYNC_KEY = 'wiki:last-sync:attributes';
const ATTACHMENTS_SYNC_KEY = 'wiki:last-sync:attachments';
const EPOCH = '1970-01-01T00:00:00Z';
const SYNC_INTERVAL_MS = 15_000;

let timer: ReturnType<typeof setInterval> | null = null;
let syncing = false;

/**
 * Start the background sync loop: an immediate pass, then every 15s and
 * whenever the browser comes back online. Call from the aal2-gated shell
 * only — every request here goes through RLS.
 */
export function startSync(): void {
	if (timer) return;
	localStorage.removeItem('wiki:last-sync'); // legacy single-table watermark
	window.addEventListener('online', handleOnline);
	timer = setInterval(() => void syncNow(), SYNC_INTERVAL_MS);
	void syncNow();
}

export function stopSync(): void {
	if (!timer) return;
	clearInterval(timer);
	timer = null;
	window.removeEventListener('online', handleOnline);
}

function handleOnline(): void {
	void syncNow();
}

export async function syncNow(): Promise<void> {
	if (syncing || !navigator.onLine) return;
	syncing = true;
	let notesModule;
	try {
		notesModule = await import('$lib/notes.svelte');
		notesModule.notes.isSyncing = true;
	} catch (e) {
		// Ignore if dynamic import fails during initial bundle load
	}
	try {
		// Push before pull so the server never overwrites unsynced local work
		// (the merge functions skip dirty rows as a second line of defence).
		// Notes go before branches to satisfy the branches→notes foreign key.
		await pushNotes();
		await pushBranches();
		await pushAttributes();
		await pushAttachments();
		await pushDeletes();
		await pullNotes();
		await pullBranches();
		await pullAttributes();
		await pullAttachments();
	} catch (error) {
		console.error('Sync pass failed; will retry on the next cycle.', error);
	} finally {
		syncing = false;
		if (notesModule) {
			notesModule.notes.isSyncing = false;
		}
	}
}

async function pushNotes(): Promise<void> {
	const dirty = await pendingNotes();
	if (!dirty.length) return;

	// Strip local bookkeeping, the server-managed change clock, and
	// created_at (the server default owns it; also keeps pushes working
	// before migration 0008 lands).
	const payload = dirty.map(
		({ dirty: _d, modified_at: _m, updated_at: _u, created_at: _c, ...note }) => note
	);
	const { error } = await supabase.from('notes').upsert(payload);
	if (error) throw error;

	await clearDirtyFlags(db.notes, dirty);
}

async function pushBranches(): Promise<void> {
	const dirty = await pendingBranches();
	if (!dirty.length) return;

	const payload = dirty.map(({ dirty: _d, modified_at: _m, updated_at: _u, ...branch }) => branch);
	const { error } = await supabase.from('branches').upsert(payload);
	if (error) throw error;

	await clearDirtyFlags(db.branches, dirty);
}

async function pushAttributes(): Promise<void> {
	const dirty = await pendingAttributes();
	if (!dirty.length) return;

	const payload = dirty.map(({ dirty: _d, modified_at: _m, updated_at: _u, ...attr }) => attr);
	const { error } = await supabase.from('attributes').upsert(payload);
	if (error) throw error;

	await clearDirtyFlags(db.attributes, dirty);
}

async function pushAttachments(): Promise<void> {
	const dirty = await pendingAttachments();
	if (!dirty.length) return;

	const payload = dirty.map(({ dirty: _d, modified_at: _m, updated_at: _u, ...meta }) => meta);
	// file_path is unique server-side; onConflict merges rows created
	// independently on two devices for the same file.
	const { error } = await supabase.from('attachments').upsert(payload, { onConflict: 'file_path' });
	if (error) throw error;

	await clearDirtyFlags(db.attachments, dirty);
}

/** Clear dirty flags, but only on rows untouched while the push was in flight. */
async function clearDirtyFlags(
	table: typeof db.notes | typeof db.branches | typeof db.attributes | typeof db.attachments,
	pushed: { id: string; modified_at: number }[]
): Promise<void> {
	await db.transaction('rw', table, async () => {
		for (const row of pushed) {
			const current = await table.get(row.id);
			if (current && current.modified_at === row.modified_at) {
				await table.update(row.id, { dirty: 0 });
			}
		}
	});
}

async function pushDeletes(): Promise<void> {
	// Branch tombstones first; deleting a note cascades to its branches
	// server-side, so the note pass mops up whatever is left.
	const branchTombs = await db.branchTombstones.toArray();
	if (branchTombs.length) {
		const ids = branchTombs.map((t) => t.id);
		const { error } = await supabase.from('branches').delete().in('id', ids);
		if (error) throw error;
		await db.branchTombstones.bulkDelete(ids);
	}

	const attrTombs = await db.attributeTombstones.toArray();
	if (attrTombs.length) {
		const ids = attrTombs.map((t) => t.id);
		const { error } = await supabase.from('attributes').delete().in('id', ids);
		if (error) throw error;
		await db.attributeTombstones.bulkDelete(ids);
	}

	const attachmentTombs = await db.attachmentTombstones.toArray();
	if (attachmentTombs.length) {
		const ids = attachmentTombs.map((t) => t.id);
		const { error } = await supabase.from('attachments').delete().in('id', ids);
		if (error) throw error;
		await db.attachmentTombstones.bulkDelete(ids);
	}

	const noteTombs = await db.tombstones.toArray();
	if (noteTombs.length) {
		const ids = noteTombs.map((t) => t.id);
		const { error } = await supabase.from('notes').delete().in('id', ids);
		if (error) throw error;
		await db.tombstones.bulkDelete(ids);
	}
}

async function pullNotes(): Promise<void> {
	const since = localStorage.getItem(NOTES_SYNC_KEY) ?? EPOCH;
	let result = await supabase
		.from('notes')
		.select('id, title, content, is_shared, created_at, updated_at') // legacy parent_id excluded
		.gt('updated_at', since)
		.order('updated_at', { ascending: true });
	if (result.error && /created_at/.test(result.error.message)) {
		// Migration 0008 not applied yet — pull without the column so sync
		// keeps working in the deploy→migration window.
		result = (await supabase
			.from('notes')
			.select('id, title, content, is_shared, updated_at')
			.gt('updated_at', since)
			.order('updated_at', { ascending: true })) as unknown as typeof result;
	}
	const { data, error } = result;
	if (error) throw error;
	if (!data?.length) return;

	await mergeNotesFromServer(data);
	// Advance the watermark using server time, so client clock skew can't
	// cause missed rows.
	localStorage.setItem(NOTES_SYNC_KEY, data[data.length - 1].updated_at);
}

async function pullBranches(): Promise<void> {
	const since = localStorage.getItem(BRANCHES_SYNC_KEY) ?? EPOCH;
	const { data, error } = await supabase
		.from('branches')
		.select('*')
		.gt('updated_at', since)
		.order('updated_at', { ascending: true });
	if (error) throw error;
	if (!data.length) return;

	await mergeBranchesFromServer(data);
	localStorage.setItem(BRANCHES_SYNC_KEY, data[data.length - 1].updated_at);
}

async function pullAttributes(): Promise<void> {
	const since = localStorage.getItem(ATTRIBUTES_SYNC_KEY) ?? EPOCH;
	const { data, error } = await supabase
		.from('attributes')
		.select('*')
		.gt('updated_at', since)
		.order('updated_at', { ascending: true });
	if (error) throw error;
	if (!data.length) return;

	await mergeAttributesFromServer(data);
	localStorage.setItem(ATTRIBUTES_SYNC_KEY, data[data.length - 1].updated_at);
}

async function pullAttachments(): Promise<void> {
	const since = localStorage.getItem(ATTACHMENTS_SYNC_KEY) ?? EPOCH;
	const { data, error } = await supabase
		.from('attachments')
		.select('*')
		.gt('updated_at', since)
		.order('updated_at', { ascending: true });
	if (error) throw error;
	if (!data.length) return;

	await mergeAttachmentsFromServer(data);
	localStorage.setItem(ATTACHMENTS_SYNC_KEY, data[data.length - 1].updated_at);
}

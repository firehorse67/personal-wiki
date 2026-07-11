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
	// Mobile suspends the tab (and its interval) in the background; sync
	// immediately when the app returns to the foreground.
	document.addEventListener('visibilitychange', handleVisibility);
	timer = setInterval(() => void syncNow(), SYNC_INTERVAL_MS);
	void syncNow();
}

export function stopSync(): void {
	if (!timer) return;
	clearInterval(timer);
	timer = null;
	window.removeEventListener('online', handleOnline);
	document.removeEventListener('visibilitychange', handleVisibility);
}

function handleOnline(): void {
	void syncNow();
}

function handleVisibility(): void {
	if (document.visibilityState === 'visible') void syncNow();
}

// A hung request (mobile network handoff, suspended tab) must never wedge
// the whole engine: each step gets its own deadline, and a failing step
// no longer aborts the ones after it.
const STEP_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${label} timed out after ${STEP_TIMEOUT_MS / 1000}s`)),
			STEP_TIMEOUT_MS
		);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
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

	// Push before pull so the server never overwrites unsynced local work
	// (the merge functions skip dirty rows as a second line of defence).
	// Notes go before branches to satisfy the branches→notes foreign key —
	// but a failure in one step must not block independent steps (a single
	// unpushable row previously froze deletions AND all pulls forever).
	const failures: string[] = [];
	const step = async (label: string, fn: () => Promise<void>) => {
		try {
			await withTimeout(fn(), label);
		} catch (error) {
			// Supabase errors are plain objects with a message, not Error instances.
			const message =
				error instanceof Error
					? error.message
					: ((error as { message?: string })?.message ?? JSON.stringify(error));
			failures.push(`${label}: ${message}`);
		}
	};

	try {
		await step('push notes', pushNotes);
		await step('push branches', pushBranches);
		await step('push attributes', pushAttributes);
		await step('push attachments', pushAttachments);
		await step('push deletions', pushDeletes);
		await step('pull notes', pullNotes);
		await step('pull branches', pullBranches);
		await step('pull attributes', pullAttributes);
		await step('pull attachments', pullAttachments);
	} finally {
		syncing = false;
		if (notesModule) {
			notesModule.notes.isSyncing = false;
			notesModule.notes.lastSyncError = failures.join(' • ');
		}
		if (failures.length) {
			console.error('Sync pass had failures; will retry on the next cycle.', failures);
		}
	}
}

// Push payloads WHITELIST the server's columns rather than stripping known
// local fields: a stray extra property on a local row (a created_at that
// leaked onto branches once wedged sync for days) then can't 400 a push.

async function pushNotes(): Promise<void> {
	const dirty = await pendingNotes();
	if (!dirty.length) return;

	// created_at/updated_at are server-owned and deliberately not sent.
	const payload = dirty.map((n) => ({
		id: n.id,
		title: n.title,
		content: n.content,
		is_shared: n.is_shared
	}));
	// Read back the server's change clock so the pull can tell our own
	// echo (same updated_at) from a genuinely foreign edit (conflicts).
	const { data, error } = await supabase.from('notes').upsert(payload).select('id, updated_at');
	if (error) throw error;

	if (data) {
		const serverClock = new Map(data.map((row) => [row.id, row.updated_at]));
		await db.transaction('rw', db.notes, async () => {
			for (const row of dirty) {
				const stamped = serverClock.get(row.id);
				if (stamped) await db.notes.update(row.id, { updated_at: stamped });
			}
		});
	}

	await clearDirtyFlags(db.notes, dirty);
}

function isForeignKeyError(error: { code?: string; message?: string }): boolean {
	return error.code === '23503' || /foreign key/i.test(error.message ?? '');
}

/**
 * A dirty branch/attribute pointing at a note that no longer exists locally
 * can never push (the note was deleted on another device and the server
 * cascaded) — without healing, that one orphan re-fails the push forever
 * and the row stays "unsynced" permanently. Drop such rows with a tombstone
 * so the next pass runs clean.
 */
async function healOrphanBranches(): Promise<number> {
	const dirty = await pendingBranches();
	let healed = 0;
	for (const row of dirty) {
		const noteExists = await db.notes.get(row.note_id);
		const parentExists = row.parent_id === null || (await db.notes.get(row.parent_id));
		if (noteExists && parentExists) continue;
		await db.transaction('rw', [db.branches, db.branchTombstones], async () => {
			await db.branches.delete(row.id);
			await db.branchTombstones.put({ id: row.id, deleted_at: Date.now() });
		});
		healed++;
	}
	return healed;
}

async function healOrphanAttributes(): Promise<number> {
	const dirty = await pendingAttributes();
	let healed = 0;
	for (const row of dirty) {
		if (await db.notes.get(row.note_id)) continue;
		await db.transaction('rw', [db.attributes, db.attributeTombstones], async () => {
			await db.attributes.delete(row.id);
			await db.attributeTombstones.put({ id: row.id, deleted_at: Date.now() });
		});
		healed++;
	}
	return healed;
}

async function pushBranches(): Promise<void> {
	const dirty = await pendingBranches();
	if (!dirty.length) return;

	const payload = dirty.map((b) => ({
		id: b.id,
		note_id: b.note_id,
		parent_id: b.parent_id
	}));
	const { error } = await supabase.from('branches').upsert(payload);
	if (error) {
		if (isForeignKeyError(error)) {
			const healed = await healOrphanBranches();
			if (healed) console.warn(`Sync: dropped ${healed} orphaned branch(es) referencing deleted notes.`);
		}
		throw error;
	}

	await clearDirtyFlags(db.branches, dirty);
}

async function pushAttributes(): Promise<void> {
	const dirty = await pendingAttributes();
	if (!dirty.length) return;

	const payload = dirty.map((a) => ({
		id: a.id,
		note_id: a.note_id,
		type: a.type,
		key: a.key,
		value: a.value
	}));
	const { error } = await supabase.from('attributes').upsert(payload);
	if (error) {
		if (isForeignKeyError(error)) {
			const healed = await healOrphanAttributes();
			if (healed) console.warn(`Sync: dropped ${healed} orphaned attribute(s) referencing deleted notes.`);
		}
		throw error;
	}

	await clearDirtyFlags(db.attributes, dirty);
}

async function pushAttachments(): Promise<void> {
	const dirty = await pendingAttachments();
	if (!dirty.length) return;

	// If any dirty attachments have local_blob, upload them first
	let token: string | undefined;
	for (const m of dirty) {
		if (m.local_blob) {
			if (!token) {
				const { data: sessionData } = await supabase.auth.getSession();
				token = sessionData.session?.access_token;
				if (!token) throw new Error('Authentication token required for attachment upload');
			}

			// 1. Get a signed upload URL for the existing file path
			const slotResponse = await fetch('/api/upload-url', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ path: m.file_path })
			});
			if (!slotResponse.ok) {
				const body = await slotResponse.json().catch(() => null);
				throw new Error(body?.message ?? `Upload slot request failed (${slotResponse.status})`);
			}
			const slot: { path: string; token: string } = await slotResponse.json();

			// 2. Upload the binary to the signed URL (overwriting)
			const { error: uploadError } = await supabase.storage
				.from('clips')
				.uploadToSignedUrl(slot.path, slot.token, m.local_blob, {
					contentType: 'application/pdf',
					cacheControl: '0',
					upsert: true
				});
			if (uploadError) throw new Error(uploadError.message);

			// 3. Clear local_blob in Dexie to free IndexedDB space
			await db.attachments.update(m.id, { local_blob: undefined } as any);
			m.local_blob = undefined; // Clear in-memory
		}
	}

	// attachments DOES have a server-side created_at (unlike branches/
	// attributes), and the local value is meaningful — keep it.
	const payload = dirty.map((m) => ({
		id: m.id,
		file_path: m.file_path,
		description: m.description,
		alt_text: m.alt_text,
		created_at: m.created_at
	}));
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

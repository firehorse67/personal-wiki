import Dexie, { type EntityTable } from 'dexie';
import type { Note, Branch, NoteAttribute, AttachmentMeta } from '$lib/supabaseClient';

/**
 * Local sync bookkeeping shared by both synced tables: `dirty` marks rows
 * with unpushed local edits (numeric so it can be indexed); `modified_at`
 * is the local modification time used to order the sync queue (distinct
 * from the server-managed `updated_at` change clock).
 */
export interface LocalNote extends Note {
	dirty: number;
	modified_at: number;
}

export interface LocalBranch extends Branch {
	dirty: number;
	modified_at: number;
}

export interface LocalAttribute extends NoteAttribute {
	dirty: number;
	modified_at: number;
}

export interface LocalAttachment extends AttachmentMeta {
	dirty: number;
	modified_at: number;
	local_blob?: Blob;
}

/** A row deleted locally whose remote deletion hasn't been pushed yet. */
export interface Tombstone {
	id: string;
	deleted_at: number; // epoch ms
}

const db = new Dexie('wiki') as Dexie & {
	notes: EntityTable<LocalNote, 'id'>;
	branches: EntityTable<LocalBranch, 'id'>;
	attributes: EntityTable<LocalAttribute, 'id'>;
	attachments: EntityTable<LocalAttachment, 'id'>;
	tombstones: EntityTable<Tombstone, 'id'>; // deleted notes
	branchTombstones: EntityTable<Tombstone, 'id'>; // deleted branches
	attributeTombstones: EntityTable<Tombstone, 'id'>; // deleted attributes
	attachmentTombstones: EntityTable<Tombstone, 'id'>; // deleted attachment metadata
};

// v2: tree placement moved out of notes.parent_id into the branches table.
// v3: note attributes (label/relation metadata).
// v4: attachment metadata (Media Library descriptions/alt text).
db.version(4).stores({
	notes: 'id, title, dirty, modified_at',
	branches: 'id, note_id, parent_id, dirty, modified_at',
	attributes: 'id, note_id, key, dirty, modified_at',
	attachments: 'id, file_path, dirty, modified_at',
	tombstones: 'id',
	branchTombstones: 'id',
	attributeTombstones: 'id',
	attachmentTombstones: 'id'
});

/** Merge note rows pulled from Supabase. Local wins until synced. */
export async function mergeNotesFromServer(rows: Note[]): Promise<void> {
	await db.transaction('rw', db.notes, db.tombstones, db.attributes, async () => {
		for (const row of rows) {
			if (await db.tombstones.get(row.id)) continue; // deleted locally, push pending
			const existing = await db.notes.get(row.id);
			if (existing?.dirty) {
				// Conflict check: only a genuinely FOREIGN edit counts. The
				// server clock must have moved past what we last saw for this
				// row (pushNotes writes the server's updated_at back after
				// each push, so our own echo matches and never flags — a
				// bare content comparison flagged your own typing, because
				// the pull echoes your push one keystroke behind the still-
				// dirty local row).
				const serverChangedElsewhere = existing.updated_at !== row.updated_at;
				if (
					serverChangedElsewhere &&
					(existing.title !== row.title || existing.content !== row.content)
				) {
					// It's a real conflict. Let's add a conflict tag/attribute if not present.
					const hasConflict = await db.attributes
						.where('note_id')
						.equals(row.id)
						.filter((a) => a.key === 'conflict')
						.first();
					if (!hasConflict) {
						await db.attributes.put({
							id: crypto.randomUUID(),
							note_id: row.id,
							type: 'label',
							key: 'conflict',
							value: 'server-version-diverged',
							dirty: 1,
							modified_at: Date.now(),
							updated_at: new Date().toISOString()
						});
					}
				}
				continue; // local edits win until they sync
			}
			await db.notes.put({ ...row, dirty: 0, modified_at: Date.now() });
		}
	});
}

/** Merge branch rows pulled from Supabase. Local wins until synced. */
export async function mergeBranchesFromServer(rows: Branch[]): Promise<void> {
	await db.transaction('rw', db.branches, db.branchTombstones, db.tombstones, async () => {
		for (const row of rows) {
			if (await db.branchTombstones.get(row.id)) continue;
			// A branch of a note we deleted locally would resurrect a ghost row.
			if (await db.tombstones.get(row.note_id)) continue;
			const existing = await db.branches.get(row.id);
			if (existing?.dirty) continue;
			await db.branches.put({ ...row, dirty: 0, modified_at: Date.now() });
		}
	});
}

/** Merge attribute rows pulled from Supabase. Local wins until synced. */
export async function mergeAttributesFromServer(rows: NoteAttribute[]): Promise<void> {
	await db.transaction('rw', db.attributes, db.attributeTombstones, db.tombstones, async () => {
		for (const row of rows) {
			if (await db.attributeTombstones.get(row.id)) continue;
			// An attribute of a note we deleted locally would resurrect a ghost row.
			if (await db.tombstones.get(row.note_id)) continue;
			const existing = await db.attributes.get(row.id);
			if (existing?.dirty) continue;
			await db.attributes.put({ ...row, dirty: 0, modified_at: Date.now() });
		}
	});
}

/** Merge attachment metadata pulled from Supabase. Local wins until synced. */
export async function mergeAttachmentsFromServer(rows: AttachmentMeta[]): Promise<void> {
	await db.transaction('rw', db.attachments, db.attachmentTombstones, async () => {
		for (const row of rows) {
			if (await db.attachmentTombstones.get(row.id)) continue; // deleted locally
			const existing = await db.attachments.get(row.id);
			if (existing?.dirty) continue;
			await db.attachments.put({ ...row, dirty: 0, modified_at: Date.now() });
		}
	});
}

/** Rows edited locally that still need to be pushed to Supabase, oldest first. */
export function pendingNotes(): Promise<LocalNote[]> {
	return db.notes.where('dirty').equals(1).sortBy('modified_at');
}

export function pendingBranches(): Promise<LocalBranch[]> {
	return db.branches.where('dirty').equals(1).sortBy('modified_at');
}

export function pendingAttributes(): Promise<LocalAttribute[]> {
	return db.attributes.where('dirty').equals(1).sortBy('modified_at');
}

export function pendingAttachments(): Promise<LocalAttachment[]> {
	return db.attachments.where('dirty').equals(1).sortBy('modified_at');
}

export { db };

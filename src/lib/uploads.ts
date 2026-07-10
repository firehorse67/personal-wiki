import { supabase } from '$lib/supabaseClient';
import { db } from '$lib/db';
import { syncNow } from '$lib/sync';

// Script-capable extensions are refused: the bucket serves files inline.
export const BLOCKED_ATTACH_EXT = new Set(['html', 'htm', 'svg', 'xml', 'xhtml', 'js', 'mjs']);
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // Supabase per-object default

export interface UploadedFile {
	url: string;
	path: string;
	name: string;
	size: number;
	type: string;
}

/**
 * Direct client → Supabase Storage upload via a server-issued signed slot
 * (/api/upload-url verifies the aal2 session; the bytes bypass Vercel).
 * On success a metadata row is recorded locally so the file appears in the
 * Media Library immediately and syncs to the attachments table.
 */
export async function uploadToStorage(file: File): Promise<UploadedFile> {
	const { data } = await supabase.auth.getSession();
	if (!data.session) throw new Error('Not signed in');

	const ext =
		(file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
	if (BLOCKED_ATTACH_EXT.has(ext)) throw new Error(`.${ext} files cannot be attached`);
	if (file.size > MAX_UPLOAD_BYTES) throw new Error('File exceeds 50 MB');

	const slotResponse = await fetch('/api/upload-url', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${data.session.access_token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ name: file.name })
	});
	if (!slotResponse.ok) {
		const body = await slotResponse.json().catch(() => null);
		throw new Error(body?.message ?? `Upload failed (${slotResponse.status})`);
	}
	const slot: { path: string; token: string; publicUrl: string } = await slotResponse.json();

	const { error: uploadError } = await supabase.storage
		.from('clips')
		.uploadToSignedUrl(slot.path, slot.token, file, {
			contentType: file.type && !file.type.includes('html') ? file.type : 'application/octet-stream'
		});
	if (uploadError) throw new Error(uploadError.message);

	await recordAttachmentMeta(slot.path, file.name);

	return { url: slot.publicUrl, path: slot.path, name: file.name, size: file.size, type: file.type };
}

/** Idempotent local metadata row for a stored file (synced by the engine). */
export async function recordAttachmentMeta(
	filePath: string,
	description = '',
	createdAt?: string
): Promise<void> {
	const existing = await db.attachments.where('file_path').equals(filePath).first();
	if (existing) return;
	await db.attachments.put({
		id: crypto.randomUUID(),
		file_path: filePath,
		description,
		alt_text: '',
		created_at: createdAt ?? new Date().toISOString(),
		updated_at: new Date().toISOString(), // provisional; server value arrives on pull
		dirty: 1,
		modified_at: Date.now()
	});
	void syncNow();
}

/** Public URL for a clips-bucket path. */
export function publicUrlFor(filePath: string): string {
	return supabase.storage.from('clips').getPublicUrl(filePath).data.publicUrl;
}

/**
 * Permanently delete a stored file: the server removes the bucket object
 * and its metadata row (service role); locally the row is tombstoned so a
 * concurrent sync push can't resurrect it. Requires being online.
 */
export async function deleteStoredFile(filePath: string): Promise<void> {
	const { data } = await supabase.auth.getSession();
	if (!data.session) throw new Error('Not signed in');

	const response = await fetch('/api/upload', {
		method: 'DELETE',
		headers: {
			Authorization: `Bearer ${data.session.access_token}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ path: filePath })
	});
	if (!response.ok) {
		const body = await response.json().catch(() => null);
		throw new Error(body?.message ?? `Delete failed (${response.status})`);
	}

	const row = await db.attachments.where('file_path').equals(filePath).first();
	if (row) {
		await db.transaction('rw', [db.attachments, db.attachmentTombstones], async () => {
			await db.attachments.delete(row.id);
			await db.attachmentTombstones.put({ id: row.id, deleted_at: Date.now() });
		});
	}
}

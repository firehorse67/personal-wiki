import { json, error } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { randomUUID } from 'node:crypto';
import type { Database } from '$lib/supabaseClient';
import type { RequestHandler } from './$types';

// Vercel rejects request bodies over 4.5 MB before the handler runs.
const MAX_BYTES = 4_000_000;

// Extensions that render/execute when served inline from the public bucket
// are refused; everything else is treated as an opaque attachment.
const BLOCKED_EXT = new Set(['html', 'htm', 'svg', 'xml', 'xhtml', 'js', 'mjs']);

/**
 * Authenticated file upload for note attachments. The caller must present
 * their Supabase access token, which is verified server-side and must carry
 * the aal2 claim — the same bar as the rest of the wiki. Files land in the
 * public `clips` bucket under attachments/ and the public URL is returned
 * for embedding in note content.
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!env.SUPABASE_SERVICE_ROLE_KEY) throw error(500, 'Uploads are not configured');

	const authHeader = request.headers.get('authorization');
	if (!authHeader?.startsWith('Bearer ')) throw error(401, 'Missing bearer token');
	const token = authHeader.slice(7);

	const supabase = createClient<Database>(PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: { persistSession: false, autoRefreshToken: false }
	});

	// getUser validates signature and expiry against Supabase...
	const { data: userData, error: authError } = await supabase.auth.getUser(token);
	if (authError || !userData.user) throw error(401, 'Invalid session');
	// ...and the payload's aal claim enforces the MFA bar.
	try {
		const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
		if (payload.aal !== 'aal2') throw new Error('aal1');
	} catch {
		throw error(403, 'MFA-verified session required');
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		throw error(400, 'Body must be multipart/form-data');
	}
	const file = form.get('file');
	if (!(file instanceof File)) throw error(400, 'Missing "file" field');
	if (file.size === 0) throw error(400, 'File is empty');
	if (file.size > MAX_BYTES) {
		throw error(413, 'File exceeds 4 MB (platform request limit)');
	}

	const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
	if (BLOCKED_EXT.has(ext)) throw error(415, `.${ext} files cannot be attached`);

	const path = `attachments/${randomUUID()}.${ext}`;
	const contentType = file.type && !file.type.includes('html') ? file.type : 'application/octet-stream';
	const { error: uploadError } = await supabase.storage
		.from('clips')
		.upload(path, Buffer.from(await file.arrayBuffer()), { contentType });
	if (uploadError) {
		console.error('Attachment upload failed:', uploadError.message);
		throw error(502, 'Storage upload failed');
	}

	const { data } = supabase.storage.from('clips').getPublicUrl(path);
	return json({ url: data.publicUrl, name: file.name, size: file.size, type: contentType }, { status: 201 });
};

/**
 * Lists all attachments in the storage bucket.
 */
export const GET: RequestHandler = async ({ request }) => {
	if (!env.SUPABASE_SERVICE_ROLE_KEY) throw error(500, 'Uploads are not configured');

	const authHeader = request.headers.get('authorization');
	if (!authHeader?.startsWith('Bearer ')) throw error(401, 'Missing bearer token');
	const token = authHeader.slice(7);

	const supabase = createClient<Database>(PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: { persistSession: false, autoRefreshToken: false }
	});

	const { data: userData, error: authError } = await supabase.auth.getUser(token);
	if (authError || !userData.user) throw error(401, 'Invalid session');

	try {
		const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
		if (payload.aal !== 'aal2') throw new Error('aal1');
	} catch {
		throw error(403, 'MFA-verified session required');
	}

	// 1. List the top-level attachments/ folder to find all UUID subdirectories
	const { data: folders, error: listError } = await supabase.storage
		.from('clips')
		.list('attachments', { limit: 100 });

	if (listError) {
		console.error('Failed to list attachments folder:', listError.message);
		throw error(502, 'Failed to query storage');
	}

	const filesList: Array<{ url: string, name: string, created_at: string, mime_type: string, size: number }> = [];

	// 2. For each folder, list the files inside it
	if (folders && folders.length > 0) {
		const folderPromises = folders.map(async (folder) => {
			try {
				const { data: subFiles, error: subError } = await supabase.storage
					.from('clips')
					.list(`attachments/${folder.name}`, { limit: 50 });
				
				if (subError || !subFiles) return;

				subFiles.forEach((file) => {
					// Make sure it is a file (folders do not have an ID)
					if (file.id) {
						const pathStr = `attachments/${folder.name}/${file.name}`;
						const { data: urlData } = supabase.storage.from('clips').getPublicUrl(pathStr);
						
						filesList.push({
							url: urlData.publicUrl,
							name: file.name,
							created_at: file.created_at || new Date().toISOString(),
							mime_type: file.metadata?.mimetype || 'application/octet-stream',
							size: file.metadata?.size || 0
						});
					}
				});
			} catch (err) {
				console.warn(`Failed to list subfolder attachments/${folder.name}:`, err);
			}
		});

		await Promise.all(folderPromises);
	}

	// 3. Clipper screenshots live at the bucket ROOT (uuid.jpg), not under
	// attachments/ — list those too so the Media Library sees them.
	const { data: rootEntries, error: rootError } = await supabase.storage
		.from('clips')
		.list('', { limit: 200 });
	if (!rootError && rootEntries) {
		for (const entry of rootEntries) {
			if (!entry.id) continue; // folders (e.g. attachments/) have no id
			const { data: urlData } = supabase.storage.from('clips').getPublicUrl(entry.name);
			filesList.push({
				url: urlData.publicUrl,
				name: entry.name,
				created_at: entry.created_at || new Date().toISOString(),
				mime_type: entry.metadata?.mimetype || 'application/octet-stream',
				size: entry.metadata?.size || 0
			});
		}
	}

	// Sort files by created_at descending
	filesList.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

	return json(filesList);
};

/**
 * Permanently deletes a stored file and its Media Library metadata row.
 * Same aal2-verified bearer authentication as upload/list; paths are
 * restricted to the attachments/ and screenshots areas of the clips bucket
 * so the endpoint can't be aimed at arbitrary storage objects.
 */
export const DELETE: RequestHandler = async ({ request }) => {
	if (!env.SUPABASE_SERVICE_ROLE_KEY) throw error(500, 'Uploads are not configured');

	const authHeader = request.headers.get('authorization');
	if (!authHeader?.startsWith('Bearer ')) throw error(401, 'Missing bearer token');
	const token = authHeader.slice(7);

	const supabase = createClient<Database>(PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: { persistSession: false, autoRefreshToken: false }
	});

	const { data: userData, error: authError } = await supabase.auth.getUser(token);
	if (authError || !userData.user) throw error(401, 'Invalid session');
	try {
		const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
		if (payload.aal !== 'aal2') throw new Error('aal1');
	} catch {
		throw error(403, 'MFA-verified session required');
	}

	let body: { path?: unknown };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Body must be JSON');
	}
	const path = typeof body.path === 'string' ? body.path : '';
	if (!path || path.includes('..') || !/^[\w\-./ ]+$/.test(path)) {
		throw error(400, 'Invalid "path"');
	}
	if (!path.startsWith('attachments/') && !/^[\w-]+\.(png|jpe?g|webp|gif)$/.test(path)) {
		throw error(403, 'Path is outside the managed areas');
	}

	const { error: removeError } = await supabase.storage.from('clips').remove([path]);
	if (removeError) {
		console.error('Storage delete failed:', removeError.message);
		throw error(502, 'Storage delete failed');
	}

	// Metadata row goes with the file (idempotent if none exists).
	const { error: metaError } = await supabase.from('attachments').delete().eq('file_path', path);
	if (metaError && !metaError.message.includes('does not exist')) {
		// The table may predate migration 0007 on this project; file removal
		// already succeeded, so report success but log the metadata failure.
		console.error('Attachment metadata delete failed:', metaError.message);
	}

	return json({ deleted: path });
};

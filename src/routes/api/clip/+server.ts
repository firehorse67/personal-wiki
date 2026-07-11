import { json, error } from '@sveltejs/kit';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { normalizeClip } from '$lib/server/clip';
import type { Database } from '$lib/supabaseClient';
import type { RequestHandler } from './$types';

const INBOX_TITLE = 'Inbox';

export const OPTIONS: RequestHandler = async () => {
	return new Response(null, {
		headers: {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization',
			'Access-Control-Max-Age': '86400'
		}
	});
};

/**
 * Web clipper ingestion. The browser extension authenticates with a
 * dedicated bearer token (CLIPPER_API_TOKEN) so the Supabase service-role
 * key never leaves this serverless function. Accepted JSON fields:
 * { title?, url?, excerpt?, html? } — at least one of url/excerpt/html.
 */
export const POST: RequestHandler = async ({ request }) => {
	// Config check for the token comes first; auth for everything after.
	if (!env.CLIPPER_API_TOKEN) {
		return json({ message: 'Clipper endpoint is not configured' }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
	}
	if (!bearerMatches(request.headers.get('authorization'), env.CLIPPER_API_TOKEN)) {
		return json({ message: 'Invalid or missing bearer token' }, { status: 401, headers: { 'Access-Control-Allow-Origin': '*' } });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ message: 'Body must be valid JSON' }, { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
	}
	const clip = normalizeClip(body);
	if ('error' in clip) {
		return json({ message: clip.error }, { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
	}

	if (!env.SUPABASE_SERVICE_ROLE_KEY) {
		return json({ message: 'Clipper endpoint is not configured' }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
	}
	const supabase = createClient<Database>(PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: { persistSession: false, autoRefreshToken: false }
	});

	try {
		// 1. Resolve user_id. First, try to query any existing note.
		let userId: string | null = null;
		const { data: existingNotes, error: selectError } = await supabase
			.from('notes')
			.select('user_id')
			.limit(1);

		if (selectError) {
			console.error('Failed to select existing notes for user_id:', selectError.message, selectError.details);
		} else if (existingNotes && existingNotes.length > 0) {
			userId = (existingNotes[0] as any).user_id;
		}

		// 2. If no notes exist (brand new db), get the first user from auth.users.
		if (!userId) {
			const { data: usersData, error: listError } = await supabase.auth.admin.listUsers();
			if (listError) {
				console.error('Failed to list auth users:', listError.message);
			} else {
				userId = usersData?.users?.[0]?.id || null;
			}
		}

		if (!userId) {
			return json({ message: 'No registered user found to own the clip.' }, { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } });
		}

		const inboxId = await findOrCreateInbox(supabase, userId);

		// Screenshots go to Storage; the note only carries the image URL.
		let content = clip.content;
		let screenshotUrl: string | null = null;
		if (clip.screenshot) {
			screenshotUrl = await uploadScreenshot(supabase, clip.screenshot);
			if (screenshotUrl) {
				content += `\n<p><img src="${screenshotUrl}" alt="Screenshot" style="max-width: 100%; height: auto; border: 1px solid rgba(0,0,0,0.1); border-radius: 6px; margin-top: 10px;" /></p>`;
			} else {
				content += '\n<p><em>Screenshot upload failed — see server logs.</em></p>';
			}
		}

		const noteId = randomUUID();
		const { data: note, error: noteError } = await supabase
			.from('notes')
			.insert({ id: noteId, title: clip.title, content, is_shared: false, user_id: userId } as any)
			.select('id')
			.single();
		if (noteError) {
			console.error('Clip note insert failed. Error:', noteError.message, 'Details:', noteError.details);
			return json({ message: `Failed to store clip (note): ${noteError.message}` }, { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } });
		}

		const branchId = randomUUID();
		const { error: branchError } = await supabase
			.from('branches')
			.insert({ id: branchId, note_id: note.id, parent_id: inboxId });
		if (branchError) {
			console.error('Clip branch insert failed. Error:', branchError.message, 'Details:', branchError.details);
			return json({ message: `Failed to store clip (branch): ${branchError.message}` }, { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } });
		}

		return json(
			{ id: note.id, screenshot: screenshotUrl },
			{ status: 201, headers: { 'Access-Control-Allow-Origin': '*' } }
		);
	} catch (err: any) {
		console.error('Error in /api/clip POST handler:', err);
		const status = err?.status || 500;
		const message = err?.body?.message || err?.message || 'Internal Server Error';
		return json({ message }, { status, headers: { 'Access-Control-Allow-Origin': '*' } });
	}
};

/**
 * Upload a validated image data URL to the public `clips` bucket
 * (supabase/migrations/0004) and return its public URL, or null on failure
 * so the clip still saves without the image.
 */
async function uploadScreenshot(
	supabase: SupabaseClient<Database>,
	dataUrl: string
): Promise<string | null> {
	const match = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(dataUrl);
	if (!match) return null;
	const mime = match[1] === 'jpg' ? 'jpeg' : match[1];
	const path = `${randomUUID()}.${mime === 'jpeg' ? 'jpg' : mime}`;
	const { error: uploadError } = await supabase.storage
		.from('clips')
		.upload(path, Buffer.from(match[2], 'base64'), { contentType: `image/${mime}` });
	if (uploadError) {
		console.error('Screenshot upload failed:', uploadError.message);
		return null;
	}
	// Register in the Media Library (table may predate migration 0007).
	const { error: metaError } = await supabase
		.from('attachments')
		.upsert({ file_path: path, description: 'Web clip screenshot', alt_text: '' }, { onConflict: 'file_path' });
	if (metaError) console.warn('Screenshot metadata insert failed:', metaError.message);

	return supabase.storage.from('clips').getPublicUrl(path).data.publicUrl;
}

/** Constant-time bearer comparison (hashing first equalizes lengths). */
function bearerMatches(header: string | null, expected: string): boolean {
	if (!header?.startsWith('Bearer ')) return false;
	const presented = createHash('sha256').update(header.slice(7)).digest();
	const wanted = createHash('sha256').update(expected).digest();
	return timingSafeEqual(presented, wanted);
}

/**
 * Find the root-level Inbox note, creating it on first clip. Set
 * CLIPPER_INBOX_ID (e.g. to the id seeded by initWorkspace) to pin the
 * destination and skip the title lookup.
 */
async function findOrCreateInbox(supabase: SupabaseClient<Database>, userId: string): Promise<string> {
	if (env.CLIPPER_INBOX_ID) return env.CLIPPER_INBOX_ID;
	const { data: candidates, error: findError } = await supabase
		.from('notes')
		.select('id')
		.eq('title', INBOX_TITLE);
	if (findError) {
		console.error('Inbox lookup failed:', findError.message, findError.details);
		throw error(502, `Failed to locate Web Clips folder: ${findError.message}`);
	}

	if (candidates.length) {
		const { data: rootBranches, error: branchError } = await supabase
			.from('branches')
			.select('note_id')
			.is('parent_id', null)
			.in(
				'note_id',
				candidates.map((c) => c.id)
			)
			.limit(1);
		if (branchError) {
			console.error('Inbox branch lookup failed:', branchError.message, branchError.details);
			throw error(502, `Failed to locate Web Clips branch: ${branchError.message}`);
		}
		if (rootBranches.length) return rootBranches[0].note_id;
	}

	const inboxId = randomUUID();
	const { data: inbox, error: createError } = await supabase
		.from('notes')
		.insert({ id: inboxId, title: INBOX_TITLE, content: '', is_shared: false, user_id: userId } as any)
		.select('id')
		.single();
	if (createError) {
		console.error('Inbox creation failed:', createError.message, createError.details);
		throw error(502, `Failed to create Web Clips note: ${createError.message}`);
	}

	const inboxBranchId = randomUUID();
	const { error: rootError } = await supabase
		.from('branches')
		.insert({ id: inboxBranchId, note_id: inbox.id, parent_id: null });
	if (rootError) {
		console.error('Inbox root branch creation failed:', rootError.message, rootError.details);
		throw error(502, `Failed to create Web Clips branch: ${rootError.message}`);
	}
	return inbox.id;
}

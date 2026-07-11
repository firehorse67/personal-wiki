import { json, error } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { randomUUID } from 'node:crypto';
import type { Database } from '$lib/supabaseClient';
import type { RequestHandler } from './$types';

// Extensions that render/execute when served inline from the public bucket.
const BLOCKED_EXT = new Set(['html', 'htm', 'svg', 'xml', 'xhtml', 'js', 'mjs']);

/**
 * Issues a one-time signed upload slot in the clips bucket. Only this small
 * JSON request passes through Vercel — the file bytes then go browser →
 * Supabase Storage directly via uploadToSignedUrl, so there is no 4.5 MB
 * body cap and no storage RLS policy is needed (signed URLs carry their own
 * authorization). The caller's access token must verify and carry aal2.
 */
export const POST: RequestHandler = async ({ request }) => {
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

	let body: { name?: unknown; path?: unknown };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Body must be JSON');
	}

	let path = '';
	if (typeof body.path === 'string' && body.path) {
		path = body.path;
		if (!path.startsWith('attachments/') || path.includes('..') || !/^[\w\-./ ]+$/.test(path)) {
			throw error(400, 'Invalid path');
		}
		const ext = (path.split('.').pop() || 'bin').toLowerCase();
		if (BLOCKED_EXT.has(ext)) throw error(415, `.${ext} files cannot be attached`);
	} else {
		// Keep the original filename (sanitized) as the object's basename so
		// browser open/save actions show a friendly name; the UUID folder keeps
		// paths collision-free. slice(-100) trims from the front, preserving
		// the extension.
		const safeName =
			String(body.name ?? 'file.bin')
				.replace(/[^\w.\- ]+/g, '')
				.replace(/\s+/g, '-')
				.replace(/^\.+/, '')
				.slice(-100) || 'file.bin';
		const ext = (safeName.split('.').pop() || 'bin').toLowerCase();
		if (BLOCKED_EXT.has(ext)) throw error(415, `.${ext} files cannot be attached`);

		path = `attachments/${randomUUID()}/${safeName}`;
	}

	const { data, error: signError } = await supabase.storage
		.from('clips')
		.createSignedUploadUrl(path, { upsert: true });
	if (signError) {
		console.error('Signed upload URL creation failed:', signError.message);
		throw error(502, 'Could not create upload slot');
	}

	return json(
		{
			path,
			token: data.token,
			publicUrl: supabase.storage.from('clips').getPublicUrl(path).data.publicUrl
		},
		{ status: 201 }
	);
};

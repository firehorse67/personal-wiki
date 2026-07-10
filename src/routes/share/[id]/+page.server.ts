import { error } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import { sanitizeSharedHtml } from '$lib/server/sanitizeShared';
import type { Database } from '$lib/supabaseClient';
import type { PageServerLoad } from './$types';

// Public page: server-render it (the root layout disables SSR app-wide for
// the offline-first shell) so shared links unfurl and load without JS.
export const ssr = true;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Serves exactly one note, read-only, keyed by its UUID (122 random bits —
 * the unguessable access token). The service-role client bypasses RLS, so
 * the isShared attribute check is the sole authorization gate and MUST pass
 * before the note row is ever read. Nothing else is queried: no branches,
 * no children, no attributes beyond the flag — a shared note can never leak
 * its subtree or neighbours.
 */
export const load: PageServerLoad = async ({ params, setHeaders }) => {
	if (!UUID_RE.test(params.id)) throw error(404, 'Not found');
	if (!env.SUPABASE_SERVICE_ROLE_KEY) throw error(500, 'Sharing is not configured');

	const supabase = createClient<Database>(PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: { persistSession: false, autoRefreshToken: false }
	});

	const { data: flags, error: flagError } = await supabase
		.from('attributes')
		.select('id')
		.eq('note_id', params.id)
		.eq('type', 'label')
		.eq('key', 'isShared')
		.eq('value', 'true')
		.limit(1);
	if (flagError) {
		console.error('Share flag lookup failed:', flagError.message);
		throw error(502, 'Temporarily unavailable');
	}
	// Unshared and nonexistent are indistinguishable on purpose.
	if (!flags.length) throw error(404, 'Not found');

	const { data: note, error: noteError } = await supabase
		.from('notes')
		.select('title, content, updated_at')
		.eq('id', params.id)
		.maybeSingle();
	if (noteError) {
		console.error('Shared note fetch failed:', noteError.message);
		throw error(502, 'Temporarily unavailable');
	}
	if (!note) throw error(404, 'Not found');

	// CDN-cache briefly; unsharing takes effect within five minutes.
	setHeaders({ 'cache-control': 'public, max-age=0, s-maxage=300' });

	return {
		title: note.title || 'Untitled',
		html: sanitizeSharedHtml(note.content || ''),
		updatedAt: note.updated_at
	};
};

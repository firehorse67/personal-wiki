import { json, error } from '@sveltejs/kit';
import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/private';
import { PUBLIC_SUPABASE_URL } from '$env/static/public';
import type { Database } from '$lib/supabaseClient';
import type { RequestHandler } from './$types';

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Weekly maintenance: permanently remove notes that have sat in Trash past
 * the 30-day retention window. The client already does this on page load
 * (src/lib/notes.svelte.ts purgeOldTrash), but that only runs when someone
 * opens the app — this cron closes the gap for a wiki nobody's visited in a
 * month. Configure as a Vercel Cron Job hitting this route on a schedule;
 * Vercel automatically sends `Authorization: Bearer $CRON_SECRET` for cron
 * requests when that env var is set, which is what's checked below.
 */
export const GET: RequestHandler = async ({ request }) => {
	if (!env.CRON_SECRET) throw error(500, 'CRON_SECRET is not configured');
	if (request.headers.get('authorization') !== `Bearer ${env.CRON_SECRET}`) {
		throw error(401, 'Unauthorized');
	}
	if (!env.SUPABASE_SERVICE_ROLE_KEY) throw error(500, 'Purge is not configured');

	const supabase = createClient<Database>(PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
		auth: { persistSession: false, autoRefreshToken: false }
	});

	const cutoff = new Date(Date.now() - TRASH_RETENTION_MS).toISOString();
	const { data: stale, error: attrError } = await supabase
		.from('attributes')
		.select('note_id')
		.eq('key', 'trashedAt')
		.lt('value', cutoff);
	if (attrError) {
		console.error('Trash purge: trashedAt lookup failed:', attrError.message);
		throw error(502, 'Purge failed');
	}
	if (!stale.length) return json({ purged: 0 });

	let purged = 0;
	for (const { note_id: rootNoteId } of stale) {
		try {
			purged += await purgeSubtree(supabase, rootNoteId);
		} catch (err) {
			console.error(`Trash purge: failed for note ${rootNoteId}:`, err);
		}
	}
	return json({ purged });
};

/**
 * Deletes a trashed note and its subtree. A note cloned outside the
 * subtree (still has other placements) survives — only its branch under
 * this subtree is removed, mirroring the client's removeBranchRecursive.
 * Returns the count of notes actually deleted.
 */
async function purgeSubtree(
	supabase: ReturnType<typeof createClient<Database>>,
	rootNoteId: string
): Promise<number> {
	// BFS the subtree via branch rows so clones with placements elsewhere
	// aren't silently swept up by a cascade.
	const branchPairs: { branchId: string; noteId: string }[] = [];
	const queue = [rootNoteId];
	const seen = new Set<string>();
	while (queue.length) {
		const parentId = queue.shift()!;
		const { data: children, error: childError } = await supabase
			.from('branches')
			.select('id, note_id')
			.eq('parent_id', parentId);
		if (childError) throw childError;
		for (const child of children ?? []) {
			if (seen.has(child.id)) continue;
			seen.add(child.id);
			branchPairs.push({ branchId: child.id, noteId: child.note_id });
			queue.push(child.note_id);
		}
	}
	// Include the root's own branch under Trash.
	const { data: rootBranches, error: rootError } = await supabase
		.from('branches')
		.select('id')
		.eq('note_id', rootNoteId);
	if (rootError) throw rootError;
	for (const branch of rootBranches ?? []) {
		if (!seen.has(branch.id)) {
			seen.add(branch.id);
			branchPairs.push({ branchId: branch.id, noteId: rootNoteId });
		}
	}
	if (!branchPairs.length) return 0;

	const { error: deleteBranchesError } = await supabase
		.from('branches')
		.delete()
		.in(
			'id',
			branchPairs.map((p) => p.branchId)
		);
	if (deleteBranchesError) throw deleteBranchesError;

	let deletedNotes = 0;
	const uniqueNoteIds = [...new Set(branchPairs.map((p) => p.noteId))];
	for (const noteId of uniqueNoteIds) {
		const { count, error: countError } = await supabase
			.from('branches')
			.select('id', { count: 'exact', head: true })
			.eq('note_id', noteId);
		if (countError) throw countError;
		if ((count ?? 0) > 0) continue; // still placed elsewhere — survives

		// Cascades attributes (0003) and any remaining branch rows for this note.
		const { error: deleteNoteError } = await supabase.from('notes').delete().eq('id', noteId);
		if (deleteNoteError) throw deleteNoteError;
		deletedNotes++;
	}
	return deletedNotes;
}

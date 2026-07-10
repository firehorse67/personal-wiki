import { liveQuery } from 'dexie';
import { SvelteSet } from 'svelte/reactivity';
import { db, type LocalNote, type LocalBranch, type LocalAttribute } from '$lib/db';
import { syncNow } from '$lib/sync';
import type { NoteAttribute } from '$lib/supabaseClient';

// $state.raw: rows are replaced wholesale by the live query, never mutated
// in place, so deep proxies would only add per-read overhead on hot paths
// (tree map rebuilds iterate every row).
let allNotes = $state.raw<LocalNote[]>([]);
let allBranches = $state.raw<LocalBranch[]>([]);
let allAttributes = $state.raw<LocalAttribute[]>([]);
let selectedId = $state<string | null>(null);
let searchQuery = $state('');
let apiKey = $state(typeof localStorage !== 'undefined' ? (localStorage.getItem('gemini_api_key') || '') : '');
let systemPrompt = $state(typeof localStorage !== 'undefined' ? (localStorage.getItem('gemini_system_prompt') || "You are a helpful AI assistant. Respond using Australian English spelling (e.g. summarise, colour), currency (AUD, $), metric measures, and dates formatted as D/M/YY. Adapt your tone to match the user's writing style based on their notes.") : "You are a helpful AI assistant. Respond using Australian English spelling (e.g. summarise, colour), currency (AUD, $), metric measures, and dates formatted as D/M/YY. Adapt your tone to match the user's writing style based on their notes.");
let sortOption = $state<'az' | 'za' | 'date_asc' | 'date_desc'>(
	typeof localStorage !== 'undefined' ? (localStorage.getItem('wiki_sort_option') as any || 'az') : 'az'
);

let isOnline = $state(typeof window !== 'undefined' ? navigator.onLine : true);
let isSyncing = $state(false);
let lastSyncError = $state('');
let attachmentsDirtyCount = $state(0);
let attachmentTombstonesCount = $state(0);
let sidebarOpen = $state(false);

let notesTombstonesCount = $state(0);
let branchesTombstonesCount = $state(0);
let attributesTombstonesCount = $state(0);

if (typeof window !== 'undefined') {
	window.addEventListener('online', () => { isOnline = true; });
	window.addEventListener('offline', () => { isOnline = false; });
}


/**
 * Fold text to what the user actually sees before matching: drop HTML tags
 * (so "em dash" matches "em <strong>dash</strong>" and tag names can't
 * false-positive), remove invisible characters (soft hyphens and zero-width
 * spaces are common in clipped web content and break substring matching
 * while looking identical), fold diacritics, and collapse whitespace.
 */
function searchable(text: string): string {
	return text
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '') // combining marks: café → cafe
		.replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '') // soft hyphen + zero-width chars
		.toLowerCase()
		.replace(/\s+/g, ' ');
}

const matchingNoteIds = $derived.by(() => {
	const trimmed = searchQuery.trim();
	if (!trimmed) return null;
	const ids = new Set<string>();

	if (trimmed.startsWith('#')) {
		// Attribute search: e.g. #topic:Travel or #topic
		const parts = trimmed.substring(1).split(':');
		const key = parts[0]?.trim().toLowerCase();
		const val = parts[1]?.trim().toLowerCase();
		if (!key) return null;

		for (const attr of allAttributes) {
			if (attr.type === 'label' && attr.key.toLowerCase() === key) {
				if (!val || attr.value.toLowerCase() === val) {
					ids.add(attr.note_id);
				}
			}
		}
	} else if (trimmed.startsWith(':')) {
		// Type prefix search: e.g. :webview
		const typeVal = trimmed.substring(1).trim().toLowerCase();
		if (!typeVal) return null;

		for (const attr of allAttributes) {
			if (attr.type === 'label' && attr.key === 'noteType' && attr.value.toLowerCase() === typeVal) {
				ids.add(attr.note_id);
			}
		}
	} else {
		// Normal text search
		const query = searchable(searchQuery).trim();
		if (!query) return null;
		for (const note of allNotes) {
			if (
				searchable(note.title || '').includes(query) ||
				searchable(note.content || '').includes(query)
			) {
				ids.add(note.id);
			}
		}
	}
	return ids;
});

const visibleBranchIds = $derived.by(() => {
	if (!matchingNoteIds) return null;
	const visible = new Set<string>();

	function markAncestorsVisible(branch: LocalBranch) {
		if (visible.has(branch.id)) return;
		visible.add(branch.id);
		if (branch.parent_id) {
			for (const parentBranch of allBranches) {
				if (parentBranch.note_id === branch.parent_id) {
					markAncestorsVisible(parentBranch);
				}
			}
		}
	}

	for (const branch of allBranches) {
		if (matchingNoteIds.has(branch.note_id)) {
			markAncestorsVisible(branch);
		}
	}
	return visible;
});

// A note being cloned: set by the row action, consumed by clicking a
// destination (or the "place at root" button in the sidebar banner).
let pendingCloneId = $state<string | null>(null);
let pendingMoveBranchId = $state<string | null>(null);

// Expansion is keyed by BRANCH id, not note id, so expanding one clone of a
// note doesn't expand its other placements — and it lives outside the rows
// themselves so sync cycles can't collapse the tree.
const expandedIds = new SvelteSet<string>();

const noteById = $derived(new Map(allNotes.map((note) => [note.id, note])));

const bookmarkedBranches = $derived.by(() => {
	const list: LocalBranch[] = [];
	const seenNotes = new Set<string>();
	for (const branch of allBranches) {
		if (seenNotes.has(branch.note_id)) continue;
		const isBookmarked = allAttributes.some((a) => a.note_id === branch.note_id && a.type === 'label' && a.key === 'bookmark');
		if (isBookmarked) {
			list.push(branch);
			seenNotes.add(branch.note_id);
		}
	}
	list.sort((a, b) => {
		const titleA = noteById.get(a.note_id)?.title ?? '';
		const titleB = noteById.get(b.note_id)?.title ?? '';
		return titleA.localeCompare(titleB);
	});
	return list;
});

const branchCounts = $derived.by(() => {
	const counts = new Map<string, number>();
	for (const branch of allBranches) {
		counts.set(branch.note_id, (counts.get(branch.note_id) ?? 0) + 1);
	}
	return counts;
});

const branchesByParent = $derived.by(() => {
	const map = new Map<string | null, LocalBranch[]>();
	for (const branch of allBranches) {
		// A branch whose note hasn't arrived yet (mid-pull) renders nothing.
		if (!noteById.has(branch.note_id)) continue;
		const siblings = map.get(branch.parent_id);
		if (siblings) siblings.push(branch);
		else map.set(branch.parent_id, [branch]);
	}
	for (const siblings of map.values()) {
		siblings.sort((a, b) => {
			const noteA = noteById.get(a.note_id);
			const noteB = noteById.get(b.note_id);
			const titleA = noteA?.title ?? '';
			const titleB = noteB?.title ?? '';

			const isHomeA = titleA.trim().toLowerCase() === 'home';
			const isHomeB = titleB.trim().toLowerCase() === 'home';
			if (isHomeA && !isHomeB) return -1;
			if (!isHomeA && isHomeB) return 1;

			if (sortOption === 'az') {
				return titleA.localeCompare(titleB);
			} else if (sortOption === 'za') {
				return titleB.localeCompare(titleA);
			} else if (sortOption === 'date_asc') {
				const dateA = noteA?.updated_at || '';
				const dateB = noteB?.updated_at || '';
				return dateA.localeCompare(dateB);
			} else if (sortOption === 'date_desc') {
				const dateA = noteA?.updated_at || '';
				const dateB = noteB?.updated_at || '';
				return dateB.localeCompare(dateA);
			}
			return 0;
		});
	}
	return map;
});

const selected = $derived(selectedId ? (noteById.get(selectedId) ?? null) : null);

const attributesByNote = $derived.by(() => {
	const map = new Map<string, LocalAttribute[]>();
	for (const attribute of allAttributes) {
		const list = map.get(attribute.note_id);
		if (list) list.push(attribute);
		else map.set(attribute.note_id, [attribute]);
	}
	for (const list of map.values()) {
		list.sort((a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value));
	}
	return map;
});

/**
 * Mirror Dexie's notes and branches tables into reactive state. Returns an
 * unsubscribe function, so it can be used directly as an $effect body.
 */
/**
 * Preserve object identity for rows the write didn't touch, and array
 * identity when nothing changed at all. Every Dexie write re-emits whole
 * tables; without this, each keystroke gave every row a fresh identity,
 * so every $derived map rebuilt and every TreeItem re-evaluated. With it,
 * unchanged rows compare === and downstream reactivity short-circuits
 * (a no-op sync tick becomes completely free).
 */
function reuseRows<T extends { id: string; updated_at: string; dirty: number; modified_at: number }>(
	previous: T[],
	next: T[]
): T[] {
	const previousById = new Map(previous.map((row) => [row.id, row]));
	let unchanged = previous.length === next.length;
	const merged = next.map((row) => {
		const old = previousById.get(row.id);
		if (
			old &&
			old.modified_at === row.modified_at &&
			old.dirty === row.dirty &&
			old.updated_at === row.updated_at
		) {
			return old;
		}
		unchanged = false;
		return row;
	});
	return unchanged ? previous : merged;
}

let migratedRootNotes = false;

async function migrateRootNotesToNotesFolder() {
	if (typeof localStorage !== 'undefined' && localStorage.getItem('wiki_root_migration_v1') === 'true') {
		return;
	}
	try {
		const allNotesList = await db.notes.toArray();
		const allBranchesList = await db.branches.toArray();

		let notesFolderBranch = allBranchesList.find((b) => {
			const n = allNotesList.find((note) => note.id === b.note_id);
			return n && n.title.trim().toLowerCase() === 'notes' && b.parent_id === null;
		});

		let notesFolderNoteId: string;

		if (!notesFolderBranch) {
			const notesNote = allNotesList.find((n) => n.title.trim().toLowerCase() === 'notes');
			if (notesNote) {
				const branch = allBranchesList.find((b) => b.note_id === notesNote.id);
				if (branch) {
					notesFolderNoteId = notesNote.id;
				} else {
					notesFolderNoteId = notesNote.id;
					await db.branches.put({
						id: crypto.randomUUID(),
						note_id: notesFolderNoteId,
						parent_id: null,
						updated_at: new Date().toISOString(),
						dirty: 1,
						modified_at: Date.now()
					});
				}
			} else {
				notesFolderNoteId = crypto.randomUUID();
				await db.notes.put({
					id: notesFolderNoteId,
					title: 'Notes',
					content: '',
					is_shared: false,
					updated_at: new Date().toISOString(),
					dirty: 1,
					modified_at: Date.now()
				});
				await db.branches.put({
					id: crypto.randomUUID(),
					note_id: notesFolderNoteId,
					parent_id: null,
					updated_at: new Date().toISOString(),
					dirty: 1,
					modified_at: Date.now()
				});
			}
		} else {
			notesFolderNoteId = notesFolderBranch.note_id;
		}

		const systemNotes = new Set(['home', 'journal', 'inbox', 'notes', 'public']);
		const branchesToMove = allBranchesList.filter((b) => {
			if (b.parent_id !== null) return false;
			const n = allNotesList.find((note) => note.id === b.note_id);
			if (!n) return false;
			const titleLower = n.title.trim().toLowerCase();
			return !systemNotes.has(titleLower);
		});

		if (branchesToMove.length > 0) {
			const stamp = { updated_at: new Date().toISOString(), dirty: 1, modified_at: Date.now() };
			await db.transaction('rw', [db.branches], async () => {
				for (const branch of branchesToMove) {
					await db.branches.update(branch.id, {
						parent_id: notesFolderNoteId,
						...stamp
					});
				}
			});
			void syncNow();
		}
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('wiki_root_migration_v1', 'true');
		}
	} catch (error) {
		console.error('Migration failed:', error);
	}
}

export function initNotes(): () => void {
	const subscription = liveQuery(async () => ({
		notes: await db.notes.toArray(),
		branches: await db.branches.toArray(),
		attributes: await db.attributes.toArray(),
		tombnotes: await db.tombstones.count(),
		tombranches: await db.branchTombstones.count(),
		tomattrs: await db.attributeTombstones.count(),
		dirtyattachments: await db.attachments.where('dirty').equals(1).count(),
		tombattachments: await db.attachmentTombstones.count()
	})).subscribe({
		next: (rows) => {
			allNotes = reuseRows(allNotes, rows.notes);
			allBranches = reuseRows(allBranches, rows.branches);
			allAttributes = reuseRows(allAttributes, rows.attributes);
			notesTombstonesCount = rows.tombnotes;
			branchesTombstonesCount = rows.tombranches;
			attributesTombstonesCount = rows.tomattrs;
			attachmentsDirtyCount = rows.dirtyattachments;
			attachmentTombstonesCount = rows.tombattachments;

			const hasMigrated = typeof localStorage !== 'undefined' && localStorage.getItem('wiki_root_migration_v1') === 'true';
			if (!migratedRootNotes && !hasMigrated && allNotes.length > 0) {
				migratedRootNotes = true;
				setTimeout(migrateRootNotesToNotesFolder, 100);
			}
		},
		error: (error) => console.error('Notes live query failed:', error)
	});
	return () => subscription.unsubscribe();
}

// Batch rapid edits (typing) into one sync pass shortly after they stop.
let syncDebounce: ReturnType<typeof setTimeout> | null = null;
function scheduleSyncSoon(): void {
	if (syncDebounce) clearTimeout(syncDebounce);
	syncDebounce = setTimeout(() => {
		syncDebounce = null;
		void syncNow();
	}, 1_500);
}

async function updateNote(
	id: string,
	patch: Partial<Pick<LocalNote, 'title' | 'content' | 'is_shared'>>
): Promise<void> {
	await db.notes.update(id, { ...patch, dirty: 1, modified_at: Date.now() });
	scheduleSyncSoon();
}

/** Attach a label or relation to a note. Duplicate keys are allowed (Trilium-style). */
async function addAttribute(
	noteId: string,
	attribute: Pick<NoteAttribute, 'type' | 'key' | 'value'>
): Promise<string> {
	const id = crypto.randomUUID();
	await db.attributes.put({
		id,
		note_id: noteId,
		...attribute,
		updated_at: new Date().toISOString(), // provisional; server value arrives on next pull
		dirty: 1,
		modified_at: Date.now()
	});
	scheduleSyncSoon();
	return id;
}

async function updateAttribute(
	id: string,
	patch: Partial<Pick<NoteAttribute, 'type' | 'key' | 'value'>>
): Promise<void> {
	await db.attributes.update(id, { ...patch, dirty: 1, modified_at: Date.now() });
	scheduleSyncSoon();
}

async function removeAttribute(id: string): Promise<void> {
	await db.transaction('rw', db.attributes, db.attributeTombstones, async () => {
		await db.attributes.delete(id);
		await db.attributeTombstones.put({ id, deleted_at: Date.now() });
	});
	scheduleSyncSoon();
}

/**
 * Rename a Kanban status across a board in ONE transaction: every child
 * note's status label whose value matches `oldValue` migrates to `newValue`,
 * and the board's kanbanColumns attribute is upserted with `newColumnsCsv`
 * in the same commit — an interrupted rename can never half-migrate a
 * column. Returns the number of cards migrated.
 */
async function renameStatusLabel(
	parentNoteId: string,
	oldValue: string,
	newValue: string,
	newColumnsCsv: string
): Promise<number> {
	const childIds = new Set(
		allBranches.filter((b) => b.parent_id === parentNoteId).map((b) => b.note_id)
	);
	const now = Date.now();
	let migrated = 0;

	await db.transaction('rw', db.attributes, async () => {
		const statusRows = await db.attributes.where('key').equals('status').toArray();
		for (const row of statusRows) {
			if (row.type === 'label' && row.value === oldValue && childIds.has(row.note_id)) {
				await db.attributes.update(row.id, { value: newValue, dirty: 1, modified_at: now });
				migrated++;
			}
		}
		const boardAttrs = await db.attributes.where('note_id').equals(parentNoteId).toArray();
		const colsAttr = boardAttrs.find((a) => a.type === 'label' && a.key === 'kanbanColumns');
		if (colsAttr) {
			await db.attributes.update(colsAttr.id, {
				value: newColumnsCsv,
				dirty: 1,
				modified_at: now
			});
		} else {
			await db.attributes.put({
				id: crypto.randomUUID(),
				note_id: parentNoteId,
				type: 'label',
				key: 'kanbanColumns',
				value: newColumnsCsv,
				updated_at: new Date().toISOString(),
				dirty: 1,
				modified_at: now
			});
		}
	});
	scheduleSyncSoon();
	return migrated;
}

/** Delete a status label from every child of a board in one transaction. */
async function clearStatusLabel(parentNoteId: string, value: string): Promise<void> {
	const childIds = new Set(
		allBranches.filter((b) => b.parent_id === parentNoteId).map((b) => b.note_id)
	);
	await db.transaction('rw', [db.attributes, db.attributeTombstones], async () => {
		const statusRows = await db.attributes.where('key').equals('status').toArray();
		for (const row of statusRows) {
			if (row.type === 'label' && row.value === value && childIds.has(row.note_id)) {
				await db.attributes.delete(row.id);
				await db.attributeTombstones.put({ id: row.id, deleted_at: Date.now() });
			}
		}
	});
	scheduleSyncSoon();
}

/**
 * Trilium-style saved-search: AND-combine query tokens against the live
 * in-memory rows. Tokens: #key:value (label equals), #key (label exists),
 * :type (noteType equals), anything else is folded full-text. Reads
 * reactive state, so results recompute automatically inside $derived.
 */
function runSavedSearch(query: string): LocalNote[] {
	const tokens = query.trim().split(/\s+/).filter(Boolean);
	if (!tokens.length) return [];

	const labelChecks: { key: string; value: string | null }[] = [];
	const textTerms: string[] = [];
	for (const token of tokens) {
		if (token.startsWith('#') && token.length > 1) {
			const [key, ...rest] = token.slice(1).split(':');
			labelChecks.push({
				key: key.toLowerCase(),
				value: rest.length ? rest.join(':').toLowerCase() : null
			});
		} else if (token.startsWith(':') && token.length > 1) {
			labelChecks.push({ key: 'notetype', value: token.slice(1).toLowerCase() });
		} else {
			textTerms.push(token);
		}
	}
	const textQuery = searchable(textTerms.join(' ')).trim();

	const results: LocalNote[] = [];
	for (const note of allNotes) {
		const attrs = attributesByNote.get(note.id) ?? [];
		const labelsOk = labelChecks.every((check) =>
			attrs.some(
				(a) =>
					a.type === 'label' &&
					a.key.toLowerCase() === check.key &&
					(check.value === null || a.value.toLowerCase() === check.value)
			)
		);
		if (!labelsOk) continue;
		if (
			textQuery &&
			!searchable(note.title || '').includes(textQuery) &&
			!searchable(note.content || '').includes(textQuery)
		) {
			continue;
		}
		results.push(note);
	}
	results.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
	return results;
}

/** Create a note plus its first branch. `expandBranchId` opens the row the + was clicked on. */
async function createNote(parentNoteId: string | null, expandBranchId?: string): Promise<string> {
	const noteId = crypto.randomUUID();
	const now = Date.now();
	const provisionalClock = new Date().toISOString(); // replaced by server value on next pull
	await db.transaction('rw', db.notes, db.branches, async () => {
		await db.notes.put({
			id: noteId,
			title: 'Untitled',
			content: '',
			is_shared: false,
			created_at: provisionalClock,
			updated_at: provisionalClock,
			dirty: 1,
			modified_at: now
		});
		await db.branches.put({
			id: crypto.randomUUID(),
			note_id: noteId,
			parent_id: parentNoteId,
			updated_at: provisionalClock,
			dirty: 1,
			modified_at: now
		});
	});
	if (expandBranchId) expandedIds.add(expandBranchId);
	selectedId = noteId;
	sidebarOpen = false;
	void syncNow();
	return noteId;
}

async function createJournalNote(parentNoteId: string, title: string, content: string): Promise<string> {
	const noteId = crypto.randomUUID();
	const now = Date.now();
	const provisionalClock = new Date().toISOString();
	await db.transaction('rw', [db.notes, db.branches], async () => {
		await db.notes.put({
			id: noteId,
			title,
			content,
			is_shared: false,
			updated_at: provisionalClock,
			dirty: 1,
			modified_at: now
		});
		await db.branches.put({
			id: crypto.randomUUID(),
			note_id: noteId,
			parent_id: parentNoteId,
			updated_at: provisionalClock,
			dirty: 1,
			modified_at: now
		});
	});
	selectedId = noteId;
	sidebarOpen = false;
	void syncNow();
	return noteId;
}

/**
 * Every path at which a note lives, as "/Parent/Child" strings of ancestor
 * titles (the note's own title excluded). One path per placement — and since
 * ancestors can themselves be cloned, paths multiply through every placement
 * of every ancestor, Trilium-style. Reads reactive state, so calling it
 * inside $derived keeps the result live across renames and re-parenting.
 */
function parentPaths(noteId: string): string[] {
	const results: string[] = [];
	const walk = (id: string, suffix: string[], seen: Set<string>) => {
		if (results.length >= 50) return; // pathological clone graphs stay bounded
		for (const branch of allBranches) {
			if (branch.note_id !== id) continue;
			if (branch.parent_id === null) {
				results.push('/' + suffix.join('/'));
				continue;
			}
			if (seen.has(branch.parent_id)) continue; // cycle guard
			const parent = noteById.get(branch.parent_id);
			if (!parent) continue;
			walk(
				branch.parent_id,
				[parent.title || 'Untitled', ...suffix],
				new Set(seen).add(branch.parent_id)
			);
		}
	};
	walk(noteId, [], new Set([noteId]));
	return results.length ? results : ['/'];
}

/** Every note id reachable walking UP from `noteId` through any branch. */
function ancestorNoteIds(noteId: string): Set<string> {
	const seen = new Set<string>();
	const queue = [noteId];
	while (queue.length) {
		const current = queue.pop()!;
		for (const branch of allBranches) {
			if (branch.note_id === current && branch.parent_id && !seen.has(branch.parent_id)) {
				seen.add(branch.parent_id);
				queue.push(branch.parent_id);
			}
		}
	}
	return seen;
}

/** Finish a pending clone. Returns an error message to show, or null on success. */
async function placeClone(destParentNoteId: string | null): Promise<string | null> {
	const sourceId = pendingCloneId;
	if (!sourceId) return null;

	if (destParentNoteId === sourceId) {
		return 'A note cannot be cloned under itself.';
	}
	if (destParentNoteId && ancestorNoteIds(destParentNoteId).has(sourceId)) {
		return 'That would create a cycle: the destination sits inside the note being cloned.';
	}
	if (allBranches.some((b) => b.note_id === sourceId && b.parent_id === destParentNoteId)) {
		return 'The note is already placed there.';
	}

	await db.branches.put({
		id: crypto.randomUUID(),
		note_id: sourceId,
		parent_id: destParentNoteId,
		updated_at: new Date().toISOString(),
		dirty: 1,
		modified_at: Date.now()
	});
	// Open every placement of the destination so the new clone is visible.
	if (destParentNoteId) {
		for (const branch of allBranches) {
			if (branch.note_id === destParentNoteId) expandedIds.add(branch.id);
		}
	}
	pendingCloneId = null;
	void syncNow();
	return null;
}

/** Finish a pending move. Returns an error message to show, or null on success. */
async function placeMove(destParentNoteId: string | null): Promise<string | null> {
	const sourceBranchId = pendingMoveBranchId;
	if (!sourceBranchId) return null;

	const sourceBranch = allBranches.find((b) => b.id === sourceBranchId);
	if (!sourceBranch) {
		pendingMoveBranchId = null;
		return null;
	}

	const sourceNoteId = sourceBranch.note_id;

	if (destParentNoteId === sourceNoteId) {
		return 'A note cannot be moved under itself.';
	}
	if (destParentNoteId && ancestorNoteIds(destParentNoteId).has(sourceNoteId)) {
		return 'That would create a cycle: the destination sits inside the note being moved.';
	}
	if (sourceBranch.parent_id === destParentNoteId) {
		pendingMoveBranchId = null;
		return null;
	}
	if (allBranches.some((b) => b.note_id === sourceNoteId && b.parent_id === destParentNoteId)) {
		return 'The note is already placed there.';
	}

	await db.branches.update(sourceBranchId, {
		parent_id: destParentNoteId,
		updated_at: new Date().toISOString(),
		dirty: 1,
		modified_at: Date.now()
	});

	// Open every placement of the destination so the moved note is visible.
	if (destParentNoteId) {
		for (const branch of allBranches) {
			if (branch.note_id === destParentNoteId) expandedIds.add(branch.id);
		}
	}
	pendingMoveBranchId = null;
	void syncNow();
	return null;
}

/**
 * Remove one placement. If it was the note's last branch, the note itself is
 * deleted and the removal recurses into its children — a child that is also
 * cloned elsewhere survives (only its branch under this subtree is removed).
 */
/** The root note titled "Trash", if it exists. */
const trashRootId = $derived.by(() => {
	for (const branch of allBranches) {
		if (branch.parent_id !== null) continue;
		const note = noteById.get(branch.note_id);
		if (note && note.title.trim().toLowerCase() === 'trash') return note.id;
	}
	return null;
});

async function ensureTrashRoot(): Promise<string> {
	if (trashRootId) return trashRootId;
	const id = crypto.randomUUID();
	const stamp = { updated_at: new Date().toISOString(), dirty: 1, modified_at: Date.now() };
	await db.transaction('rw', [db.notes, db.branches], async () => {
		await db.notes.put({ id, title: 'Trash', content: '', is_shared: false, ...stamp });
		await db.branches.put({ id: crypto.randomUUID(), note_id: id, parent_id: null, ...stamp });
	});
	return id;
}

/**
 * Deleting is now recoverable: the last placement of a note moves to the
 * Trash root (subtree rides along via parent_id), stamped with trashedFrom/
 * trashedAt attributes for restore and the 30-day purge. Removing one
 * placement of a clone stays immediate (the note survives elsewhere), and
 * deleting something already inside Trash is permanent.
 */
async function deleteBranch(branchId: string): Promise<void> {
	const branch = allBranches.find((b) => b.id === branchId);
	if (!branch) return;
	if (branch.parent_id === null && branch.note_id === trashRootId) return; // Trash itself

	// Clone placement removal: other placements keep the note alive.
	if ((branchCounts.get(branch.note_id) ?? 0) > 1) {
		await db.transaction('rw', [db.branches, db.branchTombstones], async () => {
			await db.branches.delete(branchId);
			await db.branchTombstones.put({ id: branchId, deleted_at: Date.now() });
		});
		void syncNow();
		return;
	}

	// Already in Trash → permanent delete.
	if (trashRootId !== null && branch.parent_id === trashRootId) {
		await hardDeleteBranch(branchId);
		return;
	}

	const trashId = await ensureTrashRoot();
	const stamp = { updated_at: new Date().toISOString(), dirty: 1, modified_at: Date.now() };
	await db.transaction('rw', [db.branches, db.attributes], async () => {
		await db.branches.update(branchId, { parent_id: trashId, dirty: 1, modified_at: Date.now() });
		await db.attributes.put({
			id: crypto.randomUUID(),
			note_id: branch.note_id,
			type: 'label',
			key: 'trashedFrom',
			value: branch.parent_id ?? '',
			...stamp
		});
		await db.attributes.put({
			id: crypto.randomUUID(),
			note_id: branch.note_id,
			type: 'label',
			key: 'trashedAt',
			value: new Date().toISOString(),
			...stamp
		});
	});
	if (selectedId === branch.note_id) selectedId = null;
	void syncNow();
}

/** Immediate, unrecoverable subtree delete (used inside Trash and by purge). */
async function hardDeleteBranch(branchId: string): Promise<void> {
	const deletedNoteIds: string[] = [];
	await db.transaction(
		'rw',
		[db.notes, db.branches, db.attributes, db.tombstones, db.branchTombstones, db.attributeTombstones],
		() => removeBranchRecursive(branchId, deletedNoteIds)
	);
	if (selectedId && deletedNoteIds.includes(selectedId)) selectedId = null;
	void syncNow();
}

/** Move a trashed note back to where it came from (or the root if gone). */
async function restoreFromTrash(branchId: string): Promise<void> {
	const branch = allBranches.find((b) => b.id === branchId);
	if (!branch) return;
	const attrs = attributesByNote.get(branch.note_id) ?? [];
	const fromAttr = attrs.find((a) => a.key === 'trashedFrom');
	const atAttr = attrs.find((a) => a.key === 'trashedAt');
	const from = fromAttr?.value || null;
	const targetParent = from && noteById.has(from) ? from : null;

	await db.transaction('rw', [db.branches, db.attributes, db.attributeTombstones], async () => {
		await db.branches.update(branchId, {
			parent_id: targetParent,
			dirty: 1,
			modified_at: Date.now()
		});
		for (const attr of [fromAttr, atAttr]) {
			if (!attr) continue;
			await db.attributes.delete(attr.id);
			await db.attributeTombstones.put({ id: attr.id, deleted_at: Date.now() });
		}
	});
	void syncNow();
}

const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Permanently remove trashed notes older than 30 days. Returns count purged. */
async function purgeOldTrash(): Promise<number> {
	const trashId = trashRootId;
	if (!trashId) return 0;
	const cutoff = Date.now() - TRASH_RETENTION_MS;
	let purged = 0;
	for (const branch of allBranches.filter((b) => b.parent_id === trashId)) {
		const trashedAt = attributesByNote
			.get(branch.note_id)
			?.find((a) => a.key === 'trashedAt')?.value;
		if (trashedAt && Date.parse(trashedAt) < cutoff) {
			await hardDeleteBranch(branch.id);
			purged++;
		}
	}
	return purged;
}

/**
 * Rename a tag across the ENTIRE workspace in one transaction. With
 * oldValue null, every row with the key is re-keyed (values preserved);
 * otherwise only the exact key:value pair migrates to newKey:newValue.
 * Renaming onto a tag a note already carries merges (the duplicate row is
 * tombstoned rather than doubled).
 */
async function renameTag(
	oldKey: string,
	oldValue: string | null,
	newKey: string,
	newValue: string | null
): Promise<{ changed: number; merged: number }> {
	const now = Date.now();
	let changed = 0;
	let merged = 0;
	await db.transaction('rw', [db.attributes, db.attributeTombstones], async () => {
		const rows = await db.attributes.where('key').equals(oldKey).toArray();
		const all = await db.attributes.toArray();
		for (const row of rows) {
			if (row.type !== 'label') continue;
			if (oldValue !== null && row.value !== oldValue) continue;
			const targetValue = oldValue === null ? row.value : (newValue ?? '');
			const duplicate = all.some(
				(a) =>
					a.id !== row.id &&
					a.note_id === row.note_id &&
					a.type === 'label' &&
					a.key === newKey &&
					a.value === targetValue
			);
			if (duplicate) {
				await db.attributes.delete(row.id);
				await db.attributeTombstones.put({ id: row.id, deleted_at: now });
				merged++;
			} else {
				await db.attributes.update(row.id, {
					key: newKey,
					value: targetValue,
					dirty: 1,
					modified_at: now
				});
				changed++;
			}
		}
	});
	scheduleSyncSoon();
	return { changed, merged };
}

/** Delete a tag (key, or exact key:value) from every note, transactionally. */
async function deleteTagEverywhere(key: string, value: string | null): Promise<number> {
	const now = Date.now();
	let removed = 0;
	await db.transaction('rw', [db.attributes, db.attributeTombstones], async () => {
		const rows = await db.attributes.where('key').equals(key).toArray();
		for (const row of rows) {
			if (row.type !== 'label') continue;
			if (value !== null && row.value !== value) continue;
			await db.attributes.delete(row.id);
			await db.attributeTombstones.put({ id: row.id, deleted_at: now });
			removed++;
		}
	});
	scheduleSyncSoon();
	return removed;
}

/** Reverse relation index: target note id → the relations pointing at it. */
const backlinksByTarget = $derived.by(() => {
	const titleToId = new Map<string, string>();
	for (const note of allNotes) {
		if (note.title && !titleToId.has(note.title)) titleToId.set(note.title, note.id);
	}
	const map = new Map<string, { attrId: string; sourceId: string; sourceTitle: string; key: string }[]>();
	for (const attr of allAttributes) {
		if (attr.type !== 'relation' || !attr.value) continue;
		// Relations may hold a note id or (hand-typed) an exact note title.
		const targetId = noteById.has(attr.value) ? attr.value : titleToId.get(attr.value);
		if (!targetId || targetId === attr.note_id) continue;
		const source = noteById.get(attr.note_id);
		if (!source) continue;
		const entry = {
			attrId: attr.id,
			sourceId: attr.note_id,
			sourceTitle: source.title || 'Untitled',
			key: attr.key
		};
		const list = map.get(targetId);
		if (list) list.push(entry);
		else map.set(targetId, [entry]);
	}
	return map;
});

async function removeBranchRecursive(branchId: string, deletedNoteIds: string[]): Promise<void> {
	const branch = await db.branches.get(branchId);
	if (!branch) return;
	await db.branches.delete(branchId);
	await db.branchTombstones.put({ id: branchId, deleted_at: Date.now() });

	const remaining = await db.branches.where('note_id').equals(branch.note_id).count();
	if (remaining > 0) return; // still cloned elsewhere — note survives

	await db.notes.delete(branch.note_id);
	await db.tombstones.put({ id: branch.note_id, deleted_at: Date.now() });
	deletedNoteIds.push(branch.note_id);

	// Purge the note's attributes too: a dirty attribute left behind would
	// wedge the push loop on a foreign-key error once the note is gone.
	const attributeIds = await db.attributes.where('note_id').equals(branch.note_id).primaryKeys();
	if (attributeIds.length) {
		await db.attributes.bulkDelete(attributeIds);
		await db.attributeTombstones.bulkPut(
			attributeIds.map((id) => ({ id, deleted_at: Date.now() }))
		);
	}

	const childBranchIds = await db.branches.where('parent_id').equals(branch.note_id).primaryKeys();
	for (const childId of childBranchIds) {
		await removeBranchRecursive(childId, deletedNoteIds);
	}
}

const dirtyCount = $derived.by(() => {
	const dirtyNotes = allNotes.filter(n => n.dirty).length;
	const dirtyBranches = allBranches.filter(b => b.dirty).length;
	const dirtyAttributes = allAttributes.filter(a => a.dirty).length;
	return (
		dirtyNotes +
		dirtyBranches +
		dirtyAttributes +
		attachmentsDirtyCount +
		notesTombstonesCount +
		branchesTombstonesCount +
		attributesTombstonesCount +
		attachmentTombstonesCount
	);
});

/**
 * Human-readable breakdown of everything still waiting to sync, plus the
 * last sync error — so "N unsynced" is always explainable from the UI.
 */
async function pendingSummary(): Promise<string> {
	const dirtyNotes = allNotes.filter((n) => n.dirty);
	const dirtyBranches = allBranches.filter((b) => b.dirty).length;
	const dirtyAttrs = allAttributes.filter((a) => a.dirty);
	const deletions =
		notesTombstonesCount +
		branchesTombstonesCount +
		attributesTombstonesCount +
		attachmentTombstonesCount;

	const lines: string[] = [];
	if (dirtyNotes.length) {
		const titles = dirtyNotes
			.slice(0, 5)
			.map((n) => `“${n.title || 'Untitled'}”`)
			.join(', ');
		lines.push(`${dirtyNotes.length} note edit${dirtyNotes.length === 1 ? '' : 's'}: ${titles}${dirtyNotes.length > 5 ? '…' : ''}`);
	}
	if (dirtyBranches) lines.push(`${dirtyBranches} tree placement${dirtyBranches === 1 ? '' : 's'}`);
	if (dirtyAttrs.length) {
		const keys = [...new Set(dirtyAttrs.map((a) => `#${a.key}`))].slice(0, 5).join(', ');
		lines.push(`${dirtyAttrs.length} tag${dirtyAttrs.length === 1 ? '' : 's'}: ${keys}`);
	}
	if (attachmentsDirtyCount) lines.push(`${attachmentsDirtyCount} media metadata edit${attachmentsDirtyCount === 1 ? '' : 's'}`);
	if (deletions) lines.push(`${deletions} deletion${deletions === 1 ? '' : 's'}`);
	if (!lines.length) lines.push('Nothing pending — all changes are synced.');
	if (lastSyncError) lines.push(`\nLast sync problem: ${lastSyncError}`);
	return lines.join('\n');
}

export const notes = {
	get isOnline() {
		return isOnline;
	},
	get isSyncing() {
		return isSyncing;
	},
	set isSyncing(val: boolean) {
		isSyncing = val;
	},
	get dirtyCount() {
		return dirtyCount;
	},
	get lastSyncError() {
		return lastSyncError;
	},
	set lastSyncError(val: string) {
		lastSyncError = val;
	},
	pendingSummary,
	get selected() {
		return selected;
	},
	get selectedId() {
		return selectedId;
	},
	get sidebarOpen() {
		return sidebarOpen;
	},
	set sidebarOpen(val: boolean) {
		sidebarOpen = val;
	},
	get pendingClone() {
		return pendingCloneId ? (noteById.get(pendingCloneId) ?? null) : null;
	},
	get pendingMoveBranch() {
		return pendingMoveBranchId ? (allBranches.find((b) => b.id === pendingMoveBranchId) || null) : null;
	},
	get searchQuery() {
		return searchQuery;
	},
	set searchQuery(val: string) {
		searchQuery = val;
	},
	isVisible(branchId: string): boolean {
		return visibleBranchIds === null || visibleBranchIds.has(branchId);
	},
	noteFor(branchOrId: LocalBranch | string | null | undefined): LocalNote | undefined {
		if (!branchOrId) return undefined;
		if (typeof branchOrId === 'string') return noteById.get(branchOrId);
		return noteById.get(branchOrId.note_id);
	},
	childBranches(noteId: string | null): LocalBranch[] {
		return branchesByParent.get(noteId) ?? [];
	},
	placementCount(noteId: string): number {
		return branchCounts.get(noteId) ?? 0;
	},
	isExpanded(branchId: string): boolean {
		return expandedIds.has(branchId);
	},
	toggleExpanded(branchId: string): void {
		if (expandedIds.has(branchId)) expandedIds.delete(branchId);
		else expandedIds.add(branchId);
	},
	select(noteId: string): void {
		selectedId = noteId;
		sidebarOpen = false;
	},
	/** Deselect the active note — returns the canvas to the root Dashboard. */
	goToDashboard(): void {
		selectedId = null;
		sidebarOpen = false;
	},
	startClone(noteId: string): void {
		pendingCloneId = noteId;
		pendingMoveBranchId = null;
	},
	cancelClone(): void {
		pendingCloneId = null;
	},
	startMove(branchId: string): void {
		pendingMoveBranchId = branchId;
		pendingCloneId = null;
	},
	cancelMove(): void {
		pendingMoveBranchId = null;
	},
	/** Reactive: every workspace path where this note lives (parents only). */
	parentPaths,
	renameStatusLabel,
	clearStatusLabel,
	runSavedSearch,
	renameTag,
	deleteTagEverywhere,
	restoreFromTrash,
	purgeOldTrash,
	get trashRootId() {
		return trashRootId;
	},
	/** Reactive: relations pointing AT this note (source note + relation key). */
	backlinksFor(noteId: string): { attrId: string; sourceId: string; sourceTitle: string; key: string }[] {
		return backlinksByTarget.get(noteId) ?? [];
	},
	getAttributes(noteId: string): LocalAttribute[] {
		return attributesByNote.get(noteId) ?? [];
	},
	get bookmarkedBranches() {
		return bookmarkedBranches;
	},
	isBookmarkFolder(noteId: string): boolean {
		const attrs = attributesByNote.get(noteId) ?? [];
		return attrs.some((a) => a.type === 'label' && a.key === 'bookmarkFolder');
	},
	get allAttributes() {
		return allAttributes;
	},
	get allNotes() {
		return allNotes;
	},
	get apiKey() {
		return apiKey;
	},
	set apiKey(val: string) {
		apiKey = val;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('gemini_api_key', val);
		}
	},
	get systemPrompt() {
		return systemPrompt;
	},
	set systemPrompt(val: string) {
		systemPrompt = val;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('gemini_system_prompt', val);
		}
	},
	get sortOption() {
		return sortOption;
	},
	set sortOption(val: 'az' | 'za' | 'date_asc' | 'date_desc') {
		sortOption = val;
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('wiki_sort_option', val);
		}
	},
	placeClone,
	placeMove,
	createNote,
	createJournalNote,
	updateNote,
	deleteBranch,
	addAttribute,
	updateAttribute,
	removeAttribute,
	scheduleSyncSoon(): void {
		scheduleSyncSoon();
	}
};

import { marked } from 'marked';
import TurndownService from 'turndown';
import { db, type LocalNote, type LocalBranch, type LocalAttribute } from '$lib/db';
import { syncNow } from '$lib/sync';

/**
 * JSON transfer uses a companion Organiser-style backup shape ({ version, exportedAt,
 * notebooks, notes, journals, ... }) so exports import straight into the
 * Organiser. Wiki tree structure flattens for the Organiser (root notes →
 * notebooks, descendants → pages); an extra `wiki` key carries the exact
 * notes/branches/attributes rows for lossless wiki→wiki restores — the
 * Organiser's importer only reads its known collections and ignores it.
 */

const clock = () => new Date().toISOString();

function download(filename: string, contents: string, type: string): void {
	const blob = new Blob([contents], { type });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	URL.revokeObjectURL(url);
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

// ---------- JSON export ----------

const LOOSE_NOTEBOOK_ID = 'wiki-loose-notes';

export async function exportJson(): Promise<string> {
	const [notes, branches, attributes] = await Promise.all([
		db.notes.toArray(),
		db.branches.toArray(),
		db.attributes.toArray()
	]);

	const childrenOf = new Map<string, string[]>();
	for (const branch of branches) {
		if (!branch.parent_id) continue;
		const list = childrenOf.get(branch.parent_id);
		if (list) list.push(branch.note_id);
		else childrenOf.set(branch.parent_id, [branch.note_id]);
	}
	const noteById = new Map(notes.map((note) => [note.id, note]));
	const tagsFor = (noteId: string) =>
		attributes
			.filter((attr) => attr.note_id === noteId && attr.type === 'label')
			.map((attr) => (attr.value ? `${attr.key}=${attr.value}` : attr.key));

	const notebooks: Record<string, unknown>[] = [];
	const pages: Record<string, unknown>[] = [];
	const assigned = new Set<string>(); // clones flatten to their first notebook

	const rootNoteIds = branches.filter((b) => b.parent_id === null).map((b) => b.note_id);
	const page = (note: LocalNote, notebookId: string) => ({
		id: note.id,
		title: note.title,
		content: note.content,
		tags: tagsFor(note.id),
		notebookId,
		type: 'notebook'
	});

	for (const rootId of rootNoteIds) {
		const root = noteById.get(rootId);
		if (!root || assigned.has(rootId)) continue;
		if (!childrenOf.has(rootId)) continue; // childless roots become loose pages below
		assigned.add(rootId);
		notebooks.push({ id: rootId, name: root.title || 'Untitled', type: 'notebook' });
		if (root.content.trim()) pages.push(page(root, rootId));
		// Flatten the whole subtree into this notebook.
		const queue = [...(childrenOf.get(rootId) ?? [])];
		while (queue.length) {
			const noteId = queue.shift()!;
			if (assigned.has(noteId)) continue;
			assigned.add(noteId);
			const note = noteById.get(noteId);
			if (note) pages.push(page(note, rootId));
			queue.push(...(childrenOf.get(noteId) ?? []));
		}
	}

	const loose = rootNoteIds.filter((id) => !assigned.has(id) && noteById.has(id));
	if (loose.length) {
		notebooks.push({ id: LOOSE_NOTEBOOK_ID, name: 'Wiki', type: 'notebook' });
		for (const noteId of loose) {
			assigned.add(noteId);
			pages.push(page(noteById.get(noteId)!, LOOSE_NOTEBOOK_ID));
		}
	}

	const payload = {
		version: 1,
		exportedAt: clock(),
		notebooks,
		notes: pages,
		wiki: {
			notes: notes.map(({ dirty: _d, modified_at: _m, ...note }) => note),
			branches: branches.map(({ dirty: _d, modified_at: _m, ...branch }) => branch),
			attributes: attributes.map(({ dirty: _d, modified_at: _m, ...attr }) => attr)
		}
	};
	download(`wiki-export-${today()}.json`, JSON.stringify(payload, null, 2), 'application/json');
	return `Exported ${notes.length} notes (${notebooks.length} notebooks for Organiser)`;
}

// ---------- Organiser JSON Export / Import ----------

export async function exportOrganiserJson(): Promise<string> {
	const [notes, branches, attributes] = await Promise.all([
		db.notes.toArray(),
		db.branches.toArray(),
		db.attributes.toArray()
	]);

	const noteById = new Map(notes.map((note) => [note.id, note]));

	const getNotebookName = (noteId: string): string => {
		const branch = branches.find((b) => b.note_id === noteId);
		if (!branch || !branch.parent_id) {
			return '';
		}
		let currParentId = branch.parent_id;
		const visited = new Set<string>([noteId]);
		while (currParentId) {
			if (visited.has(currParentId)) break;
			visited.add(currParentId);
			const parentBranch = branches.find((b) => b.note_id === currParentId);
			if (!parentBranch || !parentBranch.parent_id) {
				const rootNote = noteById.get(currParentId);
				return rootNote?.title || '';
			}
			currParentId = parentBranch.parent_id;
		}
		return '';
	};

	const exportNotes = notes.map((note) => {
		const tags = attributes
			.filter((attr) => attr.note_id === note.id && attr.type === 'label' && attr.key !== 'pinned')
			.map((attr) => (attr.value ? `${attr.key}=${attr.value}` : attr.key));

		const pinned = attributes.some(
			(attr) =>
				attr.note_id === note.id &&
				attr.type === 'label' &&
				attr.key === 'pinned' &&
				(attr.value === 'true' || attr.value === '')
		);

		const notebook = getNotebookName(note.id);
		const markdown = turndown.turndown(note.content || '');

		return {
			title: note.title || '',
			content: markdown,
			tags,
			pinned,
			notebook
		};
	});

	const payload = {
		version: 1,
		notes: exportNotes
	};

	download(`organiser-export-${today()}.json`, JSON.stringify(payload, null, 2), 'application/json');
	return `Exported ${notes.length} notes in Organiser format`;
}

export async function importOrganiserJson(file: File): Promise<string> {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(await file.text());
	} catch {
		throw new Error('File is not valid JSON');
	}
	if (typeof data !== 'object' || data === null) throw new Error('Unrecognized JSON shape');

	if (!('notes' in data) || !Array.isArray(data.notes)) {
		throw new Error('Missing "notes" array in the JSON file');
	}

	const notesArray = data.notes as Record<string, unknown>[];
	const stamp = () => ({ updated_at: clock(), dirty: 1, modified_at: Date.now() });

	let importedCount = 0;

	await db.transaction('rw', [db.notes, db.branches, db.attributes], async () => {
		const notebookCache = new Map<string, string>();

		const getOrCreateNotebook = async (name: string): Promise<string> => {
			const trimmedName = name.trim();
			if (notebookCache.has(trimmedName)) {
				return notebookCache.get(trimmedName)!;
			}

			const candidates = await db.notes.where('title').equals(trimmedName).toArray();
			for (const note of candidates) {
				const branch = await db.branches.where('note_id').equals(note.id).first();
				if (branch && branch.parent_id === null) {
					notebookCache.set(trimmedName, note.id);
					return note.id;
				}
			}

			const notebookNoteId = crypto.randomUUID();
			await db.notes.put({
				id: notebookNoteId,
				title: trimmedName,
				content: '',
				is_shared: false,
				...stamp()
			});
			await db.branches.put({
				id: crypto.randomUUID(),
				note_id: notebookNoteId,
				parent_id: null,
				...stamp()
			});
			notebookCache.set(trimmedName, notebookNoteId);
			return notebookNoteId;
		};

		for (const n of notesArray) {
			const title = typeof n.title === 'string' ? n.title : 'Untitled';
			const markdownContent = typeof n.content === 'string' ? n.content : '';
			const htmlContent = await marked.parse(markdownContent);

			const noteId = crypto.randomUUID();
			await db.notes.put({
				id: noteId,
				title,
				content: htmlContent,
				is_shared: false,
				...stamp()
			});

			let parentId: string | null = null;
			if (typeof n.notebook === 'string' && n.notebook.trim()) {
				parentId = await getOrCreateNotebook(n.notebook);
			} else {
				parentId = await getOrCreateNotebook('Notes');
			}

			await db.branches.put({
				id: crypto.randomUUID(),
				note_id: noteId,
				parent_id: parentId,
				...stamp()
			});

			if (Array.isArray(n.tags)) {
				for (const tag of n.tags) {
					if (typeof tag === 'string' && tag.trim()) {
						const tagStr = tag.trim();
						const eqIdx = tagStr.indexOf('=');
						let key = tagStr;
						let value = '';
						if (eqIdx !== -1) {
							key = tagStr.slice(0, eqIdx);
							value = tagStr.slice(eqIdx + 1);
						}
						await db.attributes.put({
							id: crypto.randomUUID(),
							note_id: noteId,
							type: 'label',
							key,
							value,
							...stamp()
						});
					}
				}
			}

			if (n.pinned === true) {
				await db.attributes.put({
					id: crypto.randomUUID(),
					note_id: noteId,
					type: 'label',
					key: 'pinned',
					value: 'true',
					...stamp()
				});
			}

			importedCount++;
		}
	});

	void syncNow();
	return `Imported ${importedCount} notes in Organiser format`;
}

// ---------- JSON import ----------

export async function importJson(file: File): Promise<string> {
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(await file.text());
	} catch {
		throw new Error('File is not valid JSON');
	}
	if (typeof data !== 'object' || data === null) throw new Error('Unrecognized JSON shape');

	const summary =
		'wiki' in data && typeof data.wiki === 'object' && data.wiki !== null
			? await importWikiNative(data.wiki as Record<string, unknown>)
			: await importOrganiser(data);
	void syncNow();
	return summary;
}

/** Lossless restore of a wiki export: upsert rows by id, marked dirty. */
async function importWikiNative(wiki: Record<string, unknown>): Promise<string> {
	const rows = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
	const stamp = { dirty: 1, modified_at: Date.now() };

	const notes = rows<LocalNote>(wiki.notes)
		.filter((n) => typeof n.id === 'string' && typeof n.title === 'string')
		.map((n) => ({ ...n, content: n.content ?? '', is_shared: !!n.is_shared, updated_at: clock(), ...stamp }));
	const branches = rows<LocalBranch>(wiki.branches)
		.filter((b) => typeof b.id === 'string' && typeof b.note_id === 'string')
		.map((b) => ({ ...b, parent_id: b.parent_id ?? null, updated_at: clock(), ...stamp }));
	const attributes = rows<LocalAttribute>(wiki.attributes)
		.filter((a) => typeof a.id === 'string' && typeof a.note_id === 'string')
		.map((a) => ({ ...a, value: a.value ?? '', updated_at: clock(), ...stamp }));

	await db.transaction('rw', [db.notes, db.branches, db.attributes], async () => {
		await db.notes.bulkPut(notes);
		await db.branches.bulkPut(branches);
		await db.attributes.bulkPut(attributes);
	});
	return `Restored ${notes.length} notes, ${branches.length} placements, ${attributes.length} attributes`;
}

/** Map an Organiser backup: notebooks → root notes, pages/journals → children. */
async function importOrganiser(data: Record<string, unknown>): Promise<string> {
	type AnyDoc = Record<string, unknown>;
	const rows = (value: unknown): AnyDoc[] => (Array.isArray(value) ? (value as AnyDoc[]) : []);
	const notebooks = rows(data.notebooks);
	const pages = rows(data.notes);
	const journals = rows(data.journals);
	if (!notebooks.length && !pages.length && !journals.length) {
		throw new Error('No notebooks, notes or journals found in this file');
	}

	const stamp = () => ({ updated_at: clock(), dirty: 1, modified_at: Date.now() });
	let imported = 0;

	await db.transaction('rw', [db.notes, db.branches, db.attributes], async () => {
		const ensureNote = async (id: string, title: string, content: string) => {
			await db.notes.put({ id, title, content, is_shared: false, ...stamp() });
			imported++;
		};
		const ensureBranch = async (noteId: string, parentId: string | null) => {
			const existing = await db.branches.where('note_id').equals(noteId).toArray();
			if (existing.some((b) => b.parent_id === parentId)) return;
			await db.branches.put({ id: crypto.randomUUID(), note_id: noteId, parent_id: parentId, ...stamp() });
		};
		const ensureLabel = async (noteId: string, key: string) => {
			const existing = await db.attributes.where('note_id').equals(noteId).toArray();
			if (existing.some((a) => a.type === 'label' && a.key === key)) return;
			await db.attributes.put({ id: crypto.randomUUID(), note_id: noteId, type: 'label', key, value: '', ...stamp() });
		};
		/** Root note found by title (e.g. seeded Journal), created if missing. */
		const rootByTitle = async (title: string): Promise<string> => {
			const candidates = await db.notes.where('title').equals(title).primaryKeys();
			for (const id of candidates) {
				const placements = await db.branches.where('note_id').equals(id).toArray();
				if (placements.some((b) => b.parent_id === null)) return id;
			}
			const id = crypto.randomUUID();
			await ensureNote(id, title, '');
			await ensureBranch(id, null);
			return id;
		};

		const knownNotebooks = new Set<string>();
		for (const nb of notebooks) {
			if (typeof nb.id !== 'string') continue;
			await ensureNote(nb.id, String(nb.name ?? 'Untitled'), '');
			await ensureBranch(nb.id, null);
			knownNotebooks.add(nb.id);
		}

		let fallbackId: string | null = null;
		for (const pg of pages) {
			if (typeof pg.id !== 'string') continue;
			await ensureNote(pg.id, String(pg.title ?? 'Untitled'), String(pg.content ?? ''));
			let parentId: string | null = null;
			if (typeof pg.notebookId === 'string' && knownNotebooks.has(pg.notebookId)) {
				parentId = pg.notebookId;
			} else {
				fallbackId ??= await rootByTitle('Imported');
				parentId = fallbackId;
			}
			await ensureBranch(pg.id, parentId);
			for (const tag of Array.isArray(pg.tags) ? pg.tags : []) {
				if (typeof tag === 'string' && tag.trim()) await ensureLabel(pg.id, tag.trim());
			}
		}

		if (journals.length) {
			const journalRootId = await rootByTitle('Journal');
			for (const entry of journals) {
				if (typeof entry.id !== 'string') continue;
				const title = String(entry.title || entry.date || 'Journal entry');
				await ensureNote(entry.id, title, String(entry.content ?? ''));
				await ensureBranch(entry.id, journalRootId);
				for (const tag of Array.isArray(entry.tags) ? entry.tags : []) {
					if (typeof tag === 'string' && tag.trim()) await ensureLabel(entry.id, tag.trim());
				}
			}
		}
	});

	return `Imported ${imported} notes from Organiser backup (tasks/events/files are skipped)`;
}

// ---------- Markdown ----------

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

export function exportMarkdown(note: { title: string; content: string }): string {
	const markdown = `# ${note.title || 'Untitled'}\n\n${turndown.turndown(note.content || '')}\n`;
	const safeName = (note.title || 'untitled').replace(/[^\w\s-]/g, '').trim().slice(0, 80) || 'untitled';
	download(`${safeName}.md`, markdown, 'text/markdown');
	return `Exported “${note.title || 'Untitled'}” as Markdown`;
}

/** Each file becomes a root note; an H1 on the first line becomes the title. */
export async function importMarkdown(files: FileList): Promise<string> {
	let count = 0;
	for (const file of files) {
		let text = await file.text();
		let title = file.name.replace(/\.(md|markdown|txt)$/i, '');
		const heading = /^#\s+(.+)\n?/.exec(text);
		if (heading) {
			title = heading[1].trim();
			text = text.slice(heading[0].length);
		}
		const html = await marked.parse(text);
		const noteId = crypto.randomUUID();
		const stamp = { updated_at: clock(), dirty: 1, modified_at: Date.now() };
		await db.transaction('rw', [db.notes, db.branches], async () => {
			await db.notes.put({ id: noteId, title, content: html, is_shared: false, ...stamp });
			await db.branches.put({ id: crypto.randomUUID(), note_id: noteId, parent_id: null, ...stamp });
		});
		count++;
	}
	void syncNow();
	return `Imported ${count} Markdown ${count === 1 ? 'note' : 'notes'}`;
}

// ---------- Note-shaped data JSON (e.g. a bill-scanning app's export) ----------

/**
 * A single "Key: Value | Key: Value | ..." line — common when an external
 * tool summarises structured fields as one line before the full extracted
 * text. Rendered as a small table pinned above the rest of the note.
 */
function extractSummaryLine(content: string): { table: string; body: string } | null {
	const firstBreak = content.indexOf('\n\n');
	const firstLine = (firstBreak === -1 ? content : content.slice(0, firstBreak)).trim();
	if (!firstLine.includes('|')) return null;

	const pairs = firstLine.split('|').map((segment) => {
		const colon = segment.indexOf(':');
		if (colon === -1) return null;
		const key = segment.slice(0, colon).trim();
		const value = segment.slice(colon + 1).trim();
		return key && value ? { key, value } : null;
	});
	if (pairs.some((p) => !p) || pairs.length < 2) return null;

	const rows = (pairs as { key: string; value: string }[])
		.map(({ key, value }) => `<tr><td><strong>${escapeHtml(key)}</strong></td><td>${escapeHtml(value)}</td></tr>`)
		.join('');
	return {
		table: `<table><tbody>${rows}</tbody></table>`,
		body: firstBreak === -1 ? '' : content.slice(firstBreak + 2)
	};
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * A 📎 file-card link back to the source document, matching the visual
 * convention used everywhere else a file is attached in the app. Kept as a
 * plain link (not noteType=pdf) so the note stays in rich-text/searchable
 * form — the extracted text is the point, the PDF is there to verify against.
 */
function sourcePdfCard(url: string): string {
	let label = 'Source PDF';
	try {
		const name = decodeURIComponent(url.split('?')[0].split('/').pop() ?? '');
		if (name) label = name;
	} catch {
		/* keep the generic label */
	}
	return `<p>📎 <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a></p>`;
}

interface ImportableNote {
	title?: unknown;
	content?: unknown;
	tags?: unknown;
	sourcePdfUrl?: unknown;
}

/**
 * Import one or more { title, content, tags, sourcePdfUrl? } records — the
 * shape a note-taking or data-extraction tool naturally produces (e.g. a
 * utility-bill scanner). A leading "Key: Value | Key: Value" summary line in
 * `content` becomes a table; the remainder is parsed as Markdown. An optional
 * `sourcePdfUrl` is linked as a file card so the extraction can be checked
 * against the original. Each import lands as a child of a root note titled
 * `parentTitle` (created if missing).
 */
export async function importNoteJson(file: File, parentTitle = 'Inbox'): Promise<string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await file.text());
	} catch {
		throw new Error('File is not valid JSON');
	}
	const items: ImportableNote[] = Array.isArray(parsed) ? parsed : [parsed];
	const usable = items.filter(
		(item): item is ImportableNote =>
			typeof item === 'object' && item !== null && (typeof (item as ImportableNote).title === 'string' || typeof (item as ImportableNote).content === 'string')
	);
	if (!usable.length) throw new Error('No importable notes found — expected { title, content, tags } objects');

	const stamp = () => ({ updated_at: clock(), dirty: 1, modified_at: Date.now() });
	let imported = 0;

	await db.transaction('rw', [db.notes, db.branches, db.attributes], async () => {
		let parentId: string | null = null;
		const candidates = await db.notes.where('title').equals(parentTitle).primaryKeys();
		for (const id of candidates) {
			const placements = await db.branches.where('note_id').equals(id).toArray();
			if (placements.some((b) => b.parent_id === null)) {
				parentId = id;
				break;
			}
		}
		if (!parentId) {
			parentId = crypto.randomUUID();
			await db.notes.put({ id: parentId, title: parentTitle, content: '', is_shared: false, ...stamp() });
			await db.branches.put({ id: crypto.randomUUID(), note_id: parentId, parent_id: null, ...stamp() });
		}

		for (const item of usable) {
			const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : 'Untitled import';
			const rawContent = typeof item.content === 'string' ? item.content : '';
			const summary = extractSummaryLine(rawContent);
			const bodyMarkdown = summary ? summary.body : rawContent;
			const bodyHtml = bodyMarkdown.trim() ? await marked.parse(bodyMarkdown) : '';
			const pdfCard =
				typeof item.sourcePdfUrl === 'string' && item.sourcePdfUrl.trim()
					? sourcePdfCard(item.sourcePdfUrl.trim())
					: '';
			const content = (summary ? summary.table : '') + pdfCard + bodyHtml;

			const noteId = crypto.randomUUID();
			await db.notes.put({ id: noteId, title, content, is_shared: false, ...stamp() });
			await db.branches.put({ id: crypto.randomUUID(), note_id: noteId, parent_id: parentId, ...stamp() });
			for (const tag of Array.isArray(item.tags) ? item.tags : []) {
				if (typeof tag === 'string' && tag.trim()) {
					await db.attributes.put({
						id: crypto.randomUUID(),
						note_id: noteId,
						type: 'label',
						key: tag.trim(),
						value: '',
						...stamp()
					});
				}
			}
			imported++;
		}
	});

	void syncNow();
	return `Imported ${imported} ${imported === 1 ? 'note' : 'notes'} into "${parentTitle}"`;
}

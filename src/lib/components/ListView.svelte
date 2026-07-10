<script lang="ts">
	import { notes } from '$lib/notes.svelte';
	import { db, type LocalNote } from '$lib/db';
	import { Plus, Trash2, Calendar, FileText } from 'lucide-svelte';

	let { note }: { note: LocalNote } = $props();

	import { untrack } from 'svelte';

	// Fetch children
	const children = $derived(notes.childBranches(note.id));

	let listSortOption = $state<'az' | 'za' | 'date_asc' | 'date_desc'>(
		typeof localStorage !== 'undefined' ? (localStorage.getItem('wiki_list_sort') as any || 'az') : 'az'
	);

	$effect(() => {
		const val = listSortOption;
		untrack(() => {
			if (typeof localStorage !== 'undefined') {
				localStorage.setItem('wiki_list_sort', val);
			}
		});
	});

	const childNotes = $derived.by(() => {
		const list = children
			.map((b) => notes.noteFor(b))
			.filter((n): n is LocalNote => !!n);

		list.sort((a, b) => {
			const titleA = a.title || '';
			const titleB = b.title || '';

			if (listSortOption === 'az') {
				return titleA.localeCompare(titleB);
			} else if (listSortOption === 'za') {
				return titleB.localeCompare(titleA);
			} else if (listSortOption === 'date_asc') {
				const dateA = a.updated_at || '';
				const dateB = b.updated_at || '';
				return dateA.localeCompare(dateB);
			} else if (listSortOption === 'date_desc') {
				const dateA = a.updated_at || '';
				const dateB = b.updated_at || '';
				return dateB.localeCompare(dateA);
			}
			return 0;
		});

		return list;
	});

	let newNoteTitle = $state('');

	function formatDate(isoString: string): string {
		if (!isoString) return '';
		try {
			const d = new Date(isoString);
			return d.toLocaleDateString(undefined, {
				month: 'short',
				day: 'numeric',
				year: 'numeric'
			});
		} catch {
			return '';
		}
	}

	async function createChildNote(e: Event) {
		e.preventDefault();
		const title = newNoteTitle.trim();
		if (!title) return;

		const noteId = crypto.randomUUID();
		const provisionalClock = new Date().toISOString();

		await db.transaction('rw', [db.notes, db.branches], async () => {
			await db.notes.put({
				id: noteId,
				title,
				content: '',
				is_shared: false,
				updated_at: provisionalClock,
				dirty: 1,
				modified_at: Date.now()
			});
			await db.branches.put({
				id: crypto.randomUUID(),
				note_id: noteId,
				parent_id: note.id,
				updated_at: provisionalClock,
				dirty: 1,
				modified_at: Date.now()
			});
		});

		newNoteTitle = '';
		notes.scheduleSyncSoon();
	}

	async function deleteNote(noteId: string, event: MouseEvent) {
		event.stopPropagation();
		const branch = children.find((b) => b.note_id === noteId);
		if (branch && confirm('Are you sure you want to delete this note?')) {
			await notes.deleteBranch(branch.id);
		}
	}
</script>

<div class="list-view-container">
	<div class="list-header-actions">
		<form class="quick-add-form" onsubmit={createChildNote}>
			<input 
				type="text" 
				placeholder="+ Add note to list..." 
				bind:value={newNoteTitle}
			/>
			<button type="submit" class="quick-add-btn">
				<Plus size={16} />
				<span>Add Note</span>
			</button>
		</form>

		<div class="sort-control">
			<label for="list-sort-select">Sort by</label>
			<select id="list-sort-select" class="sort-select" bind:value={listSortOption}>
				<option value="az">A-Z</option>
				<option value="za">Z-A</option>
				<option value="date_desc">Newest First</option>
				<option value="date_asc">Oldest First</option>
			</select>
		</div>
	</div>

	{#if childNotes.length === 0}
		<div class="empty-list-state">
			<p class="empty-icon">📭</p>
			<p class="empty-title">This folder is empty</p>
			<p class="empty-desc">Create your first sub-note using the input above.</p>
		</div>
	{:else}
		<div class="list-table-wrapper">
			<table class="list-table">
				<thead>
					<tr>
						<th class="col-title">Title</th>
						<th class="col-attributes">Attributes</th>
						<th class="col-date">Last Updated</th>
						<th class="col-actions"></th>
					</tr>
				</thead>
				<tbody>
					{#each childNotes as child (child.id)}
						{@const attrs = notes.getAttributes(child.id).filter(a => a.key !== 'viewType')}
						<tr onclick={() => notes.select(child.id)}>
							<td class="cell-title">
								<div class="title-cell-content">
									<FileText size={16} class="doc-icon" />
									<span class="note-title-text">{child.title || 'Untitled'}</span>
								</div>
							</td>
							<td class="cell-attributes">
								{#if attrs.length > 0}
									<div class="cell-tags">
										{#each attrs as attr}
											<button
												class="list-tag-badge"
												title="Find all notes tagged {attr.key}{attr.value ? `:${attr.value}` : ''}"
												onclick={(e) => {
													e.stopPropagation();
													notes.searchQuery = attr.value ? `#${attr.key}:${attr.value}` : `#${attr.key}`;
													notes.sidebarOpen = true;
												}}
											>
												{attr.value || attr.key}
											</button>
										{/each}
									</div>
								{:else}
									<span class="no-attributes">-</span>
								{/if}
							</td>
							<td class="cell-date">
								<div class="date-cell-content">
									<Calendar size={12} class="date-icon" />
									<span>{formatDate(child.updated_at)}</span>
								</div>
							</td>
							<td class="cell-actions">
								<button 
									class="list-delete-btn" 
									onclick={(e) => deleteNote(child.id, e)}
									title="Delete note"
								>
									<Trash2 size={13} />
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<style>
	.list-view-container {
		flex: 1;
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		overflow-y: auto;
		background: #ffffff;
		padding: 1.5rem;
	}

	.list-header-actions {
		margin-bottom: 1.5rem;
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 1rem;
	}

	.sort-control {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.sort-control label {
		font-size: 0.75rem;
		font-weight: 600;
		color: #64748b;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.sort-select {
		border: 1px solid rgba(0, 0, 0, 0.12);
		border-radius: 8px;
		padding: 0.4375rem 2rem 0.4375rem 0.75rem;
		font-size: 0.8125rem;
		font-weight: 550;
		color: #475569;
		background: #ffffff;
		outline: none;
		cursor: pointer;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
		transition: all 0.15s ease;
		appearance: none;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23475569' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
		background-repeat: no-repeat;
		background-position: right 0.75rem center;
	}

	.sort-select:focus {
		border-color: #c66930;
		box-shadow: 0 0 0 2px rgba(198, 105, 48, 0.1);
	}

	.quick-add-form {
		display: flex;
		gap: 0.75rem;
		max-width: 500px;
	}

	.quick-add-form input {
		flex: 1;
		border: 1px solid rgba(0, 0, 0, 0.12);
		border-radius: 8px;
		padding: 0.5rem 0.75rem;
		font-size: 0.875rem;
		outline: none;
		background: #ffffff;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
		transition: border-color 0.15s ease;
	}

	.quick-add-form input:focus {
		border-color: #c66930;
	}

	.quick-add-btn {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		background: #c66930;
		color: #ffffff;
		border: none;
		border-radius: 8px;
		padding: 0.5rem 1rem;
		font-size: 0.875rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s ease;
	}

	.quick-add-btn:hover {
		background: #b05c28;
	}

	.empty-list-state {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 3rem;
		text-align: center;
		background: #f8f9fa;
		border: 1px dashed rgba(0, 0, 0, 0.08);
		border-radius: 12px;
	}

	.empty-icon {
		font-size: 2.5rem;
		margin-bottom: 0.5rem;
	}

	.empty-title {
		font-weight: 650;
		color: #1e293b;
		margin-bottom: 0.25rem;
	}

	.empty-desc {
		font-size: 0.875rem;
		color: #64748b;
	}

	.list-table-wrapper {
		border: 1px solid rgba(0, 0, 0, 0.08);
		border-radius: 12px;
		overflow: hidden;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.02);
	}

	.list-table {
		width: 100%;
		border-collapse: collapse;
		text-align: left;
		font-size: 0.875rem;
	}

	.list-table th,
	.list-table td {
		padding: 0.875rem 1rem;
		border-bottom: 1px solid rgba(0, 0, 0, 0.06);
	}

	.list-table th {
		background: #f8f9fa;
		font-weight: 650;
		color: #475569;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.list-table tbody tr {
		cursor: pointer;
		transition: background 0.15s ease;
	}

	.list-table tbody tr:hover {
		background: rgba(198, 105, 48, 0.03);
	}

	.col-title { width: 45%; }
	.col-attributes { width: 35%; }
	.col-date { width: 15%; }
	.col-actions { width: 5%; }

	.title-cell-content {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.doc-icon {
		color: #64748b;
	}

	.note-title-text {
		font-weight: 600;
		color: #0f172a;
	}

	.list-table tbody tr:hover .note-title-text {
		color: #c66930;
	}

	.cell-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}

	.list-tag-badge {
		border: none;
		font-family: inherit;
		cursor: pointer;
		font-size: 0.6875rem;
		font-weight: 500;
		background: rgba(0, 0, 0, 0.04);
		color: #475569;
		padding: 0.125rem 0.375rem;
		border-radius: 4px;
	}

	.no-attributes {
		color: #94a3b8;
	}

	.date-cell-content {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		color: #64748b;
	}

	.date-icon {
		color: #94a3b8;
	}

	.list-delete-btn {
		border: none;
		background: none;
		color: #94a3b8;
		padding: 0.25rem;
		border-radius: 4px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		opacity: 0;
		transition: opacity 0.15s ease, color 0.15s ease;
	}

	.list-table tbody tr:hover .list-delete-btn {
		opacity: 1;
	}

	.list-delete-btn:hover {
		background: rgba(0, 0, 0, 0.05);
		color: #ef4444;
	}
</style>

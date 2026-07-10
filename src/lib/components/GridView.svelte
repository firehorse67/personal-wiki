<script lang="ts">
	import { notes } from '$lib/notes.svelte';
	import { db, type LocalNote } from '$lib/db';
	import { Plus, Trash2, ExternalLink, Calendar, Tag } from 'lucide-svelte';

	let { note }: { note: LocalNote } = $props();

	import { untrack } from 'svelte';

	// Fetch children
	const children = $derived(notes.childBranches(note.id));

	let gridSortOption = $state<'az' | 'za' | 'date_asc' | 'date_desc'>(
		typeof localStorage !== 'undefined' ? (localStorage.getItem('wiki_grid_sort') as any || 'az') : 'az'
	);

	$effect(() => {
		const val = gridSortOption;
		untrack(() => {
			if (typeof localStorage !== 'undefined') {
				localStorage.setItem('wiki_grid_sort', val);
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

			if (gridSortOption === 'az') {
				return titleA.localeCompare(titleB);
			} else if (gridSortOption === 'za') {
				return titleB.localeCompare(titleA);
			} else if (gridSortOption === 'date_asc') {
				const dateA = a.updated_at || '';
				const dateB = b.updated_at || '';
				return dateA.localeCompare(dateB);
			} else if (gridSortOption === 'date_desc') {
				const dateA = a.updated_at || '';
				const dateB = b.updated_at || '';
				return dateB.localeCompare(dateA);
			}
			return 0;
		});

		return list;
	});

	let newNoteTitle = $state('');

	function stripHtml(html: string): string {
		const temp = html.replace(/<[^>]*>/g, ' ');
		return temp.replace(/\s+/g, ' ').trim();
	}

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

<div class="grid-view-container">
	<div class="grid-header-actions">
		<form class="quick-add-form" onsubmit={createChildNote}>
			<input 
				type="text" 
				placeholder="+ Add note to this grid..." 
				bind:value={newNoteTitle}
			/>
			<button type="submit" class="quick-add-btn">
				<Plus size={16} />
				<span>Add Note</span>
			</button>
		</form>

		<div class="sort-control">
			<label for="grid-sort-select">Sort by</label>
			<select id="grid-sort-select" class="sort-select" bind:value={gridSortOption}>
				<option value="az">A-Z</option>
				<option value="za">Z-A</option>
				<option value="date_desc">Newest First</option>
				<option value="date_asc">Oldest First</option>
			</select>
		</div>
	</div>

	{#if childNotes.length === 0}
		<div class="empty-grid-state">
			<p class="empty-icon">📭</p>
			<p class="empty-title">This folder is empty</p>
			<p class="empty-desc">Create your first sub-note using the input above.</p>
		</div>
	{:else}
		<div class="cards-grid">
			{#each childNotes as child (child.id)}
				{@const textSnippet = stripHtml(child.content || '')}
				{@const attrs = notes.getAttributes(child.id).filter(a => a.key !== 'viewType')}
				<div class="note-card" onclick={() => notes.select(child.id)}>
					<div class="card-header">
						<h3 class="card-title">{child.title || 'Untitled'}</h3>
						<button 
							class="card-delete-btn" 
							onclick={(e) => deleteNote(child.id, e)}
							title="Delete note"
						>
							<Trash2 size={13} />
						</button>
					</div>
					
					<div class="card-body">
						<p class="card-snippet">
							{textSnippet || 'No content'}
						</p>
					</div>

					{#if attrs.length > 0}
						<div class="card-tags">
							{#each attrs as attr}
								<button
									class="tag-badge"
									title="Find all notes tagged {attr.key}{attr.value ? `:${attr.value}` : ''}"
									onclick={(e) => {
										e.stopPropagation();
										notes.searchQuery = attr.value ? `#${attr.key}:${attr.value}` : `#${attr.key}`;
										notes.sidebarOpen = true;
									}}
								>
									<Tag size={10} />
									<span>{attr.value || attr.key}</span>
								</button>
							{/each}
						</div>
					{/if}

					<div class="card-meta">
						<div class="meta-date">
							<Calendar size={12} />
							<span>{formatDate(child.updated_at)}</span>
						</div>
						<span class="open-link-indicator">
							<ExternalLink size={12} />
						</span>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.grid-view-container {
		flex: 1;
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		overflow-y: auto;
		background: #f8f9fa;
		padding: 1.5rem;
	}

	.grid-header-actions {
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

	.empty-grid-state {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 3rem;
		text-align: center;
		background: rgba(255, 255, 255, 0.5);
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

	.cards-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: 1.25rem;
	}

	.note-card {
		background: #ffffff;
		border: 1px solid rgba(0, 0, 0, 0.06);
		border-radius: 12px;
		padding: 1.25rem;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.02);
		cursor: pointer;
		display: flex;
		flex-direction: column;
		transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
		min-height: 180px;
	}

	.note-card:hover {
		transform: translateY(-2px);
		box-shadow: 0 6px 16px rgba(0, 0, 0, 0.06);
		border-color: rgba(198, 105, 48, 0.2);
	}

	.card-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
	}

	.card-title {
		font-size: 1rem;
		font-weight: 650;
		color: #0f172a;
		margin: 0;
		line-height: 1.3;
	}

	.card-delete-btn {
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

	.note-card:hover .card-delete-btn {
		opacity: 1;
	}

	.card-delete-btn:hover {
		background: rgba(0, 0, 0, 0.05);
		color: #ef4444;
	}

	.card-body {
		flex: 1;
		margin-bottom: 1rem;
	}

	.card-snippet {
		font-size: 0.8125rem;
		line-height: 1.5;
		color: #475569;
		display: -webkit-box;
		-webkit-line-clamp: 4;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.card-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-bottom: 0.75rem;
	}

	.tag-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.6875rem;
		font-weight: 500;
		background: rgba(0, 0, 0, 0.04);
		color: #475569;
		padding: 0.125rem 0.375rem;
		border-radius: 4px;
		border: none;
		font-family: inherit;
		cursor: pointer;
	}

	.tag-badge:hover {
		background: rgba(198, 105, 48, 0.12);
		color: #c66930;
	}

	.card-meta {
		border-top: 1px solid rgba(0, 0, 0, 0.04);
		padding-top: 0.75rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		color: #94a3b8;
		font-size: 0.75rem;
	}

	.meta-date {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}

	.open-link-indicator {
		display: flex;
		align-items: center;
		justify-content: center;
		color: #c66930;
		opacity: 0.7;
	}
</style>

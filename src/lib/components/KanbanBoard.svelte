<script lang="ts">
	import { notes } from '$lib/notes.svelte';
	import { db, type LocalNote } from '$lib/db';
	import { Plus, Trash2, ExternalLink, X } from 'lucide-svelte';

	let { note }: { note: LocalNote } = $props();

	// Fetch children
	const children = $derived(notes.childBranches(note.id));
	const childNotes = $derived(
		children
			.map((b) => notes.noteFor(b))
			.filter(Boolean) as LocalNote[]
	);

	// Group children by status
	const statusGroups = $derived.by(() => {
		const groups = new Map<string, LocalNote[]>();
		const unassigned: LocalNote[] = [];

		for (const child of childNotes) {
			const attrs = notes.allAttributes.filter(a => a.note_id === child.id);
			const statusAttr = attrs.find((a) => a.type === 'label' && a.key === 'status');
			if (statusAttr && statusAttr.value) {
				const val = statusAttr.value.trim();
				const list = groups.get(val) || [];
				list.push(child);
				groups.set(val, list);
			} else {
				unassigned.push(child);
			}
		}
		return { groups, unassigned };
	});

	// Column list state
	let localColumns = $state<string[]>(['To Do', 'In Progress', 'Done']);
	let newColumnName = $state('');
	let showAddColumnInput = $state(false);
	let newCardTitles = $state<Record<string, string>>({});

	// Load columns from database attribute "kanbanColumns"
	const boardAttributes = $derived(notes.allAttributes.filter(a => a.note_id === note.id));
	const kanbanColumnsAttr = $derived(boardAttributes.find(a => a.type === 'label' && a.key === 'kanbanColumns'));

	$effect(() => {
		if (kanbanColumnsAttr && kanbanColumnsAttr.value) {
			const cols = kanbanColumnsAttr.value.split(',').map(s => s.trim()).filter(Boolean);
			if (cols.length > 0) {
				if (JSON.stringify(localColumns) !== JSON.stringify(cols)) {
					localColumns = cols;
				}
			}
		}
	});

	async function saveColumnsToDb(cols: string[]) {
		const val = cols.join(',');
		if (kanbanColumnsAttr) {
			await notes.updateAttribute(kanbanColumnsAttr.id, { value: val });
		} else {
			await notes.addAttribute(note.id, {
				type: 'label',
				key: 'kanbanColumns',
				value: val
			});
		}
	}

	// Compute final list of columns to render
	const columns = $derived.by(() => {
		const cols = new Set<string>();
		// Always include unassigned first if it has items
		if (statusGroups.unassigned.length > 0) {
			cols.add('Unassigned');
		}
		for (const col of localColumns) {
			cols.add(col);
		}
		for (const col of statusGroups.groups.keys()) {
			cols.add(col);
		}
		return Array.from(cols);
	});

	// Drag state
	let draggedNoteId = $state<string | null>(null);
	let draggedColumn = $state<string | null>(null);
	let dragOverColumn = $state<string | null>(null);

	function handleDragStart(e: DragEvent, noteId: string) {
		e.stopPropagation(); // Don't trigger column drag
		draggedNoteId = noteId;
		if (e.dataTransfer) {
			e.dataTransfer.setData('text/plain', noteId);
			e.dataTransfer.effectAllowed = 'move';
		}
	}

	function handleDragEnd() {
		draggedNoteId = null;
	}

	function handleColumnDragStart(e: DragEvent, colName: string) {
		draggedColumn = colName;
		if (e.dataTransfer) {
			e.dataTransfer.setData('text/column-name', colName);
			e.dataTransfer.effectAllowed = 'move';
		}
	}

	function handleColumnDragOver(e: DragEvent, colName: string) {
		e.preventDefault();
		dragOverColumn = colName;
	}

	function handleColumnDragLeave() {
		dragOverColumn = null;
	}

	async function handleColumnDrop(e: DragEvent, targetColumn: string) {
		e.preventDefault();
		dragOverColumn = null;

		// 1. Handle column reordering
		const colName = e.dataTransfer?.getData('text/column-name') || draggedColumn;
		if (colName) {
			if (colName !== targetColumn && colName !== 'Unassigned' && targetColumn !== 'Unassigned') {
				const fromIdx = localColumns.indexOf(colName);
				const toIdx = localColumns.indexOf(targetColumn);
				if (fromIdx !== -1 && toIdx !== -1) {
					const updated = [...localColumns];
					updated.splice(fromIdx, 1);
					updated.splice(toIdx, 0, colName);
					localColumns = updated;
					await saveColumnsToDb(updated);
				}
			}
			draggedColumn = null;
			return;
		}

		// 2. Handle card moving
		const noteId = e.dataTransfer?.getData('text/plain') || draggedNoteId;
		if (!noteId) return;

		const attrs = notes.allAttributes.filter(a => a.note_id === noteId);
		const statusAttr = attrs.find((a) => a.type === 'label' && a.key === 'status');

		if (targetColumn === 'Unassigned') {
			if (statusAttr) {
				await notes.removeAttribute(statusAttr.id);
			}
		} else {
			if (statusAttr) {
				await notes.updateAttribute(statusAttr.id, { value: targetColumn });
			} else {
				await notes.addAttribute(noteId, {
					type: 'label',
					key: 'status',
					value: targetColumn
				});
			}
		}
		draggedNoteId = null;
	}

	// Column renaming state
	let editingColumn = $state<string | null>(null);
	let editColumnValue = $state('');

	function startEditColumn(colName: string) {
		if (colName === 'Unassigned') return;
		editingColumn = colName;
		editColumnValue = colName;
	}

	async function saveColumnRename() {
		const oldName = editingColumn;
		const newName = editColumnValue.trim();
		editingColumn = null;

		if (!oldName || !newName || oldName === newName) return;
		if (newName === 'Unassigned' || localColumns.includes(newName)) {
			alert(`A column named “${newName}” already exists.`);
			return;
		}

		// Column list + every matching child status label migrate in ONE
		// database transaction, so an interrupted rename can't leave the
		// board half-migrated (and the tree updates in a single emission).
		const idx = localColumns.indexOf(oldName);
		const updated = idx !== -1 ? localColumns.with(idx, newName) : [...localColumns, newName];
		localColumns = updated;
		await notes.renameStatusLabel(note.id, oldName, newName, updated.join(','));
	}

	async function addColumn(e: Event) {
		e.preventDefault();
		const name = newColumnName.trim();
		if (!name) return;
		if (!localColumns.includes(name) && name !== 'Unassigned') {
			const updated = [...localColumns, name];
			localColumns = updated;
			await saveColumnsToDb(updated);
		}
		newColumnName = '';
		showAddColumnInput = false;
	}

	async function removeColumn(col: string) {
		if (confirm(`Are you sure you want to delete column "${col}"? Cards will be moved to Unassigned.`)) {
			const updated = localColumns.filter((c) => c !== col);
			localColumns = updated;
			await saveColumnsToDb(updated);
			// All matching child status labels clear in one transaction.
			await notes.clearStatusLabel(note.id, col);
		}
	}

	async function addNewCard(column: string) {
		const title = (newCardTitles[column] || '').trim();
		if (!title) return;

		const noteId = crypto.randomUUID();
		const provisionalClock = new Date().toISOString();

		await db.transaction('rw', [db.notes, db.branches, db.attributes], async () => {
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
			if (column !== 'Unassigned') {
				await db.attributes.put({
					id: crypto.randomUUID(),
					note_id: noteId,
					type: 'label',
					key: 'status',
					value: column,
					updated_at: provisionalClock,
					dirty: 1,
					modified_at: Date.now()
				});
			}
		});

		newCardTitles[column] = '';
		notes.scheduleSyncSoon();
	}

	async function deleteNote(noteId: string) {
		const branch = children.find((b) => b.note_id === noteId);
		if (branch) {
			if (confirm('Are you sure you want to delete this card?')) {
				await notes.deleteBranch(branch.id);
			}
		}
	}
</script>

<div class="kanban-container">
	<div class="kanban-board">
		{#each columns as col}
			{@const cards = col === 'Unassigned' ? statusGroups.unassigned : (statusGroups.groups.get(col) || [])}
			<div 
				class="kanban-column"
				class:drag-over={dragOverColumn === col}
				draggable={col !== 'Unassigned'}
				ondragstart={(e) => handleColumnDragStart(e, col)}
				ondragend={() => { draggedColumn = null; dragOverColumn = null; }}
				ondrop={(e) => handleColumnDrop(e, col)}
				ondragover={(e) => handleColumnDragOver(e, col)}
				ondragleave={handleColumnDragLeave}
			>
				<div class="column-header">
					<div class="column-title-group">
						{#if editingColumn === col}
							<input
								type="text"
								class="column-rename-input"
								bind:value={editColumnValue}
								onkeydown={(e) => {
									if (e.key === 'Enter') saveColumnRename();
									if (e.key === 'Escape') editingColumn = null;
								}}
								onblur={saveColumnRename}
								autofocus
							/>
						{:else}
							<span 
								class="column-title" 
								ondblclick={() => startEditColumn(col)}
								title={col !== 'Unassigned' ? "Double-click to rename" : ""}
							>
								{col}
							</span>
						{/if}
						<span class="card-count">{cards.length}</span>
					</div>
					{#if col !== 'Unassigned' && col !== 'To Do' && col !== 'In Progress' && col !== 'Done'}
						<button 
							class="delete-col-btn" 
							onclick={() => removeColumn(col)}
							title="Delete Column"
						>
							<X size={12} />
						</button>
					{/if}
				</div>

				<div class="column-cards">
					{#each cards as card (card.id)}
						{@const attrs = notes.allAttributes.filter(a => a.note_id === card.id && a.key !== 'status' && a.key !== 'viewType')}
						{@const cardColor = notes.allAttributes.find(a => a.note_id === card.id && a.key === 'color')?.value || ''}
						<div 
							class="kanban-card"
							draggable="true"
							ondragstart={(e) => handleDragStart(e, card.id)}
							ondragend={handleDragEnd}
							class:dragging={draggedNoteId === card.id}
							style:border-top={cardColor ? `4px solid ${cardColor}` : ''}
						>
							<div class="card-body">
								<button class="card-title-link" onclick={() => notes.select(card.id)}>
									{card.title || 'Untitled'}
								</button>
								{#if attrs.length > 0}
									<div class="card-tags">
										{#each attrs as attr}
											{#if attr.type === 'label'}
												<button
													class="tag-pill"
													title="Find all notes with this tag"
													onclick={(e) => {
														e.stopPropagation();
														notes.searchQuery = attr.value ? `#${attr.key}:${attr.value}` : `#${attr.key}`;
														notes.sidebarOpen = true;
													}}
												>
													{attr.value ? `${attr.key}: ${attr.value}` : attr.key}
												</button>
											{:else}
												<span class="tag-pill" title={`${attr.key}: ${attr.value}`}>➔ {attr.key}</span>
											{/if}
										{/each}
									</div>
								{/if}
							</div>
							<div class="card-footer">
								<button class="card-action-btn" onclick={() => notes.select(card.id)} title="Open note">
									<ExternalLink size={12} />
								</button>
								<button class="card-action-btn delete" onclick={() => deleteNote(card.id)} title="Delete note">
									<Trash2 size={12} />
								</button>
							</div>
						</div>
					{/each}
				</div>

				<div class="column-footer">
					<form class="add-card-form" onsubmit={(e) => { e.preventDefault(); addNewCard(col); }}>
						<input 
							type="text" 
							placeholder="+ Add card..." 
							bind:value={newCardTitles[col]} 
						/>
					</form>
				</div>
			</div>
		{/each}

		<div class="add-column-container">
			{#if showAddColumnInput}
				<form class="add-column-form" onsubmit={addColumn}>
					<input 
						type="text" 
						placeholder="Column name..." 
						bind:value={newColumnName}
						autofocus
					/>
					<div class="form-actions">
						<button type="submit" class="submit-btn"><Plus size={14} /></button>
						<button type="button" class="cancel-btn" onclick={() => showAddColumnInput = false}><X size={14} /></button>
					</div>
				</form>
			{:else}
				<button class="add-column-btn" onclick={() => showAddColumnInput = true}>
					<Plus size={14} />
					<span>Add Column</span>
				</button>
			{/if}
		</div>
	</div>
</div>

<style>
	.kanban-container {
		flex: 1;
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		overflow-x: auto;
		background: #f8f9fa;
		padding: 1.5rem;
	}

	.kanban-board {
		display: flex;
		align-items: flex-start;
		gap: 1.25rem;
		height: 100%;
	}

	.kanban-column {
		width: 280px;
		flex-shrink: 0;
		background: rgba(255, 255, 255, 0.85);
		border: 1px solid rgba(0, 0, 0, 0.05);
		border-radius: 12px;
		display: flex;
		flex-direction: column;
		max-height: 100%;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.02);
		backdrop-filter: blur(10px);
		transition: background-color 0.2s ease, border-color 0.2s ease;
	}

	.kanban-column.drag-over {
		background: rgba(198, 105, 48, 0.05);
		border-color: rgba(198, 105, 48, 0.3);
	}

	.column-header {
		padding: 1rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		border-bottom: 1px solid rgba(0, 0, 0, 0.04);
	}

	.column-title-group {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
	}

	.column-title {
		font-weight: 650;
		font-size: 0.9375rem;
		color: #1e293b;
		cursor: text;
		user-select: none;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.column-rename-input {
		border: 1px solid #c66930;
		border-radius: 4px;
		padding: 0.125rem 0.375rem;
		font-size: 0.9375rem;
		font-family: inherit;
		outline: none;
		width: 100%;
		background: #ffffff;
	}

	.card-count {
		background: rgba(0, 0, 0, 0.05);
		color: #64748b;
		padding: 0.125rem 0.375rem;
		border-radius: 9999px;
		font-size: 0.75rem;
		font-weight: 600;
		flex-shrink: 0;
	}

	.delete-col-btn {
		border: none;
		background: none;
		color: #94a3b8;
		cursor: pointer;
		padding: 0.25rem;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		margin-left: 0.25rem;
	}

	.delete-col-btn:hover {
		background: rgba(0, 0, 0, 0.05);
		color: #ef4444;
	}

	.column-cards {
		flex: 1;
		overflow-y: auto;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		scrollbar-width: thin;
	}

	.kanban-card {
		background: #ffffff;
		border: 1px solid rgba(0, 0, 0, 0.06);
		border-radius: 8px;
		padding: 0.875rem;
		box-shadow: 0 2px 6px rgba(0, 0, 0, 0.02);
		cursor: grab;
		transition: transform 0.15s ease, box-shadow 0.15s ease;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.kanban-card:hover {
		box-shadow: 0 4px 10px rgba(0, 0, 0, 0.05);
		border-color: rgba(0, 0, 0, 0.1);
	}

	.kanban-card:active {
		cursor: grabbing;
	}

	.kanban-card.dragging {
		opacity: 0.4;
		transform: scale(0.98);
	}

	.card-title-link {
		border: none;
		background: none;
		padding: 0;
		font-size: 0.875rem;
		font-weight: 600;
		color: #0f172a;
		text-align: left;
		cursor: pointer;
		line-height: 1.4;
		font-family: inherit;
		overflow: hidden;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
	}

	.card-title-link:hover {
		color: #c66930;
	}

	.card-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-top: 0.25rem;
	}

	.tag-pill {
		font-size: 0.6875rem;
		font-weight: 500;
		background: rgba(198, 105, 48, 0.08);
		color: #c66930;
		padding: 0.125rem 0.375rem;
		border-radius: 4px;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		border: none;
		font-family: inherit;
	}

	button.tag-pill {
		cursor: pointer;
	}

	button.tag-pill:hover {
		background: rgba(198, 105, 48, 0.2);
	}

	.card-footer {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
		border-top: 1px solid rgba(0, 0, 0, 0.03);
		padding-top: 0.5rem;
		margin-top: 0.25rem;
	}

	.card-action-btn {
		border: none;
		background: none;
		color: #94a3b8;
		padding: 0.25rem;
		border-radius: 4px;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.card-action-btn:hover {
		background: rgba(0, 0, 0, 0.04);
		color: #475569;
	}

	.card-action-btn.delete:hover {
		color: #ef4444;
	}

	.column-footer {
		padding: 0.75rem 1rem;
		border-top: 1px solid rgba(0, 0, 0, 0.03);
	}

	.add-card-form input {
		width: 100%;
		border: 1px dashed rgba(0, 0, 0, 0.15);
		background: none;
		border-radius: 6px;
		padding: 0.375rem 0.625rem;
		font-size: 0.8125rem;
		outline: none;
		color: #475569;
		transition: border-color 0.15s ease;
	}

	.add-card-form input:focus {
		border-color: #c66930;
		border-style: solid;
		background: #ffffff;
	}

	.add-column-container {
		width: 280px;
		flex-shrink: 0;
	}

	.add-column-btn {
		width: 100%;
		border: 1px dashed rgba(0, 0, 0, 0.15);
		background: rgba(255, 255, 255, 0.4);
		border-radius: 12px;
		padding: 1rem;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		color: #64748b;
		font-weight: 600;
		font-size: 0.875rem;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.add-column-btn:hover {
		background: rgba(255, 255, 255, 0.8);
		border-color: #c66930;
		color: #c66930;
	}

	.add-column-form {
		background: #ffffff;
		border: 1px solid rgba(0, 0, 0, 0.08);
		border-radius: 12px;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
	}

	.add-column-form input {
		width: 100%;
		border: 1px solid rgba(0, 0, 0, 0.12);
		border-radius: 6px;
		padding: 0.5rem;
		font-size: 0.875rem;
		outline: none;
	}

	.add-column-form input:focus {
		border-color: #c66930;
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.form-actions button {
		border: none;
		border-radius: 4px;
		padding: 0.375rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.submit-btn {
		background: #c66930;
		color: #ffffff;
	}

	.submit-btn:hover {
		background: #b05c28;
	}

	.cancel-btn {
		background: rgba(0, 0, 0, 0.05);
		color: #64748b;
	}

	.cancel-btn:hover {
		background: rgba(0, 0, 0, 0.1);
	}
</style>

<script lang="ts">
	import TreeItem from './TreeItem.svelte';
	import { notes } from '$lib/notes.svelte';
	import type { LocalBranch } from '$lib/db';
	import { Folder, FileText, Inbox, Book, Home } from 'lucide-svelte';

	let { branch }: { branch: LocalBranch } = $props();

	const note = $derived(notes.noteFor(branch));
	const children = $derived(notes.childBranches(branch.note_id));
	const expanded = $derived(notes.isExpanded(branch.id));
	const isSearchActive = $derived(notes.searchQuery.trim() !== '');
	const shouldExpand = $derived(isSearchActive || expanded);
	const isVisible = $derived(notes.isVisible(branch.id));
	const selected = $derived(notes.selected?.id === branch.note_id);
	const cloned = $derived(notes.placementCount(branch.note_id) > 1);
	const placing = $derived(notes.pendingClone !== null);
	const moving = $derived(notes.pendingMoveBranch !== null);
	const attributes = $derived(note ? notes.getAttributes(note.id) : []);

	let menuOpen = $state(false);

	function getIcon(title: string, hasChildren: boolean) {
		const lower = (title || '').trim().toLowerCase();
		if (lower === 'home') return Home;
		if (lower === 'journal') return Book;
		if (lower === 'inbox') return Inbox;
		if (hasChildren) return Folder;
		return FileText;
	}

	const Icon = $derived(note ? getIcon(note.title, children.length > 0) : null);

	async function onTitleClick() {
		if (placing) {
			const problem = await notes.placeClone(branch.note_id);
			if (problem) alert(problem);
		} else if (moving) {
			const problem = await notes.placeMove(branch.note_id);
			if (problem) alert(problem);
		} else {
			notes.select(branch.note_id);
		}
	}

	const inTrash = $derived(notes.trashRootId !== null && branch.parent_id === notes.trashRootId);

	function remove() {
		if (!note) return;
		const message = cloned
			? `Remove this placement of “${note.title}”? The note stays in its other locations.`
			: inTrash
				? `Permanently delete “${note.title}” and everything nested under it? This cannot be undone.`
				: `Move “${note.title}” to Trash? (It can be restored for 30 days.)`;
		if (confirm(message)) void notes.deleteBranch(branch.id);
	}

	function restoreNote(event: MouseEvent) {
		event.stopPropagation();
		void notes.restoreFromTrash(branch.id);
		menuOpen = false;
	}

	function toggleMenu(event: MouseEvent) {
		event.stopPropagation();
		menuOpen = !menuOpen;
	}

	// Close menu on document click outside
	$effect(() => {
		if (menuOpen) {
			const handleOutside = (e: MouseEvent) => {
				const target = e.target as HTMLElement;
				if (!target.closest('.menu-container')) {
					menuOpen = false;
				}
			};
			document.addEventListener('click', handleOutside);
			return () => document.removeEventListener('click', handleOutside);
		}
	});

	// Close menu on document click outside
	function cloneNote(event: MouseEvent) {
		event.stopPropagation();
		if (note) {
			notes.startClone(note.id);
		}
		menuOpen = false;
	}

	function moveNote(event: MouseEvent) {
		event.stopPropagation();
		notes.startMove(branch.id);
		menuOpen = false;
	}

	function deleteNote(event: MouseEvent) {
		event.stopPropagation();
		remove();
		menuOpen = false;
	}

	function createChild(event: MouseEvent) {
		event.stopPropagation();
		if (note) {
			void notes.createNote(note.id, branch.id);
		}
	}
</script>

{#if note && isVisible}
	<li>
		<div class="row" class:selected class:placing={placing || moving}>
			<button
				class="chevron"
				class:open={shouldExpand}
				class:leaf={!children.length}
				onclick={() => notes.toggleExpanded(branch.id)}
				aria-label={shouldExpand ? 'Collapse' : 'Expand'}
				tabindex={children.length ? 0 : -1}
			>
				<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="9 18 15 12 9 6"></polyline>
				</svg>
			</button>
			<button
				class="title"
				title={placing ? 'Place clone inside this note' : (moving ? 'Move note inside this note' : undefined)}
				onclick={onTitleClick}
			>
				{#if Icon}
					<Icon size={14} class="node-icon" />
				{/if}
				{note.title || 'Untitled'}
				{#if cloned}
					<span
						class="clone-badge"
						title="Appears in {notes.placementCount(branch.note_id)} places"
					>
						⧉
					</span>
				{/if}
			</button>
			<span class="actions">
				<button class="action-btn" title="Add child note" onclick={createChild}>
					<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
						<line x1="12" y1="5" x2="12" y2="19"></line>
						<line x1="5" y1="12" x2="19" y2="12"></line>
					</svg>
				</button>
				<div class="menu-container">
					<button class="action-btn" title="Note actions" onclick={toggleMenu}>
						<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="1.5"></circle>
							<circle cx="12" cy="5" r="1.5"></circle>
							<circle cx="12" cy="19" r="1.5"></circle>
						</svg>
					</button>
					{#if menuOpen}
						<div class="menu-dropdown">
							{#if inTrash}
								<button onclick={restoreNote}>Restore</button>
								<button onclick={deleteNote} class="danger">Delete Forever</button>
							{:else}
								<button onclick={cloneNote}>Clone Note</button>
								<button onclick={moveNote}>Move Note</button>
								<button onclick={deleteNote} class="danger">Delete</button>
							{/if}
						</div>
					{/if}
				</div>
			</span>
		</div>
		{#if shouldExpand && children.length && note.title.trim().toLowerCase() !== 'journal'}
			<ul>
				{#each children as child (child.id)}
					<TreeItem branch={child} />
				{/each}
			</ul>
		{/if}
	</li>
{/if}

<style>
	li {
		list-style: none;
	}

	ul {
		margin: 0;
		padding: 0 0 0 0.875rem;
	}

	.row {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		border-radius: 6px;
		padding: 0.125rem 0.25rem;
		color: #ffffff;
		position: relative;
	}

	.row:hover {
		background: rgba(255, 255, 255, 0.08);
	}

	.row.selected {
		background: rgba(255, 255, 255, 0.15);
		font-weight: 500;
	}

	.row.placing:hover {
		outline: 1px dashed rgba(255, 255, 255, 0.5);
	}

	.row button {
		border: none;
		background: none;
		padding: 0.125rem 0.25rem;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}

	.chevron {
		flex: none;
		width: 1.25rem;
		height: 1.25rem;
		display: flex;
		align-items: center;
		justify-content: center;
		color: rgba(255, 255, 255, 0.5);
		transition: transform 120ms, color 0.15s;
		padding: 0;
		border: none;
		background: none;
		cursor: pointer;
	}

	.chevron:hover {
		color: #ffffff;
	}

	.chevron.open {
		transform: rotate(90deg);
	}

	.chevron.leaf {
		visibility: hidden;
		pointer-events: none;
	}

	.title {
		flex: 1;
		min-width: 0;
		text-align: left;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.875rem;
		color: #ffffff;
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.clone-badge {
		margin-left: 0.375rem;
		font-size: 0.75rem;
		color: #c66930;
	}

	.actions {
		flex: none;
		display: none;
		align-items: center;
		gap: 0.125rem;
	}

	.row:hover .actions,
	.row:focus-within .actions {
		display: flex;
	}

	.action-btn {
		color: rgba(255, 255, 255, 0.6) !important;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		padding: 0.25rem !important;
		transition: all 0.15s ease;
	}

	.action-btn:hover {
		color: #ffffff !important;
		background: rgba(255, 255, 255, 0.1);
	}

	.menu-container {
		position: relative;
		display: inline-flex;
	}

	.menu-dropdown {
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 4px;
		background: #ffffff;
		border: 1px solid #e2e4e8;
		border-radius: 6px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		z-index: 100;
		min-width: 120px;
		padding: 4px 0;
		display: flex;
		flex-direction: column;
	}

	.menu-dropdown button {
		border: none;
		background: none;
		text-align: left;
		padding: 6px 12px;
		font-size: 0.8125rem;
		color: #1d2129 !important;
		cursor: pointer;
		width: 100%;
		display: block;
		border-radius: 0;
		transition: background 0.15s;
	}

	.menu-dropdown button:hover {
		background: #f4f5f7 !important;
		color: #1d2129 !important;
	}

	.menu-dropdown button.danger {
		color: #d9383a !important;
	}

	.menu-dropdown button.danger:hover {
		background: #fef0f0 !important;
		color: #d9383a !important;
	}
</style>

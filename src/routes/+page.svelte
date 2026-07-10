<script lang="ts">
	import { auth } from '$lib/auth.svelte';
	import { notes, initNotes } from '$lib/notes.svelte';
	import { startSync, stopSync } from '$lib/sync';
	import { maybeSeedWorkspace } from '$lib/initWorkspace';
	import TreeItem from '$lib/components/TreeItem.svelte';
	import NoteEditor from '$lib/components/NoteEditor.svelte';
	import SavedSearchView from '$lib/components/SavedSearchView.svelte';
	import QuickSwitcher from '$lib/components/QuickSwitcher.svelte';
	import Dashboard from '$lib/components/Dashboard.svelte';
	import JournalCalendar from '$lib/components/JournalCalendar.svelte';
	import Toolbar from '$lib/components/Toolbar.svelte';
	import { CloudCheck, CloudOff, RefreshCw } from 'lucide-svelte';
	import { db } from '$lib/db';

	// This page only mounts at aal2 (the layout gates it), so the sync loop
	// starts and stops with the verified session.
	$effect(() => {
		const stopNotes = initNotes();
		startSync();
		void maybeSeedWorkspace();
		// Empty the oldest trash once per session, after the first pull settles.
		const purgeTimer = setTimeout(() => void notes.purgeOldTrash(), 10_000);

		return () => {
			stopNotes();
			stopSync();
			clearTimeout(purgeTimer);
		};
	});

	const roots = $derived(notes.childBranches(null));
	const visibleRoots = $derived(roots.filter(branch => notes.isVisible(branch.id)));

	// Saved Search note type: noteType=search renders a live virtual folder
	// instead of the editor (the query lives in a `query` attribute or the
	// note body).
	const isSearchNote = $derived(
		notes.selected
			? notes
					.getAttributes(notes.selected.id)
					.some((a) => a.type === 'label' && a.key === 'noteType' && a.value === 'search')
			: false
	);

	// Web View note type: noteType=webview + a url attribute swaps the
	// editor canvas for an embedded page. http(s) only.
	const webviewUrl = $derived.by(() => {
		if (!notes.selected) return null;
		const attrs = notes.getAttributes(notes.selected.id);
		if (!attrs.some((a) => a.key === 'noteType' && a.value === 'webview')) return null;
		const url = attrs.find((a) => a.key === 'url')?.value ?? '';
		return /^https?:\/\//i.test(url) ? url : null;
	});

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			if (notes.pendingClone) notes.cancelClone();
			if (notes.pendingMoveBranch) notes.cancelMove();
		}
	}

	async function placeAtRoot() {
		const problem = await notes.placeClone(null);
		if (problem) alert(problem);
	}
</script>

<svelte:window onkeydown={onKeydown} />

<svelte:head>
	<title>Personal Wiki</title>
</svelte:head>

<div class="app">
	<Toolbar />
	<QuickSwitcher />
	<div class="body">
		{#if notes.sidebarOpen}
			<div class="sidebar-backdrop" onclick={() => notes.sidebarOpen = false}></div>
		{/if}
		<aside class:open={notes.sidebarOpen}>
		<div class="sidebar-top">
			<button class="new-note" onclick={() => void notes.createNote(null)}>+ New note</button>
			<div class="sort-selector">
				<label for="sidebar-sort-select">
					<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="sort-icon">
						<path d="m21 16-4 4-4-4"/>
						<path d="M17 20V4"/>
						<path d="m3 8 4-4 4 4"/>
						<path d="M7 4v16"/>
					</svg>
					<span>Sort:</span>
				</label>
				<select
					id="sidebar-sort-select"
					value={notes.sortOption}
					onchange={(e) => notes.sortOption = e.currentTarget.value as any}
				>
					<option value="az">A-Z (Ascending)</option>
					<option value="za">Z-A (Descending)</option>
					<option value="date_desc">Created (Newest first)</option>
					<option value="date_asc">Created (Oldest first)</option>
				</select>
			</div>
		</div>
		{#if notes.pendingClone}
			<div class="clone-banner">
				<p>
					Placing clone of <strong>{notes.pendingClone.title || 'Untitled'}</strong> — click a
					destination note, or:
				</p>
				<div class="clone-actions">
					<button onclick={() => void notes.placeClone(null)}>Place at root</button>
					<button onclick={() => notes.cancelClone()}>Cancel (Esc)</button>
				</div>
			</div>
		{/if}
		{#if notes.pendingMoveBranch}
			<div class="clone-banner">
				<p>
					Moving <strong>{notes.noteFor(notes.pendingMoveBranch)?.title || 'Untitled'}</strong> — click a
					destination note, or:
				</p>
				<div class="clone-actions">
					<button onclick={() => void notes.placeMove(null)}>Place at root</button>
					<button onclick={() => notes.cancelMove()}>Cancel (Esc)</button>
				</div>
			</div>
		{/if}
		<nav>
			{#if notes.bookmarkedBranches.length}
				<div class="sidebar-section-title">
					<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="section-icon">
						<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
					</svg>
					<span>Bookmarks</span>
				</div>
				<ul class="bookmarks-list">
					{#each notes.bookmarkedBranches as branch (branch.id)}
						{@const note = notes.noteFor(branch)}
						{#if note}
							{@const isFolder = notes.isBookmarkFolder(note.id)}
							<li class="bookmark-item-wrapper">
								{#if isFolder}
									<div class="bookmark-folder-header">
										<button
											class="folder-toggle-btn"
											onclick={() => notes.toggleExpanded(branch.id)}
											aria-label="Toggle folder"
										>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												width="10"
												height="10"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												stroke-width="2"
												class="chevron-icon"
												class:rotated={notes.isExpanded(branch.id)}
											>
												<path d="m9 18 6-6-6-6"/>
											</svg>
										</button>
										<button
											class="bookmark-link folder-link"
											class:active={notes.selectedId === note.id}
											onclick={() => notes.select(note.id)}
										>
											<span class="bookmark-icon">📁</span>
											<span class="bookmark-title">{note.title || 'Untitled'}</span>
										</button>
									</div>
									{#if notes.isExpanded(branch.id)}
										<ul class="bookmark-folder-children">
											{#each notes.childBranches(note.id) as childBranch (childBranch.id)}
												<TreeItem branch={childBranch} />
											{/each}
										</ul>
									{/if}
								{:else}
									<button
										class="bookmark-link"
										class:active={notes.selectedId === note.id}
										onclick={() => notes.select(note.id)}
									>
										<span class="bookmark-icon">⭐</span>
										<span class="bookmark-title">{note.title || 'Untitled'}</span>
									</button>
								{/if}
							</li>
						{/if}
					{/each}
				</ul>
				<div class="sidebar-divider"></div>
			{/if}

			{#if visibleRoots.length}
				<ul>
					{#each visibleRoots as branch (branch.id)}
						<TreeItem {branch} />
					{/each}
				</ul>
			{:else if notes.searchQuery.trim()}
				<p class="empty">No matching notes found</p>
			{:else}
				<p class="empty">No notes yet — create your first one above.</p>
			{/if}
		</nav>
		<footer>
			<div class="footer-layout">
				<div class="sync-status" class:online={notes.isOnline} class:syncing={notes.isSyncing} class:dirty={notes.dirtyCount > 0}>
					{#if !notes.isOnline}
						<CloudOff size={14} class="status-icon" />
						<span>Offline - Changes Saved Locally</span>
					{:else if notes.isSyncing}
						<RefreshCw size={14} class="status-icon spinning" />
						<span>Syncing...</span>
					{:else}
						<CloudCheck size={14} class="status-icon" />
						<span>
							{notes.dirtyCount > 0 ? `${notes.dirtyCount} unsynced` : 'Synced'}
						</span>
					{/if}
				</div>
				<div class="footer-bottom">
					<span class="email">{auth.session?.user.email}</span>
					<button onclick={() => auth.signOut()}>Sign out</button>
				</div>
			</div>
		</footer>
	</aside>

	<main class:no-padding={notes.selected?.title.trim().toLowerCase() === 'journal'}>
		{#if notes.selected}
			{#if notes.selected.title.trim().toLowerCase() === 'journal'}
				<JournalCalendar journalNote={notes.selected} />
			{:else if isSearchNote}
				<SavedSearchView note={notes.selected} />
			{:else if webviewUrl}
				<div class="webview">
					<header>
						<span class="webview-title">{notes.selected.title || 'Untitled'}</span>
						<a href={webviewUrl} target="_blank" rel="noopener noreferrer">Open in new tab ↗</a>
					</header>
					<iframe
						src={webviewUrl}
						title={notes.selected.title || 'Embedded page'}
						sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
						referrerpolicy="no-referrer"
					></iframe>
				</div>
			{:else}
				<NoteEditor note={notes.selected} />
			{/if}
		{:else}
			<Dashboard />
		{/if}
	</main>
	</div>
</div>

<style>
	.app {
		display: flex;
		flex-direction: column;
		height: 100dvh;
	}

	.body {
		display: grid;
		grid-template-columns: 280px 1fr;
		flex: 1;
		min-height: 0;
	}

	aside {
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: #00361f;
		border-right: 1px solid rgba(255, 255, 255, 0.1);
		color: #ffffff;
	}

	.sidebar-top {
		padding: 0.75rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.1);
	}

	.new-note {
		width: 100%;
		border: 1px solid rgba(255, 255, 255, 0.3);
		background: rgba(255, 255, 255, 0.1);
		border-radius: 6px;
		padding: 0.375rem 0.625rem;
		font: inherit;
		font-size: 0.8125rem;
		color: #ffffff;
		cursor: pointer;
		transition: all 0.2s ease;
		text-align: center;
	}

	.new-note:hover {
		border-color: #ffffff;
		background: #ffffff;
		color: #00361f;
	}

	.sort-selector {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		margin-top: 0.625rem;
		font-size: 0.75rem;
		color: rgba(255, 255, 255, 0.6);
	}

	.sort-selector label {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		cursor: pointer;
	}

	.sort-selector select {
		flex: 1;
		background: transparent;
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 4px;
		color: #ffffff;
		padding: 0.1875rem 0.375rem;
		font-size: 0.75rem;
		outline: none;
		cursor: pointer;
		transition: all 0.2s ease;
		box-sizing: border-box;
	}

	.sort-selector select:hover {
		border-color: rgba(255, 255, 255, 0.35);
		background: rgba(255, 255, 255, 0.05);
	}

	.sort-selector select option {
		background: #00361f;
		color: #ffffff;
	}

	.clone-banner {
		padding: 0.625rem 0.75rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.1);
		background: rgba(255, 255, 255, 0.05);
		font-size: 0.8125rem;
		color: #ffffff;
	}

	.clone-banner p {
		margin: 0 0 0.5rem;
	}

	.clone-actions {
		display: flex;
		gap: 0.5rem;
	}

	.clone-actions button {
		border: 1px solid rgba(255, 255, 255, 0.3);
		background: rgba(255, 255, 255, 0.1);
		color: #ffffff;
		border-radius: 6px;
		padding: 0.125rem 0.5rem;
		font: inherit;
		font-size: 0.75rem;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.clone-actions button:hover {
		background: #ffffff;
		color: #00361f;
		border-color: #ffffff;
	}

	nav {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem;
	}

	nav > ul {
		margin: 0;
		padding: 0;
	}

	.empty {
		margin: 0.5rem 0.25rem;
		color: rgba(255, 255, 255, 0.6);
		font-size: 0.8125rem;
	}

	footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.625rem 0.75rem;
		border-top: 1px solid rgba(255, 255, 255, 0.1);
		font-size: 0.75rem;
		color: rgba(255, 255, 255, 0.7);
	}

	.footer-layout {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: 100%;
	}

	.sync-status {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.75rem;
		padding: 0.375rem 0.5rem;
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.05);
		transition: all 0.2s ease;
	}

	.sync-status.online {
		color: #a7f3d0;
	}

	.sync-status.online.dirty {
		color: #fde047;
	}

	.sync-status:not(.online) {
		color: #fca5a5;
		background: rgba(239, 68, 68, 0.1);
	}

	:global(.spinning) {
		animation: spin 1.5s linear infinite;
	}

	@keyframes spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}

	.status-icon {
		flex-shrink: 0;
	}

	.footer-bottom {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		width: 100%;
	}

	.email {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	footer button {
		border: none;
		background: none;
		padding: 0;
		font: inherit;
		color: rgba(255, 255, 255, 0.7);
		text-decoration: underline;
		cursor: pointer;
		transition: color 0.2s ease;
	}

	footer button:hover {
		color: #ffffff;
	}

	main {
		overflow-y: auto;
		padding: 1.5rem 2rem;
	}

	main.no-padding {
		padding: 0;
	}

	.placeholder {
		color: #667;
	}

	/* ── Web View note type ─────────────────────────────────────────── */

	.webview {
		display: flex;
		flex-direction: column;
		height: 100%;
		gap: 0.625rem;
	}

	.webview header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 1rem;
	}

	.webview-title {
		font-size: 1.125rem;
		font-weight: 600;
	}

	.webview header a {
		font-size: 0.8125rem;
		color: #c66930;
		white-space: nowrap;
	}

	.webview iframe {
		flex: 1;
		min-height: 0;
		width: 100%;
		border: 1px solid #e2e4e8;
		border-radius: 8px;
		background: #ffffff;
	}

	.sidebar-backdrop {
		display: none;
	}

	@media (max-width: 768px) {
		.body {
			display: block;
			position: relative;
			overflow: hidden;
		}

		aside {
			position: absolute;
			top: 0;
			left: 0;
			bottom: 0;
			width: 280px;
			z-index: 1000;
			transform: translateX(-100%);
			transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
			box-shadow: 4px 0 12px rgba(0, 0, 0, 0.3);
		}

		aside.open {
			transform: translateX(0);
		}

		.sidebar-backdrop {
			display: block;
			position: absolute;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background: rgba(0, 0, 0, 0.4);
			z-index: 999;
			backdrop-filter: blur(2px);
			-webkit-backdrop-filter: blur(2px);
		}

		main {
			width: 100%;
			box-sizing: border-box;
			padding: 1rem;
			/* Anything wider than the phone (Kanban, code) scrolls inside its
			   own container; the page itself must never scroll sideways. */
			overflow-x: hidden;
		}
	}

	/* ── Print-to-PDF media engine ──────────────────────────────────────
	   Ctrl+P exports just the note canvas: chrome hidden, typography
	   full-width, sensible page breaks. :global reaches into the scoped
	   Toolbar/NoteEditor components. */

	@page {
		margin: 18mm 16mm;
	}

	@media print {
		.body > aside,
		.webview header,
		:global(.toolbar),
		:global(.editor-sidebar-right),
		:global(.attributes-container),
		:global(.meta-actions),
		:global(.note-paths),
		:global(.uploading-hint),
		:global(.global-ai-dropdown),
		:global(.dropdown),
		:global(.image-bubble-menu),
		:global(.drag-drop-overlay),
		:global(.floating-popover),
		:global(.bubble-menu),
		:global(.split-toggle-btn),
		:global(.right-viewer-pane) {
			display: none !important;
		}

		.app,
		.body {
			display: block;
			height: auto;
			overflow: visible !important;
		}

		main {
			overflow: visible !important;
			padding: 0;
		}

		:global(.editor-workspace),
		:global(.editor) {
			display: block;
			height: auto;
			overflow: visible !important;
		}

		:global(.editor-content-wrapper) {
			display: block !important;
			max-width: 100% !important;
			width: 100% !important;
			padding: 0 !important;
			margin: 0 !important;
			overflow: visible !important;
		}

		:global(input.title) {
			border: none;
			font-size: 20pt;
			font-weight: 700;
			color: #000;
			width: 100%;
		}

		:global(.ProseMirror) {
			color: #000 !important;
			font-size: 11pt;
			line-height: 1.55;
		}

		:global(.ProseMirror h1),
		:global(.ProseMirror h2),
		:global(.ProseMirror h3) {
			break-after: avoid;
		}

		:global(.ProseMirror pre),
		:global(.ProseMirror blockquote),
		:global(.ProseMirror img),
		:global(.ProseMirror table) {
			break-inside: avoid;
		}

		:global(.ProseMirror a) {
			color: #000;
			text-decoration: underline;
		}

		.webview iframe {
			border: none;
			height: 250mm;
		}
	}

	.sidebar-section-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.25rem 0.25rem 0.25rem;
		font-size: 0.6875rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: rgba(255, 255, 255, 0.4);
	}

	.section-icon {
		opacity: 0.6;
	}

	.bookmarks-list {
		margin: 0 0 0.5rem 0;
		padding: 0;
		list-style: none;
	}

	.bookmark-item-wrapper {
		margin: 2px 0;
	}

	.bookmark-link {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		border: none;
		background: none;
		padding: 0.375rem 0.5rem;
		border-radius: 4px;
		color: rgba(255, 255, 255, 0.85);
		font-size: 0.8125rem;
		text-align: left;
		cursor: pointer;
		font-family: inherit;
		outline: none;
		transition: background 0.15s ease, color 0.15s ease;
	}

	.bookmark-link:hover {
		background: rgba(255, 255, 255, 0.08);
		color: #ffffff;
	}

	.bookmark-link.active {
		background: rgba(255, 255, 255, 0.15);
		color: #ffffff;
		font-weight: 500;
	}

	.bookmark-icon {
		font-size: 0.875rem;
		display: inline-block;
		width: 16px;
		text-align: center;
	}

	.bookmark-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.bookmark-folder-header {
		display: flex;
		align-items: center;
	}

	.folder-toggle-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		border: none;
		background: none;
		color: rgba(255, 255, 255, 0.5);
		cursor: pointer;
		padding: 0;
		outline: none;
	}

	.folder-toggle-btn:hover {
		color: #ffffff;
	}

	.chevron-icon {
		transition: transform 0.15s ease;
	}

	.chevron-icon.rotated {
		transform: rotate(90deg);
	}

	.folder-link {
		flex: 1;
		padding-left: 0.25rem;
	}

	.bookmark-folder-children {
		margin: 0 0 0 16px;
		padding: 0;
		list-style: none;
		border-left: 1px solid rgba(255, 255, 255, 0.1);
	}

	.sidebar-divider {
		height: 1px;
		background: rgba(255, 255, 255, 0.15);
		margin: 0.5rem 0.25rem;
	}
</style>

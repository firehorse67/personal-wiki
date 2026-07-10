<script lang="ts">
	import { notes } from '$lib/notes.svelte';
	import type { LocalNote } from '$lib/db';
	import { Search, FileText } from 'lucide-svelte';

	let { note }: { note: LocalNote } = $props();

	// The query lives in a `query` label if present, else in the note body
	// (tags stripped, so a body edited in Tiptap still works).
	const queryAttr = $derived(
		notes.getAttributes(note.id).find((a) => a.type === 'label' && a.key === 'query')
	);
	const storedQuery = $derived(
		queryAttr?.value ?? (note.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
	);

	// Draft follows the stored value until the user edits, then saves write
	// through to the attribute (creating it on first save).
	let draft = $state('');
	let editing = $state(false);
	const shownQuery = $derived(editing ? draft : storedQuery);

	async function saveQuery() {
		editing = false;
		const value = draft.trim();
		if (value === storedQuery) return;
		if (queryAttr) {
			await notes.updateAttribute(queryAttr.id, { value });
		} else {
			await notes.addAttribute(note.id, { type: 'label', key: 'query', value });
		}
	}

	// The live engine: recomputes on every store change (edits, sync pulls,
	// attribute mutations) — the folder populates itself in real time.
	const results = $derived(
		shownQuery.trim() ? notes.runSavedSearch(shownQuery).filter((n) => n.id !== note.id) : []
	);
</script>

<div class="saved-search">
	<header>
		<div class="query-row">
			<Search size={16} class="query-icon" />
			<input
				type="text"
				placeholder="Search tokens, e.g. #topic:Travel #status:planning japan"
				value={shownQuery}
				onfocus={() => {
					draft = storedQuery;
					editing = true;
				}}
				oninput={(e) => (draft = e.currentTarget.value)}
				onblur={() => void saveQuery()}
				onkeydown={(e) => {
					if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
				}}
			/>
		</div>
		<p class="hint">
			<code>#key:value</code> label equals · <code>#key</code> label exists ·
			<code>:type</code> noteType · plain words search text — all conditions must match
		</p>
	</header>

	<div class="results">
		{#if !shownQuery.trim()}
			<p class="empty">Enter a query above to populate this virtual folder.</p>
		{:else if results.length === 0}
			<p class="empty">No notes match this query.</p>
		{:else}
			<p class="count">{results.length} {results.length === 1 ? 'note' : 'notes'}</p>
			<ul>
				{#each results as hit (hit.id)}
					<li>
						<button class="hit" onclick={() => notes.select(hit.id)}>
							<FileText size={14} class="hit-icon" />
							<span class="hit-title">{hit.title || 'Untitled'}</span>
							<span class="hit-paths">
								{#each notes.parentPaths(hit.id).slice(0, 2) as path (path)}
									<span class="hit-path">{path}</span>
								{/each}
							</span>
						</button>
						<div class="hit-attrs">
							{#each notes.getAttributes(hit.id).slice(0, 6) as attr (attr.id)}
								<button
									class="attr-pill"
									title="Find all notes with this tag"
									onclick={() => {
										notes.searchQuery = attr.value ? `#${attr.key}:${attr.value}` : `#${attr.key}`;
										notes.sidebarOpen = true;
									}}
								>
									#{attr.key}{attr.value ? `:${attr.value}` : ''}
								</button>
							{/each}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>

<style>
	.saved-search {
		display: flex;
		flex-direction: column;
		height: 100%;
		gap: 0.75rem;
	}

	header {
		flex: none;
	}

	.query-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		background: #ffffff;
		border: 1px solid #cfd3da;
		border-radius: 8px;
		padding: 0.625rem 0.875rem;
		color: #667;
	}

	.query-row input {
		flex: 1;
		border: none;
		outline: none;
		font: inherit;
		font-size: 0.9375rem;
		color: #1d2129;
		background: none;
	}

	.hint {
		margin: 0.375rem 0 0;
		font-size: 0.75rem;
		color: #99a;
	}

	.hint code {
		background: #f0f2f5;
		border-radius: 3px;
		padding: 0 0.25rem;
	}

	.results {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}

	.count {
		margin: 0 0 0.5rem;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: #99a;
	}

	.empty {
		color: #667;
		font-size: 0.875rem;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	li {
		background: #ffffff;
		border: 1px solid #e2e4e8;
		border-radius: 8px;
		padding: 0.625rem 0.875rem;
	}

	.hit {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		border: none;
		background: none;
		padding: 0;
		font: inherit;
		text-align: left;
		cursor: pointer;
		color: #1d2129;
		min-width: 0;
	}

	.hit:hover .hit-title {
		color: #c66930;
	}

	.hit-title {
		font-weight: 600;
		font-size: 0.9375rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.hit-paths {
		display: flex;
		gap: 0.375rem;
		margin-left: auto;
		flex: none;
	}

	.hit-path {
		font-size: 0.6875rem;
		color: #99a;
		background: #f0f2f5;
		border-radius: 4px;
		padding: 0.0625rem 0.375rem;
		white-space: nowrap;
	}

	.hit-attrs {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		margin-top: 0.375rem;
	}

	.attr-pill {
		font-size: 0.6875rem;
		color: #c66930;
		background: rgba(198, 105, 48, 0.08);
		border-radius: 4px;
		padding: 0.0625rem 0.375rem;
		border: none;
		font-family: inherit;
		cursor: pointer;
	}

	.attr-pill:hover {
		background: rgba(198, 105, 48, 0.2);
	}
</style>

<script lang="ts">
	import { notes } from '$lib/notes.svelte';
	import { FileText, Search } from 'lucide-svelte';

	let open = $state(false);
	let query = $state('');
	let index = $state(0);
	let inputEl = $state<HTMLInputElement>();

	function onWindowKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
			e.preventDefault();
			open = true;
			query = '';
			index = 0;
			setTimeout(() => inputEl?.focus(), 30);
		} else if (e.key === 'Escape' && open) {
			open = false;
		}
	}

	/**
	 * Fuzzy title match: prefix beats substring beats in-order subsequence;
	 * ties break on most recently modified. Empty query shows recent notes.
	 */
	const results = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (!q) {
			return [...notes.allNotes]
				.sort((a, b) => b.modified_at - a.modified_at)
				.slice(0, 10);
		}
		const scored: { note: (typeof notes.allNotes)[number]; score: number }[] = [];
		for (const note of notes.allNotes) {
			const title = (note.title || '').toLowerCase();
			if (!title) continue;
			let score = 0;
			if (title.startsWith(q)) score = 3;
			else if (title.includes(q)) score = 2;
			else {
				// in-order subsequence: "rtl" matches "Road Trip Log"
				let pos = 0;
				for (const ch of q) {
					pos = title.indexOf(ch, pos);
					if (pos === -1) break;
					pos++;
				}
				if (pos !== -1) score = 1;
			}
			if (score > 0) scored.push({ note, score });
		}
		scored.sort((a, b) => b.score - a.score || b.note.modified_at - a.note.modified_at);
		return scored.slice(0, 10).map((s) => s.note);
	});

	// Keep the highlight inside the result list as it shrinks.
	$effect(() => {
		if (index >= results.length) index = Math.max(0, results.length - 1);
	});

	function choose(noteId: string) {
		notes.select(noteId);
		open = false;
	}

	function onInputKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			index = (index + 1) % Math.max(1, results.length);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			index = (index - 1 + Math.max(1, results.length)) % Math.max(1, results.length);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const hit = results[index];
			if (hit) choose(hit.id);
		}
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="overlay" onclick={(e) => { if (e.target === e.currentTarget) open = false; }}>
		<div class="panel">
			<div class="input-row">
				<Search size={16} class="search-icon" />
				<input
					id="quick-switcher-input"
					name="quick-switcher"
					type="text"
					placeholder="Jump to note…"
					bind:value={query}
					bind:this={inputEl}
					oninput={() => (index = 0)}
					onkeydown={onInputKeydown}
				/>
				<kbd>esc</kbd>
			</div>
			<ul>
				{#each results as note, i (note.id)}
					<li>
						<button class="result" class:active={i === index} onmousedown={(e) => { e.preventDefault(); choose(note.id); }} onmousemove={() => (index = i)}>
							<FileText size={13} class="result-icon" />
							<span class="result-title">{note.title || 'Untitled'}</span>
							<span class="result-path">{notes.parentPaths(note.id)[0] ?? '/'}</span>
						</button>
					</li>
				{:else}
					<li class="none">No matching notes</li>
				{/each}
			</ul>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.3);
		z-index: 3000;
		display: flex;
		justify-content: center;
		padding-top: 12vh;
	}

	.panel {
		width: min(32rem, 92vw);
		height: fit-content;
		background: #ffffff;
		border-radius: 10px;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3);
		overflow: hidden;
	}

	.input-row {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid #e2e4e8;
		color: #667;
	}

	.input-row input {
		flex: 1;
		border: none;
		outline: none;
		font: inherit;
		font-size: 1rem;
		color: #1d2129;
	}

	kbd {
		font-size: 0.6875rem;
		color: #99a;
		background: #f0f2f5;
		border: 1px solid #e2e4e8;
		border-radius: 4px;
		padding: 0.0625rem 0.375rem;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0.375rem;
		max-height: 20rem;
		overflow-y: auto;
	}

	.result {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		border: none;
		background: none;
		padding: 0.4375rem 0.625rem;
		border-radius: 6px;
		font: inherit;
		text-align: left;
		cursor: pointer;
		color: #1d2129;
		min-width: 0;
	}

	.result.active {
		background: rgba(198, 105, 48, 0.1);
	}

	.result-title {
		font-size: 0.875rem;
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.result-path {
		margin-left: auto;
		flex: none;
		font-size: 0.6875rem;
		color: #99a;
		max-width: 40%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.none {
		padding: 0.75rem;
		color: #667;
		font-size: 0.875rem;
	}
</style>

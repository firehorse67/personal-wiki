<script lang="ts">
	import { notes } from '$lib/notes.svelte';
	import { X, Pencil, Trash2, Search } from 'lucide-svelte';

	let { onclose }: { onclose: () => void } = $props();

	let filter = $state('');
	let expandedKeys = $state<Set<string>>(new Set());
	// One edit at a time: either a key row or a key:value row.
	let editing = $state<{ key: string; value: string | null } | null>(null);
	let editText = $state('');
	let status = $state('');

	function flash(message: string) {
		status = message;
		setTimeout(() => (status = ''), 4000);
	}

	/** key → total count + per-value counts, live from the store. */
	const vocab = $derived.by(() => {
		const keys = new Map<string, { count: number; values: Map<string, number> }>();
		for (const attr of notes.allAttributes) {
			if (attr.type !== 'label' || !attr.key) continue;
			let entry = keys.get(attr.key);
			if (!entry) {
				entry = { count: 0, values: new Map() };
				keys.set(attr.key, entry);
			}
			entry.count++;
			if (attr.value) entry.values.set(attr.value, (entry.values.get(attr.value) ?? 0) + 1);
		}
		return keys;
	});

	const rows = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		return [...vocab.entries()]
			.filter(
				([key, entry]) =>
					!q ||
					key.toLowerCase().includes(q) ||
					[...entry.values.keys()].some((v) => v.toLowerCase().includes(q))
			)
			.sort((a, b) => b[1].count - a[1].count);
	});

	function toggleKey(key: string) {
		const next = new Set(expandedKeys);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		expandedKeys = next;
	}

	function startEdit(key: string, value: string | null) {
		editing = { key, value };
		editText = value === null ? key : value;
	}

	async function saveEdit() {
		const target = editing;
		editing = null;
		if (!target) return;
		const text = editText.trim();
		if (!text) return;

		if (target.value === null) {
			// Renaming a KEY across the workspace.
			if (text === target.key) return;
			const mergingInto = vocab.has(text);
			if (
				mergingInto &&
				!confirm(`“${text}” already exists — merge every “${target.key}” tag into it?`)
			) {
				return;
			}
			const result = await notes.renameTag(target.key, null, text, null);
			flash(
				`Renamed ${result.changed} tag${result.changed === 1 ? '' : 's'}` +
					(result.merged ? `, merged ${result.merged} duplicate${result.merged === 1 ? '' : 's'}` : '')
			);
		} else {
			// Renaming one VALUE of a key.
			if (text === target.value) return;
			const mergingInto = vocab.get(target.key)?.values.has(text);
			if (
				mergingInto &&
				!confirm(
					`“${target.key}:${text}” already exists — merge every “${target.key}:${target.value}” into it?`
				)
			) {
				return;
			}
			const result = await notes.renameTag(target.key, target.value, target.key, text);
			flash(
				`Updated ${result.changed} tag${result.changed === 1 ? '' : 's'}` +
					(result.merged ? `, merged ${result.merged} duplicate${result.merged === 1 ? '' : 's'}` : '')
			);
		}
	}

	async function removeTag(key: string, value: string | null) {
		const label = value === null ? `#${key} (all values)` : `#${key}:${value}`;
		const count =
			value === null ? (vocab.get(key)?.count ?? 0) : (vocab.get(key)?.values.get(value) ?? 0);
		if (!confirm(`Delete ${label} from ${count} note${count === 1 ? '' : 's'}? The notes themselves are untouched.`)) {
			return;
		}
		const removed = await notes.deleteTagEverywhere(key, value);
		flash(`Removed ${removed} tag${removed === 1 ? '' : 's'}`);
	}

	function searchTag(key: string, value: string | null) {
		notes.searchQuery = value === null ? `#${key}` : `#${key}:${value}`;
		notes.sidebarOpen = true;
		onclose();
	}

	function onOverlayKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}
</script>

<svelte:window onkeydown={onOverlayKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="overlay" onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}>
	<div class="panel">
		<header>
			<h2>Tag Manager</h2>
			{#if status}<span class="status">{status}</span>{/if}
			<button class="close-btn" onclick={onclose} title="Close"><X size={16} /></button>
		</header>

		<input
			type="text"
			class="filter"
			placeholder="Filter tags…"
			bind:value={filter}
		/>

		<div class="tag-list">
			{#if rows.length === 0}
				<p class="empty">No tags yet.</p>
			{/if}
			{#each rows as [key, entry] (key)}
				<div class="key-row">
					{#if editing && editing.key === key && editing.value === null}
						<input
							class="edit-input"
							bind:value={editText}
							onkeydown={(e) => {
								if (e.key === 'Enter') void saveEdit();
								if (e.key === 'Escape') editing = null;
							}}
							onblur={() => void saveEdit()}
							autofocus
						/>
					{:else}
						<button class="key-name" onclick={() => toggleKey(key)}>
							<span class="chevron" class:open={expandedKeys.has(key)}>▸</span>
							#{key}
						</button>
						<span class="count">{entry.count}</span>
						<span class="row-actions">
							<button title="Find notes" onclick={() => searchTag(key, null)}><Search size={12} /></button>
							<button title="Rename key everywhere" onclick={() => startEdit(key, null)}><Pencil size={12} /></button>
							<button title="Delete key everywhere" class="danger" onclick={() => void removeTag(key, null)}><Trash2 size={12} /></button>
						</span>
					{/if}
				</div>
				{#if expandedKeys.has(key)}
					{#each [...entry.values.entries()].sort((a, b) => b[1] - a[1]) as [value, count] (value)}
						<div class="value-row">
							{#if editing && editing.key === key && editing.value === value}
								<input
									class="edit-input"
									bind:value={editText}
									onkeydown={(e) => {
										if (e.key === 'Enter') void saveEdit();
										if (e.key === 'Escape') editing = null;
									}}
									onblur={() => void saveEdit()}
									autofocus
								/>
							{:else}
								<span class="value-name">{value}</span>
								<span class="count">{count}</span>
								<span class="row-actions">
									<button title="Find notes" onclick={() => searchTag(key, value)}><Search size={12} /></button>
									<button title="Rename this value everywhere" onclick={() => startEdit(key, value)}><Pencil size={12} /></button>
									<button title="Delete this value everywhere" class="danger" onclick={() => void removeTag(key, value)}><Trash2 size={12} /></button>
								</span>
							{/if}
						</div>
					{/each}
				{/if}
			{/each}
		</div>

		<p class="hint">
			Renaming onto an existing tag merges them. Changes apply to every note in one
			transaction and sync automatically.
		</p>
	</div>
</div>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.35);
		z-index: 3000;
		display: grid;
		place-items: center;
		padding: 1rem;
	}

	.panel {
		width: min(30rem, 100%);
		max-height: min(36rem, 90vh);
		background: #ffffff;
		border-radius: 10px;
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
		display: flex;
		flex-direction: column;
		padding: 1rem 1.25rem;
		gap: 0.75rem;
	}

	header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	h2 {
		margin: 0;
		font-size: 1.0625rem;
		color: #00361f;
		flex: 1;
	}

	.status {
		font-size: 0.75rem;
		color: #0ca678;
		background: #e6fcf5;
		border-radius: 4px;
		padding: 0.125rem 0.5rem;
	}

	.close-btn {
		border: none;
		background: none;
		color: #667;
		cursor: pointer;
		padding: 0.25rem;
		display: flex;
	}

	.close-btn:hover {
		color: #1d2129;
	}

	.filter {
		border: 1px solid #cfd3da;
		border-radius: 6px;
		padding: 0.4375rem 0.625rem;
		font: inherit;
		font-size: 0.875rem;
		outline: none;
	}

	.filter:focus {
		border-color: #c66930;
	}

	.tag-list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
	}

	.empty {
		color: #667;
		font-size: 0.875rem;
	}

	.key-row,
	.value-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3125rem 0.375rem;
		border-radius: 6px;
	}

	.key-row:hover,
	.value-row:hover {
		background: #f5f6f8;
	}

	.value-row {
		margin-left: 1.5rem;
	}

	.key-name {
		border: none;
		background: none;
		padding: 0;
		font: inherit;
		font-size: 0.875rem;
		font-weight: 600;
		color: #1d2129;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.chevron {
		display: inline-block;
		font-size: 0.6875rem;
		color: #99a;
		transition: transform 120ms;
	}

	.chevron.open {
		transform: rotate(90deg);
	}

	.value-name {
		font-size: 0.8125rem;
		color: #4c525d;
	}

	.count {
		font-size: 0.6875rem;
		font-weight: 600;
		color: #99a;
		background: #f0f2f5;
		border-radius: 9999px;
		padding: 0.0625rem 0.4375rem;
	}

	.row-actions {
		margin-left: auto;
		display: none;
		gap: 0.25rem;
	}

	.key-row:hover .row-actions,
	.value-row:hover .row-actions {
		display: flex;
	}

	.row-actions button {
		border: none;
		background: none;
		color: #889;
		cursor: pointer;
		padding: 0.25rem;
		border-radius: 4px;
		display: flex;
	}

	.row-actions button:hover {
		background: #e9ecef;
		color: #1d2129;
	}

	.row-actions button.danger:hover {
		color: #b3261e;
	}

	.edit-input {
		flex: 1;
		border: 1px solid #c66930;
		border-radius: 4px;
		padding: 0.1875rem 0.5rem;
		font: inherit;
		font-size: 0.8125rem;
		outline: none;
	}

	.hint {
		margin: 0;
		font-size: 0.6875rem;
		color: #99a;
	}
</style>

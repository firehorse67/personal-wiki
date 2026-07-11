<script lang="ts">
	import { liveQuery } from 'dexie';
	import { db, type LocalAttachment } from '$lib/db';
	import { supabase } from '$lib/supabaseClient';
	import { notes } from '$lib/notes.svelte';
	import { uploadToStorage, deleteStoredFile, recordAttachmentMeta, publicUrlFor } from '$lib/uploads';
	import { X, UploadCloud, Copy, Trash2, FileText, Check, Search, Pencil } from 'lucide-svelte';

	let { onclose }: { onclose: () => void } = $props();

	let rows = $state<LocalAttachment[]>([]);
	let selectedPath = $state<string | null>(null);
	let status = $state('');
	let uploading = $state(0);
	let dragOver = $state(false);
	let backfilling = $state(true);

	// Detail-card drafts
	let draftDescription = $state('');
	let draftAlt = $state('');
	let copied = $state(false);

	function flash(message: string) {
		status = message;
		setTimeout(() => (status = ''), 4000);
	}

	// Live local metadata — the offline-capable source of truth.
	$effect(() => {
		const subscription = liveQuery(() => db.attachments.toArray()).subscribe({
			next: (data) => (rows = data),
			error: (err) => console.error('Attachments live query failed:', err)
		});
		return () => subscription.unsubscribe();
	});

	let search = $state('');

	const sorted = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return [...rows]
			.filter(
				(r) =>
					!q ||
					fileName(r.file_path).toLowerCase().includes(q) ||
					r.description.toLowerCase().includes(q) ||
					r.alt_text.toLowerCase().includes(q)
			)
			.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
	});

	const selected = $derived(
		selectedPath ? (rows.find((r) => r.file_path === selectedPath) ?? null) : null
	);

	const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
	function isImage(path: string): boolean {
		return IMAGE_EXT.test(path);
	}

	function fileName(path: string): string {
		return path.split('/').pop() ?? path;
	}

	/**
	 * One-time backfill per open: list the bucket via GET /api/upload and
	 * create metadata rows for legacy files that predate the attachments
	 * table, so the grid covers everything ever uploaded.
	 */
	$effect(() => {
		void (async () => {
			try {
				const { data } = await supabase.auth.getSession();
				if (!data.session) return;
				const response = await fetch('/api/upload', {
					headers: { Authorization: `Bearer ${data.session.access_token}` }
				});
				if (!response.ok) return;
				const files: Array<{ url: string; name: string; created_at: string }> = await response.json();
				const marker = '/storage/v1/object/public/clips/';
				for (const file of files) {
					const at = file.url.indexOf(marker);
					if (at === -1) continue;
					const path = decodeURIComponent(file.url.slice(at + marker.length));
					await recordAttachmentMeta(path, '', file.created_at);
				}
			} catch (err) {
				console.warn('Media backfill skipped:', err);
			} finally {
				backfilling = false;
			}
		})();
	});

	// ── Inline tile editing (quick description rename in the grid) ──
	let editingTileId = $state<string | null>(null);
	let tileDraft = $state('');

	function startTileEdit(row: LocalAttachment, event: MouseEvent) {
		event.stopPropagation();
		editingTileId = row.id;
		tileDraft = row.description || fileName(row.file_path);
	}

	async function saveTileEdit() {
		const id = editingTileId;
		editingTileId = null;
		if (!id) return;
		const row = rows.find((r) => r.id === id);
		const value = tileDraft.trim();
		if (!row || row.description === value) return;
		await db.attachments.update(id, { description: value, dirty: 1, modified_at: Date.now() });
		flash('Saved — syncing');
	}

	// ── "Used in…" — notes whose content embeds this file ──
	let usedIn = $state<{ id: string; title: string }[]>([]);

	async function computeUsedIn(row: LocalAttachment) {
		usedIn = [];
		const url = publicUrlFor(row.file_path);
		const encoded = encodeURI(url);
		const allNotes = await db.notes.toArray();
		usedIn = allNotes
			.filter((n) => n.content && (n.content.includes(url) || n.content.includes(encoded)))
			.map((n) => ({ id: n.id, title: n.title || 'Untitled' }));
	}

	function jumpToNote(noteId: string) {
		notes.select(noteId);
		onclose();
	}

	function openDetail(row: LocalAttachment) {
		selectedPath = row.file_path;
		draftDescription = row.description;
		draftAlt = row.alt_text;
		copied = false;
		void computeUsedIn(row);
	}

	async function saveDetail() {
		if (!selected) return;
		if (selected.description === draftDescription.trim() && selected.alt_text === draftAlt.trim()) {
			return;
		}
		await db.attachments.update(selected.id, {
			description: draftDescription.trim(),
			alt_text: draftAlt.trim(),
			dirty: 1,
			modified_at: Date.now()
		});
		flash('Saved — syncing');
	}

	async function copyUrl() {
		if (!selected) return;
		await navigator.clipboard.writeText(publicUrlFor(selected.file_path));
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}

	async function removeFile() {
		if (!selected) return;
		const name = fileName(selected.file_path);
		const usage = usedIn.length
			? `It is used in ${usedIn.length} note${usedIn.length === 1 ? '' : 's'}, which will show broken links.`
			: 'No notes appear to use it.';
		if (!confirm(`Permanently delete “${name}”? ${usage} This cannot be undone.`)) {
			return;
		}
		try {
			await deleteStoredFile(selected.file_path);
			selectedPath = null;
			flash(`Deleted ${name}`);
		} catch (err) {
			alert(err instanceof Error ? err.message : String(err));
		}
	}

	async function ingest(files: FileList | File[]) {
		for (const file of files) {
			uploading++;
			try {
				await uploadToStorage(file);
				flash(`Uploaded ${file.name}`);
			} catch (err) {
				alert(`Could not upload “${file.name}”: ${err instanceof Error ? err.message : err}`);
			} finally {
				uploading--;
			}
		}
	}

	let batchInput = $state<HTMLInputElement>();

	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragOver = false;
		if (event.dataTransfer?.files.length) void ingest(event.dataTransfer.files);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			if (selectedPath) selectedPath = null;
			else onclose();
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overlay">
	<div class="manager">
		<header>
			<h2>Media Library</h2>
			<span class="count">{sorted.length} file{sorted.length === 1 ? '' : 's'}</span>
			<div class="search-box">
				<Search size={13} />
				<input
					id="media-search-input"
					name="media-search"
					type="text"
					placeholder="Search name, description, alt text…"
					bind:value={search}
				/>
				{#if search}
					<button class="clear-search" onclick={() => (search = '')} aria-label="Clear">×</button>
				{/if}
			</div>
			{#if backfilling}<span class="scanning">Scanning storage…</span>{/if}
			{#if uploading > 0}<span class="scanning">Uploading…</span>{/if}
			{#if status}<span class="status">{status}</span>{/if}
			<button class="close-btn" onclick={onclose} title="Close"><X size={18} /></button>
		</header>

		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="dropzone"
			class:drag-over={dragOver}
			ondragover={(e) => {
				e.preventDefault();
				dragOver = true;
			}}
			ondragleave={() => (dragOver = false)}
			ondrop={onDrop}
		>
			<UploadCloud size={18} />
			<span>Drop files here to upload, or</span>
			<button class="browse-btn" onclick={() => batchInput?.click()}>browse…</button>
			<input
				type="file"
				multiple
				hidden
				bind:this={batchInput}
				onchange={(e) => {
					const files = e.currentTarget.files;
					if (files?.length) void ingest(files);
					e.currentTarget.value = '';
				}}
			/>
		</div>

		<div class="grid">
			{#if rows.length === 0 && !backfilling}
				<p class="empty">Nothing uploaded yet — drop a file above to start.</p>
			{/if}
			{#if sorted.length === 0 && search.trim() && rows.length > 0}
				<p class="empty">No files match “{search.trim()}”.</p>
			{/if}
			{#each sorted as row (row.id)}
				<div class="tile" class:active={selectedPath === row.file_path}>
					<button class="tile-media" onclick={() => openDetail(row)} title="Open details">
						{#if isImage(row.file_path)}
							<img src={publicUrlFor(row.file_path)} alt={row.alt_text || fileName(row.file_path)} loading="lazy" />
						{:else}
							<span class="file-tile"><FileText size={26} /></span>
						{/if}
					</button>
					{#if editingTileId === row.id}
						<input
							id="media-tile-edit"
							name="media-tile-edit"
							class="tile-edit"
							bind:value={tileDraft}
							onkeydown={(e) => {
								if (e.key === 'Enter') void saveTileEdit();
								if (e.key === 'Escape') editingTileId = null;
							}}
							onblur={() => void saveTileEdit()}
							autofocus
						/>
					{:else}
						<span class="tile-footer">
							<button class="tile-name" onclick={() => openDetail(row)}>
								{row.description || fileName(row.file_path)}
							</button>
							<button class="tile-pencil" title="Edit description" onclick={(e) => startTileEdit(row, e)}>
								<Pencil size={11} />
							</button>
						</span>
					{/if}
				</div>
			{/each}
		</div>

		{#if selected}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div class="detail-backdrop" onclick={(e) => { if (e.target === e.currentTarget) selectedPath = null; }}>
				<div class="detail-card">
					<div class="detail-preview">
						{#if isImage(selected.file_path)}
							<img src={publicUrlFor(selected.file_path)} alt={selected.alt_text || fileName(selected.file_path)} />
						{:else}
							<a class="detail-file" href={publicUrlFor(selected.file_path)} target="_blank" rel="noopener noreferrer">
								<FileText size={40} />
								<span>Open {fileName(selected.file_path)}</span>
							</a>
						{/if}
					</div>
					<div class="detail-fields">
						<span class="detail-name" title={selected.file_path}>{fileName(selected.file_path)}</span>
						<label>
							Description
							<input type="text" bind:value={draftDescription} onblur={() => void saveDetail()} placeholder="What is this file?" />
						</label>
						<label>
							Alt text
							<input type="text" bind:value={draftAlt} onblur={() => void saveDetail()} placeholder="Accessible description for images" />
						</label>
						<div class="used-in">
							<span class="used-in-label">Used in</span>
							{#if usedIn.length === 0}
								<span class="used-in-none">no notes</span>
							{:else}
								{#each usedIn as ref (ref.id)}
									<button class="used-in-chip" onclick={() => jumpToNote(ref.id)}>{ref.title}</button>
								{/each}
							{/if}
						</div>
						<div class="detail-actions">
							<button onclick={() => void copyUrl()}>
								{#if copied}<Check size={13} /> Copied{:else}<Copy size={13} /> Copy URL{/if}
							</button>
							<button class="danger" onclick={() => void removeFile()}>
								<Trash2 size={13} /> Delete file
							</button>
						</div>
						<span class="detail-date">Added {new Date(selected.created_at).toLocaleDateString()}</span>
					</div>
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.45);
		z-index: 3000;
		display: grid;
		place-items: center;
		padding: 1.5rem;
	}

	.manager {
		width: min(64rem, 100%);
		height: min(44rem, 92vh);
		background: #f8f9fa;
		border-radius: 12px;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.875rem 1.25rem;
		background: #ffffff;
		border-bottom: 1px solid #e2e4e8;
	}

	h2 {
		margin: 0;
		font-size: 1.0625rem;
		color: #00361f;
	}

	.count {
		font-size: 0.75rem;
		color: #99a;
	}

	.scanning {
		font-size: 0.75rem;
		color: #c66930;
	}

	.status {
		font-size: 0.75rem;
		color: #0ca678;
		background: #e6fcf5;
		border-radius: 4px;
		padding: 0.125rem 0.5rem;
	}

	.close-btn {
		margin-left: auto;
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

	.dropzone {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		margin: 0.875rem 1.25rem 0;
		padding: 0.875rem;
		border: 2px dashed #cfd3da;
		border-radius: 8px;
		color: #667;
		font-size: 0.8125rem;
		background: #ffffff;
		flex: none;
		transition: all 0.15s ease;
	}

	.dropzone.drag-over {
		border-color: #c66930;
		background: rgba(198, 105, 48, 0.05);
		color: #c66930;
	}

	.browse-btn {
		border: none;
		background: none;
		color: #c66930;
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
		padding: 0;
	}

	.grid {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
		gap: 0.875rem;
		padding: 1.25rem;
		align-content: start;
	}

	.empty {
		grid-column: 1 / -1;
		color: #667;
		font-size: 0.875rem;
	}

	.tile {
		display: flex;
		flex-direction: column;
		border: 1px solid #e2e4e8;
		background: #ffffff;
		border-radius: 8px;
		overflow: hidden;
		transition: box-shadow 0.15s ease, border-color 0.15s ease;
	}

	.tile:hover {
		border-color: #c66930;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
	}

	.tile.active {
		border-color: #c66930;
	}

	.tile-media {
		border: none;
		background: none;
		padding: 0;
		cursor: pointer;
		display: block;
		width: 100%;
	}

	.tile img {
		width: 100%;
		height: 7rem;
		object-fit: cover;
		display: block;
		background: #f0f2f5;
	}

	.tile-footer {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0 0.25rem 0 0;
	}

	.tile-pencil {
		border: none;
		background: none;
		color: #bbc;
		cursor: pointer;
		padding: 0.25rem;
		display: none;
		flex: none;
	}

	.tile:hover .tile-pencil {
		display: inline-flex;
	}

	.tile-pencil:hover {
		color: #c66930;
	}

	.tile-edit {
		margin: 0.25rem 0.375rem 0.375rem;
		border: 1px solid #c66930;
		border-radius: 4px;
		padding: 0.125rem 0.375rem;
		font: inherit;
		font-size: 0.6875rem;
		outline: none;
	}

	.search-box {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		border: 1px solid #cfd3da;
		border-radius: 6px;
		padding: 0.25rem 0.5rem;
		color: #99a;
		background: #f8f9fa;
		width: min(20rem, 40%);
	}

	.search-box input {
		flex: 1;
		border: none;
		background: none;
		outline: none;
		font: inherit;
		font-size: 0.8125rem;
		color: #1d2129;
		min-width: 0;
	}

	.clear-search {
		border: none;
		background: none;
		color: #99a;
		cursor: pointer;
		padding: 0;
		font-size: 0.875rem;
		line-height: 1;
	}

	.clear-search:hover {
		color: #1d2129;
	}

	.used-in {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem;
	}

	.used-in-label {
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: #99a;
	}

	.used-in-none {
		font-size: 0.75rem;
		color: #99a;
	}

	.used-in-chip {
		border: 1px solid #e2e4e8;
		background: #f8f9fa;
		color: #1d2129;
		border-radius: 4px;
		padding: 0.0625rem 0.4375rem;
		font-family: inherit;
		font-size: 0.75rem;
		cursor: pointer;
	}

	.used-in-chip:hover {
		border-color: #c66930;
		color: #c66930;
	}

	.file-tile {
		width: 100%;
		height: 7rem;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #99a;
		background: #f0f2f5;
	}

	.tile-name {
		flex: 1;
		min-width: 0;
		border: none;
		background: none;
		cursor: pointer;
		font-family: inherit;
		font-size: 0.6875rem;
		color: #4c525d;
		padding: 0.375rem 0.5rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
	}

	.detail-backdrop {
		position: absolute;
		inset: 0;
		background: rgba(0, 0, 0, 0.35);
		display: grid;
		place-items: center;
		padding: 1.5rem;
	}

	.overlay .manager {
		position: relative;
	}

	.detail-card {
		width: min(34rem, 100%);
		background: #ffffff;
		border-radius: 10px;
		box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.detail-preview {
		background: #1d2129;
		display: flex;
		align-items: center;
		justify-content: center;
		max-height: 18rem;
		min-height: 8rem;
	}

	.detail-preview img {
		max-width: 100%;
		max-height: 18rem;
		object-fit: contain;
	}

	.detail-file {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		color: #ffffff;
		font-size: 0.8125rem;
		text-decoration: none;
		padding: 1.5rem;
	}

	.detail-fields {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		padding: 1rem 1.25rem 1.25rem;
	}

	.detail-name {
		font-weight: 600;
		font-size: 0.875rem;
		color: #1d2129;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.detail-fields label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: #99a;
	}

	.detail-fields input {
		border: 1px solid #cfd3da;
		border-radius: 6px;
		padding: 0.4375rem 0.625rem;
		font: inherit;
		font-size: 0.875rem;
		color: #1d2129;
		outline: none;
	}

	.detail-fields input:focus {
		border-color: #c66930;
	}

	.detail-actions {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}

	.detail-actions button {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		border: 1px solid #cfd3da;
		background: #ffffff;
		border-radius: 6px;
		padding: 0.375rem 0.75rem;
		font: inherit;
		font-size: 0.8125rem;
		cursor: pointer;
		color: #1d2129;
	}

	.detail-actions button:hover {
		border-color: #c66930;
		color: #c66930;
	}

	.detail-actions button.danger:hover {
		border-color: #b3261e;
		color: #b3261e;
	}

	.detail-date {
		font-size: 0.6875rem;
		color: #99a;
	}

	@media (max-width: 768px) {
		.overlay {
			padding: 0;
		}

		.manager {
			width: 100%;
			height: 100%;
			border-radius: 0;
		}
	}
</style>

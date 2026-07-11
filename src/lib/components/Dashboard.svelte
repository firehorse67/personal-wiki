<script lang="ts">
	import { liveQuery } from 'dexie';
	import { onDestroy } from 'svelte';
	import { db, type LocalAttachment } from '$lib/db';
	import { notes } from '$lib/notes.svelte';
	import { publicUrlFor } from '$lib/uploads';
	import { syncNow } from '$lib/sync';
	import { Zap, FileText, Clock, PlusSquare, Image as ImageIcon, Mic, Square, Loader2 } from 'lucide-svelte';
	import { startRecording, transcribeAudio, extensionFor, type RecordingController } from '$lib/voice';
	import { uploadToStorage } from '$lib/uploads';

	// ── Quick Post scratch pad ──────────────────────────────────────────

	let qpTitle = $state('');
	let qpBody = $state('');
	let qpTags = $state('');
	let capturing = $state(false);
	let captured = $state(false);

	// ── Voice capture: record → transcribe into the body, keep the audio
	// as an attachment so the original oral source survives alongside the
	// transcript (valuable for oral history, not just a convenience) ──
	let voiceState = $state<'idle' | 'recording' | 'transcribing'>('idle');
	let voiceError = $state('');
	let recordingController: RecordingController | null = null;
	let recordingStartedAt = 0;
	let elapsedSec = $state(0);
	let elapsedTimer: ReturnType<typeof setInterval> | null = null;
	let pendingAudioFile = $state<File | null>(null); // attached to the note on capture

	async function toggleVoice() {
		if (voiceState === 'recording') {
			await stopVoice();
			return;
		}
		if (voiceState !== 'idle') return;
		voiceError = '';
		if (!notes.apiKey) {
			voiceError = 'Add a Gemini API key in Settings → AI Integration first';
			return;
		}
		try {
			recordingController = await startRecording();
			voiceState = 'recording';
			recordingStartedAt = Date.now();
			elapsedSec = 0;
			elapsedTimer = setInterval(() => {
				elapsedSec = Math.floor((Date.now() - recordingStartedAt) / 1000);
			}, 250);
		} catch (err) {
			voiceError =
				err instanceof Error && err.name === 'NotAllowedError'
					? 'Microphone permission denied'
					: 'Could not access the microphone';
		}
	}

	async function stopVoice() {
		if (!recordingController) return;
		if (elapsedTimer) clearInterval(elapsedTimer);
		voiceState = 'transcribing';
		try {
			const recording = await recordingController.stop();
			recordingController = null;
			const transcript = await transcribeAudio(recording, notes.apiKey);
			qpBody = qpBody.trim() ? `${qpBody.trim()}\n\n${transcript}` : transcript;
			pendingAudioFile = new File(
				[recording.blob],
				`voice-note-${Date.now()}.${extensionFor(recording.mimeType)}`,
				{ type: recording.mimeType }
			);
		} catch (err) {
			voiceError = err instanceof Error ? err.message : 'Transcription failed';
		} finally {
			voiceState = 'idle';
		}
	}

	function cancelVoice() {
		if (elapsedTimer) clearInterval(elapsedTimer);
		recordingController?.cancel();
		recordingController = null;
		voiceState = 'idle';
	}

	onDestroy(() => {
		if (elapsedTimer) clearInterval(elapsedTimer);
		recordingController?.cancel();
	});

	/** Space-separated tokens: `key:value` or bare `key`. */
	function parseTags(text: string): { key: string; value: string }[] {
		return text
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map((token) => {
				const raw = token.replace(/^#/, '');
				const colon = raw.indexOf(':');
				if (colon === -1) return { key: raw, value: '' };
				return { key: raw.slice(0, colon), value: raw.slice(colon + 1) };
			})
			.filter((t) => t.key);
	}

	// Suggest the workspace's most-used key:value pairs in the tag field.
	const tagSuggestions = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const attr of notes.allAttributes) {
			if (attr.type !== 'label' || !attr.key) continue;
			const token = attr.value ? `${attr.key}:${attr.value}` : attr.key;
			counts.set(token, (counts.get(token) ?? 0) + 1);
		}
		return [...counts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 20)
			.map(([token]) => token);
	});

	async function inboxRootId(): Promise<string> {
		for (const note of notes.allNotes) {
			if (note.title.trim().toLowerCase() !== 'inbox') continue;
			const isRoot = notes.childBranches(null).some((b) => b.note_id === note.id);
			if (isRoot) return note.id;
		}
		// created_at belongs on the NOTE only — branches have no such column
		// server-side (a leaked created_at on a branch once 400'd every push).
		const stamp = () => ({
			updated_at: new Date().toISOString(),
			dirty: 1,
			modified_at: Date.now()
		});
		const id = crypto.randomUUID();
		await db.transaction('rw', [db.notes, db.branches], async () => {
			await db.notes.put({
				id,
				title: 'Inbox',
				content: '',
				is_shared: false,
				created_at: new Date().toISOString(),
				...stamp()
			});
			await db.branches.put({ id: crypto.randomUUID(), note_id: id, parent_id: null, ...stamp() });
		});
		return id;
	}

	async function fastCapture() {
		if (capturing) return;
		const body = qpBody.trim();
		const title =
			qpTitle.trim() ||
			`Quick note ${new Date().toLocaleString(undefined, {
				day: 'numeric',
				month: 'numeric',
				year: '2-digit',
				hour: '2-digit',
				minute: '2-digit'
			})}`;
		if (!body && !qpTitle.trim()) return;

		capturing = true;
		try {
			const parentId = await inboxRootId();
			const noteId = crypto.randomUUID();
			const now = Date.now();
			const iso = new Date().toISOString();

			// Voice recordings upload before the note write so the file card
			// can be embedded directly in the initial content.
			let audioCard = '';
			if (pendingAudioFile) {
				try {
					const uploaded = await uploadToStorage(pendingAudioFile);
					audioCard = `<p>🎤 <a href="${uploaded.url}" target="_blank" rel="noopener noreferrer">${uploaded.name}</a></p>`;
				} catch (err) {
					console.warn('Voice recording upload failed; transcript kept, audio dropped.', err);
				}
			}

			const html =
				(body
					? body
							.split(/\n{2,}/)
							.map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`)
							.join('')
					: '') + audioCard;

			// One transaction: note + placement + tags land atomically.
			await db.transaction('rw', [db.notes, db.branches, db.attributes], async () => {
				await db.notes.put({
					id: noteId,
					title,
					content: html,
					is_shared: false,
					created_at: iso,
					updated_at: iso,
					dirty: 1,
					modified_at: now
				});
				await db.branches.put({
					id: crypto.randomUUID(),
					note_id: noteId,
					parent_id: parentId,
					updated_at: iso,
					dirty: 1,
					modified_at: now
				});
				for (const tag of parseTags(qpTags)) {
					await db.attributes.put({
						id: crypto.randomUUID(),
						note_id: noteId,
						type: 'label',
						...tag,
						updated_at: iso,
						dirty: 1,
						modified_at: now
					});
				}
			});
			void syncNow();

			qpTitle = '';
			qpBody = '';
			qpTags = '';
			pendingAudioFile = null;
			captured = true;
			setTimeout(() => (captured = false), 2200);
		} catch (err) {
			alert(`Capture failed: ${err instanceof Error ? err.message : err}`);
		} finally {
			capturing = false;
		}
	}

	// ── Feeds — derived from the store's live in-memory rows ────────────

	const trashedIds = $derived.by(() => {
		const ids = new Set<string>();
		for (const attr of notes.allAttributes) {
			if (attr.type === 'label' && attr.key === 'trashedAt') ids.add(attr.note_id);
		}
		return ids;
	});

	const recentNotes = $derived(
		[...notes.allNotes]
			.filter((n) => !trashedIds.has(n.id))
			.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
			.slice(0, 5)
	);

	const recentEdits = $derived(
		[...notes.allNotes]
			.filter((n) => !trashedIds.has(n.id))
			.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
			.slice(0, 5)
	);

	// ── Media strip — its own live query (attachments aren't in the store) ─

	let recentMedia = $state<LocalAttachment[]>([]);
	$effect(() => {
		const subscription = liveQuery(() =>
			db.attachments.orderBy('modified_at').reverse().limit(12).toArray()
		).subscribe({
			next: (rows) => {
				recentMedia = [...rows]
					.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
					.slice(0, 6);
			},
			error: (err) => console.error('Media strip query failed:', err)
		});
		return () => subscription.unsubscribe();
	});

	// Parent note per media item (content embeds the file URL), for hover
	// and click-through.
	let mediaParents = $state<Record<string, { id: string; title: string } | null>>({});
	$effect(() => {
		const items = recentMedia;
		void (async () => {
			const map: Record<string, { id: string; title: string } | null> = {};
			for (const item of items) {
				const url = publicUrlFor(item.file_path);
				const parent = notes.allNotes.find((n) => n.content?.includes(url));
				map[item.id] = parent ? { id: parent.id, title: parent.title || 'Untitled' } : null;
			}
			mediaParents = map;
		})();
	});

	const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

	function mediaClick(item: LocalAttachment) {
		const parent = mediaParents[item.id];
		if (parent) notes.select(parent.id);
		else window.open(publicUrlFor(item.file_path), '_blank', 'noopener');
	}

	function fileName(path: string): string {
		return path.split('/').pop() ?? path;
	}

	function relTime(iso?: string): string {
		if (!iso) return '';
		const diff = Date.now() - Date.parse(iso);
		const mins = Math.round(diff / 60_000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hours = Math.round(mins / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.round(hours / 24);
		if (days < 31) return `${days}d ago`;
		return new Date(iso).toLocaleDateString();
	}
</script>

<div class="dashboard">
	<!-- Quick Post -->
	<section class="widget quick-post">
		<header><Zap size={15} /> Quick Post</header>
		<input
			id="qp-title-input"
			name="qp-title"
			type="text"
			class="qp-title"
			placeholder="Title (optional — timestamped if blank)"
			bind:value={qpTitle}
			onkeydown={(e) => {
				if (e.key === 'Enter') void fastCapture();
			}}
		/>
		<textarea
			id="qp-body-input"
			name="qp-body"
			class="qp-body"
			rows="4"
			placeholder="What needs capturing?"
			bind:value={qpBody}
			onkeydown={(e) => {
				if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void fastCapture();
			}}
		></textarea>
		<div class="qp-row">
			<input
				id="qp-tags-input"
				name="qp-tags"
				type="text"
				class="qp-tags"
				placeholder="Tags: status:planning topic:Travel"
				bind:value={qpTags}
				list="qp-tag-suggestions"
			/>
			<datalist id="qp-tag-suggestions">
				{#each tagSuggestions as token (token)}<option value={token}></option>{/each}
			</datalist>
			<button
				class="qp-mic"
				class:recording={voiceState === 'recording'}
				onclick={() => void toggleVoice()}
				disabled={voiceState === 'transcribing' || capturing}
				title={voiceState === 'recording' ? 'Stop recording' : 'Record a voice note'}
			>
				{#if voiceState === 'recording'}
					<Square size={14} /> {String(Math.floor(elapsedSec / 60)).padStart(2, '0')}:{String(
						elapsedSec % 60
					).padStart(2, '0')}
				{:else if voiceState === 'transcribing'}
					<Loader2 size={14} class="spin" /> Transcribing…
				{:else}
					<Mic size={14} />
				{/if}
			</button>
			{#if voiceState === 'recording'}
				<button class="qp-mic-cancel" onclick={cancelVoice} title="Cancel recording">Cancel</button>
			{/if}
			<button class="qp-capture" onclick={() => void fastCapture()} disabled={capturing}>
				⚡ Fast Capture
			</button>
		</div>
		{#if pendingAudioFile && voiceState === 'idle'}
			<p class="qp-audio-hint">🎤 Voice recording will attach to this note</p>
		{/if}
		{#if voiceError}
			<p class="qp-voice-error">{voiceError}</p>
		{/if}
		{#if captured}
			<div class="qp-success">✓ Captured to Inbox</div>
		{/if}
	</section>

	<!-- Recent Notes -->
	<section class="widget">
		<header><PlusSquare size={15} /> Recent Notes</header>
		{#if recentNotes.length === 0}
			<p class="widget-empty">Nothing yet.</p>
		{:else}
			<ul class="feed">
				{#each recentNotes as n (n.id)}
					<li>
						<button class="feed-item" onclick={() => notes.select(n.id)}>
							<FileText size={13} />
							<span class="feed-title">{n.title || 'Untitled'}</span>
							<span class="feed-when">{relTime(n.created_at)}</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<!-- Recent Edits -->
	<section class="widget">
		<header><Clock size={15} /> Recent Edits</header>
		{#if recentEdits.length === 0}
			<p class="widget-empty">Nothing yet.</p>
		{:else}
			<ul class="feed">
				{#each recentEdits as n (n.id)}
					<li>
						<button class="feed-item" onclick={() => notes.select(n.id)}>
							<FileText size={13} />
							<span class="feed-title">{n.title || 'Untitled'}</span>
							<span class="feed-when">{relTime(n.updated_at)}</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<!-- Recent Media -->
	<section class="widget media-widget">
		<header><ImageIcon size={15} /> Recent Media</header>
		{#if recentMedia.length === 0}
			<p class="widget-empty">No uploads yet.</p>
		{:else}
			<div class="media-strip">
				{#each recentMedia as item (item.id)}
					<button
						class="media-card"
						onclick={() => mediaClick(item)}
						title={mediaParents[item.id]
							? `Open “${mediaParents[item.id]?.title}”`
							: 'Open file'}
					>
						{#if IMAGE_EXT.test(item.file_path)}
							<img src={publicUrlFor(item.file_path)} alt={item.alt_text || fileName(item.file_path)} loading="lazy" />
						{:else}
							<span class="media-file"><FileText size={22} /></span>
						{/if}
						<span class="media-hover">
							<span class="media-hover-name">{item.description || fileName(item.file_path)}</span>
							<span class="media-hover-note">
								{mediaParents[item.id] ? `in ${mediaParents[item.id]?.title}` : relTime(item.created_at)}
							</span>
						</span>
					</button>
				{/each}
			</div>
		{/if}
	</section>
</div>

<style>
	.dashboard {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
		max-width: 56rem;
		margin: 0 auto;
	}

	.widget {
		background: #ffffff;
		border: 1px solid #e2e4e8;
		border-radius: 10px;
		padding: 1rem 1.125rem;
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		min-width: 0;
	}

	.widget header {
		display: flex;
		align-items: center;
		gap: 0.4375rem;
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: #00361f;
	}

	.widget header :global(svg) {
		color: #c66930;
	}

	.widget-empty {
		margin: 0;
		font-size: 0.8125rem;
		color: #99a;
	}

	/* Quick Post spans the full width, WordPress-style */
	.quick-post {
		grid-column: 1 / -1;
		position: relative;
	}

	.qp-title {
		border: 1px solid #cfd3da;
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		font: inherit;
		font-size: 1rem;
		font-weight: 600;
		outline: none;
	}

	.qp-title:focus,
	.qp-body:focus,
	.qp-tags:focus {
		border-color: #c66930;
	}

	.qp-body {
		border: 1px solid #cfd3da;
		border-radius: 6px;
		padding: 0.5rem 0.75rem;
		font: inherit;
		font-size: 0.9375rem;
		line-height: 1.5;
		resize: vertical;
		outline: none;
	}

	.qp-row {
		display: flex;
		gap: 0.625rem;
		align-items: center;
	}

	.qp-tags {
		flex: 1;
		min-width: 0;
		border: 1px dashed #cfd3da;
		border-radius: 6px;
		padding: 0.4375rem 0.75rem;
		font: inherit;
		font-size: 0.8125rem;
		outline: none;
	}

	.qp-capture {
		flex: none;
		border: none;
		border-radius: 6px;
		background: #00361f;
		color: #ffffff;
		font: inherit;
		font-size: 0.9375rem;
		font-weight: 700;
		padding: 0.5rem 1.125rem;
		cursor: pointer;
		transition: background 0.15s ease;
	}

	.qp-capture:hover:not(:disabled) {
		background: #c66930;
	}

	.qp-capture:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.qp-mic {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		border: 1px solid #cfd3da;
		border-radius: 6px;
		background: #ffffff;
		color: #00361f;
		font: inherit;
		font-size: 0.8125rem;
		font-weight: 600;
		padding: 0.5rem 0.75rem;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.qp-mic:hover:not(:disabled) {
		border-color: #c66930;
		color: #c66930;
	}

	.qp-mic:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.qp-mic.recording {
		border-color: #d64545;
		color: #d64545;
		background: rgba(214, 69, 69, 0.06);
		animation: pulse-recording 1.6s ease-in-out infinite;
	}

	@keyframes pulse-recording {
		0%,
		100% {
			box-shadow: 0 0 0 0 rgba(214, 69, 69, 0.25);
		}
		50% {
			box-shadow: 0 0 0 4px rgba(214, 69, 69, 0.12);
		}
	}

	.qp-mic :global(.spin) {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	.qp-mic-cancel {
		flex: none;
		border: none;
		background: none;
		color: #99a;
		font: inherit;
		font-size: 0.75rem;
		text-decoration: underline;
		cursor: pointer;
		padding: 0 0.25rem;
	}

	.qp-mic-cancel:hover {
		color: #d64545;
	}

	.qp-audio-hint,
	.qp-voice-error {
		margin: -0.25rem 0 0;
		font-size: 0.75rem;
	}

	.qp-audio-hint {
		color: #667;
	}

	.qp-voice-error {
		color: #d64545;
	}

	.qp-success {
		position: absolute;
		top: 0.875rem;
		right: 1.125rem;
		font-size: 0.8125rem;
		font-weight: 600;
		color: #0ca678;
		animation: fade-out 2.2s ease forwards;
	}

	@keyframes fade-out {
		0% {
			opacity: 0;
			transform: translateY(2px);
		}
		15% {
			opacity: 1;
			transform: translateY(0);
		}
		70% {
			opacity: 1;
		}
		100% {
			opacity: 0;
		}
	}

	.feed {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}

	.feed-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		border: none;
		background: none;
		padding: 0.375rem 0.375rem;
		border-radius: 6px;
		font: inherit;
		text-align: left;
		cursor: pointer;
		color: #1d2129;
		min-width: 0;
	}

	.feed-item:hover {
		background: #f5f6f8;
	}

	.feed-item :global(svg) {
		flex: none;
		color: #99a;
	}

	.feed-title {
		flex: 1;
		min-width: 0;
		font-size: 0.875rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.feed-when {
		flex: none;
		font-size: 0.6875rem;
		color: #99a;
	}

	.media-widget {
		grid-column: 1 / -1;
	}

	.media-strip {
		display: flex;
		gap: 0.75rem;
		overflow-x: auto;
		padding-bottom: 0.25rem;
	}

	.media-card {
		position: relative;
		flex: none;
		width: 6.5rem;
		height: 6.5rem;
		border: 1px solid #e2e4e8;
		border-radius: 8px;
		overflow: hidden;
		padding: 0;
		background: #f0f2f5;
		cursor: pointer;
	}

	.media-card:hover {
		border-color: #c66930;
	}

	.media-card img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}

	.media-file {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #99a;
	}

	.media-hover {
		position: absolute;
		inset: auto 0 0 0;
		background: rgba(0, 0, 0, 0.72);
		color: #ffffff;
		padding: 0.3125rem 0.4375rem;
		display: none;
		flex-direction: column;
		gap: 0.0625rem;
		text-align: left;
	}

	.media-card:hover .media-hover {
		display: flex;
	}

	.media-hover-name {
		font-size: 0.625rem;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.media-hover-note {
		font-size: 0.5625rem;
		color: rgba(255, 255, 255, 0.75);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@media (max-width: 768px) {
		.dashboard {
			grid-template-columns: 1fr;
		}
	}
</style>

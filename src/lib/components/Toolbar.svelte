<script lang="ts">
	import { notes } from '$lib/notes.svelte';
	import { exportJson, importJson, exportMarkdown, importMarkdown, exportOrganiserJson, importOrganiserJson } from '$lib/importExport';
	import TagManager from '$lib/components/TagManager.svelte';
	import MediaManager from '$lib/components/MediaManager.svelte';
	import { Eye, EyeOff, Sparkles } from 'lucide-svelte';

	let tagManagerOpen = $state(false);
	let mediaManagerOpen = $state(false);

	const currentNoteType = $derived.by(() => {
		if (!notes.selected) return 'text';
		const attrs = notes.getAttributes(notes.selected.id);
		const nt = attrs.find((a) => a.type === 'label' && a.key === 'noteType')?.value;
		return nt || 'text';
	});

	const hasPdfAttachment = $derived.by(() => {
		if (!notes.selected) return false;
		return /href="([^"]+\.pdf[^"]*)"/i.test(notes.selected.content || '');
	});

	async function setNoteType(type: string) {
		if (!notes.selected) return;
		const attrs = notes.getAttributes(notes.selected.id);
		const existing = attrs.find((a) => a.type === 'label' && a.key === 'noteType');

		if (type === 'text') {
			if (existing) {
				await notes.removeAttribute(existing.id);
			}
		} else {
			if (existing) {
				await notes.updateAttribute(existing.id, { value: type });
			} else {
				await notes.addAttribute(notes.selected.id, { type: 'label', key: 'noteType', value: type });
			}
		}
	}

	async function saveSearchAsFolder() {
		const q = notes.searchQuery.trim();
		if (!q.startsWith('#')) return;
		const id = await notes.createNote(null);
		await notes.updateNote(id, { title: q });
		await notes.addAttribute(id, { type: 'label', key: 'noteType', value: 'search' });
		await notes.addAttribute(id, { type: 'label', key: 'query', value: q });
		notes.searchQuery = '';
		flash('Saved as a live search folder');
	}

	let menuOpen = $state(false);
	let status = $state('');
	let busy = $state(false);
	let jsonInput: HTMLInputElement;
	let organiserJsonInput: HTMLInputElement;
	let mdInput: HTMLInputElement;
	let showApiKey = $state(false);

	function flash(message: string) {
		status = message;
		setTimeout(() => (status = ''), 5000);
	}

	// The isShared=true label is what authorizes /share/[id] server-side.
	const shareFlag = $derived(
		notes.selected
			? notes.getAttributes(notes.selected.id).find(
					(attr) => attr.type === 'label' && attr.key === 'isShared' && attr.value === 'true'
				)
			: undefined
	);

	function shareUrl(): string {
		return `${location.origin}/share/${notes.selected!.id}`;
	}

	async function copyShareLink() {
		await navigator.clipboard.writeText(shareUrl());
		flash('Public link copied');
	}

	async function startSharing() {
		if (!notes.selected) return;
		menuOpen = false;
		await notes.addAttribute(notes.selected.id, { type: 'label', key: 'isShared', value: 'true' });
		await copyShareLink();
		flash('Note is now public — link copied (live after next sync)');
	}

	async function stopSharing() {
		if (!shareFlag) return;
		menuOpen = false;
		await notes.removeAttribute(shareFlag.id);
		flash('Sharing stopped (public link disabled after next sync)');
	}

	async function run(action: () => Promise<string> | string) {
		menuOpen = false;
		busy = true;
		try {
			flash(await action());
		} catch (error) {
			alert(error instanceof Error ? error.message : String(error));
		} finally {
			busy = false;
		}
	}

	async function onJsonChosen() {
		const file = jsonInput.files?.[0];
		jsonInput.value = '';
		if (!file) return;
		if (!confirm(`Import “${file.name}”? Notes with matching ids will be overwritten.`)) return;
		await run(() => importJson(file));
	}

	async function onOrganiserJsonChosen() {
		const file = organiserJsonInput.files?.[0];
		organiserJsonInput.value = '';
		if (!file) return;
		if (!confirm(`Import “${file.name}” in Organiser format? New notes will be created.`)) return;
		await run(() => importOrganiserJson(file));
	}

	async function onMdChosen() {
		const files = mdInput.files;
		if (files?.length) await run(() => importMarkdown(files));
		mdInput.value = '';
	}

	// Close the menu on any click outside it.
	$effect(() => {
		if (!menuOpen) return;
		const handle = (event: MouseEvent) => {
			if (!(event.target as HTMLElement).closest('.settings-container')) menuOpen = false;
		};
		document.addEventListener('click', handle);
		return () => document.removeEventListener('click', handle);
	});

	let aiOpen = $state(false);
	let chatMessages = $state<{ role: 'user' | 'assistant', content: string }[]>([
		{ role: 'assistant', content: 'Hello! I am your global Wiki AI assistant. I can search, summarise, and answer questions across all your notes.' }
	]);
	let aiPrompt = $state('');
	let isGenerating = $state(false);
	let chatContainerEl = $state<HTMLDivElement>();

	$effect(() => {
		if (!aiOpen) return;
		const handle = (event: MouseEvent) => {
			if (!(event.target as HTMLElement).closest('.global-ai-container')) aiOpen = false;
		};
		document.addEventListener('click', handle);
		return () => document.removeEventListener('click', handle);
	});

	function handlePromptKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void sendPrompt();
		}
	}

	function stripHtml(html: string): string {
		if (typeof document === 'undefined') return '';
		const doc = new DOMParser().parseFromString(html, 'text/html');
		return doc.body.textContent || '';
	}

	async function sendPrompt() {
		const promptText = aiPrompt.trim();
		if (!promptText || isGenerating) return;

		chatMessages.push({ role: 'user', content: promptText });
		aiPrompt = '';
		isGenerating = true;

		setTimeout(scrollToBottom, 50);

		// Prepare history mapped for Gemini API structure
		const geminiHistory = chatMessages.map(msg => ({
			role: msg.role === 'user' ? 'user' : 'model',
			parts: [{ text: msg.content }]
		}));

		// Inject workspace context (notes count & titles) so the AI knows about all notes
		const count = notes.allNotes.length;
		const titles = notes.allNotes.map(n => `“${n.title || 'Untitled'}”`).join(", ");
		const contextPrompt = `Workspace context:\n- Total Notes: ${count}\n- Notes in workspace: ${titles}\n\nUser Question: ${promptText}`;
		
		// Update the last user message in the history with the context
		if (geminiHistory.length > 0 && geminiHistory[geminiHistory.length - 1].role === 'user') {
			geminiHistory[geminiHistory.length - 1].parts[0].text = contextPrompt;
		}

		try {
			const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=${notes.apiKey}`;
			
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					systemInstruction: {
						parts: [{ text: notes.systemPrompt }]
					},
					contents: geminiHistory
				})
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(errorText || `HTTP ${response.status}`);
			}

			const reader = response.body?.getReader();
			if (!reader) throw new Error("No response body reader.");

			const decoder = new TextDecoder();
			let buffer = '';

			chatMessages.push({ role: 'assistant', content: '' });
			const lastIdx = chatMessages.length - 1;

			let braceCount = 0;
			let startIdx = -1;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				for (let i = 0; i < buffer.length; i++) {
					if (buffer[i] === '{') {
						if (braceCount === 0) startIdx = i;
						braceCount++;
					} else if (buffer[i] === '}') {
						braceCount--;
						if (braceCount === 0 && startIdx !== -1) {
							const jsonStr = buffer.substring(startIdx, i + 1);
							try {
								const obj = JSON.parse(jsonStr);
								const text = obj.candidates?.[0]?.content?.parts?.[0]?.text;
								if (text) {
									chatMessages[lastIdx].content += text;
									scrollToBottom();
								}
							} catch (e) {
								// Ignored
							}
							buffer = buffer.substring(i + 1);
							i = -1;
							startIdx = -1;
						}
					}
				}
			}
		} catch (err: any) {
			console.error(err);
			chatMessages.push({ role: 'assistant', content: `Error: ${err.message || err}` });
		} finally {
			isGenerating = false;
			scrollToBottom();
		}
	}

	function scrollToBottom() {
		if (chatContainerEl) {
			chatContainerEl.scrollTop = chatContainerEl.scrollHeight;
		}
	}

	let searchFocused = $state(false);
</script>

<header class="toolbar">
	<button
		class="sidebar-toggle"
		onclick={() => notes.sidebarOpen = !notes.sidebarOpen}
		aria-label="Toggle sidebar"
	>
		<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<line x1="3" y1="12" x2="21" y2="12"></line>
			<line x1="3" y1="6" x2="21" y2="6"></line>
			<line x1="3" y1="18" x2="21" y2="18"></line>
		</svg>
	</button>
	<button class="brand" onclick={() => notes.goToDashboard()} title="Go to dashboard">Personal Wiki</button>

	<div class="search-container">
		<div class="search">
			<input
				id="global-search-input"
				name="search"
				type="text"
				placeholder="Search notes..."
				value={notes.searchQuery}
				oninput={(e) => (notes.searchQuery = e.currentTarget.value)}
				onfocus={() => searchFocused = true}
				onblur={() => setTimeout(() => searchFocused = false, 200)}
			/>
			{#if notes.searchQuery}
				<button class="clear" onclick={() => (notes.searchQuery = '')} aria-label="Clear search">
					×
				</button>
			{/if}
		</div>
		{#if searchFocused}
			<div class="search-shortcuts-dropdown">
				<div class="shortcut-header">Advanced Search Filters</div>
				<button class="shortcut-item" onmousedown={(e) => { e.preventDefault(); notes.searchQuery = '#'; }}>
					<span class="prefix">#</span>
					<span class="desc">Filter by label (e.g. <code>#topic:Travel</code>)</span>
				</button>
				<button class="shortcut-item" onmousedown={(e) => { e.preventDefault(); notes.searchQuery = ':webview'; }}>
					<span class="prefix">:</span>
					<span class="desc">Filter by note type (e.g. <code>:webview</code>)</span>
				</button>
				{#if notes.searchQuery.trim().startsWith('#')}
					<button class="shortcut-item save-search" onmousedown={(e) => { e.preventDefault(); void saveSearchAsFolder(); }}>
						<span class="prefix">💾</span>
						<span class="desc">Save <code>{notes.searchQuery.trim()}</code> as a live search folder</span>
					</button>
				{/if}
			</div>
		{/if}
	</div>

	{#if notes.selected}
		<div class="view-mode-selector">
			<label for="view-mode-select">View:</label>
			<select
				id="view-mode-select"
				value={currentNoteType}
				onchange={(e) => setNoteType(e.currentTarget.value)}
			>
				<option value="text">Rich Text</option>
				{#if hasPdfAttachment || currentNoteType === 'pdf'}
					<option value="pdf">PDF Viewer</option>
				{/if}
				<option value="webview">Web View</option>
				<option value="search">Saved Search</option>
			</select>
		</div>
	{/if}

	<div class="spacer"></div>

	{#if status}<span class="status">{status}</span>{/if}

	<button class="media-btn" onclick={() => (mediaManagerOpen = true)} title="Media Library Manager">
		<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
			<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
			<circle cx="8.5" cy="8.5" r="1.5"></circle>
			<polyline points="21 15 16 10 5 21"></polyline>
		</svg>
		<span class="btn-text">Media</span>
	</button>

	<div class="global-ai-container">
		<button class="global-ai-btn" onclick={() => aiOpen = !aiOpen} title="Global AI Assistant">
			<Sparkles size={14} />
			<span class="btn-text">AI Assistant</span>
		</button>
		{#if aiOpen}
			<div class="global-ai-dropdown">
				{#if !notes.apiKey}
					<div class="ai-key-alert">
						<Sparkles size={18} class="alert-icon" />
						<p class="alert-text">To begin, please add your <strong>Gemini API Key</strong> in the Settings menu (top right of the window).</p>
					</div>
				{:else}
					<div class="global-ai-chat">
						<div class="chat-header">
							<Sparkles size={12} style="color: #c66930;" />
							<span>GLOBAL WIKI ASSISTANT</span>
						</div>
						<div class="chat-messages" bind:this={chatContainerEl}>
							{#each chatMessages as msg}
								<div class="chat-message {msg.role}">
									<div class="message-bubble">
										{msg.content}
									</div>
								</div>
							{/each}
							{#if isGenerating}
								<div class="chat-message assistant generating">
									<div class="message-bubble pulse">
										<span>Generating...</span>
									</div>
								</div>
							{/if}
						</div>
						<div class="chat-input-wrapper">
							<textarea
								id="ai-prompt-input"
								name="ai-prompt"
								placeholder="Ask about all notes..."
								bind:value={aiPrompt}
								onkeydown={handlePromptKeydown}
								disabled={isGenerating}
								rows="2"
							></textarea>
							<button class="send-btn" onclick={sendPrompt} disabled={isGenerating || !aiPrompt.trim()}>
								Send
							</button>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</div>

	<div class="settings-container">
		<button class="settings-btn" disabled={busy} onclick={() => (menuOpen = !menuOpen)}>
			<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="12" cy="12" r="3"></circle>
				<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1-2-2 2 2 0 0 1 2-2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
			</svg>
			<span class="btn-text">Settings</span>
		</button>
		{#if menuOpen}
			<div class="dropdown">
				<span class="section">Sharing</span>
				{#if !notes.selected}
					<button disabled>Select a note to share</button>
				{:else if shareFlag}
					<button onclick={() => { menuOpen = false; void copyShareLink(); }}>
						Copy public link
					</button>
					<button onclick={() => void stopSharing()}>Stop sharing this note</button>
				{:else}
					<button onclick={() => void startSharing()}>Share note publicly</button>
				{/if}
				<span class="section">Transfer</span>
				<button onclick={() => void run(exportJson)}>Export Wiki Backup JSON</button>
				<button onclick={() => { menuOpen = false; jsonInput.click(); }}>Import Wiki Backup JSON…</button>
				<button onclick={() => void run(exportOrganiserJson)}>Export Organiser JSON</button>
				<button onclick={() => { menuOpen = false; organiserJsonInput.click(); }}>Import Organiser JSON…</button>
				<button
					disabled={!notes.selected}
					onclick={() => void run(() => exportMarkdown(notes.selected!))}
				>
					Export note as Markdown
				</button>
				<button onclick={() => { menuOpen = false; mdInput.click(); }}>Import Markdown…</button>
				
				<span class="section">Maintenance</span>
				<button onclick={() => { menuOpen = false; tagManagerOpen = true; }}>Tag Manager…</button>
				<button onclick={() => { menuOpen = false; mediaManagerOpen = true; }}>Media Library…</button>

				<span class="section">AI Integration</span>
				<div class="ai-key-section">
					<label for="gemini-key-input">Gemini API Key</label>
					<div class="key-input-wrapper">
						<input
							id="gemini-key-input"
							type={showApiKey ? "text" : "password"}
							placeholder="Enter API Key..."
							value={notes.apiKey}
							oninput={(e) => notes.apiKey = e.currentTarget.value}
						/>
						<button 
							type="button" 
							class="eye-btn" 
							onclick={() => showApiKey = !showApiKey} 
							title={showApiKey ? "Hide Key" : "Show Key"}
						>
							{#if showApiKey}
								<EyeOff size={14} />
							{:else}
								<Eye size={14} />
							{/if}
						</button>
					</div>

					<label for="gemini-prompt-input" style="margin-top: 8px;">AI Training Instructions</label>
					<textarea
						id="gemini-prompt-input"
						class="prompt-textarea"
						placeholder="E.g. use Australian regional spelling, metric measures, and learn my voice tone."
						value={notes.systemPrompt}
						oninput={(e) => notes.systemPrompt = e.currentTarget.value}
						rows="3"
					></textarea>
				</div>
			</div>
		{/if}
	</div>

	{#if tagManagerOpen}
		<TagManager onclose={() => (tagManagerOpen = false)} />
	{/if}
	{#if mediaManagerOpen}
		<MediaManager onclose={() => (mediaManagerOpen = false)} />
	{/if}

	<input type="file" accept=".json,application/json" hidden bind:this={jsonInput} onchange={onJsonChosen} />
	<input type="file" accept=".json,application/json" hidden bind:this={organiserJsonInput} onchange={onOrganiserJsonChosen} />
	<input type="file" accept=".md,.markdown,.txt" multiple hidden bind:this={mdInput} onchange={onMdChosen} />
</header>

<style>
	.toolbar {
		display: flex;
		align-items: center;
		gap: 1rem;
		height: 48px;
		padding: 0 1rem;
		background: #003924;
		color: #ffffff;
		border-bottom: 1px solid rgba(255, 255, 255, 0.12);
		flex: none;
	}

	.brand {
		border: none;
		background: none;
		padding: 0;
		font: inherit;
		font-weight: 700;
		font-size: 1.125rem;
		color: #c66930;
		white-space: nowrap;
		cursor: pointer;
		transition: color 0.15s ease;
	}

	.brand:hover {
		color: #ffffff;
	}

	.search {
		position: relative;
		display: flex;
		align-items: center;
		width: min(24rem, 40vw);
	}

	.search input {
		width: 100%;
		border: 1px solid rgba(255, 255, 255, 0.2);
		background: rgba(255, 255, 255, 0.08);
		border-radius: 6px;
		padding: 0.375rem 1.75rem 0.375rem 0.625rem;
		font: inherit;
		font-size: 0.8125rem;
		color: #ffffff;
		outline: none;
		transition: all 0.2s ease;
	}

	.search input::placeholder {
		color: rgba(255, 255, 255, 0.4);
	}

	.search input:focus {
		border-color: rgba(255, 255, 255, 0.5);
		background: rgba(255, 255, 255, 0.12);
	}

	.clear {
		position: absolute;
		right: 0.5rem;
		border: none;
		background: none;
		color: rgba(255, 255, 255, 0.5);
		cursor: pointer;
		font-size: 1rem;
		padding: 0;
		line-height: 1;
	}

	.clear:hover {
		color: #ffffff;
	}

	.spacer {
		flex: 1;
	}

	.status {
		font-size: 0.75rem;
		color: rgba(255, 255, 255, 0.85);
		background: rgba(255, 255, 255, 0.1);
		border-radius: 4px;
		padding: 0.25rem 0.625rem;
		white-space: nowrap;
	}

	.settings-container {
		position: relative;
	}

	.settings-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		border: 1px solid rgba(255, 255, 255, 0.3);
		background: rgba(255, 255, 255, 0.1);
		color: #ffffff;
		border-radius: 6px;
		padding: 0.3125rem 0.75rem;
		font: inherit;
		font-size: 0.8125rem;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.settings-btn:hover {
		background: #ffffff;
		color: #003924;
		border-color: #ffffff;
	}

	.settings-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.dropdown {
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 6px;
		background: #ffffff;
		border: 1px solid #e2e4e8;
		border-radius: 6px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		z-index: 200;
		min-width: 210px;
		padding: 4px 0;
		display: flex;
		flex-direction: column;
	}

	.section {
		padding: 4px 12px 2px;
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: #99a;
	}

	.dropdown button {
		border: none;
		background: none;
		text-align: left;
		padding: 7px 12px;
		font: inherit;
		font-size: 0.8125rem;
		color: #1d2129;
		cursor: pointer;
	}

	.dropdown button:hover:not(:disabled) {
		background: #f0f2f5;
	}

	.dropdown button:disabled {
		color: #aab;
		cursor: default;
	}

	.ai-key-section {
		padding: 6px 12px 10px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		border-top: 1px solid #f0f2f5;
		margin-top: 4px;
	}

	.ai-key-section label {
		font-size: 0.6875rem;
		font-weight: 600;
		color: #99a;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		margin-bottom: 2px;
		display: block;
	}

	.prompt-textarea {
		width: 100%;
		border: 1px solid #cfd3da;
		border-radius: 4px;
		background: #ffffff;
		font-family: inherit;
		font-size: 0.75rem;
		padding: 5px 8px;
		resize: vertical;
		color: #1d2129;
		box-sizing: border-box;
	}

	.prompt-textarea:focus {
		outline: none;
		border-color: #c66930;
	}

	.key-input-wrapper {
		display: flex;
		align-items: center;
		border: 1px solid #cfd3da;
		border-radius: 4px;
		overflow: hidden;
		background: #ffffff;
	}

	.key-input-wrapper input {
		flex: 1;
		border: none;
		background: none;
		font-size: 0.75rem;
		padding: 5px 8px;
		min-width: 0;
		color: #1d2129;
	}

	.key-input-wrapper input:focus {
		outline: none;
		border-color: #c66930;
	}

	.eye-btn {
		border: none !important;
		background: none !important;
		padding: 5px 8px !important;
		color: #6c737f !important;
		cursor: pointer !important;
		display: inline-flex !important;
		align-items: center !important;
		justify-content: center !important;
		border-left: 1px solid #cfd3da !important;
		border-radius: 0 !important;
	}

	.eye-btn:hover {
		color: #c66930 !important;
		background: #fffbf9 !important;
	}

	.media-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		border: 1px solid rgba(255, 255, 255, 0.3);
		background: rgba(255, 255, 255, 0.1);
		color: #ffffff;
		border-radius: 6px;
		padding: 0.3125rem 0.75rem;
		font: inherit;
		font-size: 0.8125rem;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.media-btn:hover {
		background: #ffffff;
		color: #003924;
		border-color: #ffffff;
	}

	.global-ai-container {
		position: relative;
	}

	.global-ai-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		border: 1px solid rgba(255, 255, 255, 0.3);
		background: rgba(255, 255, 255, 0.1);
		color: #ffffff;
		border-radius: 6px;
		padding: 0.3125rem 0.75rem;
		font: inherit;
		font-size: 0.8125rem;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.global-ai-btn:hover {
		background: #ffffff;
		color: #003924;
		border-color: #ffffff;
	}

	.global-ai-btn :global(svg) {
		color: #c66930;
	}
	
	.global-ai-btn:hover :global(svg) {
		color: #c66930;
	}

	.global-ai-dropdown {
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 6px;
		background: #ffffff;
		border: 1px solid #e2e4e8;
		border-radius: 6px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		z-index: 2000;
		width: 300px;
		padding: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.global-ai-chat {
		display: flex;
		flex-direction: column;
		background: #ffffff;
		border: 1px solid #e2e4e8;
		border-radius: 6px;
		overflow: hidden;
		max-height: 400px;
	}

	.chat-header {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		background: #fafafa;
		border-bottom: 1px solid #e2e4e8;
		padding: 6px 10px;
		font-size: 0.6875rem;
		font-weight: 700;
		color: #889;
		letter-spacing: 0.05em;
	}

	.global-ai-chat .chat-messages {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.75rem;
		overflow-y: auto;
		height: 200px;
		background: #fafafa;
	}

	.global-ai-chat .chat-message {
		display: flex;
		width: 100%;
	}

	.global-ai-chat .chat-message.user {
		justify-content: flex-end;
	}

	.global-ai-chat .chat-message.assistant {
		justify-content: flex-start;
	}

	.global-ai-chat .message-bubble {
		max-width: 90%;
		padding: 6px 10px;
		font-size: 0.75rem;
		line-height: 1.4;
		border-radius: 8px;
		white-space: pre-wrap;
		box-sizing: border-box;
	}

	.global-ai-chat .chat-message.user .message-bubble {
		background: #c66930;
		color: #ffffff;
		border-bottom-right-radius: 2px;
	}

	.global-ai-chat .chat-message.assistant .message-bubble {
		background: #f1f2f4;
		color: #1d2129;
		border-bottom-left-radius: 2px;
	}

	.global-ai-chat .chat-message.assistant.generating .message-bubble {
		color: #8b929e;
		background: #f8f9fa;
		border: 1px dashed #cfd3da;
	}

	.global-ai-chat .chat-input-wrapper {
		display: flex;
		align-items: stretch;
		border-top: 1px solid #e2e4e8;
		background: #ffffff;
	}

	.global-ai-chat .chat-input-wrapper textarea {
		flex: 1;
		border: none;
		background: none;
		resize: none;
		padding: 6px 8px;
		font-family: inherit;
		font-size: 0.75rem;
		line-height: 1.4;
		color: #1d2129;
	}

	.global-ai-chat .chat-input-wrapper textarea:focus {
		outline: none;
	}

	.global-ai-chat .chat-input-wrapper textarea:disabled {
		background: #f8f9fa;
		color: #8b929e;
	}

	.global-ai-chat .chat-input-wrapper .send-btn {
		border: none;
		border-left: 1px solid #e2e4e8;
		background: #ffffff;
		padding: 0 8px;
		font-size: 0.75rem;
		font-weight: 600;
		color: #c66930;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.global-ai-chat .chat-input-wrapper .send-btn:hover:not(:disabled) {
		background: rgba(198, 105, 48, 0.05);
	}

	.global-ai-chat .chat-input-wrapper .send-btn:disabled {
		color: #8b929e;
		cursor: not-allowed;
	}

	.search-container {
		position: relative;
		display: flex;
		flex-direction: column;
	}

	.search-shortcuts-dropdown {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		margin-top: 4px;
		background: #ffffff;
		border: 1px solid #e2e4e8;
		border-radius: 6px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		z-index: 1500;
		padding: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		width: 250px;
	}

	.shortcut-header {
		font-size: 0.6875rem;
		font-weight: 700;
		color: #8b929e;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 4px 6px;
		border-bottom: 1px solid #f1f2f4;
		margin-bottom: 4px;
	}

	.shortcut-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: none;
		border: none;
		padding: 6px;
		border-radius: 4px;
		cursor: pointer;
		text-align: left;
		width: 100%;
		transition: background 0.15s ease;
	}

	.shortcut-item:hover {
		background: #f1f2f4;
	}

	.shortcut-item .prefix {
		font-size: 0.875rem;
		font-weight: bold;
		color: #c66930;
		background: rgba(198, 105, 48, 0.1);
		border-radius: 4px;
		width: 20px;
		height: 20px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.shortcut-item .desc {
		font-size: 0.75rem;
		color: #4c525d;
		line-height: 1.3;
	}

	.shortcut-item code {
		background: #f1f2f4;
		padding: 1px 3px;
		border-radius: 3px;
		font-family: monospace;
		color: #c66930;
	}

	.sidebar-toggle {
		display: none;
		background: none;
		border: none;
		color: #ffffff;
		cursor: pointer;
		padding: 0.25rem;
		align-items: center;
		justify-content: center;
	}

	.sidebar-toggle:hover {
		color: #c66930;
	}

	.view-mode-selector {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		color: rgba(255, 255, 255, 0.7);
		margin-left: 0.5rem;
		flex-shrink: 0;
	}

	.view-mode-selector label {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: rgba(255, 255, 255, 0.5);
	}

	.view-mode-selector select {
		background: rgba(255, 255, 255, 0.08);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 6px;
		color: #ffffff;
		padding: 0.25rem 0.5rem;
		font-size: 0.8125rem;
		outline: none;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.view-mode-selector select:hover {
		border-color: rgba(255, 255, 255, 0.4);
		background: rgba(255, 255, 255, 0.12);
	}

	.view-mode-selector select option {
		background: #003924;
		color: #ffffff;
	}

	@media (max-width: 768px) {
		.sidebar-toggle {
			display: flex;
		}

		.btn-text {
			display: none;
		}

		.toolbar {
			gap: 0.5rem;
			padding: 0 0.5rem;
		}

		.brand {
			font-size: 1rem;
		}

		.global-ai-btn,
		.settings-btn {
			padding: 0.3125rem;
			gap: 0;
			justify-content: center;
			min-width: 28px;
		}
	}
</style>

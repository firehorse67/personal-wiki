<script lang="ts">
	import { notes } from '$lib/notes.svelte';

	import type { LocalNote } from '$lib/db';

	let { journalNote }: { journalNote: any } = $props();

	let viewMode = $state<'calendar' | 'list'>('calendar');
	let currentYear = $state(new Date().getFullYear());
	let currentMonth = $state(new Date().getMonth());

	const monthNames = [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'
	];

	const childBranches = $derived(notes.childBranches(journalNote.id));
	const journalNotes = $derived(childBranches.map(b => notes.noteFor(b)).filter((n): n is LocalNote => !!n));

	function getNoteDateKey(title: string): string | null {
		const match = title.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
		if (!match) return null;
		const d = parseInt(match[1]);
		const m = parseInt(match[2]);
		let y = parseInt(match[3]);
		if (y < 100) y += 2000;
		return `${d}/${m}/${y}`;
	}

	const notesByDateKey = $derived.by(() => {
		const map = new Map<string, any[]>();
		for (const note of journalNotes) {
			if (note && note.title) {
				const key = getNoteDateKey(note.title);
				if (key) {
					const list = map.get(key) || [];
					list.push(note);
					map.set(key, list);
				}
			}
		}
		return map;
	});

	function getJournalTitleForDate(date: Date): string {
		const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
		const dayName = days[date.getDay()];
		const d = date.getDate();
		const m = date.getMonth() + 1;
		const y = String(date.getFullYear()).slice(-2);
		return `${dayName} ${d}/${m}/${y}`;
	}

	const calendarDays = $derived.by(() => {
		const days: { date: Date; isCurrentMonth: boolean; hasNote: boolean; noteId?: string }[] = [];
		const firstDay = new Date(currentYear, currentMonth, 1);
		const startDayOfWeek = firstDay.getDay();
		const numDays = new Date(currentYear, currentMonth + 1, 0).getDate();
		const prevMonthNumDays = new Date(currentYear, currentMonth, 0).getDate();

		for (let i = startDayOfWeek - 1; i >= 0; i--) {
			const date = new Date(currentYear, currentMonth - 1, prevMonthNumDays - i);
			const key = `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
			const matching = notesByDateKey.get(key);
			days.push({
				date,
				isCurrentMonth: false,
				hasNote: !!(matching && matching.length > 0),
				noteId: matching?.[0]?.id
			});
		}

		for (let i = 1; i <= numDays; i++) {
			const date = new Date(currentYear, currentMonth, i);
			const key = `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
			const matching = notesByDateKey.get(key);
			days.push({
				date,
				isCurrentMonth: true,
				hasNote: !!(matching && matching.length > 0),
				noteId: matching?.[0]?.id
			});
		}

		const totalCells = Math.ceil(days.length / 7) * 7;
		const nextDaysCount = totalCells - days.length;
		for (let i = 1; i <= nextDaysCount; i++) {
			const date = new Date(currentYear, currentMonth + 1, i);
			const key = `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
			const matching = notesByDateKey.get(key);
			days.push({
				date,
				isCurrentMonth: false,
				hasNote: !!(matching && matching.length > 0),
				noteId: matching?.[0]?.id
			});
		}

		return days;
	});

	const sortedJournalNotes = $derived.by(() => {
		const list = [...journalNotes].filter(Boolean);
		list.sort((a, b) => {
			const dateA = parseDateFromTitle(a.title);
			const dateB = parseDateFromTitle(b.title);
			return dateB.getTime() - dateA.getTime();
		});
		return list;
	});

	function parseDateFromTitle(title: string): Date {
		const match = title.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
		if (!match) return new Date(0);
		const d = parseInt(match[1]);
		const m = parseInt(match[2]) - 1;
		let y = parseInt(match[3]);
		if (y < 100) y += 2000;
		return new Date(y, m, d);
	}

	function prevMonth() {
		if (currentMonth === 0) {
			currentMonth = 11;
			currentYear -= 1;
		} else {
			currentMonth -= 1;
		}
	}

	function nextMonth() {
		if (currentMonth === 11) {
			currentMonth = 0;
			currentYear += 1;
		} else {
			currentMonth += 1;
		}
	}

	async function selectDay(day: { date: Date }) {
		const key = `${day.date.getDate()}/${day.date.getMonth() + 1}/${day.date.getFullYear()}`;
		const existing = notesByDateKey.get(key);
		if (existing && existing.length > 0) {
			notes.select(existing[0].id);
		} else {
			const titleStr = getJournalTitleForDate(day.date);
			const defaultTemplate = `<h2>Daily Log</h2><ul><li></li></ul>`;
			await notes.createJournalNote(journalNote.id, titleStr, defaultTemplate);
		}
	}

	async function createTodayEntry() {
		const today = new Date();
		const titleStr = getJournalTitleForDate(today);
		const defaultTemplate = `<h2>Daily Log</h2><ul><li></li></ul>`;
		
		const key = `${today.getDate()}/${today.getMonth() + 1}/${today.getFullYear()}`;
		const existing = notesByDateKey.get(key);
		if (existing && existing.length > 0) {
			notes.select(existing[0].id);
		} else {
			await notes.createJournalNote(journalNote.id, titleStr, defaultTemplate);
		}
	}

	function isToday(date: Date): boolean {
		const today = new Date();
		return date.getDate() === today.getDate() &&
			date.getMonth() === today.getMonth() &&
			date.getFullYear() === today.getFullYear();
	}

	function stripHtml(html: string): string {
		if (typeof document === 'undefined') return '';
		const doc = new DOMParser().parseFromString(html, 'text/html');
		return doc.body.textContent || '';
	}

	function getPreview(html: string): string {
		const text = stripHtml(html);
		if (text.length <= 180) return text;
		return text.slice(0, 180) + '…';
	}
</script>

<div class="journal-calendar-container">
	<div class="calendar-header">
		<div class="view-toggle">
			<button class="toggle-btn" class:active={viewMode === 'calendar'} onclick={() => viewMode = 'calendar'}>Calendar</button>
			<button class="toggle-btn" class:active={viewMode === 'list'} onclick={() => viewMode = 'list'}>List</button>
		</div>

		{#if viewMode === 'calendar'}
			<div class="month-navigation">
				<button class="nav-btn" onclick={prevMonth} aria-label="Previous Month">
					<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
						<polyline points="15 18 9 12 15 6"></polyline>
					</svg>
				</button>
				<h2 class="month-title">{monthNames[currentMonth]} {currentYear}</h2>
				<button class="nav-btn" onclick={nextMonth} aria-label="Next Month">
					<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
						<polyline points="9 18 15 12 9 6"></polyline>
					</svg>
				</button>
			</div>
		{:else}
			<h2 class="month-title">Journal Entries</h2>
		{/if}

		<button class="create-today-btn" onclick={createTodayEntry}>
			+ New Entry Today
		</button>
	</div>

	{#if viewMode === 'calendar'}
		<div class="calendar-grid">
			<div class="weekday-label">Sun</div>
			<div class="weekday-label">Mon</div>
			<div class="weekday-label">Tue</div>
			<div class="weekday-label">Wed</div>
			<div class="weekday-label">Thu</div>
			<div class="weekday-label">Fri</div>
			<div class="weekday-label">Sat</div>

			{#each calendarDays as day}
				{@const key = `${day.date.getDate()}/${day.date.getMonth() + 1}/${day.date.getFullYear()}`}
				{@const dayNotesList = notesByDateKey.get(key) || []}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div 
					class="calendar-cell" 
					class:inactive={!day.isCurrentMonth}
					class:today={isToday(day.date)}
					class:has-note={day.hasNote}
					onclick={() => selectDay(day)}
				>
					<div class="day-number">{day.date.getDate()}</div>
					
					{#if dayNotesList.length > 0}
						<div class="cell-entries">
							{#each dayNotesList as note}
								<button 
									class="entry-link" 
									onclick={(e) => { e.stopPropagation(); notes.select(note.id); }}
									title={note.title}
								>
									{note.title}
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<div class="list-view-container">
			{#if sortedJournalNotes.length === 0}
				<div class="empty-list">
					<p>No journal entries recorded yet.</p>
					<button class="create-today-btn" onclick={createTodayEntry}>Create First Entry</button>
				</div>
			{:else}
				<div class="entries-feed">
					{#each sortedJournalNotes as entry}
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div class="feed-item" onclick={() => notes.select(entry.id)}>
							<div class="feed-item-header">
								<h3 class="feed-item-title">{entry.title}</h3>
								<span class="feed-item-date">{new Date(entry.modified_at).toLocaleDateString()}</span>
							</div>
							<p class="feed-item-preview">
								{getPreview(entry.content || '') || 'No content yet.'}
							</p>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.journal-calendar-container {
		display: flex;
		flex-direction: column;
		height: 100%;
		padding: 2rem;
		box-sizing: border-box;
		background: #ffffff;
	}

	.calendar-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1.5rem;
		gap: 1.5rem;
	}

	.view-toggle {
		display: flex;
		background: #eceef2;
		border-radius: 6px;
		padding: 3px;
	}

	.toggle-btn {
		border: none;
		background: none;
		border-radius: 4px;
		padding: 6px 12px;
		font-size: 0.8125rem;
		font-weight: 500;
		color: #4c525d;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.toggle-btn.active {
		background: #ffffff;
		color: #1d2129;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
	}

	.month-navigation {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.month-title {
		margin: 0;
		font-family: inherit;
		font-size: 1.375rem;
		font-weight: 600;
		color: #1d2129;
		min-width: 150px;
		text-align: center;
	}

	.nav-btn {
		background: none;
		border: 1px solid #cfd3da;
		border-radius: 6px;
		width: 32px;
		height: 32px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		color: #4c525d;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.nav-btn:hover {
		border-color: #c66930;
		color: #c66930;
		background: rgba(198, 105, 48, 0.05);
	}

	.create-today-btn {
		background: #c66930;
		border: none;
		border-radius: 6px;
		padding: 8px 16px;
		font-size: 0.8125rem;
		font-weight: 600;
		color: #ffffff;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.create-today-btn:hover {
		background: #b25824;
		box-shadow: 0 2px 8px rgba(198, 105, 48, 0.25);
	}

	.calendar-grid {
		display: grid;
		grid-template-columns: repeat(7, 1fr);
		gap: 8px;
		flex: 1;
	}

	.weekday-label {
		text-align: center;
		font-weight: 600;
		font-size: 0.75rem;
		color: #8b929e;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding-bottom: 8px;
	}

	.calendar-cell {
		aspect-ratio: 1;
		background: #f8f9fa;
		border: 1px solid #e2e4e8;
		border-radius: 8px;
		padding: 8px;
		display: flex;
		flex-direction: column;
		justify-content: flex-start;
		cursor: pointer;
		position: relative;
		transition: all 0.2s ease;
		overflow: hidden;
	}

	.calendar-cell:hover {
		transform: translateY(-2px);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
		border-color: #c66930;
	}

	.calendar-cell.inactive {
		opacity: 0.4;
	}

	.calendar-cell.today {
		border-width: 2px;
		border-color: #c66930;
	}

	.calendar-cell.has-note {
		background: rgba(198, 105, 48, 0.02);
	}

	.day-number {
		font-size: 1rem;
		font-weight: 600;
		color: #2e3338;
		margin-bottom: 4px;
	}

	.calendar-cell.has-note .day-number {
		color: #c66930;
	}

	.cell-entries {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
		overflow-y: auto;
		max-height: calc(100% - 24px);
		padding-right: 2px;
	}

	.entry-link {
		background: #ffffff;
		border: 1px solid #e2e4e8;
		border-radius: 4px;
		padding: 3px 6px;
		font-size: 0.6875rem;
		color: #4c525d;
		text-align: left;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		cursor: pointer;
		display: block;
		width: 100%;
		box-sizing: border-box;
		transition: all 0.15s ease;
	}

	.entry-link:hover {
		background: rgba(198, 105, 48, 0.08);
		border-color: #c66930;
		color: #c66930;
	}

	/* List View Styles */
	.list-view-container {
		flex: 1;
		overflow-y: auto;
		background: #f8f9fa;
		border: 1px solid #e2e4e8;
		border-radius: 8px;
		padding: 1.5rem;
	}

	.empty-list {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 300px;
		color: #8b929e;
		gap: 1rem;
	}

	.entries-feed {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.feed-item {
		background: #ffffff;
		border: 1px solid #e2e4e8;
		border-radius: 8px;
		padding: 1.25rem;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.feed-item:hover {
		transform: translateY(-1px);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
		border-color: #c66930;
	}

	.feed-item-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.5rem;
	}

	.feed-item-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: #1d2129;
	}

	.feed-item:hover .feed-item-title {
		color: #c66930;
	}

	.feed-item-date {
		font-size: 0.75rem;
		color: #8b929e;
	}

	.feed-item-preview {
		margin: 0;
		font-size: 0.875rem;
		color: #4c525d;
		line-height: 1.5;
	}
</style>

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { notes } from '$lib/notes.svelte';
	import { db } from '$lib/db';
	import {
		GlobalWorkerOptions,
		getDocument,
		AnnotationEditorType,
		type PDFDocumentProxy
	} from 'pdfjs-dist';
	import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
	import {
		PDFViewer,
		EventBus,
		PDFLinkService
	} from 'pdfjs-dist/web/pdf_viewer.mjs';
	import 'pdfjs-dist/web/pdf_viewer.css';
	import {
		ChevronLeft,
		ChevronRight,
		ZoomIn,
		ZoomOut,
		MoveHorizontal,
		RotateCw,
		Printer,
		Download,
		PanelLeft,
		WifiOff,
		FileWarning,
		Loader2,
		MousePointerClick,
		Highlighter,
		PenTool,
		Type,
		MessageSquare
	} from 'lucide-svelte';

	GlobalWorkerOptions.workerSrc = workerUrl;

	let {
		url,
		noteId,
		title = '',
		compact = false
	}: { url: string; noteId: string; title?: string; compact?: boolean } = $props();

	type ViewerState = 'loading' | 'ready' | 'offline' | 'error';
	let viewerState = $state<ViewerState>('loading');
	let errorDetail = $state('');

	let pdf: PDFDocumentProxy | null = null;
	let loadingTask: ReturnType<typeof getDocument> | null = null;
	let pdfViewer: any = null;
	let currentEditorMode = $state<number>(0); // 0 corresponds to NONE
	let saveStatus = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');

	let localBlobUrl = '';
	let currentViewUrl = $state(url);
	let activeLoadId = 0;
	let observer: MutationObserver | null = null;

	let isAddingComment = $state(false);
	let commentModalOpen = $state(false);
	let newCommentText = $state('');
	let targetPageIndex = 0;
	let targetPdfX = 0;
	let targetPdfY = 0;
	let commentInputEl = $state<HTMLTextAreaElement>();
	// Set while the modal is editing an existing comment rather than adding
	// a new one; null means "add" mode.
	let editingAnnotId = $state<string | null>(null);
	let editingPageIndex = 0;

	$effect(() => {
		if (commentModalOpen) {
			setTimeout(() => commentInputEl?.focus(), 30);
		}
	});

	let numPages = $state(0);
	let scale = $state(1);
	let rotation = $state(0);
	let currentPage = $state(1);
	let pageInputValue = $state('1');
	let sidebarOpen = $state(!compact);
	let sidebarTab = $state<'outline' | 'pages'>('outline');

	// Base (scale-1, rotation-0) dimensions per page, fetched once.
	let baseSizes: { width: number; height: number }[] = [];
	let scrollEl = $state<HTMLDivElement>();
	let viewerEl = $state<HTMLDivElement>();
	let thumbEls: (HTMLCanvasElement | null)[] = $state([]);

	let thumbObserver: IntersectionObserver | null = null;

	type OutlineEntry = { title: string; depth: number; dest: unknown };
	let outline = $state<OutlineEntry[]>([]);

	// The thumbnail canvases only exist while the Pages tab is mounted —
	// (re)observe them whenever that tab becomes visible. setTimeout rather
	// than rAF so it also runs in hidden/background tabs.
	$effect(() => {
		if (sidebarOpen && sidebarTab === 'pages' && viewerState === 'ready') {
			setTimeout(() => setupThumbObservers(), 30);
		}
	});

	// Effective page size after rotation (90/270 swap width and height).
	function pageSize(index: number): { width: number; height: number } {
		const base = baseSizes[index] ?? { width: 612, height: 792 };
		const swapped = rotation % 180 !== 0;
		return {
			width: (swapped ? base.height : base.width) * scale,
			height: (swapped ? base.width : base.height) * scale
		};
	}

	// ── Position memory (attributes: pdfPage / pdfScroll / pdfRotation / pdfZoom) ──

	function readSavedPosition() {
		const attrs = notes.getAttributes(noteId);
		const val = (key: string) => attrs.find((a) => a.type === 'label' && a.key === key)?.value;
		const pageVal = val('pdfPage');
		const scrollVal = val('pdfScroll');
		const rotationVal = val('pdfRotation');
		const zoomVal = val('pdfZoom');

		const parsedPage = pageVal ? parseInt(pageVal, 10) : NaN;
		const parsedScroll = scrollVal ? parseInt(scrollVal, 10) : NaN;
		const parsedRotation = rotationVal ? parseInt(rotationVal, 10) : NaN;
		const parsedZoom = zoomVal ? parseFloat(zoomVal) : NaN;

		return {
			page: isNaN(parsedPage) ? null : parsedPage,
			scroll: isNaN(parsedScroll) ? null : parsedScroll,
			rotation: isNaN(parsedRotation) ? 0 : parsedRotation,
			zoom: isNaN(parsedZoom) ? null : parsedZoom
		};
	}

	async function saveAttr(key: string, value: string) {
		const existing = notes
			.getAttributes(noteId)
			.find((a) => a.type === 'label' && a.key === key);
		if (existing) {
			if (existing.value !== value) await notes.updateAttribute(existing.id, { value });
		} else {
			await notes.addAttribute(noteId, { type: 'label', key, value });
		}
	}

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let restoring = true; // suppress saves while applying the restored position

	function schedulePositionSave() {
		if (restoring) return;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => void savePosition(), 2500);
	}

	async function savePosition() {
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = null;
		if (!scrollEl || viewerState !== 'ready') return;
		await saveAttr('pdfPage', String(currentPage));
		await saveAttr('pdfScroll', String(Math.round(scrollEl.scrollTop)));
		await saveAttr('pdfRotation', String(rotation));
		await saveAttr('pdfZoom', scale.toFixed(2));
	}

	// ── Loading ──

	onMount(() => {
		window.addEventListener('beforeunload', onBeforeUnload);
		return () => {
			window.removeEventListener('beforeunload', onBeforeUnload);
			if (localBlobUrl) {
				URL.revokeObjectURL(localBlobUrl);
			}
		};
	});

	$effect(() => {
		if (url) {
			void load();
		}
	});

	function onBeforeUnload(e: BeforeUnloadEvent) {
		if (saveStatus === 'saving' || saveDebounceTimer !== null) {
			e.preventDefault();
			e.returnValue = 'Annotations are still saving. Are you sure you want to leave?';
			return e.returnValue;
		}
	}

	/**
	 * Frame-ish tick that also fires in hidden/background tabs, where the
	 * browser suspends requestAnimationFrame indefinitely. Initialization
	 * must not depend on the tab being visible.
	 */
	function nextTick(): Promise<void> {
		return new Promise((resolve) => {
			let done = false;
			const fin = () => {
				if (!done) {
					done = true;
					resolve();
				}
			};
			requestAnimationFrame(fin);
			setTimeout(fin, 60);
		});
	}

	async function load() {
		const currentLoadId = ++activeLoadId;

		// Clean up existing instances to prevent duplicate listeners/elements
		if (observer) {
			try {
				observer.disconnect();
			} catch (e) {}
			observer = null;
		}
		if (pdfViewer) {
			try {
				pdfViewer.cleanup();
				pdfViewer.setDocument(null);
			} catch (e) {}
			pdfViewer = null;
		}
		if (viewerEl) {
			try {
				viewerEl.innerHTML = '';
			} catch (e) {}
		}
		if (pdf) {
			try {
				pdf.cleanup();
			} catch (e) {}
			pdf = null;
		}
		if (loadingTask) {
			try {
				await loadingTask.destroy();
			} catch (e) {}
			loadingTask = null;
		}
		thumbObserver?.disconnect();
		if (localBlobUrl) {
			URL.revokeObjectURL(localBlobUrl);
			localBlobUrl = '';
		}

		viewerState = 'loading';
		try {
			// Find attachment in Dexie to see if we have a local blob
			const match = url.match(/attachments\/[^?#]+/);
			const filePath = match ? decodeURIComponent(match[0]) : '';
			let loadUrl = url;

			if (filePath) {
				let attachment = await db.attachments.where('file_path').equals(filePath).first();
				if (currentLoadId !== activeLoadId) return;
				if (!attachment) {
					const all = await db.attachments.toArray();
					if (currentLoadId !== activeLoadId) return;
					attachment = all.find((a) => url.includes(a.file_path));
				}
				if (attachment?.local_blob) {
					localBlobUrl = URL.createObjectURL(attachment.local_blob);
					loadUrl = localBlobUrl;
				}
			}
			if (currentLoadId !== activeLoadId) return;
			currentViewUrl = loadUrl;

			if (loadUrl.startsWith('blob:')) {
				loadingTask = getDocument({ url: loadUrl });
			} else {
				const separator = loadUrl.includes('?') ? '&' : '?';
				const cacheBustUrl = `${loadUrl}${separator}t=${Date.now()}`;
				const response = await fetch(cacheBustUrl, { cache: 'no-store' });
				if (currentLoadId !== activeLoadId) return;
				if (!response.ok) {
					throw new Error(`Failed to fetch PDF from server (${response.status})`);
				}
				const arrayBuffer = await response.arrayBuffer();
				if (currentLoadId !== activeLoadId) return;
				const pdfData = new Uint8Array(arrayBuffer);
				loadingTask = getDocument({ data: pdfData });
			}

			const resolvedPdf = await loadingTask.promise;
			if (currentLoadId !== activeLoadId) return;
			pdf = resolvedPdf;
			numPages = pdf.numPages;

			const sizes: { width: number; height: number }[] = [];
			for (let i = 1; i <= numPages; i++) {
				const page = await pdf.getPage(i);
				if (currentLoadId !== activeLoadId) return;
				const viewport = page.getViewport({ scale: 1 });
				sizes.push({ width: viewport.width, height: viewport.height });
			}
			baseSizes = sizes;

			// Outline (may be null); flatten with depth for simple rendering.
			const raw = await pdf.getOutline();
			if (currentLoadId !== activeLoadId) return;
			const flat: OutlineEntry[] = [];
			const walk = (items: { title: string; dest: unknown; items?: unknown[] }[], depth: number) => {
				for (const item of items) {
					flat.push({ title: item.title, depth, dest: item.dest });
					if (item.items?.length && depth < 4) {
						walk(item.items as typeof items, depth + 1);
					}
				}
			};
			if (raw) walk(raw, 0);
			outline = flat;
			if (!flat.length) sidebarTab = 'pages';

			const saved = readSavedPosition();
			rotation = ((saved.rotation % 360) + 360) % 360;
			viewerState = 'ready';

			// Monkey-patch annotationStorage to trigger auto-saves
			const annotationStorage = pdf.annotationStorage;
			if (annotationStorage) {
				const origSetValue = annotationStorage.setValue.bind(annotationStorage);
				annotationStorage.setValue = (key: string, value: any) => {
					origSetValue(key, value);
					triggerAutoSave();
				};
				const origRemove = annotationStorage.remove.bind(annotationStorage);
				annotationStorage.remove = (key: string) => {
					origRemove(key);
					triggerAutoSave();
				};
			}

			// Initialize PDFViewer once the DOM elements exist.
			await nextTick();
			if (currentLoadId !== activeLoadId) return;
			if (!scrollEl || !viewerEl) return;

			if (!pdfViewer) {
				const eventBus = new EventBus();
				const linkService = new PDFLinkService({ eventBus });

				pdfViewer = new PDFViewer({
					container: scrollEl,
					viewer: viewerEl,
					eventBus,
					linkService,
					textLayerMode: 1, // ENABLE
					annotationMode: 3, // ENABLE_STORAGE
					annotationEditorMode: 0 // NONE
				});

				linkService.setViewer(pdfViewer);

				eventBus.on('pagechanging', (evt: { pageNumber: number }) => {
					const pageNum = Number(evt.pageNumber);
					if (currentPage !== pageNum) {
						currentPage = pageNum;
						pageInputValue = String(currentPage);
						schedulePositionSave();
					}
				});
			}

			pdfViewer.setDocument(pdf!);
			startAnnotationObserver();
			setupThumbObservers();

			// Wait for page views to load, then restore scale, rotation, and scroll/page
			await nextTick();
			if (currentLoadId !== activeLoadId) return;
			scale = saved.zoom ?? fitWidthScale();
			pdfViewer.currentScale = scale;
			pdfViewer.pagesRotation = rotation;

			try {
				await pdfViewer.pagesPromise;
			} catch (e: any) {
				if (e?.name !== 'RenderingCancelledException') {
					console.warn('Pages promise rejected:', e);
				}
			}
			if (currentLoadId !== activeLoadId) return;
			if (saved.scroll !== null && scrollEl) {
				scrollEl.scrollTop = saved.scroll;
			} else if (saved.page) {
				pdfViewer.currentPageNumber = Number(saved.page);
			}

			await nextTick();
			if (currentLoadId !== activeLoadId) return;
			restoring = false;
		} catch (err) {
			if (currentLoadId !== activeLoadId) return;
			console.error('PDF load failed:', err);
			errorDetail = err instanceof Error ? err.message : String(err);
			viewerState = navigator.onLine ? 'error' : 'offline';
		}
	}

	function fitWidthScale(): number {
		if (!scrollEl || !baseSizes.length) return 1;
		const available = scrollEl.clientWidth - 48; // page margins
		const widest = Math.max(...baseSizes.map((s) => (rotation % 180 !== 0 ? s.height : s.width)));
		return Math.min(3, Math.max(0.3, available / widest));
	}

	function setupThumbObservers() {
		thumbObserver?.disconnect();
		thumbObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const index = Number((entry.target as HTMLElement).dataset.thumb);
					void renderThumb(index);
					thumbObserver?.unobserve(entry.target);
				}
			},
			{ rootMargin: '300px 0px' }
		);
		for (const el of thumbEls) if (el) thumbObserver.observe(el);
	}

	async function renderThumb(index: number) {
		const canvas = thumbEls[index];
		if (!pdf || !canvas || canvas.dataset.done) return;
		try {
			const page = await pdf.getPage(index + 1);
			const base = baseSizes[index] ?? { width: 612, height: 792 };
			const thumbScale = 108 / base.width;
			const viewport = page.getViewport({ scale: thumbScale });
			canvas.width = viewport.width;
			canvas.height = viewport.height;
			await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
			canvas.dataset.done = '1';
		} catch (err) {
			// Cancelled renders throw when the thumb scrolls out of view mid-paint; harmless.
			if (!(err instanceof Error && err.name === 'RenderingCancelledException')) {
				console.warn(`PDF thumbnail ${index + 1} failed:`, err);
			}
		}
	}

	// ── Annotation Saving & Editor Modes ──

	let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

	function triggerAutoSave() {
		saveStatus = 'idle';
		if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
		saveDebounceTimer = setTimeout(() => {
			saveDebounceTimer = null;
			void saveAnnotations();
		}, 5000);
	}

	async function saveAnnotations() {
		if (!pdf || viewerState !== 'ready') return;
		saveStatus = 'saving';
		try {
			// Bake pdf.js editor annotations, then rewrite (and heal) via pdf-lib.
			const rawBytes = await currentDocumentBytes();
			const lib = await import('pdf-lib');
			const pdfDoc = await lib.PDFDocument.load(rawBytes);
			repairCommentAnnotations(pdfDoc, lib);
			const rewrittenBytes = await pdfDoc.save();
			const newBlob = new Blob([rewrittenBytes as any], { type: 'application/pdf' });

			const attachment = await findAttachment();
			await db.attachments.update(attachment.id, {
				local_blob: newBlob,
				dirty: 1,
				modified_at: Date.now()
			});

			saveStatus = 'saved';

			// Background sync (no viewer reload — the editor layer stays live).
			const { syncNow } = await import('$lib/sync');
			await syncNow();
		} catch (err) {
			console.error('Failed to save annotations:', err);
			saveStatus = 'error';
		}
	}

	function setEditorMode(mode: number) {
		currentEditorMode = mode;
		isAddingComment = false; // Disable comment mode if switching to another tool
		if (pdfViewer) {
			pdfViewer.annotationEditorMode = { mode };
		}
	}

	function toggleAddCommentMode() {
		if (isAddingComment) {
			isAddingComment = false;
		} else {
			if (pdfViewer) {
				pdfViewer.annotationEditorMode = { mode: 0 };
			}
			currentEditorMode = 0;
			isAddingComment = true;
		}
	}

	function closeCommentModal() {
		commentModalOpen = false;
		newCommentText = '';
		editingAnnotId = null;
	}

	/** Open the comment modal pre-filled to edit an existing sticky note. */
	function openEditModal(pageIndex: number, annotId: string, currentText: string) {
		editingAnnotId = annotId;
		editingPageIndex = pageIndex;
		newCommentText = currentText;
		commentModalOpen = true;
	}

	/**
	 * Primary path for viewing/editing a comment: clicking its icon opens the
	 * modal with the text read straight from the document via getAnnotations.
	 * Deliberately independent of pdf.js's hover-popup machinery, which has
	 * proven unreliable across environments.
	 */
	async function openCommentFromAnnotation(el: Element) {
		if (!pdf) return;
		const annotId = el.getAttribute('data-annotation-id');
		if (!annotId) return;
		const pageIndex = pageIndexOf(el);
		try {
			const page = await pdf.getPage(pageIndex + 1);
			const annots = await page.getAnnotations();
			const annot = annots.find((a: any) => a.id === annotId);
			openEditModal(pageIndex, annotId, annot?.contentsObj?.str ?? '');
		} catch (err) {
			console.warn('Could not read comment annotation:', err);
		}
	}

	async function handleViewerClick(event: MouseEvent) {
		if (!isAddingComment) return;

		const target = event.target as HTMLElement;
		const pageEl = target.closest('.page');
		if (!pageEl) return;

		const pageNumAttr = pageEl.getAttribute('data-page-number');
		if (!pageNumAttr) return;
		const pageNumber = parseInt(pageNumAttr, 10);
		const pageIndex = pageNumber - 1;

		const rect = pageEl.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;

		try {
			const pageView = pdfViewer?.getPageView(pageIndex);
			if (!pageView || !pageView.viewport) return;
			const [pdfX, pdfY] = pageView.viewport.convertToPdfPoint(x, y);

			targetPageIndex = pageIndex;
			targetPdfX = pdfX;
			targetPdfY = pdfY;
			newCommentText = '';
			commentModalOpen = true;
			isAddingComment = false; // Exit add mode
		} catch (err) {
			console.error('Error converting click coordinates:', err);
			isAddingComment = false;
		}
	}

	/** The Dexie attachment row backing this viewer's URL. */
	async function findAttachment() {
		const match = url.match(/attachments\/[^?#]+/);
		const filePath = match ? decodeURIComponent(match[0]) : '';
		if (!filePath) throw new Error('Could not parse file path from URL');
		let attachment = await db.attachments.where('file_path').equals(filePath).first();
		if (!attachment) {
			const all = await db.attachments.toArray();
			attachment = all.find((a) => url.includes(a.file_path));
		}
		if (!attachment) throw new Error('Attachment record not found');
		return attachment;
	}

	/** Store rewritten bytes locally, refresh the viewer, and kick off sync. */
	async function persistAndReload(bytes: Uint8Array) {
		const newBlob = new Blob([bytes as any], { type: 'application/pdf' });
		const attachment = await findAttachment();
		await db.attachments.update(attachment.id, {
			local_blob: newBlob,
			dirty: 1,
			modified_at: Date.now()
		});
		saveStatus = 'saved';
		await load();
		const { syncNow } = await import('$lib/sync');
		await syncNow();
	}

	/** Current document bytes including any unbaked pdf.js editor annotations. */
	async function currentDocumentBytes(): Promise<Uint8Array> {
		if (!pdf) throw new Error('No document loaded');
		return pdf.annotationStorage && pdf.annotationStorage.size > 0
			? await pdf.saveDocument()
			: await pdf.getData();
	}

	function pdfDateNow(): string {
		return 'D:' + new Date().toISOString().slice(0, 19).replace(/[-T:]/g, '') + 'Z';
	}

	/**
	 * Shared /AP appearance stream for comment icons: a small yellow speech
	 * bubble. Viewers that only render appearance streams (Master PDF etc.)
	 * show this instead of nothing; icon-name-based viewers ignore it.
	 */
	function commentAppearanceRef(pdfDoc: any, PDFName: any) {
		const ops = [
			'q',
			'1 0.87 0.34 rg',
			'0.45 0.35 0.13 RG',
			'1 w',
			'1 7 18 12 re',
			'5 7 m 7 3 l 9 7 l h',
			'B',
			'4 15.5 m 16 15.5 l S',
			'4 12.5 m 13 12.5 l S',
			'Q'
		].join('\n');
		const stream = pdfDoc.context.stream(ops, {
			Type: PDFName.of('XObject'),
			Subtype: PDFName.of('Form'),
			FormType: 1,
			BBox: [0, 0, 20, 20]
		});
		return pdfDoc.context.register(stream);
	}

	/**
	 * Create a spec-complete sticky note: Text annotation + explicit /Popup
	 * (so every viewer sizes the note box sensibly instead of inventing its
	 * own) + /AP appearance stream (so strict viewers render the icon).
	 */
	function createCommentAnnotation(
		pdfDoc: any,
		lib: any,
		page: any,
		x: number,
		y: number,
		text: string
	) {
		const { PDFName, PDFString, PDFHexString } = lib;
		const { width: pageW } = page.getSize();
		const now = pdfDateNow();

		const iconRect = [x - 10, y - 10, x + 10, y + 10];
		// A compact note box to the right of the icon, kept on the page. No
		// author line (T omitted) — this is a single-user note, not a
		// multi-reviewer thread, so a name row is just noise.
		const [popupW, popupH] = [130, 60];
		const popupLeft = Math.min(x + 14, Math.max(0, pageW - popupW - 4));
		const popupRect = [popupLeft, y - popupH + 10, popupLeft + popupW, y + 10];

		const annotDict = pdfDoc.context.obj({
			Type: PDFName.of('Annot'),
			Subtype: PDFName.of('Text'),
			Rect: iconRect,
			Contents: PDFHexString.fromText(text),
			Name: PDFName.of('Comment'),
			NM: PDFString.of(crypto.randomUUID()),
			C: [1, 0.9, 0.2],
			M: PDFString.of(now),
			CreationDate: PDFString.of(now),
			F: 4,
			AP: pdfDoc.context.obj({ N: commentAppearanceRef(pdfDoc, PDFName) })
		});
		const annotRef = pdfDoc.context.register(annotDict);

		const popupDict = pdfDoc.context.obj({
			Type: PDFName.of('Annot'),
			Subtype: PDFName.of('Popup'),
			Rect: popupRect,
			Parent: annotRef,
			Open: false,
			F: 28 // Print | NoZoom | NoRotate
		});
		const popupRef = pdfDoc.context.register(popupDict);
		annotDict.set(PDFName.of('Popup'), popupRef);

		let annots = page.node.Annots();
		if (!annots) {
			page.node.set(PDFName.of('Annots'), pdfDoc.context.obj([]));
			annots = page.node.Annots();
		}
		annots!.push(annotRef);
		annots!.push(popupRef);
	}

	/**
	 * Heal the annotation table on every save. Removes exact-duplicate sticky
	 * notes (same text + same timestamp — artifacts of earlier save races),
	 * drops orphaned Popup annotations, and back-fills /Popup + /AP on notes
	 * created by earlier versions of this feature so they display correctly
	 * in external viewers. Returns the number of changes made.
	 */
	function repairCommentAnnotations(pdfDoc: any, lib: any): number {
		const { PDFName, PDFDict, PDFRef, PDFArray } = lib;
		let changes = 0;
		const decode = (v: any): string => {
			try {
				return v?.decodeText?.() ?? v?.asString?.() ?? '';
			} catch {
				return '';
			}
		};

		for (const page of pdfDoc.getPages()) {
			const annots = page.node.Annots();
			if (!(annots instanceof PDFArray)) continue;

			const entries: { ref: any; dict: any; subtype: string }[] = [];
			for (let i = 0; i < annots.size(); i++) {
				const ref = annots.get(i);
				if (!(ref instanceof PDFRef)) continue;
				const dict = pdfDoc.context.lookup(ref);
				if (!(dict instanceof PDFDict)) continue;
				const subtype = dict.get(PDFName.of('Subtype'))?.toString() ?? '';
				entries.push({ ref, dict, subtype });
			}

			// 1. Dedupe sticky notes by content + modification timestamp.
			const seen = new Set<string>();
			const removeRefs = new Set<any>();
			const keptTextRefs: any[] = [];
			for (const e of entries) {
				if (e.subtype !== '/Text') continue;
				const key =
					decode(e.dict.get(PDFName.of('Contents'))) + '|' + decode(e.dict.get(PDFName.of('M')));
				if (key !== '|' && seen.has(key)) {
					removeRefs.add(e.ref);
					const popupRef = e.dict.get(PDFName.of('Popup'));
					if (popupRef instanceof PDFRef) removeRefs.add(popupRef);
					changes++;
				} else {
					seen.add(key);
					keptTextRefs.push(e.ref);
				}
			}

			// 2. Remove orphaned popups (parent gone or not on this page).
			const liveRefs = new Set(
				entries.filter((e) => !removeRefs.has(e.ref)).map((e) => e.ref.toString())
			);
			for (const e of entries) {
				if (e.subtype !== '/Popup' || removeRefs.has(e.ref)) continue;
				const parent = e.dict.get(PDFName.of('Parent'));
				if (!(parent instanceof PDFRef) || !liveRefs.has(parent.toString())) {
					removeRefs.add(e.ref);
					changes++;
				}
			}

			if (removeRefs.size) {
				for (let i = annots.size() - 1; i >= 0; i--) {
					const ref = annots.get(i);
					if (ref instanceof PDFRef && removeRefs.has(ref)) annots.remove(i);
				}
			}

			// 3. Back-fill /AP, drop the redundant author line, and normalize
			// every popup (new or pre-existing) to the compact size — heals
			// both legacy comments and the earlier, oversized 180x90 ones.
			for (const e of entries) {
				if (e.subtype !== '/Text' || removeRefs.has(e.ref)) continue;
				if (!e.dict.get(PDFName.of('AP'))) {
					e.dict.set(
						PDFName.of('AP'),
						pdfDoc.context.obj({ N: commentAppearanceRef(pdfDoc, PDFName) })
					);
					changes++;
				}
				if (e.dict.get(PDFName.of('T'))) {
					e.dict.delete(PDFName.of('T'));
					changes++;
				}

				let x = 0, y = 0;
				try {
					const rect = e.dict.get(PDFName.of('Rect'));
					x = rect.get(2).asNumber();
					y = rect.get(3).asNumber();
				} catch { /* keep 0,0 */ }
				const [popupW, popupH] = [130, 60];
				const popupRect = [x + 4, y - popupH + 10, x + 4 + popupW, y + 10];

				const existingPopupRef = e.dict.get(PDFName.of('Popup'));
				if (existingPopupRef instanceof PDFRef) {
					const popupDict = pdfDoc.context.lookup(existingPopupRef);
					if (popupDict instanceof PDFDict) {
						const currentRect = popupDict.get(PDFName.of('Rect'))?.toString() ?? '';
						const desiredRect = pdfDoc.context.obj(popupRect).toString();
						if (currentRect !== desiredRect) {
							popupDict.set(PDFName.of('Rect'), pdfDoc.context.obj(popupRect));
							changes++;
						}
					}
				} else {
					const popupDict = pdfDoc.context.obj({
						Type: PDFName.of('Annot'),
						Subtype: PDFName.of('Popup'),
						Rect: popupRect,
						Parent: e.ref,
						Open: false,
						F: 28
					});
					const popupRef = pdfDoc.context.register(popupDict);
					e.dict.set(PDFName.of('Popup'), popupRef);
					annots.push(popupRef);
					changes++;
				}
			}
		}
		return changes;
	}

	/** Parse a pdf.js annotation id ("24R" / "24_0") into object/gen numbers. */
	function parseAnnotId(annotId: string, lib: any) {
		const match = annotId.match(/^(\d+)(?:R|_(\d+))?$/);
		if (!match) throw new Error('Invalid annotation ID format');
		return {
			objectNumber: parseInt(match[1], 10),
			generationNumber: match[2] ? parseInt(match[2], 10) : 0
		};
	}

	/** Locate a Text annotation's PDFRef + dict on a page by pdf.js id. */
	function findAnnotOnPage(pdfDoc: any, lib: any, page: any, annotId: string) {
		const { PDFRef, PDFDict } = lib;
		const { objectNumber, generationNumber } = parseAnnotId(annotId, lib);
		const annots = page.node.Annots();
		if (!annots) return null;
		for (let i = 0; i < annots.size(); i++) {
			const ref = annots.get(i);
			if (
				ref instanceof PDFRef &&
				ref.objectNumber === objectNumber &&
				ref.generationNumber === generationNumber
			) {
				const dict = pdfDoc.context.lookup(ref);
				return dict instanceof PDFDict ? { ref, dict } : null;
			}
		}
		return null;
	}

	let submittingComment = false;

	async function submitComment() {
		if (!newCommentText.trim() || !pdf || submittingComment) return;
		submittingComment = true;
		saveStatus = 'saving';
		const editId = editingAnnotId;
		const editPageIndex = editingPageIndex;
		commentModalOpen = false;

		try {
			const rawBytes = await currentDocumentBytes();
			const lib = await import('pdf-lib');
			const pdfDoc = await lib.PDFDocument.load(rawBytes);
			const pages = pdfDoc.getPages();

			if (editId !== null) {
				if (editPageIndex < 0 || editPageIndex >= pages.length) {
					throw new Error('Invalid page index');
				}
				const found = findAnnotOnPage(pdfDoc, lib, pages[editPageIndex], editId);
				if (!found) throw new Error('Comment no longer exists');
				const { PDFHexString, PDFName, PDFString } = lib;
				found.dict.set(PDFName.of('Contents'), PDFHexString.fromText(newCommentText));
				found.dict.set(PDFName.of('M'), PDFString.of(pdfDateNow()));
			} else {
				if (targetPageIndex < 0 || targetPageIndex >= pages.length) {
					throw new Error('Invalid page index');
				}
				createCommentAnnotation(pdfDoc, lib, pages[targetPageIndex], targetPdfX, targetPdfY, newCommentText);
			}
			repairCommentAnnotations(pdfDoc, lib);

			await persistAndReload(await pdfDoc.save());
		} catch (err) {
			console.error('Failed to save comment annotation:', err);
			saveStatus = 'error';
		} finally {
			submittingComment = false;
			editingAnnotId = null;
		}
	}

	function startAnnotationObserver() {
		if (observer) {
			observer.disconnect();
			observer = null;
		}
		if (!viewerEl) return;
		observer = new MutationObserver(() => {
			decorateAnnotations();
		});
		observer.observe(viewerEl, { childList: true, subtree: true });
		decorateAnnotations();
	}

	function formatAudate(dateStr: string): string {
		const d = new Date(dateStr);
		if (isNaN(d.getTime())) return '';
		const day = String(d.getDate()).padStart(2, '0');
		const month = String(d.getMonth() + 1).padStart(2, '0');
		const year = d.getFullYear();
		let hours = d.getHours();
		const minutes = String(d.getMinutes()).padStart(2, '0');
		const seconds = String(d.getSeconds()).padStart(2, '0');
		const ampm = hours >= 12 ? 'PM' : 'AM';
		hours = hours % 12;
		hours = hours ? hours : 12;
		return `${day}/${month}/${year}, ${hours}:${minutes}:${seconds} ${ampm}`;
	}

	/** Resolve the parent sticky-note id for a popup section. */
	function popupParentId(section: Element): string | null {
		// File-backed popups list their parent(s) in aria-controls
		// ("pdfjs_internal_id_13R"); synthetic ones are named popup_<id>.
		const controls = section.getAttribute('aria-controls') ?? '';
		const fromControls = controls.match(/(\d+R)\s*(?:,|$)/);
		if (fromControls) return fromControls[1];
		const id = section.getAttribute('data-annotation-id') ?? '';
		return id.startsWith('popup_') ? id.slice(6) : null;
	}

	function pageIndexOf(el: Element): number {
		const pageEl = el.closest('.page');
		const pageNumAttr = pageEl?.getAttribute('data-page-number');
		return (pageNumAttr ? parseInt(pageNumAttr, 10) : 1) - 1;
	}

	function deleteFromElement(el: Element, annotId: string) {
		void deleteComment(pageIndexOf(el), annotId);
	}

	function decorateAnnotations() {
		if (!viewerEl) return;

		// 1. Clicking a comment icon opens the view/edit modal; the hover ×
		// stays as a delete shortcut.
		const annots = viewerEl.querySelectorAll('.textAnnotation:not(.has-delete-btn)');
		for (const annot of annots) {
			annot.classList.add('has-delete-btn');

			annot.addEventListener('click', (e) => {
				e.stopPropagation();
				void openCommentFromAnnotation(annot);
			});

			const btn = document.createElement('button');
			btn.className = 'pv-annot-delete-btn';
			btn.innerHTML = '×';
			btn.title = 'Delete comment';
			btn.onclick = (e) => {
				e.stopPropagation();
				e.preventDefault();
				const annotId = annot.getAttribute('data-annotation-id');
				if (annotId) deleteFromElement(annot, annotId);
			};
			annot.appendChild(btn);
		}

		// 1b. Edit + delete actions inside the popup box itself (the popup div
		// is created lazily on first open, so this catches it via the
		// MutationObserver). Editing pre-fills the modal with the currently
		// rendered text, which is the pdf.js-parsed /Contents — always
		// accurate even for annotations from before this session.
		const popups = viewerEl.querySelectorAll('.popupAnnotation .popup:not(.pv-decorated)');
		for (const popup of popups) {
			popup.classList.add('pv-decorated');
			const section = popup.closest('.popupAnnotation');
			const annotId = section ? popupParentId(section) : null;
			if (!annotId) continue;

			const actions = document.createElement('div');
			actions.className = 'pv-popup-actions';

			const editBtn = document.createElement('button');
			editBtn.className = 'pv-popup-action';
			editBtn.textContent = 'Edit';
			editBtn.onclick = (e) => {
				e.stopPropagation();
				e.preventDefault();
				const text = popup.querySelector('.popupContent')?.textContent?.trim() ?? '';
				openEditModal(pageIndexOf(section!), annotId, text);
			};

			const deleteBtn = document.createElement('button');
			deleteBtn.className = 'pv-popup-action delete';
			deleteBtn.textContent = 'Delete';
			deleteBtn.onclick = (e) => {
				e.stopPropagation();
				e.preventDefault();
				deleteFromElement(section!, annotId);
			};

			actions.append(editBtn, deleteBtn);
			popup.appendChild(actions);
		}

		// 2. Format popup dates to Australian style (dd/mm/yyyy)
		const popupDates = viewerEl.querySelectorAll('.annotationLayer time.popupDate:not(.formatted-au)');
		for (const el of popupDates) {
			const datetime = el.getAttribute('datetime');
			if (datetime) {
				const formatted = formatAudate(datetime);
				if (formatted) {
					el.textContent = formatted;
					el.removeAttribute('data-l10n-id');
					el.removeAttribute('data-l10n-args');
					el.classList.add('formatted-au');
				}
			}
		}
	}

	async function deleteComment(pageIndex: number, annotId: string) {
		if (!pdf) return;
		saveStatus = 'saving';
		try {
			const rawBytes = await currentDocumentBytes();
			const lib = await import('pdf-lib');
			const { PDFDocument, PDFName, PDFRef } = lib;
			const pdfDoc = await PDFDocument.load(rawBytes);

			const pages = pdfDoc.getPages();
			if (pageIndex < 0 || pageIndex >= pages.length) {
				throw new Error('Invalid page index for deletion');
			}
			const page = pages[pageIndex];
			const found = findAnnotOnPage(pdfDoc, lib, page, annotId);

			const annots = page.node.Annots();
			if (found && annots) {
				const popupRef = found.dict.get(PDFName.of('Popup'));
				for (let i = annots.size() - 1; i >= 0; i--) {
					const ref = annots.get(i);
					if (!(ref instanceof PDFRef)) continue;
					if (
						ref === found.ref ||
						(popupRef instanceof PDFRef &&
							ref.objectNumber === popupRef.objectNumber &&
							ref.generationNumber === popupRef.generationNumber)
					) {
						annots.remove(i);
					}
				}
			}

			repairCommentAnnotations(pdfDoc, lib);
			await persistAndReload(await pdfDoc.save());
		} catch (err) {
			console.error('Failed to delete comment annotation:', err);
			saveStatus = 'error';
		}
	}

	// ── Navigation / toolbar ──

	function gotoPage(page: number | string) {
		const pageNum = typeof page === 'string' ? parseInt(page, 10) : page;
		if (isNaN(pageNum)) return;
		const clamped = Math.max(1, Math.min(numPages, pageNum));
		if (pdfViewer) {
			pdfViewer.currentPageNumber = clamped;
		}
		currentPage = clamped;
		pageInputValue = String(clamped);
	}

	function onPageInput(event: KeyboardEvent) {
		if (event.key !== 'Enter') return;
		const value = parseInt(pageInputValue, 10);
		if (value) gotoPage(value);
		else pageInputValue = String(currentPage);
	}

	function zoomBy(factor: number) {
		scale = Math.min(3, Math.max(0.3, scale * factor));
		if (pdfViewer) {
			pdfViewer.currentScale = scale;
		}
		schedulePositionSave();
	}

	function fitWidth() {
		scale = fitWidthScale();
		if (pdfViewer) {
			pdfViewer.currentScale = scale;
		}
		schedulePositionSave();
	}

	function rotate() {
		rotation = (rotation + 90) % 360;
		if (pdfViewer) {
			pdfViewer.pagesRotation = rotation;
		}
		schedulePositionSave();
	}

	async function gotoOutlineDest(dest: unknown) {
		if (!pdf || !pdfViewer) return;
		try {
			const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
			const ref = Array.isArray(explicit) ? explicit[0] : null;
			if (!ref) return;
			const pageIndex = await pdf.getPageIndex(ref);
			gotoPage(pageIndex + 1);
		} catch (err) {
			console.warn('Outline navigation failed:', err);
		}
	}

	const fileName = $derived(decodeURIComponent(url.split('?')[0].split('/').pop() ?? 'document.pdf'));

	/**
	 * Serialize exactly what's on screen (including unsaved editor
	 * annotations). Downloading the remote URL instead can hand back a stale
	 * CDN copy that's missing recent annotations.
	 */
	async function liveDocumentUrl(): Promise<string> {
		const bytes = await currentDocumentBytes();
		if (exportBlobUrl) URL.revokeObjectURL(exportBlobUrl);
		exportBlobUrl = URL.createObjectURL(new Blob([bytes as any], { type: 'application/pdf' }));
		return exportBlobUrl;
	}

	let exportBlobUrl = '';

	async function download() {
		try {
			const anchor = document.createElement('a');
			anchor.href = await liveDocumentUrl();
			anchor.download = fileName;
			anchor.rel = 'noopener';
			anchor.click();
		} catch (err) {
			console.warn('Live download failed, falling back to remote URL:', err);
			const anchor = document.createElement('a');
			anchor.href = currentViewUrl.includes('/storage/v1/object/public/')
				? `${currentViewUrl.split('?')[0]}?download=${encodeURIComponent(fileName)}`
				: currentViewUrl;
			anchor.download = fileName;
			anchor.rel = 'noopener';
			anchor.click();
		}
	}

	async function print() {
		try {
			window.open(await liveDocumentUrl(), '_blank', 'noopener');
		} catch {
			window.open(currentViewUrl, '_blank', 'noopener');
		}
	}

	onDestroy(() => {
		if (saveTimer) {
			clearTimeout(saveTimer);
			void savePosition(); // flush the pending position
		}
		if (saveDebounceTimer) {
			clearTimeout(saveDebounceTimer);
			void saveAnnotations();
		}
		thumbObserver?.disconnect();
		if (exportBlobUrl) {
			URL.revokeObjectURL(exportBlobUrl);
			exportBlobUrl = '';
		}
		if (observer) {
			try {
				observer.disconnect();
			} catch (e) {}
			observer = null;
		}
		if (pdfViewer) {
			try {
				pdfViewer.cleanup();
				pdfViewer.setDocument(null);
			} catch (e) {}
			pdfViewer = null;
		}
		if (pdf) {
			try {
				pdf.cleanup();
			} catch (e) {}
			pdf = null;
		}
		void loadingTask?.destroy();
	});
</script>

<div class="pdf-viewer-shell" class:compact>
	<div class="pdf-toolbar">
		<button
			class="pv-btn"
			class:active={sidebarOpen}
			onclick={() => (sidebarOpen = !sidebarOpen)}
			title="Toggle outline & pages panel"
			disabled={viewerState !== 'ready'}
		>
			<PanelLeft size={15} />
		</button>
		<span class="pv-divider"></span>
		<button class="pv-btn" onclick={() => gotoPage(currentPage - 1)} title="Previous page" disabled={viewerState !== 'ready' || currentPage <= 1}>
			<ChevronLeft size={15} />
		</button>
		<span class="pv-pageinfo">
			<input
				id="pv-page-input"
				name="page-input"
				type="text"
				inputmode="numeric"
				bind:value={pageInputValue}
				onkeydown={onPageInput}
				disabled={viewerState !== 'ready'}
				aria-label="Page number"
			/>
			<span>/ {numPages || '–'}</span>
		</span>
		<button class="pv-btn" onclick={() => gotoPage(currentPage + 1)} title="Next page" disabled={viewerState !== 'ready' || currentPage >= numPages}>
			<ChevronRight size={15} />
		</button>
		<span class="pv-divider"></span>
		<button class="pv-btn" onclick={() => zoomBy(1 / 1.2)} title="Zoom out" disabled={viewerState !== 'ready'}>
			<ZoomOut size={15} />
		</button>
		<span class="pv-zoom">{Math.round(scale * 100)}%</span>
		<button class="pv-btn" onclick={() => zoomBy(1.2)} title="Zoom in" disabled={viewerState !== 'ready'}>
			<ZoomIn size={15} />
		</button>
		<button class="pv-btn" onclick={fitWidth} title="Fit width" disabled={viewerState !== 'ready'}>
			<MoveHorizontal size={15} />
		</button>
		<button class="pv-btn" onclick={rotate} title="Rotate 90°" disabled={viewerState !== 'ready'}>
			<RotateCw size={15} />
		</button>

		<span class="pv-divider"></span>
		<button
			class="pv-btn"
			class:active={currentEditorMode === 0}
			onclick={() => setEditorMode(0)}
			title="Select/None Mode"
			disabled={viewerState !== 'ready'}
		>
			<MousePointerClick size={15} />
		</button>
		<button
			class="pv-btn"
			class:active={currentEditorMode === 9}
			onclick={() => setEditorMode(9)}
			title="Highlight Tool"
			disabled={viewerState !== 'ready'}
		>
			<Highlighter size={15} />
		</button>
		<button
			class="pv-btn"
			class:active={currentEditorMode === 15}
			onclick={() => setEditorMode(15)}
			title="Pen/Ink Tool"
			disabled={viewerState !== 'ready'}
		>
			<PenTool size={15} />
		</button>
		<button
			class="pv-btn"
			class:active={currentEditorMode === 3}
			onclick={() => setEditorMode(3)}
			title="Text Tool"
			disabled={viewerState !== 'ready'}
		>
			<Type size={15} />
		</button>
		<button
			class="pv-btn"
			class:active={isAddingComment}
			onclick={toggleAddCommentMode}
			title="Comment Tool"
			disabled={viewerState !== 'ready'}
		>
			<MessageSquare size={15} />
		</button>

		<span class="pv-spacer"></span>
		{#if saveStatus === 'saving'}
			<span class="pv-save-status saving">
				<Loader2 size={12} class="pv-spin" /> Saving...
			</span>
		{:else if saveStatus === 'saved'}
			<span class="pv-save-status saved">Saved</span>
		{:else if saveStatus === 'error'}
			<span class="pv-save-status error">Error Saving</span>
		{/if}

		{#if title && !compact}<span class="pv-title" {title}>{title}</span>{/if}
		<button class="pv-btn" onclick={print} title="Open for printing" disabled={viewerState === 'loading'}>
			<Printer size={15} />
		</button>
		<button class="pv-btn" onclick={download} title="Download {fileName}" disabled={viewerState === 'loading'}>
			<Download size={15} />
		</button>
	</div>

	<div class="pdf-body">
		{#if sidebarOpen && viewerState === 'ready'}
			<aside class="pdf-sidebar">
				<div class="pv-tabs">
					<button class:active={sidebarTab === 'outline'} onclick={() => (sidebarTab = 'outline')} disabled={!outline.length}>
						Outline
					</button>
					<button class:active={sidebarTab === 'pages'} onclick={() => (sidebarTab = 'pages')}>
						Pages
					</button>
				</div>
				{#if sidebarTab === 'outline'}
					<div class="pv-outline">
						{#each outline as entry, i (i)}
							<button
								class="pv-outline-item"
								style:padding-left="{0.75 + entry.depth * 0.875}rem"
								onclick={() => void gotoOutlineDest(entry.dest)}
							>
								{entry.title}
							</button>
						{:else}
							<p class="pv-none">This document has no outline.</p>
						{/each}
					</div>
				{:else}
					<div class="pv-thumbs">
						{#each Array(numPages) as _, i (i)}
							<button class="pv-thumb" class:current={currentPage === i + 1} onclick={() => gotoPage(i + 1)}>
								<canvas bind:this={thumbEls[i]} data-thumb={i}></canvas>
								<span>{i + 1}</span>
							</button>
						{/each}
					</div>
				{/if}
			</aside>
		{/if}

		<div class="pdf-scroll-container">
			<div
				class="pdf-scroll"
				class:adding-comment={isAddingComment}
				bind:this={scrollEl}
				onclick={handleViewerClick}
			>
				{#if viewerState === 'loading'}
					<div class="pv-state"><Loader2 size={28} class="pv-spin" /><p>Loading PDF…</p></div>
				{:else if viewerState === 'offline'}
					<div class="pv-state">
						<WifiOff size={28} />
						<p><strong>This PDF isn't available offline.</strong></p>
						<p class="pv-state-sub">It will load automatically when you're back online.</p>
						<button class="pv-retry" onclick={() => void load()}>Retry</button>
					</div>
				{:else if viewerState === 'error'}
					<div class="pv-state">
						<FileWarning size={28} />
						<p><strong>Couldn't load this PDF.</strong></p>
						<p class="pv-state-sub">{errorDetail}</p>
						<button class="pv-retry" onclick={() => void load()}>Retry</button>
					</div>
				{/if}

				<div class="pdfViewer" style:display={viewerState === 'ready' ? '' : 'none'} bind:this={viewerEl}></div>
			</div>
		</div>
	</div>

	{#if commentModalOpen}
		<div class="pv-modal-backdrop" onclick={closeCommentModal} role="presentation">
			<div class="pv-modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
				<h3 class="pv-modal-title">{editingAnnotId !== null ? 'Edit Comment' : 'Add Comment'}</h3>
				<textarea
					id="pv-comment-text"
					name="comment-text"
					class="pv-modal-input"
					bind:this={commentInputEl}
					bind:value={newCommentText}
					placeholder="Write comment here..."
					rows="4"
				></textarea>
				<div class="pv-modal-actions">
					{#if editingAnnotId !== null}
						<button
							class="pv-modal-btn delete"
							onclick={() => {
								const pageIdx = editingPageIndex;
								const id = editingAnnotId!;
								closeCommentModal();
								void deleteComment(pageIdx, id);
							}}
						>
							Delete
						</button>
					{/if}
					<span class="pv-modal-spacer"></span>
					<button class="pv-modal-btn cancel" onclick={closeCommentModal}>Cancel</button>
					<button class="pv-modal-btn save" onclick={submitComment} disabled={!newCommentText.trim()}>
						{editingAnnotId !== null ? 'Save Changes' : 'Add Comment'}
					</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.pdf-viewer-shell {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		border: 1px solid #e2e4e8;
		border-radius: 8px;
		overflow: hidden;
		background: #ffffff;
	}

	.pdf-toolbar {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.375rem 0.5rem;
		border-bottom: 1px solid #e2e4e8;
		background: #fafafa;
		flex: none;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.pv-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: none;
		background: none;
		border-radius: 4px;
		color: #4c525d;
		cursor: pointer;
		flex: none;
	}

	.pv-btn:hover:not(:disabled) {
		background: #eceef2;
	}

	.pv-btn.active {
		background: #eceef2;
		color: #c66930;
	}

	.pv-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.pv-divider {
		width: 1px;
		height: 18px;
		background: #e2e4e8;
		margin: 0 0.25rem;
		flex: none;
	}

	.pv-pageinfo {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
		color: #4c525d;
		flex: none;
	}

	.pv-pageinfo input {
		width: 2.75rem;
		border: 1px solid #cfd3da;
		border-radius: 4px;
		padding: 0.125rem 0.25rem;
		font: inherit;
		font-size: 0.8125rem;
		text-align: center;
		outline: none;
	}

	.pv-pageinfo input:focus {
		border-color: #c66930;
	}

	.pv-zoom {
		font-size: 0.75rem;
		color: #4c525d;
		min-width: 2.75rem;
		text-align: center;
		flex: none;
	}

	.pv-spacer {
		flex: 1;
	}

	.pv-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: #1d2129;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 18rem;
	}

	.pdf-body {
		flex: 1;
		display: flex;
		min-height: 0;
	}

	.pdf-sidebar {
		width: 11rem;
		flex: none;
		border-right: 1px solid #e2e4e8;
		display: flex;
		flex-direction: column;
		background: #fafafa;
	}

	.pv-tabs {
		display: flex;
		border-bottom: 1px solid #e2e4e8;
		flex: none;
	}

	.pv-tabs button {
		flex: 1;
		border: none;
		background: none;
		padding: 0.4375rem 0;
		font: inherit;
		font-size: 0.6875rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: #8b929e;
		cursor: pointer;
		border-bottom: 2px solid transparent;
	}

	.pv-tabs button.active {
		color: #c66930;
		border-bottom-color: #c66930;
	}

	.pv-tabs button:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.pv-outline {
		flex: 1;
		overflow-y: auto;
		padding: 0.375rem 0;
	}

	.pv-outline-item {
		display: block;
		width: 100%;
		border: none;
		background: none;
		padding: 0.3125rem 0.75rem;
		font: inherit;
		font-size: 0.75rem;
		color: #1d2129;
		text-align: left;
		cursor: pointer;
		line-height: 1.35;
	}

	.pv-outline-item:hover {
		background: #eceef2;
		color: #c66930;
	}

	.pv-none {
		padding: 0.75rem;
		font-size: 0.75rem;
		color: #99a;
	}

	.pv-thumbs {
		flex: 1;
		overflow-y: auto;
		padding: 0.625rem;
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
		align-items: center;
	}

	.pv-thumb {
		border: 2px solid transparent;
		border-radius: 4px;
		background: none;
		padding: 0.125rem;
		cursor: pointer;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.125rem;
	}

	.pv-thumb canvas {
		width: 108px;
		background: #ffffff;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
		min-height: 40px;
	}

	.pv-thumb span {
		font-size: 0.6875rem;
		color: #8b929e;
	}

	.pv-thumb.current {
		border-color: #c66930;
	}

	.pv-thumb.current span {
		color: #c66930;
		font-weight: 700;
	}

	.pdf-scroll-container {
		flex: 1;
		position: relative;
		min-width: 0;
		height: 100%;
	}

	.pdf-scroll {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0;
		right: 0;
		overflow: auto;
		background: #52565e;
		padding: 1rem 0;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.pdfViewer {
		position: relative;
		width: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
	}

	:global(.pdfViewer .page) {
		background: #ffffff !important;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35) !important;
		margin: 0 auto !important;
		border: none !important;
	}

	.pv-save-status {
		font-size: 0.75rem;
		font-weight: 500;
		padding: 2px 6px;
		border-radius: 4px;
		margin-right: 0.5rem;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex: none;
	}
	.pv-save-status.saving {
		background: #eceef2;
		color: #4c525d;
	}
	.pv-save-status.saved {
		background: #e6f4ea;
		color: #137333;
	}
	.pv-save-status.error {
		background: #fce8e6;
		color: #c5221f;
	}

	.pv-state {
		margin: auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		color: #e5e7eb;
		text-align: center;
		padding: 2rem;
	}

	.pv-state p {
		margin: 0;
		font-size: 0.9375rem;
	}

	.pv-state-sub {
		font-size: 0.8125rem !important;
		color: #b6bac2;
		max-width: 24rem;
		overflow-wrap: anywhere;
	}

	.pv-retry {
		margin-top: 0.5rem;
		border: 1px solid #9aa0aa;
		background: none;
		color: #e5e7eb;
		border-radius: 6px;
		padding: 0.375rem 1rem;
		font: inherit;
		font-size: 0.8125rem;
		cursor: pointer;
	}

	.pv-retry:hover {
		border-color: #ffffff;
		color: #ffffff;
	}

	:global(.pv-spin) {
		animation: pv-spin 1s linear infinite;
	}

	@keyframes pv-spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 768px) {
		.pdf-sidebar {
			display: none;
		}
	}

	@media print {
		.pdf-toolbar,
		.pdf-sidebar {
			display: none !important;
		}
	}

	/* Adding comment cursor styles */
	:global(.pdf-scroll.adding-comment),
	:global(.pdf-scroll.adding-comment .page),
	:global(.pdf-scroll.adding-comment .page *) {
		cursor: cell !important;
	}

	/* Comment modal styling */
	.pv-modal-backdrop {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(0, 0, 0, 0.4);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 2000;
		backdrop-filter: blur(2px);
	}

	.pv-modal {
		background: #ffffff;
		border-radius: 8px;
		width: 320px;
		max-width: 90%;
		padding: 1.25rem;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		border: 1px solid #e2e4e8;
	}

	.pv-modal-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: #1f2328;
	}

	.pv-modal-input {
		width: 100%;
		padding: 0.5rem;
		border: 1px solid #d0d7de;
		border-radius: 6px;
		font-family: inherit;
		font-size: 0.875rem;
		resize: none;
		outline: none;
		box-sizing: border-box;
	}

	.pv-modal-input:focus {
		border-color: #c66930;
		box-shadow: 0 0 0 2px rgba(198, 105, 48, 0.2);
	}

	.pv-modal-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.pv-modal-spacer {
		flex: 1;
	}

	.pv-modal-btn.delete {
		border-color: #f0c4c2;
		color: #c5221f;
		background: #fff5f5;
	}

	.pv-modal-btn.delete:hover {
		background: #fce8e6;
	}

	.pv-modal-btn {
		padding: 0.375rem 0.75rem;
		font-size: 0.8125rem;
		font-weight: 500;
		border-radius: 6px;
		cursor: pointer;
		border: 1px solid transparent;
		background: none;
		font-family: inherit;
	}

	.pv-modal-btn.cancel {
		border-color: #d0d7de;
		color: #57606a;
		background: #fafafa;
	}

	.pv-modal-btn.cancel:hover {
		background: #f3f4f6;
	}

	.pv-modal-btn.save {
		background: #c66930;
		color: #ffffff;
	}

	.pv-modal-btn.save:hover:not(:disabled) {
		background: #b55d28;
	}

	.pv-modal-btn.save:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	:global(.textAnnotation) {
		position: absolute;
		cursor: pointer;
	}

	:global(.pv-annot-delete-btn) {
		position: absolute;
		top: -11px;
		right: -11px;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: #ff4d4f;
		color: white;
		border: 2px solid #ffffff;
		font-size: 14px;
		font-weight: bold;
		line-height: 18px;
		text-align: center;
		cursor: pointer;
		display: none;
		z-index: 10;
		padding: 0;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
	}

	:global(.textAnnotation:hover .pv-annot-delete-btn) {
		display: block;
	}

	:global(.pv-annot-delete-btn:hover) {
		background: #ff7875;
	}

	/* Long comment text scrolls inside the popup instead of growing it */
	:global(.popupAnnotation .popupContent) {
		max-height: calc(90px * var(--total-scale-factor, 1));
		overflow-y: auto;
	}

	/* Edit/delete actions inside the comment popup box itself */
	:global(.pv-popup-actions) {
		display: flex;
		gap: 0.75rem;
		margin-top: 6px;
		padding-top: 4px;
		border-top: 1px solid rgba(0, 0, 0, 0.12);
	}

	:global(.pv-popup-action) {
		border: none;
		background: none;
		padding: 2px 0;
		font: inherit;
		font-size: calc(9px * var(--total-scale-factor, 1));
		font-weight: 600;
		text-decoration: underline;
		cursor: pointer;
		color: #2d5c40;
	}

	:global(.pv-popup-action:hover) {
		color: #1d3d2a;
	}

	:global(.pv-popup-action.delete) {
		color: #c5221f;
	}

	:global(.pv-popup-action.delete:hover) {
		color: #a50e0e;
	}
</style>

<script lang="ts">
	import { notes } from '$lib/notes.svelte';
	import { supabase } from '$lib/supabaseClient';
	import { uploadToStorage } from '$lib/uploads';
	import { startRecording, transcribeAudio, extensionFor, type RecordingController } from '$lib/voice';
	import { db, type LocalNote } from '$lib/db';
	import { Editor, Mark, mergeAttributes } from '@tiptap/core';
	import StarterKit from '@tiptap/starter-kit';
	import Placeholder from '@tiptap/extension-placeholder';
	import Image from '@tiptap/extension-image';
	import Link from '@tiptap/extension-link';
	import TextAlign from '@tiptap/extension-text-align';
	import { Indent } from './IndentExtension';
	import { Table } from '@tiptap/extension-table';
	import { TableRow } from '@tiptap/extension-table-row';
	import { TableHeader } from '@tiptap/extension-table-header';
	import { TableCell } from '@tiptap/extension-table-cell';
	import { onMount, onDestroy, untrack } from 'svelte';
	import {
		Bold as BoldIcon,
		Italic as ItalicIcon,
		Heading1 as Heading1Icon,
		Heading2 as Heading2Icon,
		Heading3 as Heading3Icon,
		List as ListIcon,
		ListOrdered as ListOrderedIcon,
		Code as CodeIcon,
		Image as ImageIcon,
		Link as LinkIcon,
		Indent as IndentIcon,
		Outdent as OutdentIcon,
		AlignLeft,
		AlignCenter,
		AlignRight,
		AlignJustify,
		Settings,
		X,
		PanelRight,
		Globe,
		Share2,
		Copy,
		Check,
		Paperclip,
		Printer,
		Sparkles,
		Columns2,
		ExternalLink,
		Star,
		Table as TableIcon,
		Mic,
		Square,
		Loader2
	} from 'lucide-svelte';

	import KanbanBoard from './KanbanBoard.svelte';
	import GridView from './GridView.svelte';
	import ListView from './ListView.svelte';

	const CustomImage = Image.extend({
		inline: false,
		group: 'block',
		addAttributes() {
			return {
				...this.parent?.(),
				alignment: {
					default: 'center',
					parseHTML: (element) => {
						const style = element.getAttribute('style') || '';
						if (style.includes('float: left')) return 'left';
						if (style.includes('float: right')) return 'right';
						return 'center';
					}
				},
				width: {
					default: null,
					parseHTML: (element) => {
						const style = element.getAttribute('style') || '';
						const match = style.match(/width:\s*(\d+)px/);
						if (match) return parseInt(match[1], 10);
						const widthAttr = element.getAttribute('width');
						return widthAttr ? parseInt(widthAttr, 10) : null;
					}
				}
			};
		},

		renderHTML({ HTMLAttributes }) {
			const styles: string[] = [];
			const alignment = HTMLAttributes.alignment || 'center';
			const width = HTMLAttributes.width;

			if (width) {
				styles.push(`width: ${width}px`);
				styles.push('max-width: 100%');
			} else {
				if (alignment === 'left' || alignment === 'right') {
					styles.push('width: auto');
					styles.push('max-width: 50%');
				} else {
					styles.push('width: 100%');
					styles.push('max-width: 100%');
				}
			}

			if (alignment === 'left') {
				styles.push('float: left', 'margin: 8px 16px 8px 0', 'display: block');
			} else if (alignment === 'right') {
				styles.push('float: right', 'margin: 8px 0 8px 16px', 'display: block');
			} else {
				styles.push('display: block', 'margin: 16px auto', 'float: none');
			}

			return [
				'img',
				mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
					style: styles.join('; ') + ';'
				})
			];
		},

		addNodeView() {
			return ({ node, HTMLAttributes, getPos, editor }) => {
				const container = document.createElement('span');
				container.style.position = 'relative';
				container.style.display = 'inline-block';
				container.style.lineHeight = '0';
				container.className = 'resizable-image-container';

				const alignment = node.attrs.alignment || 'center';
				if (alignment === 'left') {
					container.style.float = 'left';
					container.style.margin = '8px 16px 8px 0';
				} else if (alignment === 'right') {
					container.style.float = 'right';
					container.style.margin = '8px 0 8px 16px';
				} else {
					container.style.display = 'block';
					container.style.margin = '16px auto';
					container.style.float = 'none';
					container.style.textAlign = 'center';
				}

				const img = document.createElement('img');
				for (const [key, value] of Object.entries(HTMLAttributes)) {
					if (key !== 'style') {
						img.setAttribute(key, value as string);
					}
				}
				img.src = node.attrs.src;
				
				if (node.attrs.width) {
					img.style.width = `${node.attrs.width}px`;
					container.style.width = `${node.attrs.width}px`;
				} else {
					if (alignment === 'left' || alignment === 'right') {
						img.style.width = 'auto';
						img.style.maxWidth = '50%';
						container.style.width = 'auto';
					} else {
						img.style.width = '100%';
						img.style.maxWidth = '100%';
						container.style.width = '';
					}
				}

				img.style.height = 'auto';
				img.style.cursor = 'pointer';
				img.style.display = 'block';
				img.style.borderRadius = '6px';
				img.style.border = '1px solid rgba(0,0,0,0.1)';

				container.appendChild(img);

				const handles = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
				const handleElements: HTMLDivElement[] = [];

				handles.forEach((dir) => {
					const handle = document.createElement('div');
					handle.className = `resize-handle ${dir}`;
					
					handle.style.position = 'absolute';
					handle.style.width = '8px';
					handle.style.height = '8px';
					handle.style.background = '#c66930';
					handle.style.border = '1px solid #ffffff';
					handle.style.borderRadius = '50%';
					handle.style.zIndex = '10';
					handle.style.display = 'none';

					if (dir.includes('top')) handle.style.top = '-4px';
					if (dir.includes('bottom')) handle.style.bottom = '-4px';
					if (dir.includes('left')) handle.style.left = '-4px';
					if (dir.includes('right')) handle.style.right = '-4px';

					if (dir === 'top-left' || dir === 'bottom-right') {
						handle.style.cursor = 'nwse-resize';
					} else {
						handle.style.cursor = 'nesw-resize';
					}

					container.appendChild(handle);
					handleElements.push(handle);

					handle.addEventListener('mousedown', (e) => {
						e.preventDefault();
						e.stopPropagation();

						const startX = e.clientX;
						const startWidth = img.clientWidth;

						const onMouseMove = (moveEvent: MouseEvent) => {
							const dx = moveEvent.clientX - startX;
							const directionMultiplier = dir.includes('right') ? 1 : -1;
							const newWidth = Math.max(50, startWidth + dx * directionMultiplier);
							
							img.style.width = `${newWidth}px`;
							container.style.width = `${newWidth}px`;
						};

						const onMouseUp = () => {
							document.removeEventListener('mousemove', onMouseMove);
							document.removeEventListener('mouseup', onMouseUp);

							if (typeof getPos === 'function') {
								const pos = getPos();
								if (typeof pos === 'number') {
									const finalWidth = img.clientWidth;
									editor.view.dispatch(
										editor.view.state.tr.setNodeMarkup(pos, undefined, {
											...node.attrs,
											width: finalWidth
										})
									);
								}
							}
						};

						document.addEventListener('mousemove', onMouseMove);
						document.addEventListener('mouseup', onMouseUp);
					});
				});

				img.addEventListener('click', (e) => {
					e.preventDefault();
					e.stopPropagation();
					if (typeof getPos === 'function') {
						const pos = getPos();
						if (typeof pos === 'number') {
							editor.commands.setNodeSelection(pos);
						}
					}
				});

				return {
					dom: container,
					selectNode() {
						container.classList.add('ProseMirror-selectednode');
						img.style.outline = '3px solid #c66930';
						handleElements.forEach(h => h.style.display = 'block');
					},
					deselectNode() {
						container.classList.remove('ProseMirror-selectednode');
						img.style.outline = 'none';
						handleElements.forEach(h => h.style.display = 'none');
					},
					update(node) {
						if (node.type.name !== 'image') return false;
						
						if (node.attrs.src !== img.src) {
							img.src = node.attrs.src;
						}

						const alignment = node.attrs.alignment || 'center';
						if (node.attrs.width) {
							img.style.width = `${node.attrs.width}px`;
							container.style.width = `${node.attrs.width}px`;
						} else {
							if (alignment === 'left' || alignment === 'right') {
								img.style.width = 'auto';
								img.style.maxWidth = '50%';
								container.style.width = 'auto';
							} else {
								img.style.width = '100%';
								img.style.maxWidth = '100%';
								container.style.width = '';
							}
						}

						if (alignment === 'left') {
							container.style.display = 'inline-block';
							container.style.float = 'left';
							container.style.margin = '8px 16px 8px 0';
						} else if (alignment === 'right') {
							container.style.display = 'inline-block';
							container.style.float = 'right';
							container.style.margin = '8px 0 8px 16px';
						} else {
							container.style.display = 'block';
							container.style.margin = '16px auto';
							container.style.float = 'none';
							container.style.textAlign = 'center';
						}

						return true;
					}
				};
			};
		}
	});

	const CustomStyle = Mark.create({
		name: 'customStyle',

		addAttributes() {
			return {
				fontFamily: {
					default: null,
					parseHTML: element => element.style.fontFamily?.replace(/['"]/g, ''),
					renderHTML: attributes => {
						if (!attributes.fontFamily) return {};
						return { style: `font-family: ${attributes.fontFamily}` };
					}
				},
				fontSize: {
					default: null,
					parseHTML: element => element.style.fontSize,
					renderHTML: attributes => {
						if (!attributes.fontSize) return {};
						return { style: `font-size: ${attributes.fontSize}` };
					}
				}
			};
		},

		parseHTML() {
			return [
				{
					tag: 'span',
					getAttrs: element => {
						const hasStyle = (element as HTMLElement).hasAttribute('style');
						if (!hasStyle) return false;
						return {};
					}
				}
			];
		},

		renderHTML({ HTMLAttributes }) {
			const styles: string[] = [];
			if (HTMLAttributes.fontFamily) {
				styles.push(`font-family: ${HTMLAttributes.fontFamily}`);
			}
			if (HTMLAttributes.fontSize) {
				styles.push(`font-size: ${HTMLAttributes.fontSize}`);
			}
			return ['span', mergeAttributes(HTMLAttributes, { style: styles.join('; ') + ';' }), 0];
		}
	});

	// The parent keys this component by note.id, so local draft state is
	// initialized once per note and later liveQuery refreshes of the same
	// row can't move the caret mid-edit.
	let { note }: { note: LocalNote } = $props();

	// svelte-ignore state_referenced_locally
	let title = $state(note.title);
	// svelte-ignore state_referenced_locally
	let content = $state(note.content);
	let status = $state<'idle' | 'saving' | 'saved'>('idle');
	let inFlight = 0;

	const attributes = $derived(notes.allAttributes.filter(a => a.note_id === note.id));
	const parentPathList = $derived(notes.parentPaths(note.id));
	const backlinks = $derived(notes.backlinksFor(note.id));

	const activeCssClasses = $derived.by(() => {
		const classes: string[] = [];
		for (const attr of attributes) {
			if (attr.key === 'cssClass' || attr.key === 'theme') {
				if (attr.value) {
					classes.push(attr.value);
				}
			}
		}
		return classes;
	});

	const isReadingMode = $derived(activeCssClasses.includes('reading-mode'));

	const sharedAttribute = $derived(attributes.find(a => a.key === 'isShared' && a.value === 'true'));
	const isShared = $derived(!!sharedAttribute);
	let sharePopoverOpen = $state(false);
	let copySuccess = $state(false);

	async function generatePublicLink() {
		await notes.addAttribute(note.id, {
			type: 'label',
			key: 'isShared',
			value: 'true'
		});
	}

	async function stopSharing() {
		if (sharedAttribute) {
			await notes.removeAttribute(sharedAttribute.id);
		}
	}

	const viewTypeAttr = $derived(attributes.find(a => a.type === 'label' && a.key === 'viewType'));
	const currentViewType = $derived(viewTypeAttr?.value || 'editor');

	async function setViewType(type: 'editor' | 'board' | 'grid' | 'list') {
		const attr = attributes.find(a => a.type === 'label' && a.key === 'viewType');
		if (type === 'editor') {
			if (attr) {
				await notes.removeAttribute(attr.id);
			}
		} else {
			if (attr) {
				await notes.updateAttribute(attr.id, { value: type });
			} else {
				await notes.addAttribute(note.id, { type: 'label', key: 'viewType', value: type });
			}
		}
	}

	const isBookmarked = $derived(attributes.some(a => a.type === 'label' && a.key === 'bookmark'));
	async function toggleBookmark() {
		const bookmarkAttr = attributes.find(a => a.type === 'label' && a.key === 'bookmark');
		if (bookmarkAttr) {
			await notes.removeAttribute(bookmarkAttr.id);
		} else {
			await notes.addAttribute(note.id, { type: 'label', key: 'bookmark', value: '' });
		}
	}

	async function copyToClipboard() {
		const url = `${location.origin}/share/${note.id}`;
		try {
			await navigator.clipboard.writeText(url);
			copySuccess = true;
			setTimeout(() => {
				copySuccess = false;
			}, 2000);
		} catch (err) {
			console.error('Failed to copy text: ', err);
		}
	}

	$effect(() => {
		if (sharePopoverOpen) {
			const handleOutsideClick = (e: MouseEvent) => {
				const target = e.target as HTMLElement;
				if (!target.closest('.share-container')) {
					sharePopoverOpen = false;
				}
			};
			document.addEventListener('click', handleOutsideClick);
			return () => document.removeEventListener('click', handleOutsideClick);
		}
	});

	$effect(() => {
		if (graduateMenuOpen) {
			const handleOutsideClick = (e: MouseEvent) => {
				const target = e.target as HTMLElement;
				if (!target.closest('.graduate-container')) {
					graduateMenuOpen = false;
				}
			};
			document.addEventListener('click', handleOutsideClick);
			return () => document.removeEventListener('click', handleOutsideClick);
		}
	});

	let showAddPopover = $state(false);
	let newAttrType = $state<'label' | 'relation'>('label');
	let newAttrKey = $state('');
	let newAttrValue = $state('');
	let keyInputEl = $state<HTMLInputElement>();
	let valueInputEl = $state<HTMLInputElement>();

	const uniqueKeys = $derived.by(() => {
		const keys = new Set<string>();
		for (const attr of notes.allAttributes) {
			if (attr.key) {
				keys.add(attr.key);
			}
		}
		return Array.from(keys).sort();
	});

	const suggestedValues = $derived.by(() => {
		if (!newAttrKey.trim()) return [];
		const values = new Set<string>();
		for (const attr of notes.allAttributes) {
			if (attr.key === newAttrKey.trim() && attr.value) {
				values.add(attr.value);
			}
		}
		return Array.from(values).sort();
	});

	// ── Tag quick-add / inline edit / click-to-search ──────────────────

	/** key → usage count + per-value counts, from live label rows. */
	const tagVocab = $derived.by(() => {
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

	let quickTag = $state('');
	let quickTagOpen = $state(false);
	let quickTagIndex = $state(-1);

	// Before ':' suggest keys (by usage); after 'key:' suggest that key's values.
	const quickSuggestions = $derived.by(() => {
		const raw = quickTag.replace(/^#/, '');
		const colon = raw.indexOf(':');
		if (colon === -1) {
			const q = raw.toLowerCase();
			return [...tagVocab.entries()]
				.filter(([key]) => key.toLowerCase().includes(q))
				.sort((a, b) => b[1].count - a[1].count)
				.slice(0, 8)
				.map(([key, entry]) => ({
					insert: `${key}:`,
					display: `${key} (${entry.count})`,
					complete: entry.values.size === 0 // valueless tags commit immediately
				}));
		}
		const keyPart = raw.slice(0, colon);
		const q = raw.slice(colon + 1).toLowerCase();
		const match = [...tagVocab.entries()].find(
			([key]) => key.toLowerCase() === keyPart.toLowerCase()
		);
		if (!match) return [];
		return [...match[1].values.entries()]
			.filter(([value]) => value.toLowerCase().includes(q))
			.sort((a, b) => b[1] - a[1])
			.slice(0, 8)
			.map(([value, count]) => ({
				insert: `${match[0]}:${value}`,
				display: `${value} (${count})`,
				complete: true
			}));
	});

	function parseTag(text: string): { key: string; value: string } | null {
		const raw = text.trim().replace(/^#/, '');
		if (!raw) return null;
		const colon = raw.indexOf(':');
		if (colon === -1) return { key: raw, value: '' };
		const key = raw.slice(0, colon).trim();
		return key ? { key, value: raw.slice(colon + 1).trim() } : null;
	}

	async function commitQuickTag() {
		const parsed = parseTag(quickTag);
		quickTag = '';
		quickTagIndex = -1;
		if (!parsed) return;
		const duplicate = attributes.some(
			(a) => a.type === 'label' && a.key === parsed.key && a.value === parsed.value
		);
		if (!duplicate) await notes.addAttribute(note.id, { type: 'label', ...parsed });
	}

	function applyQuickSuggestion(suggestion: { insert: string; complete: boolean }) {
		quickTag = suggestion.insert;
		quickTagIndex = -1;
		if (suggestion.complete) void commitQuickTag();
	}

	function quickTagKeydown(e: KeyboardEvent) {
		if (quickTagOpen && quickSuggestions.length > 0) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				quickTagIndex = (quickTagIndex + 1) % quickSuggestions.length;
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				quickTagIndex = (quickTagIndex - 1 + quickSuggestions.length) % quickSuggestions.length;
				return;
			}
			if (e.key === 'Tab' && quickTagIndex >= 0) {
				e.preventDefault();
				applyQuickSuggestion(quickSuggestions[quickTagIndex]);
				return;
			}
		}
		if (e.key === 'Enter') {
			e.preventDefault();
			if (quickTagIndex >= 0 && quickSuggestions[quickTagIndex]) {
				applyQuickSuggestion(quickSuggestions[quickTagIndex]);
			} else {
				void commitQuickTag();
			}
		} else if (e.key === 'Escape') {
			quickTagIndex = -1;
			quickTagOpen = false;
		}
	}

	let editingAttrId = $state<string | null>(null);
	let editAttrText = $state('');

	function startEditAttr(attr: { id: string; type: string; key: string; value: string }) {
		if (attr.type === 'relation') return; // relations edit via the advanced popover
		editingAttrId = attr.id;
		editAttrText = attr.value ? `${attr.key}:${attr.value}` : attr.key;
	}

	async function saveEditAttr() {
		const id = editingAttrId;
		editingAttrId = null;
		if (!id) return;
		const parsed = parseTag(editAttrText);
		if (!parsed) return;
		const current = attributes.find((a) => a.id === id);
		if (current && (current.key !== parsed.key || current.value !== parsed.value)) {
			await notes.updateAttribute(id, parsed);
		}
	}

	function searchForAttr(attr: { key: string; value: string }) {
		notes.searchQuery = attr.value ? `#${attr.key}:${attr.value}` : `#${attr.key}`;
		notes.sidebarOpen = true;
	}

	let keySuggestionsOpen = $state(false);
	let keySelectedIndex = $state(-1);
	const filteredKeySuggestions = $derived(
		uniqueKeys.filter(k => k.toLowerCase().includes(newAttrKey.toLowerCase()))
	);

	let valueSuggestionsOpen = $state(false);
	let valueSelectedIndex = $state(-1);
	const filteredValueSuggestions = $derived(
		suggestedValues.filter(v => v.toLowerCase().includes(newAttrValue.toLowerCase()))
	);

	function handleKeyKeydown(e: KeyboardEvent) {
		if (!keySuggestionsOpen || filteredKeySuggestions.length === 0) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			keySelectedIndex = (keySelectedIndex + 1) % filteredKeySuggestions.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			keySelectedIndex = (keySelectedIndex - 1 + filteredKeySuggestions.length) % filteredKeySuggestions.length;
		} else if (e.key === 'Enter' || e.key === 'Tab') {
			if (keySelectedIndex >= 0 && keySelectedIndex < filteredKeySuggestions.length) {
				e.preventDefault();
				selectKeySuggestion(filteredKeySuggestions[keySelectedIndex]);
			}
		} else if (e.key === 'Escape') {
			keySuggestionsOpen = false;
		}
	}

	function selectKeySuggestion(key: string) {
		newAttrKey = key;
		keySuggestionsOpen = false;
		keySelectedIndex = -1;
		setTimeout(() => {
			valueInputEl?.focus();
		}, 0);
	}

	function handleValueKeydown(e: KeyboardEvent) {
		if (!valueSuggestionsOpen || filteredValueSuggestions.length === 0) return;

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			valueSelectedIndex = (valueSelectedIndex + 1) % filteredValueSuggestions.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			valueSelectedIndex = (valueSelectedIndex - 1 + filteredValueSuggestions.length) % filteredValueSuggestions.length;
		} else if (e.key === 'Enter' || e.key === 'Tab') {
			if (valueSelectedIndex >= 0 && valueSelectedIndex < filteredValueSuggestions.length) {
				e.preventDefault();
				selectValueSuggestion(filteredValueSuggestions[valueSelectedIndex]);
			}
		} else if (e.key === 'Escape') {
			valueSuggestionsOpen = false;
		}
	}

	function selectValueSuggestion(value: string) {
		newAttrValue = value;
		valueSuggestionsOpen = false;
		valueSelectedIndex = -1;
	}

	$effect(() => {
		if (showAddPopover && keyInputEl) {
			keyInputEl.focus();
		}
	});

	async function saveNewAttribute() {
		if (!newAttrKey.trim()) return;
		await notes.addAttribute(note.id, {
			type: newAttrType,
			key: newAttrKey.trim(),
			value: newAttrValue.trim()
		});
		newAttrKey = '';
		newAttrValue = '';
		showAddPopover = false;
	}

	let showToc = $state(true);
	let showHighlights = $state(true);
	let showAiSection = $state(true);
	let splitView = $state(false);
	let graduateMenuOpen = $state(false);
	let selectedTargetName = $state<string | null>(null);

	function stripSocialNoise() {
		if (!editor) return;
		let html = editor.getHTML();
		
		const parser = new DOMParser();
		const doc = parser.parseFromString(html, 'text/html');
		
		const elements = doc.querySelectorAll('p, div, span, li');
		for (const el of elements) {
			const text = el.textContent || '';
			const isReply = /^\s*Reply\s*$/i.test(text);
			const isTimestamp = /(?:Today|Yesterday)\s+at\s+\d{1,2}:\d{2}/i.test(text) ||
			                    /^\s*\d{1,2}\s*(?:mins?|hours?|hr|min|d|w|m|s|y)\s+ago\s*$/i.test(text) ||
			                    /^\s*\d{1,2}[hdwms]\s*$/i.test(text) ||
			                    /^\s*\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s*,\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)?\s*$/i.test(text);
			
			if (isReply || isTimestamp || text.trim() === '') {
				el.remove();
			}
		}

		let cleanedHtml = doc.body.innerHTML;
		cleanedHtml = cleanedHtml.replace(/(?:<p>&nbsp;<\/p>|<p><\/p>|<br\s*\/?>)+$/gi, '');
		
		editor.commands.setContent(cleanedHtml);
		void save();
	}

	function formatAsBlockquote() {
		if (!editor) return;
		editor.chain().focus().toggleBlockquote().run();
		void save();
	}

	function selectTarget(name: string) {
		selectedTargetName = name;
		graduateMenuOpen = false;
	}

	function getCleanMarkdown() {
		const attrs = notes.getAttributes(note.id);
		let md = `# ${note.title || 'Untitled'}\n\n`;
		
		if (attrs.length > 0) {
			md += `---\n`;
			for (const attr of attrs) {
				md += `${attr.key}: ${attr.value}\n`;
			}
			md += `---\n\n`;
		}
		
		let body = note.content || '';
		body = body
			.replace(/<h1>(.*?)<\/h1>/gi, '# $1\n\n')
			.replace(/<h2>(.*?)<\/h2>/gi, '## $1\n\n')
			.replace(/<h3>(.*?)<\/h3>/gi, '### $1\n\n')
			.replace(/<p>(.*?)<\/p>/gi, '$1\n\n')
			.replace(/<li>(.*?)<\/li>/gi, '- $1\n')
			.replace(/<ul>/gi, '')
			.replace(/<\/ul>/gi, '\n')
			.replace(/<ol>/gi, '')
			.replace(/<\/ol>/gi, '\n')
			.replace(/<blockquote>(.*?)<\/blockquote>/gi, '> $1\n\n')
			.replace(/<pre><code>(.*?)<\/code><\/pre>/gi, '```\n$1\n```\n\n')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<[^>]+>/g, '');
			
		md += body.trim();
		return md;
	}

	async function exportAsMarkdown() {
		const md = getCleanMarkdown();
		try {
			await navigator.clipboard.writeText(md);
			await graduateNote();
			selectedTargetName = null;
			alert("Clean Markdown copied to clipboard!");
		} catch (err) {
			alert(`Failed to copy: ${err}`);
		}
	}

	async function exportAsJson() {
		const attrs = notes.getAttributes(note.id).map(a => ({
			type: a.type,
			key: a.key,
			value: a.value
		}));
		const payload = {
			title: note.title || 'Untitled',
			content: note.content || '',
			attributes: attrs,
			created_at: note.updated_at
		};

		const jsonString = JSON.stringify(payload, null, 2);
		const blob = new Blob([jsonString], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		
		const a = document.createElement('a');
		a.href = url;
		a.download = `${(note.title || 'untitled').toLowerCase().replace(/\s+/g, '_')}_package.json`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);

		await graduateNote();
		selectedTargetName = null;
	}

	async function graduateNote() {
		const attrs = notes.getAttributes(note.id);
		const statusAttr = attrs.find(a => a.type === 'label' && a.key === 'status');
		if (statusAttr) {
			if (statusAttr.value !== 'graduated') {
				await notes.updateAttribute(statusAttr.id, { value: 'graduated' });
			}
		} else {
			await notes.addAttribute(note.id, {
				type: 'label',
				key: 'status',
				value: 'graduated'
			});
		}
	}

	const activePdfUrl = $derived.by(() => {
		if (!note.content) return null;
		const match = note.content.match(/href="([^"]+\.pdf[^"]*)"/i);
		if (match) return match[1];
		return null;
	});

	const activeImageUrl = $derived.by(() => {
		if (!note.content) return null;
		const match = note.content.match(/<img[^>]+src="([^"]+)"/i);
		if (match) return match[1];
		return null;
	});

	let chatMessages = $state<{ role: 'user' | 'assistant', content: string }[]>([
		{ role: 'assistant', content: 'Hello! I am your Gemini assistant. How can I help you analyse or clean your notes today?' }
	]);
	let aiPrompt = $state('');
	let isDraggingOver = $state(false);
	let dragCounter = 0;

	function handleDragEnter(e: DragEvent) {
		e.preventDefault();
		dragCounter++;
		if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
			isDraggingOver = true;
		}
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
	}

	function handleDragLeave(e: DragEvent) {
		e.preventDefault();
		dragCounter--;
		if (dragCounter <= 0) {
			isDraggingOver = false;
			dragCounter = 0;
		}
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		isDraggingOver = false;
		dragCounter = 0;
		const files = e.dataTransfer?.files;
		if (files?.length) {
			for (const file of files) {
				void ingestFile(file);
			}
		}
	}
	let isGenerating = $state(false);
	let chatContainerEl = $state<HTMLDivElement>();

	function stripHtml(html: string): string {
		if (typeof document === 'undefined') return '';
		const doc = new DOMParser().parseFromString(html, 'text/html');
		return doc.body.textContent || '';
	}

	function injectPrompt(type: 'summarise' | 'metadata' | 'clean') {
		const text = stripHtml(note.content || '');
		if (type === 'summarise') {
			aiPrompt = `Distill the active note text into a dense 3-bullet summary:\n\n${text}`;
		} else if (type === 'metadata') {
			aiPrompt = `Read the note content and suggest relevant Key-Value attribute tags (e.g., #platform=Facebook, #year=2024):\n\n${text}`;
		} else if (type === 'clean') {
			aiPrompt = `Fix messy formatting, broken line breaks, or OCR errors in this text:\n\n${text}`;
		}
	}

	function handlePromptKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void sendPrompt();
		}
	}

	async function sendPrompt() {
		const promptText = aiPrompt.trim();
		if (!promptText || isGenerating) return;

		chatMessages.push({ role: 'user', content: promptText });
		aiPrompt = '';
		isGenerating = true;

		setTimeout(scrollToBottom, 50);

		if (!notes.apiKey) {
			const paragraphs = [
				"API key not found. Please add your Gemini API Key in the Settings menu (top-right gear icon).",
				"Once saved, I will connect to the live Gemini 2.5 flash streaming API."
			];
			chatMessages.push({ role: 'assistant', content: '' });
			const lastIdx = chatMessages.length - 1;
			for (let i = 0; i < paragraphs.length; i++) {
				await new Promise(r => setTimeout(r, 100));
				if (i > 0) chatMessages[lastIdx].content += "\n\n";
				chatMessages[lastIdx].content += paragraphs[i];
				scrollToBottom();
			}
			isGenerating = false;
			return;
		}

		// Prepare history mapped for Gemini API structure
		const geminiHistory = chatMessages.map(msg => ({
			role: msg.role === 'user' ? 'user' : 'model',
			parts: [{ text: msg.content }]
		}));

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

	let editorElement = $state<HTMLDivElement>();
	let editor = $state<Editor | null>(null);
	let imageInput = $state<HTMLInputElement>();
	let imageActive = $state(false);
	let tableActive = $state(false);
	let imageAlignment = $state<'left' | 'center' | 'right'>('center');

	let currentFontFamily = $state('');
	let currentFontSize = $state('');
	let selectedImagePos = $state<number | null>(null);

	let bubbleMenuCoords = $derived.by(() => {
		if (selectedImagePos === null || !editor) return null;
		try {
			const domNode = editor.view.nodeDOM(selectedImagePos) as HTMLElement;
			if (domNode) {
				return {
					top: domNode.offsetTop - 36,
					left: domNode.offsetLeft + (domNode.offsetWidth / 2) - 165
				};
			}
		} catch (e) {
			console.error(e);
		}
		return null;
	});

	function changeFontFamily(family: string) {
		if (!editor) return;
		const currentAttrs = (editor.state.selection.$from.marks().find(m => m.type.name === 'customStyle')?.attrs || {}) as any;
		if (family === '') {
			const newAttrs = { ...currentAttrs, fontFamily: null };
			if (!newAttrs.fontFamily && !newAttrs.fontSize) {
				editor.chain().focus().unsetMark('customStyle').run();
			} else {
				editor.chain().focus().setMark('customStyle', newAttrs).run();
			}
		} else {
			editor.chain().focus().setMark('customStyle', { ...currentAttrs, fontFamily: family }).run();
		}
		updateActiveStates();
	}

	function changeFontSize(size: string) {
		if (!editor) return;
		const currentAttrs = (editor.state.selection.$from.marks().find(m => m.type.name === 'customStyle')?.attrs || {}) as any;
		if (size === '') {
			const newAttrs = { ...currentAttrs, fontSize: null };
			if (!newAttrs.fontFamily && !newAttrs.fontSize) {
				editor.chain().focus().unsetMark('customStyle').run();
			} else {
				editor.chain().focus().setMark('customStyle', newAttrs).run();
			}
		} else {
			editor.chain().focus().setMark('customStyle', { ...currentAttrs, fontSize: size }).run();
		}
		updateActiveStates();
	}

	function triggerImageUpload() {
		imageInput?.click();
	}

	let attachInput = $state<HTMLInputElement>();
	let uploading = $state(0);

	// Signed-slot upload + Media Library metadata recording is shared with
	// the Media Manager — see $lib/uploads.

	function prettySize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)} KB`;
		return `${(bytes / 1_048_576).toFixed(1)} MB`;
	}

	function escapeAttachmentName(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function insertFileCard(info: { url: string; name: string; size: number }) {
		// ?download=<name> makes Supabase serve Content-Disposition: attachment
		// with a friendly filename instead of the storage path.
		const downloadUrl = `${info.url}?download=${encodeURIComponent(info.name)}`;
		editor
			?.chain()
			.focus()
			.insertContent(
				`<p>📎 <a href="${info.url}" target="_blank" rel="noopener noreferrer">${escapeAttachmentName(info.name)}</a> <em>(${prettySize(info.size)})</em> · <a href="${downloadUrl}" rel="noopener noreferrer">download</a></p>`
			)
			.run();
	}

	// ── Voice capture: record → transcribe at the cursor → attach audio ──
	let voiceState = $state<'idle' | 'recording' | 'transcribing'>('idle');
	let voiceError = $state('');
	let recordingController: RecordingController | null = null;
	let recordingStartedAt = 0;
	let elapsedSec = $state(0);
	let elapsedTimer: ReturnType<typeof setInterval> | null = null;

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

			editor
				?.chain()
				.focus()
				.insertContent(`<p>${transcript.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`)
				.run();

			// Attach the source recording alongside its transcript, same as
			// any other file (best-effort: offline capture keeps the text).
			try {
				const file = new File(
					[recording.blob],
					`voice-note-${Date.now()}.${extensionFor(recording.mimeType)}`,
					{ type: recording.mimeType }
				);
				insertFileCard(await uploadToStorage(file));
			} catch (err) {
				console.warn('Voice recording upload failed; transcript kept, audio dropped.', err);
			}
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

	/** Images become image nodes (base64 fallback offline); other files a link card. */
	async function ingestFile(file: File) {
		uploading++;
		try {
			if (file.type.startsWith('image/')) {
				try {
					const info = await uploadToStorage(file);
					editor?.chain().focus().setImage({ src: info.url }).run();
				} catch {
					// Offline or upload failure: inline base64 so the image still
					// lands and syncs inside the note body like before.
					const base64 = await new Promise<string>((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () => resolve(reader.result as string);
						reader.onerror = () => reject(reader.error);
						reader.readAsDataURL(file);
					});
					editor?.chain().focus().setImage({ src: base64 }).run();
				}
			} else {
				insertFileCard(await uploadToStorage(file));
			}
		} catch (err) {
			alert(`Could not attach “${file.name}”: ${err instanceof Error ? err.message : err}`);
		} finally {
			uploading--;
		}
	}

	function handleImageUpload(event: Event) {
		const file = (event.target as HTMLInputElement).files?.[0];
		if (file) void ingestFile(file);
		if (imageInput) imageInput.value = '';
	}

	function handleAttachUpload(event: Event) {
		const files = (event.target as HTMLInputElement).files;
		for (const file of files ?? []) void ingestFile(file);
		if (attachInput) attachInput.value = '';
	}

	let activeStates = $state({
		bold: false,
		italic: false,
		h1: false,
		h2: false,
		h3: false,
		bullet: false,
		code: false
	});

	// Link Popover State
	let showLinkPopover = $state(false);
	let linkUrl = $state('');
	let linkInputEl = $state<HTMLInputElement>();



	// Stock images & icons for the Media Library
	const STOCK_IMAGES = [
		{
			src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%23ff9a9e"/><stop offset="99%" stop-color="%23fecfef"/></linearGradient></defs><rect width="100%" height="100%" fill="url(%23g1)"/></svg>',
			alt: 'Warm Pink Gradient',
			noteTitle: 'Stock',
			noteId: 'stock'
		},
		{
			src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%23a1c4fd"/><stop offset="100%" stop-color="%23c2e9fb"/></linearGradient></defs><rect width="100%" height="100%" fill="url(%23g2)"/></svg>',
			alt: 'Cool Blue Gradient',
			noteTitle: 'Stock',
			noteId: 'stock'
		},
		{
			src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%23f6d365"/><stop offset="100%" stop-color="%23fda085"/></linearGradient></defs><rect width="100%" height="100%" fill="url(%23g3)"/></svg>',
			alt: 'Sunny Orange Gradient',
			noteTitle: 'Stock',
			noteId: 'stock'
		},
		{
			src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g4" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="%2384fab0"/><stop offset="100%" stop-color="%238fd3f4"/></linearGradient></defs><rect width="100%" height="100%" fill="url(%23g4)"/></svg>',
			alt: 'Fresh Mint Gradient',
			noteTitle: 'Stock',
			noteId: 'stock'
		},
		{
			src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%233182ce" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
			alt: 'Info Icon',
			noteTitle: 'Stock Icon',
			noteId: 'stock'
		},
		{
			src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%23e53e3e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
			alt: 'Warning Icon',
			noteTitle: 'Stock Icon',
			noteId: 'stock'
		},
		{
			src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%2338a169" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>',
			alt: 'Success Icon',
			noteTitle: 'Stock Icon',
			noteId: 'stock'
		},
		{
			src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="%23dd6b20" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
			alt: 'Question Icon',
			noteTitle: 'Stock Icon',
			noteId: 'stock'
		}
	];

	// Dropdown States
	let showTextDropdown = $state(false);
	let showAlignDropdown = $state(false);
	let showTableDropdown = $state(false);
	let showTriageDropdown = $state(false);
	let showImageDropdown = $state(false);

	let libraryImages = $state<Array<{ src: string, alt: string, noteTitle: string, noteId: string }>>([]);

	async function loadLibraryImages() {
		try {
			const allNotes = await db.notes.toArray();
			const images: Array<{ src: string, alt: string, noteTitle: string, noteId: string }> = [];
			const seenUrls = new Set<string>();

			// Start with stock images so they are always available
			STOCK_IMAGES.forEach(img => {
				seenUrls.add(img.src);
				images.push(img);
			});

			allNotes.forEach((n: LocalNote) => {
				let htmlContent = n.content || '';
				if (n.id === note.id && editor) {
					htmlContent = editor.getHTML();
				}
				if (!htmlContent) return;

				const parser = new DOMParser();
				const doc = parser.parseFromString(htmlContent, 'text/html');
				
				// 1. Scan <img> tags
				const imgs = doc.querySelectorAll('img');
				imgs.forEach(img => {
					const src = img.getAttribute('src');
					if (src && !seenUrls.has(src)) {
						seenUrls.add(src);
						const alt = img.getAttribute('alt') || 'Note Image';
						images.push({
							src,
							alt,
							noteTitle: n.title,
							noteId: n.id
						});
					}
				});

				// 2. Scan <a> tags pointing to images (attachments)
				const links = doc.querySelectorAll('a');
				links.forEach(link => {
					const href = link.getAttribute('href');
					if (href && !seenUrls.has(href)) {
						const linkText = link.textContent || '';
						const cleanUrl = href.split('?')[0].split('#')[0];
						const urlExt = cleanUrl.split('.').pop()?.toLowerCase() || '';
						const textExt = linkText.split('.').pop()?.toLowerCase() || '';
						
						const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
						const isImageLink = imageExtensions.includes(urlExt) || 
											imageExtensions.includes(textExt) ||
											href.includes('/storage/v1/object/public/clips/') && 
											(href.toLowerCase().endsWith('.png') || 
											 href.toLowerCase().endsWith('.jpg') || 
											 href.toLowerCase().endsWith('.jpeg') || 
											 href.toLowerCase().endsWith('.webp') ||
											 href.toLowerCase().endsWith('.gif') || 
											 href.toLowerCase().endsWith('.svg') ||
											 linkText.toLowerCase().includes('.png') ||
											 linkText.toLowerCase().includes('.jpg') ||
											 linkText.toLowerCase().includes('.jpeg') ||
											 linkText.toLowerCase().includes('.webp') ||
											 linkText.toLowerCase().includes('.gif') ||
											 linkText.toLowerCase().includes('.svg'));
						
						if (isImageLink) {
							seenUrls.add(href);
							const cleanAlt = linkText.replace(/^📎\s*/, '').trim() || 'Attached Image';
							images.push({
								src: href,
								alt: cleanAlt,
								noteTitle: n.title,
								noteId: n.id
							});
						}
					}
				});
			});

			// Fetch uploaded files from Supabase Storage via our server API
			try {
				const sessionRes = await supabase.auth.getSession();
				const session = sessionRes.data?.session;
				if (session) {
					const response = await fetch('/api/upload', {
						headers: {
							Authorization: `Bearer ${session.access_token}`
						}
					});
					if (response.ok) {
						const storageFiles: Array<{ url: string, name: string, mime_type: string, size: number }> = await response.json();
						storageFiles.forEach(file => {
							if (!seenUrls.has(file.url)) {
								const isImg = file.mime_type.startsWith('image/') || 
									['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(file.name.split('.').pop()?.toLowerCase() || '');
								if (isImg) {
									seenUrls.add(file.url);
									images.push({
										src: file.url,
										alt: file.name,
										noteTitle: 'Storage Attachment',
										noteId: 'storage'
									});
								}
							}
						});
					}
				}
			} catch (e) {
				console.warn('Could not fetch storage attachments:', e);
			}

			libraryImages = images;
		} catch (err) {
			console.error('Failed to load library images:', err);
		}
	}

	// Right Sidebar State
	let showRightSidebar = $state(true);

	$effect(() => {
		if (showTextDropdown || showAlignDropdown || showTableDropdown || showTriageDropdown || showImageDropdown) {
			const handleOutsideClick = (e: MouseEvent) => {
				const target = e.target as HTMLElement;
				if (!target.closest('.text-style-container')) {
					showTextDropdown = false;
				}
				if (!target.closest('.align-container')) {
					showAlignDropdown = false;
				}
				if (!target.closest('.table-actions-container')) {
					showTableDropdown = false;
				}
				if (!target.closest('.triage-container')) {
					showTriageDropdown = false;
				}
				if (!target.closest('.image-dropdown-container')) {
					showImageDropdown = false;
				}
			};
			document.addEventListener('click', handleOutsideClick);
			return () => document.removeEventListener('click', handleOutsideClick);
		}
	});

	function openLinkPopover() {
		if (!editor) return;
		linkUrl = editor.getAttributes('link').href || '';
		showLinkPopover = !showLinkPopover;
		if (showLinkPopover) {
			setTimeout(() => linkInputEl?.focus(), 50);
		}
	}

	function saveLink(e: SubmitEvent) {
		e.preventDefault();
		if (!editor) return;
		if (linkUrl.trim() === '') {
			editor.chain().focus().extendMarkRange('link').unsetLink().run();
		} else {
			let formattedUrl = linkUrl.trim();
			if (!/^https?:\/\//i.test(formattedUrl) && !/^\//.test(formattedUrl)) {
				formattedUrl = 'https://' + formattedUrl;
			}
			editor.chain().focus().extendMarkRange('link').setLink({ href: formattedUrl }).run();
		}
		showLinkPopover = false;
	}

	function removeLink() {
		if (!editor) return;
		editor.chain().focus().extendMarkRange('link').unsetLink().run();
		showLinkPopover = false;
	}

	let slashMenuOpen = $state(false);
	let slashMenuCoords = $state({ top: 0, left: 0 });
	let slashQuery = $state('');
	let selectedIndex = $state(0);

	const COMMANDS = [
		{
			id: 'h1',
			title: 'Heading 1',
			description: 'Large section heading',
			run: (editor: Editor) => {
				const { selection } = editor.state;
				const from = selection.$from;
				editor.chain().focus()
					.deleteRange({ from: from.start(), to: from.pos })
					.toggleHeading({ level: 1 })
					.run();
			}
		},
		{
			id: 'h2',
			title: 'Heading 2',
			description: 'Medium section heading',
			run: (editor: Editor) => {
				const { selection } = editor.state;
				const from = selection.$from;
				editor.chain().focus()
					.deleteRange({ from: from.start(), to: from.pos })
					.toggleHeading({ level: 2 })
					.run();
			}
		},
		{
			id: 'h3',
			title: 'Heading 3',
			description: 'Small section heading',
			run: (editor: Editor) => {
				const { selection } = editor.state;
				const from = selection.$from;
				editor.chain().focus()
					.deleteRange({ from: from.start(), to: from.pos })
					.toggleHeading({ level: 3 })
					.run();
			}
		},
		{
			id: 'bullet',
			title: 'Bulleted List',
			description: 'Create a simple bulleted list',
			run: (editor: Editor) => {
				const { selection } = editor.state;
				const from = selection.$from;
				editor.chain().focus()
					.deleteRange({ from: from.start(), to: from.pos })
					.toggleBulletList()
					.run();
			}
		},
		{
			id: 'code',
			title: 'Code Block',
			description: 'Insert a code block',
			run: (editor: Editor) => {
				const { selection } = editor.state;
				const from = selection.$from;
				editor.chain().focus()
					.deleteRange({ from: from.start(), to: from.pos })
					.toggleCodeBlock()
					.run();
			}
		},
		{
			id: 'table',
			title: 'Table',
			description: 'Insert a 3x3 table',
			run: (editor: Editor) => {
				const { selection } = editor.state;
				const from = selection.$from;
				editor.chain().focus()
					.deleteRange({ from: from.start(), to: from.pos })
					.insertTable({ rows: 3, cols: 3, withHeaderRow: true })
					.run();
			}
		}
	];

	const filteredCommands = $derived(
		COMMANDS.filter(cmd =>
			cmd.title.toLowerCase().includes(slashQuery.toLowerCase()) ||
			cmd.id.toLowerCase().includes(slashQuery.toLowerCase())
		)
	);

	function runCommand(cmd: typeof COMMANDS[0]) {
		if (editor) {
			cmd.run(editor);
			slashMenuOpen = false;
		}
	}

	function checkSlashCommand() {
		if (!editor) return;
		const { selection } = editor.state;
		const from = selection.$from;
		const isParagraph = from.parent.type.name === 'paragraph';

		if (isParagraph) {
			const text = from.parent.textContent;
			if (text.startsWith('/') && !text.includes(' ')) {
				slashMenuOpen = true;
				slashQuery = text.slice(1);

				if (selectedIndex >= filteredCommands.length) {
					selectedIndex = 0;
				}

				const coords = editor.view.coordsAtPos(from.pos);
				slashMenuCoords = {
					top: coords.bottom,
					left: coords.left
				};
				return;
			}
		}
		slashMenuOpen = false;
	}

	function updateActiveStates() {
		if (!editor) return;
		activeStates = {
			bold: editor.isActive('bold'),
			italic: editor.isActive('italic'),
			h1: editor.isActive('heading', { level: 1 }),
			h2: editor.isActive('heading', { level: 2 }),
			h3: editor.isActive('heading', { level: 3 }),
			bullet: editor.isActive('bulletList'),
			code: editor.isActive('codeBlock')
		};
		imageActive = editor.isActive('image');
		tableActive = editor.isActive('table');
		if (imageActive) {
			const attrs = editor.getAttributes('image');
			imageAlignment = attrs.alignment || 'center';
		} else {
			imageAlignment = 'center';
		}

		// Update font styling attributes
		const styleAttrs = editor.getAttributes('customStyle');
		currentFontFamily = styleAttrs.fontFamily || '';
		currentFontSize = styleAttrs.fontSize || '';

		// Track selected image position
		const { selection } = editor.state;
		if (selection && (selection as any).node && (selection as any).node.type.name === 'image') {
			selectedImagePos = selection.from;
		} else {
			selectedImagePos = null;
		}
	}

	// Svelte 5 reactive helper to track editor changes for ToC and Highlights
	let headingsVersion = $state(0);
	function updateHeadings() {
		headingsVersion++;
	}

	// Derived store parsing document's h1, h2, h3 tags
	const headings = $derived.by(() => {
		const _ = headingsVersion;
		if (!editor) return [];
		const list: { id: string; text: string; level: number; pos: number }[] = [];
		editor.state.doc.descendants((node, pos) => {
			if (node.type.name === 'heading') {
				const level = node.attrs.level;
				if (level === 1 || level === 2 || level === 3) {
					list.push({
						id: `heading-${pos}`,
						text: node.textContent || 'Untitled Heading',
						level,
						pos
					});
				}
			}
		});
		return list;
	});

	// Derived store parsing document's bold/italic texts
	const highlights = $derived.by(() => {
		const _ = headingsVersion;
		if (!editor) return [];
		const list: string[] = [];
		editor.state.doc.descendants((node) => {
			if (node.isText) {
				const hasBold = node.marks.some(m => m.type.name === 'bold');
				const hasItalic = node.marks.some(m => m.type.name === 'italic');
				if (hasBold || hasItalic) {
					const textVal = node.text?.trim();
					if (textVal && !list.includes(textVal)) {
						list.push(textVal);
					}
				}
			}
		});
		return list.slice(0, 10); // cap at 10 highlights
	});

	function scrollToHeading(pos: number) {
		if (!editor) return;
		editor.commands.focus();
		try {
			const domNode = editor.view.nodeDOM(pos) as HTMLElement;
			if (domNode) {
				domNode.scrollIntoView({ behavior: 'smooth', block: 'center' });
				editor.commands.setTextSelection(pos);
			}
		} catch (e) {
			console.error('Error scrolling to heading:', e);
		}
	}

	// Indentation triggers
	function indent() {
		if (!editor) return;
		if (editor.isActive('bulletList') || editor.isActive('orderedList')) {
			editor.chain().focus().sinkListItem('listItem').run();
		} else {
			editor.chain().focus().indent().run();
		}
	}

	function outdent() {
		if (!editor) return;
		if (editor.isActive('bulletList') || editor.isActive('orderedList')) {
			editor.chain().focus().liftListItem('listItem').run();
		} else {
			editor.chain().focus().outdent().run();
		}
	}

	// Write-through on every keystroke: Dexie writes are ~1ms and the store
	// debounces the network sync, so there is no pending edit to lose when
	// the component is torn down mid-typing (e.g. switching notes).
	// Remember what we last wrote so the liveQuery echo of our own save is
	// recognized and ignored (previously the echo path re-serialized the
	// whole document via getHTML() on every emission, and Tiptap's HTML
	// normalization could make that comparison fail forever).
	// svelte-ignore state_referenced_locally
	let lastSavedTitle = note.title;
	// svelte-ignore state_referenced_locally
	let lastSavedContent = note.content;

	async function save() {
		status = 'saving';
		inFlight++;
		lastSavedTitle = title;
		lastSavedContent = content;
		await notes.updateNote(note.id, { title, content });
		if (--inFlight === 0) status = 'saved';
	}

	function onTitleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			editor?.commands.focus();
		}
	}

	let ignoreUpdate = false;

	onMount(() => {
		editor = new Editor({
			element: editorElement,
			extensions: [
				StarterKit.configure({
					link: false
				}),
				CustomImage,
				CustomStyle,
				Link.configure({
					openOnClick: false,
					HTMLAttributes: {
						class: 'editor-link'
					}
				}),
				TextAlign.configure({
					types: ['heading', 'paragraph']
				}),
				Indent.configure({
					types: ['paragraph', 'heading'],
					minLevel: 0,
					maxLevel: 8
				}),
				Placeholder.configure({
					placeholder: 'Start writing…'
				}),
				Table.configure({
					resizable: true
				}),
				TableRow,
				TableHeader,
				TableCell
			],
			content: content,
			editorProps: {
				handleDrop(view, event) {
					const files = event.dataTransfer?.files;
					if (!files?.length) return false; // normal content drops proceed as usual
					event.preventDefault();
					const drop = view.posAtCoords({ left: event.clientX, top: event.clientY });
					if (drop) {
						editor?.commands.setTextSelection(drop.pos);
					}
					for (const file of files) void ingestFile(file);
					return true;
				},
				handleKeyDown(view, event) {
					if (slashMenuOpen) {
						if (event.key === 'ArrowDown') {
							selectedIndex = (selectedIndex + 1) % filteredCommands.length;
							return true;
						}
						if (event.key === 'ArrowUp') {
							selectedIndex = (selectedIndex - 1 + filteredCommands.length) % filteredCommands.length;
							return true;
						}
						if (event.key === 'Enter') {
							if (filteredCommands[selectedIndex]) {
								runCommand(filteredCommands[selectedIndex]);
								return true;
							}
						}
						if (event.key === 'Escape') {
							slashMenuOpen = false;
							return true;
						}
					}
					return false;
				}
			},
			onUpdate: ({ editor }) => {
				if (ignoreUpdate) return;
				content = editor.getHTML();
				void save();
				checkSlashCommand();
				updateActiveStates();
				updateHeadings();
			},
			onSelectionUpdate: () => {
				checkSlashCommand();
				updateActiveStates();
				updateHeadings();
			},
			onCreate: () => {
				updateHeadings();
			}
		});

		// Links inside contenteditable don't navigate natively. Attachment
		// links open on plain click (they're rarely edited); ordinary links
		// keep Ctrl/Cmd+click so text editing isn't hijacked.
		editorElement?.addEventListener('click', (event) => {
			const anchor = (event.target as HTMLElement).closest?.('a');
			if (!anchor?.href) return;
			const isAttachment = anchor.href.includes('/storage/v1/object/public/clips/');
			if (isAttachment || event.ctrlKey || event.metaKey) {
				event.preventDefault();
				window.open(anchor.href, '_blank', 'noopener');
			}
		});
	});

	onDestroy(() => {
		if (editor) {
			editor.destroy();
		}
		if (elapsedTimer) clearInterval(elapsedTimer);
		recordingController?.cancel();
	});

	// Keep local state in sync with note changes (either switching notes or background updates)
	// svelte-ignore state_referenced_locally
	let lastNoteId = $state(note.id);

	// Parsing a large document in setContent blocks the main thread; defer
	// it past the click's paint so selecting a note highlights instantly.
	// The token makes rapid switches latest-wins.
	let pendingContentLoad = 0;
	function loadIntoEditor(html: string) {
		const token = ++pendingContentLoad;
		requestAnimationFrame(() => {
			if (token !== pendingContentLoad || !editor) return;
			ignoreUpdate = true;
			editor.commands.setContent(html);
			ignoreUpdate = false;
			updateActiveStates();
			updateHeadings();
		});
	}

	$effect(() => {
		// Read prop dependencies outside untrack
		const activeId = note.id;
		const activeTitle = note.title;
		const activeContent = note.content;

		untrack(() => {
			if (activeId !== lastNoteId) {
				// Note switched!
				lastNoteId = activeId;
				title = activeTitle;
				content = activeContent;
				lastSavedTitle = activeTitle;
				lastSavedContent = activeContent;
				loadIntoEditor(activeContent);
			} else {
				// Same note: apply genuine remote changes, ignore echoes of our
				// own saves (compare stored strings — never re-serialize the doc).
				if (activeTitle !== lastSavedTitle && activeTitle !== title) {
					title = activeTitle;
					lastSavedTitle = activeTitle;
				}
				if (activeContent !== lastSavedContent && !editor?.isFocused) {
					content = activeContent;
					lastSavedContent = activeContent;
					loadIntoEditor(activeContent);
				}
			}
		});
	});
</script>

<div class="editor-workspace">
	<div class="editor">
		<div class="titlebar">
			<button 
				type="button"
				class="bookmark-toggle"
				onclick={toggleBookmark}
				title={isBookmarked ? "Remove Bookmark" : "Bookmark Note"}
				class:bookmarked={isBookmarked}
			>
				<Star size={18} fill={isBookmarked ? "#ffc107" : "none"} stroke={isBookmarked ? "#ffc107" : "currentColor"} />
			</button>
			<input
				class="title"
				type="text"
				placeholder="Untitled"
				bind:value={title}
				oninput={() => void save()}
				onkeydown={onTitleKeydown}
			/>
			<div class="meta-actions">
				<button class="clone-note-btn" onclick={() => notes.startClone(note.id)}>
					<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
						<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
						<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
					</svg>
					Clone Note
				</button>
				<button 
					class="sidebar-toggle-btn" 
					class:active={showRightSidebar}
					onclick={() => showRightSidebar = !showRightSidebar}
					title="Toggle Outline Sidebar"
				>
					<PanelRight size={14} />
					{showRightSidebar ? 'Hide Outline' : 'Show Outline'}
				</button>
				<button 
					class="split-toggle-btn" 
					class:active={splitView}
					onclick={() => splitView = !splitView}
					title="Toggle Split View"
				>
					<Columns2 size={14} />
					{splitView ? 'Close Split' : 'Split View'}
				</button>
				<div class="share-container">
					<button 
						class="share-web-btn"
						class:shared={isShared}
						onclick={() => sharePopoverOpen = !sharePopoverOpen}
						title="Share to Web"
					>
						{#if isShared}
							<Globe size={14} />
							Published
						{:else}
							<Share2 size={14} />
							Share to Web
						{/if}
					</button>

					{#if sharePopoverOpen}
						<div class="share-popover">
							{#if !isShared}
								<div class="share-popover-content">
									<p class="share-desc">Publish this note to the web to make it accessible to anyone with the link.</p>
									<button class="primary-share-btn" onclick={generatePublicLink}>
										Generate Public Link
									</button>
								</div>
							{:else}
								<div class="share-popover-content">
									<p class="share-title">Public Link</p>
									<div class="copy-box">
										<input 
											type="text" 
											readonly 
											value={`${location.origin}/share/${note.id}`}
											class="copy-input"
											onclick={(e) => (e.target as HTMLInputElement).select()}
										/>
										<button class="copy-btn" onclick={copyToClipboard} title="Copy to Clipboard">
											{#if copySuccess}
												<Check size={14} class="success-icon" />
											{:else}
												<Copy size={14} />
											{/if}
										</button>
									</div>
									<button class="stop-sharing-btn" onclick={stopSharing}>
										Stop Sharing
									</button>
								</div>
							{/if}
						</div>
					{/if}
				</div>

				<div class="graduate-container">
					<button 
						class="graduate-btn" 
						onclick={() => graduateMenuOpen = !graduateMenuOpen}
						title="Graduate Note"
					>
						<ExternalLink size={14} />
						Graduate Note
					</button>

					{#if graduateMenuOpen}
						<div class="graduate-dropdown">
							<div class="graduate-header">Archive Target</div>
							<button class="target-item" onclick={() => selectTarget('Organiser')}>
								<span class="icon">🏢</span>
								<div class="details">
									<span class="name">Export to Organiser</span>
									<span class="url">organiser.example.com</span>
								</div>
							</button>
							<button class="target-item" onclick={() => selectTarget('Locker')}>
								<span class="icon">🔒</span>
								<div class="details">
									<span class="name">Export to Locker</span>
									<span class="url">locker.example.com</span>
								</div>
							</button>
						</div>
					{/if}
				</div>
				<span class="status" class:visible={status !== 'idle'}>
					{status === 'saving' ? 'Saving…' : 'Saved'}
				</span>
			</div>
		</div>

		<div class="view-selector-tabs">
			<button class="view-tab" class:active={currentViewType === 'editor'} onclick={() => setViewType('editor')}>
				<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tab-icon">
					<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
					<polyline points="14 2 14 8 20 8"/>
				</svg>
				<span>Document</span>
			</button>
			<button class="view-tab" class:active={currentViewType === 'board'} onclick={() => setViewType('board')}>
				<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tab-icon">
					<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
					<line x1="9" y1="3" x2="9" y2="21"/>
					<line x1="15" y1="3" x2="15" y2="21"/>
					<line x1="3" y1="9" x2="21" y2="9"/>
				</svg>
				<span>Kanban</span>
			</button>
			<button class="view-tab" class:active={currentViewType === 'grid'} onclick={() => setViewType('grid')}>
				<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tab-icon">
					<rect x="3" y="3" width="7" height="9"/>
					<rect x="14" y="3" width="7" height="5"/>
					<rect x="14" y="12" width="7" height="9"/>
					<rect x="3" y="16" width="7" height="5"/>
				</svg>
				<span>Grid View</span>
			</button>
			<button class="view-tab" class:active={currentViewType === 'list'} onclick={() => setViewType('list')}>
				<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="tab-icon">
					<line x1="8" y1="6" x2="21" y2="6"/>
					<line x1="8" y1="12" x2="21" y2="12"/>
					<line x1="8" y1="18" x2="21" y2="18"/>
					<line x1="3" y1="6" x2="3.01" y2="6"/>
					<line x1="3" y1="12" x2="3.01" y2="12"/>
					<line x1="3" y1="18" x2="3.01" y2="18"/>
				</svg>
				<span>List View</span>
			</button>
		</div>

		<div class="note-paths" title="Everywhere this note lives in the workspace">
			{#each parentPathList as path (path)}
				<span class="path-chip">{path}</span>
			{/each}
		</div>

		{#if backlinks.length}
			<div class="backlinks-row" title="Notes whose relations point at this note">
				<span class="backlinks-label">Referenced by</span>
				{#each backlinks as bl (bl.attrId)}
					<button class="backlink-chip" onclick={() => notes.select(bl.sourceId)}>
						{bl.sourceTitle} <em>~{bl.key}</em>
					</button>
				{/each}
			</div>
		{/if}

		<div class="attributes-container">
			{#each attributes as attr (attr.id)}
				{#if editingAttrId === attr.id}
					<input
						type="text"
						class="attr-edit-input"
						bind:value={editAttrText}
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								void saveEditAttr();
							}
							if (e.key === 'Escape') editingAttrId = null;
						}}
						onblur={() => void saveEditAttr()}
						autofocus
					/>
				{:else}
					<div class="attribute-pill" class:relation={attr.type === 'relation'}>
						<button
							type="button"
							class="attr-text"
							title={attr.type === 'relation' ? 'Relation (edit via + Add Attribute)' : 'Click to edit'}
							onclick={() => startEditAttr(attr)}
						>
							{attr.type === 'relation' ? '~' : '#'}{attr.key}{attr.value ? `:${attr.value}` : ''}
						</button>
						{#if attr.type === 'label'}
							<button
								type="button"
								class="attr-search-btn"
								title="Find all notes with this tag"
								onclick={() => searchForAttr(attr)}
							>
								⌕
							</button>
						{/if}
						<button
							type="button"
							class="remove-attr-btn"
							onclick={() => void notes.removeAttribute(attr.id)}
							title="Delete attribute"
						>
							&times;
						</button>
					</div>
				{/if}
			{/each}

			<div class="quick-tag-wrapper">
				<input
					type="text"
					class="quick-tag-input"
					placeholder="+ tag (key:value) ⏎"
					bind:value={quickTag}
					onfocus={() => {
						quickTagOpen = true;
						quickTagIndex = -1;
					}}
					onblur={() => setTimeout(() => (quickTagOpen = false), 150)}
					onkeydown={quickTagKeydown}
					autocomplete="off"
				/>
				{#if quickTagOpen && quickTag.trim() && quickSuggestions.length > 0}
					<ul class="suggestions-list">
						{#each quickSuggestions as suggestion, idx (suggestion.insert)}
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
							<li
								class:selected={idx === quickTagIndex}
								onmousedown={(e) => {
									e.preventDefault();
									applyQuickSuggestion(suggestion);
								}}
							>
								{suggestion.display}
							</li>
						{/each}
					</ul>
				{/if}
			</div>

			<div class="add-attr-wrapper">
				<button 
					type="button" 
					class="add-attr-btn" 
					onclick={() => showAddPopover = !showAddPopover}
				>
					+ Add Attribute
				</button>
				{#if showAddPopover}
					<div class="add-attr-popover">
						<form onsubmit={(e) => { e.preventDefault(); void saveNewAttribute(); }} class="popover-form">
							<div class="form-group">
								<label for="new-attr-type">Type</label>
								<select id="new-attr-type" bind:value={newAttrType}>
									<option value="label">Label</option>
									<option value="relation">Relation</option>
								</select>
							</div>
							<div class="form-group autocomplete-wrapper">
								<label for="new-attr-key">Key</label>
								<input 
									id="new-attr-key" 
									type="text" 
									placeholder="e.g. cssClass" 
									bind:value={newAttrKey} 
									bind:this={keyInputEl}
									onfocus={() => { keySuggestionsOpen = true; keySelectedIndex = -1; }}
									onblur={() => { setTimeout(() => keySuggestionsOpen = false, 150); }}
									onkeydown={handleKeyKeydown}
									autocomplete="off"
									required 
								/>
								{#if keySuggestionsOpen && filteredKeySuggestions.length > 0}
									<ul class="suggestions-list">
										{#each filteredKeySuggestions as suggestion, idx}
											<!-- svelte-ignore a11y_click_events_have_key_events -->
											<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
											<li 
												class:selected={idx === keySelectedIndex}
												onmousedown={() => selectKeySuggestion(suggestion)}
											>
												{suggestion}
											</li>
										{/each}
									</ul>
								{/if}
							</div>
							<div class="form-group autocomplete-wrapper">
								<label for="new-attr-val">Value</label>
								<input 
									id="new-attr-val" 
									type="text" 
									placeholder="e.g. dark" 
									bind:value={newAttrValue} 
									bind:this={valueInputEl}
									onfocus={() => { valueSuggestionsOpen = true; valueSelectedIndex = -1; }}
									onblur={() => { setTimeout(() => valueSuggestionsOpen = false, 150); }}
									onkeydown={handleValueKeydown}
									autocomplete="off"
								/>
								{#if valueSuggestionsOpen && filteredValueSuggestions.length > 0}
									<ul class="suggestions-list">
										{#each filteredValueSuggestions as suggestion, idx}
											<!-- svelte-ignore a11y_click_events_have_key_events -->
											<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
											<li 
												class:selected={idx === valueSelectedIndex}
												onmousedown={() => selectValueSuggestion(suggestion)}
											>
												{suggestion}
											</li>
										{/each}
									</ul>
								{/if}
							</div>
							<div class="popover-actions">
								<button type="button" class="cancel" onclick={() => showAddPopover = false}>Cancel</button>
								<button type="submit" class="save" disabled={!newAttrKey.trim()}>Add</button>
							</div>
						</form>
					</div>
				{/if}
			</div>
		</div>

		<!-- Professional Dense Toolbar Organization -->
		{#if !isReadingMode && currentViewType === 'editor'}
			<div class="toolbar">
				<!-- Group 1: Text Styling -->
			<select 
				class="toolbar-select font-family-select"
				value={currentFontFamily}
				onchange={(e) => changeFontFamily((e.target as HTMLSelectElement).value)}
				title="Font Family"
			>
				<option value="">Default Font</option>
				<option value="Arial, Helvetica, sans-serif">Arial</option>
				<option value="'Times New Roman', Times, serif">Times New Roman</option>
				<option value="Georgia, serif">Georgia</option>
				<option value="Garamond, Baskerville, serif">Garamond</option>
				<option value="sans-serif">Sans-Serif</option>
				<option value="serif">Serif</option>
				<option value="monospace">Monospace</option>
			</select>

			<select 
				class="toolbar-select font-size-select"
				value={currentFontSize}
				onchange={(e) => changeFontSize((e.target as HTMLSelectElement).value)}
				title="Font Size"
			>
				<option value="">Default Size</option>
				{#each Array.from({ length: 9 }, (_, i) => i + 8) as size}
					<option value="{size}px">{size}px</option>
				{/each}
			</select>
			<button
				class="toolbar-btn"
				class:active={activeStates.bold}
				onclick={() => editor?.chain().focus().toggleBold().run()}
				title="Bold (Ctrl+B)"
			>
				<BoldIcon size={15} />
			</button>
			<button
				class="toolbar-btn"
				class:active={activeStates.italic}
				onclick={() => editor?.chain().focus().toggleItalic().run()}
				title="Italic (Ctrl+I)"
			>
				<ItalicIcon size={15} />
			</button>
			
			<div style="position: relative; display: inline-block;">
				<button
					class="toolbar-btn"
					class:active={editor?.isActive('link')}
					onclick={openLinkPopover}
					title="Insert Link"
				>
					<LinkIcon size={15} />
				</button>
				{#if showLinkPopover}
					<div class="link-popover">
						<form onsubmit={saveLink} class="popover-form">
							<div class="form-group">
								<label for="link-url">URL</label>
								<input
									id="link-url"
									type="text"
									placeholder="https://example.com"
									bind:value={linkUrl}
									bind:this={linkInputEl}
									required
								/>
							</div>
							<div class="popover-actions">
								{#if editor?.isActive('link')}
									<button type="button" class="remove-btn" onclick={removeLink}>Remove</button>
								{/if}
								<button type="button" class="cancel" onclick={() => showLinkPopover = false}>Cancel</button>
								<button type="submit" class="save">Apply</button>
							</div>
						</form>
					</div>
				{/if}
			</div>

			<!-- Text Style Dropdown -->
			<div class="toolbar-dropdown-container text-style-container">
				<button 
					class="toolbar-select" 
					onclick={() => {
						showTextDropdown = !showTextDropdown;
						showAlignDropdown = false;
						showTableDropdown = false;
						showTriageDropdown = false;
					}}
					style="display: flex; align-items: center; gap: 0.25rem; min-width: 90px; text-align: left; justify-content: space-between;"
				>
					<span>{activeStates.h1 ? 'Heading 1' : activeStates.h2 ? 'Heading 2' : activeStates.h3 ? 'Heading 3' : 'Paragraph'}</span>
					<span style="font-size: 0.5rem; opacity: 0.7;">▼</span>
				</button>
				{#if showTextDropdown}
					<div class="toolbar-dropdown-menu">
						<button 
							class="toolbar-dropdown-item" 
							class:active={!activeStates.h1 && !activeStates.h2 && !activeStates.h3}
							onclick={() => {
								editor?.chain().focus().setParagraph().run();
								showTextDropdown = false;
							}}
						>
							Paragraph
						</button>
						<button 
							class="toolbar-dropdown-item" 
							class:active={activeStates.h1}
							onclick={() => {
								editor?.chain().focus().toggleHeading({ level: 1 }).run();
								showTextDropdown = false;
							}}
						>
							Heading 1
						</button>
						<button 
							class="toolbar-dropdown-item" 
							class:active={activeStates.h2}
							onclick={() => {
								editor?.chain().focus().toggleHeading({ level: 2 }).run();
								showTextDropdown = false;
							}}
						>
							Heading 2
						</button>
						<button 
							class="toolbar-dropdown-item" 
							class:active={activeStates.h3}
							onclick={() => {
								editor?.chain().focus().toggleHeading({ level: 3 }).run();
								showTextDropdown = false;
							}}
						>
							Heading 3
						</button>
					</div>
				{/if}
			</div>

			<!-- Alignment Dropdown -->
			<div class="toolbar-dropdown-container align-container">
				<button 
					class="toolbar-select" 
					onclick={() => {
						showAlignDropdown = !showAlignDropdown;
						showTextDropdown = false;
						showTableDropdown = false;
						showTriageDropdown = false;
					}}
					style="display: flex; align-items: center; justify-content: center; gap: 0.25rem; min-width: 48px; height: 28px; padding: 0 0.5rem; margin-right: 0.25rem;"
					title="Text Alignment"
				>
					{#if editor?.isActive({ textAlign: 'center' })}
						<AlignCenter size={16} />
					{:else if editor?.isActive({ textAlign: 'right' })}
						<AlignRight size={16} />
					{:else if editor?.isActive({ textAlign: 'justify' })}
						<AlignJustify size={16} />
					{:else}
						<AlignLeft size={16} />
					{/if}
					<span style="font-size: 0.6rem; opacity: 0.7; margin-left: 2px;">▼</span>
				</button>
				{#if showAlignDropdown}
					<div class="toolbar-dropdown-menu" style="min-width: 120px;">
						<button 
							class="toolbar-dropdown-item" 
							class:active={editor?.isActive({ textAlign: 'left' })}
							onclick={() => {
								editor?.chain().focus().setTextAlign('left').run();
								showAlignDropdown = false;
							}}
						>
							<AlignLeft size={14} /> Align Left
						</button>
						<button 
							class="toolbar-dropdown-item" 
							class:active={editor?.isActive({ textAlign: 'center' })}
							onclick={() => {
								editor?.chain().focus().setTextAlign('center').run();
								showAlignDropdown = false;
							}}
						>
							<AlignCenter size={14} /> Align Center
						</button>
						<button 
							class="toolbar-dropdown-item" 
							class:active={editor?.isActive({ textAlign: 'right' })}
							onclick={() => {
								editor?.chain().focus().setTextAlign('right').run();
								showAlignDropdown = false;
							}}
						>
							<AlignRight size={14} /> Align Right
						</button>
						<button 
							class="toolbar-dropdown-item" 
							class:active={editor?.isActive({ textAlign: 'justify' })}
							onclick={() => {
								editor?.chain().focus().setTextAlign('justify').run();
								showAlignDropdown = false;
							}}
						>
							<AlignJustify size={14} /> Justify
						</button>
					</div>
				{/if}
			</div>

			<div class="divider"></div>

			<!-- Group 3: List & Indentation Controls -->
			<button
				class="toolbar-btn"
				class:active={activeStates.bullet}
				onclick={() => editor?.chain().focus().toggleBulletList().run()}
				title="Bulleted List"
			>
				<ListIcon size={15} />
			</button>
			<button
				class="toolbar-btn"
				class:active={editor?.isActive('orderedList')}
				onclick={() => editor?.chain().focus().toggleOrderedList().run()}
				title="Numbered List"
			>
				<ListOrderedIcon size={15} />
			</button>
			<button
				class="toolbar-btn"
				onclick={indent}
				title="Increase Indent"
			>
				<IndentIcon size={15} />
			</button>
			<button
				class="toolbar-btn"
				onclick={outdent}
				title="Decrease Indent"
			>
				<OutdentIcon size={15} />
			</button>

			<div class="divider"></div>

			<!-- Group 4: Media Embeds -->
			<div class="toolbar-dropdown-container image-dropdown-container">
				<button
					class="toolbar-select"
					onclick={(e) => {
						e.stopPropagation();
						showImageDropdown = !showImageDropdown;
						showTextDropdown = false;
						showAlignDropdown = false;
						showTableDropdown = false;
						showTriageDropdown = false;
						if (showImageDropdown) {
							void loadLibraryImages();
						}
					}}
					style="display: flex; align-items: center; justify-content: center; gap: 0.25rem; min-width: 48px; height: 28px; padding: 0 0.5rem; margin-right: 0.25rem;"
					title="Insert or Upload Image"
				>
					<ImageIcon size={16} />
					<span style="font-size: 0.6rem; opacity: 0.7; margin-left: 2px;">▼</span>
				</button>
				{#if showImageDropdown}
					<div class="toolbar-dropdown-menu image-menu-dropdown" style="min-width: 460px; padding: 8px;">
						<button 
							class="toolbar-dropdown-item" 
							onclick={() => {
								triggerImageUpload();
								showImageDropdown = false;
							}}
							style="font-weight: 550; color: #c66930; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 4px;"
						>
							📤 Upload New Image...
						</button>
						
						<!-- Media Library Section -->
						<div class="media-library-section">
							<div class="media-library-header" style="font-size: 0.75rem; color: #718096; font-weight: 600; padding: 4px 6px;">
								Media Library ({libraryImages.length})
							</div>
							{#if libraryImages.length === 0}
								<div style="font-size: 0.75rem; color: #a0aec0; padding: 8px 6px; text-align: center;">
									No images in notes yet.
								</div>
							{:else}
								<div class="media-grid" style="display: grid; grid-template-columns: repeat(10, 1fr); gap: 4px; max-height: 240px; overflow-y: auto; padding: 4px;">
									{#each libraryImages as img}
										<button 
											class="media-grid-item" 
											onclick={() => {
												editor?.chain().focus().setImage({ src: img.src, alt: img.alt }).run();
												showImageDropdown = false;
											}}
											title="Used in: {img.noteTitle || 'untitled'}"
											style="border: 1px solid #e2e8f0; border-radius: 4px; padding: 2px; background: #fff; cursor: pointer; aspect-ratio: 1; display: flex; align-items: center; justify-content: center; overflow: hidden; transition: border-color 0.15s;"
										>
											<img 
												src={img.src} 
												alt={img.alt} 
												style="max-width: 100%; max-height: 100%; object-fit: cover;" 
												onerror={(e) => {
													(e.currentTarget as HTMLImageElement).src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="%23cbd5e1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';
												}}
											/>
										</button>
									{/each}
								</div>
							{/if}
						</div>
					</div>
				{/if}
			</div>
			<button
				class="toolbar-btn"
				onclick={() => attachInput?.click()}
				title="Attach file (or drag & drop into the note)"
			>
				<Paperclip size={15} />
			</button>
			<button
				class="toolbar-btn voice-btn"
				class:recording={voiceState === 'recording'}
				onclick={() => void toggleVoice()}
				disabled={voiceState === 'transcribing'}
				title={voiceState === 'recording' ? 'Stop recording' : 'Record a voice note (transcribed at the cursor)'}
			>
				{#if voiceState === 'recording'}
					<Square size={13} />
					<span class="voice-elapsed">{String(Math.floor(elapsedSec / 60)).padStart(2, '0')}:{String(
						elapsedSec % 60
					).padStart(2, '0')}</span>
				{:else if voiceState === 'transcribing'}
					<Loader2 size={15} class="spin" />
				{:else}
					<Mic size={15} />
				{/if}
			</button>
			{#if voiceState === 'recording'}
				<button class="toolbar-btn voice-cancel" onclick={cancelVoice} title="Cancel recording">
					<X size={13} />
				</button>
			{/if}
			<button
				class="toolbar-btn"
				onclick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
				title="Insert Table (3x3)"
			>
				<TableIcon size={15} />
			</button>
			<button
				class="toolbar-btn"
				onclick={() => window.print()}
				title="Print note / Save as PDF"
			>
				<Printer size={15} />
			</button>
			{#if uploading > 0}
				<span class="uploading-hint">Uploading…</span>
			{/if}
			{#if voiceError}
				<span class="uploading-hint voice-error">{voiceError}</span>
			{/if}
			{#if imageActive}
				<button
					class="toolbar-btn"
					class:active={imageAlignment === 'left'}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => {
						editor?.commands.updateAttributes('image', { alignment: 'left' });
						updateActiveStates();
					}}
					title="Align Left (Wrap Text)"
				>
					<AlignLeft size={15} />
				</button>
				<button
					class="toolbar-btn"
					class:active={imageAlignment === 'center'}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => {
						editor?.commands.updateAttributes('image', { alignment: 'center' });
						updateActiveStates();
					}}
					title="Align Center"
				>
					<AlignCenter size={15} />
				</button>
				<button
					class="toolbar-btn"
					class:active={imageAlignment === 'right'}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => {
						editor?.commands.updateAttributes('image', { alignment: 'right' });
						updateActiveStates();
					}}
					title="Align Right (Wrap Text)"
				>
					<AlignRight size={15} />
				</button>
			{/if}
			<button
				class="toolbar-btn"
				class:active={activeStates.code}
				onclick={() => editor?.chain().focus().toggleCodeBlock().run()}
				title="Code Block"
			>
				<CodeIcon size={15} />
			</button>

			{#if tableActive}
				<div class="divider"></div>
				<div class="toolbar-dropdown-container table-actions-container">
					<button 
						class="toolbar-btn" 
						onclick={(e) => {
							e.stopPropagation();
							showTableDropdown = !showTableDropdown;
							showTextDropdown = false;
							showAlignDropdown = false;
							showTriageDropdown = false;
						}}
						style="width: auto; padding: 0 0.5rem; gap: 0.25rem; font-size: 0.8125rem; background: #fff8f5; border: 1px solid #ffdcd0; color: #c66930; font-weight: 550; height: 28px;"
					>
						<span>Table Options</span>
						<span style="font-size: 0.5rem; opacity: 0.7;">▼</span>
					</button>
					{#if showTableDropdown}
						<div class="toolbar-dropdown-menu" style="min-width: 170px;">
							<button 
								class="toolbar-dropdown-item" 
								onclick={() => {
									editor?.chain().focus().addColumnBefore().run();
									showTableDropdown = false;
								}}
							>
								+ Add Column Left
							</button>
							<button 
								class="toolbar-dropdown-item" 
								onclick={() => {
									editor?.chain().focus().addColumnAfter().run();
									showTableDropdown = false;
								}}
							>
								+ Add Column Right
							</button>
							<button 
								class="toolbar-dropdown-item" 
								onclick={() => {
									editor?.chain().focus().deleteColumn().run();
									showTableDropdown = false;
								}}
							>
								- Delete Column
							</button>
							<div style="height: 1px; background: #e2e8f0; margin: 4px 0;"></div>
							<button 
								class="toolbar-dropdown-item" 
								onclick={() => {
									editor?.chain().focus().addRowBefore().run();
									showTableDropdown = false;
								}}
							>
								+ Add Row Above
							</button>
							<button 
								class="toolbar-dropdown-item" 
								onclick={() => {
									editor?.chain().focus().addRowAfter().run();
									showTableDropdown = false;
								}}
							>
								+ Add Row Below
							</button>
							<button 
								class="toolbar-dropdown-item" 
								onclick={() => {
									editor?.chain().focus().deleteRow().run();
									showTableDropdown = false;
								}}
							>
								- Delete Row
							</button>
							<div style="height: 1px; background: #e2e8f0; margin: 4px 0;"></div>
							<button 
								class="toolbar-dropdown-item" 
								onclick={() => {
									editor?.chain().focus().toggleHeaderRow().run();
									showTableDropdown = false;
								}}
							>
								Toggle Header Row
							</button>
							<button 
								class="toolbar-dropdown-item" 
								onclick={() => {
									editor?.chain().focus().deleteTable().run();
									showTableDropdown = false;
								}}
								style="color: #d9383a; font-weight: 550;"
							>
								Delete Table
							</button>
						</div>
					{/if}
				</div>
			{/if}

			<div class="divider"></div>
			<div class="toolbar-dropdown-container triage-container">
				<button 
					class="toolbar-btn triage-btn" 
					onclick={(e) => {
						e.stopPropagation();
						showTriageDropdown = !showTriageDropdown;
						showTextDropdown = false;
						showAlignDropdown = false;
						showTableDropdown = false;
					}}
					style="width: auto; padding: 0 0.5rem; gap: 0.25rem; font-size: 0.8125rem; height: 28px;"
				>
					<span>🧹 Triage</span>
					<span style="font-size: 0.5rem; opacity: 0.7;">▼</span>
				</button>
				{#if showTriageDropdown}
					<div class="toolbar-dropdown-menu" style="min-width: 160px; right: 0; left: auto;">
						<button 
							class="toolbar-dropdown-item" 
							onclick={() => {
								stripSocialNoise();
								showTriageDropdown = false;
							}}
							title="Strip social media noise (timestamps, reply links, empty lines)"
						>
							🧹 Strip Noise
						</button>
						<button 
							class="toolbar-dropdown-item" 
							onclick={() => {
								formatAsBlockquote();
								showTriageDropdown = false;
							}}
							title="Format selection as blockquote"
						>
							❝ Blockquote
						</button>
					</div>
				{/if}
			</div>
		</div>
		{/if}

		<input
			type="file"
			accept="image/*"
			style="display: none"
			bind:this={imageInput}
			onchange={handleImageUpload}
		/>
		<input
			type="file"
			multiple
			style="display: none"
			bind:this={attachInput}
			onchange={handleAttachUpload}
		/>

		<div 
			class="editor-content-wrapper {activeCssClasses.join(' ')}"
			class:split-mode={splitView}
			ondragenter={handleDragEnter}
			ondragover={handleDragOver}
			ondragleave={handleDragLeave}
			ondrop={handleDrop}
		>
			<div
				id="editor-container"
				class={activeCssClasses.join(' ')}
				style:display={currentViewType === 'editor' ? 'block' : 'none'}
				bind:this={editorElement}
			></div>

			{#if currentViewType === 'board'}
				<KanbanBoard {note} />
			{:else if currentViewType === 'grid'}
				<GridView {note} />
			{:else if currentViewType === 'list'}
				<ListView {note} />
			{/if}

			{#if splitView && currentViewType === 'editor'}
				<div class="right-viewer-pane">
					{#if activePdfUrl}
						<iframe 
							src={activePdfUrl} 
							class="pdf-viewer"
							title="PDF Reader"
						></iframe>
					{:else if activeImageUrl}
						<div class="image-viewer">
							<img src={activeImageUrl} alt="Source asset screenshot" />
						</div>
					{:else}
						<div class="viewer-placeholder">
							<p class="placeholder-icon">📄</p>
							<p class="placeholder-title">No PDF or Image Attachment Found</p>
							<p class="placeholder-desc">Drop a PDF or image into the editor, or select a note with a file to preview it here side-by-side.</p>
						</div>
					{/if}
				</div>
			{/if}

			{#if isDraggingOver}
				<div class="drag-drop-overlay">
					<div class="drag-drop-message">
						<span class="icon">📎</span>
						<p>Drop file to upload as attachment (Max 4MB)</p>
					</div>
				</div>
			{/if}

			{#if bubbleMenuCoords}
				<div 
					class="image-bubble-menu" 
					style="position: absolute; top: {bubbleMenuCoords.top}px; left: {bubbleMenuCoords.left}px;"
				>
					<button
						class="bubble-btn"
						class:active={imageAlignment === 'left'}
						onmousedown={(e) => e.preventDefault()}
						onclick={() => {
							editor?.commands.updateAttributes('image', { alignment: 'left' });
							updateActiveStates();
						}}
						title="Wrap Left"
					>
						<AlignLeft size={14} />
						Wrap Left
					</button>
					<button
						class="bubble-btn"
						class:active={imageAlignment === 'center'}
						onmousedown={(e) => e.preventDefault()}
						onclick={() => {
							editor?.commands.updateAttributes('image', { alignment: 'center' });
							updateActiveStates();
						}}
						title="Center"
					>
						<AlignCenter size={14} />
						Center
					</button>
					<button
						class="bubble-btn"
						class:active={imageAlignment === 'right'}
						onmousedown={(e) => e.preventDefault()}
						onclick={() => {
							editor?.commands.updateAttributes('image', { alignment: 'right' });
							updateActiveStates();
						}}
						title="Wrap Right"
					>
						<AlignRight size={14} />
						Wrap Right
					</button>
				</div>
			{/if}
		</div>
	</div>

	<!-- ToC & Highlights sidebar on the right side -->
	{#if showRightSidebar}
		<aside class="editor-sidebar-right">
			<div class="sidebar-section">
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="sidebar-section-header" onclick={() => showToc = !showToc} style="cursor: pointer; user-select: none;">
					<span>TABLE OF CONTENTS</span>
					<div class="header-actions">
						<button class="icon-btn" onclick={(e) => { e.stopPropagation(); showRightSidebar = false; }} title="Close"><X size={12} /></button>
					</div>
				</div>
				{#if showToc}
					<div class="toc-list">
						{#each headings as heading (heading.id)}
							<button 
								class="toc-item level-{heading.level}" 
								onclick={() => scrollToHeading(heading.pos)}
							>
								{heading.text}
							</button>
						{/each}
						{#if headings.length === 0}
							<div class="toc-empty">No headings in document</div>
						{/if}
					</div>
				{/if}
			</div>

			<div class="sidebar-section">
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="sidebar-section-header" onclick={() => showHighlights = !showHighlights} style="cursor: pointer; user-select: none;">
					<span>HIGHLIGHTS LIST</span>
					<div class="header-actions">
						<button class="icon-btn" onclick={(e) => { e.stopPropagation(); showRightSidebar = false; }} title="Close"><X size={12} /></button>
					</div>
				</div>
				{#if showHighlights}
					<div class="highlights-list">
						{#each highlights as hl, idx}
							<div class="highlight-item">
								<span class="highlight-num">{idx + 1}.</span>
								<span class="highlight-text">{hl}</span>
							</div>
						{/each}
						{#if highlights.length === 0}
							<div class="highlights-empty">No highlights found</div>
						{/if}
					</div>
				{/if}
			</div>

			<div class="sidebar-section">
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="sidebar-section-header" onclick={() => showAiSection = !showAiSection} style="cursor: pointer; user-select: none;">
					<span style="display: flex; align-items: center; gap: 0.375rem;">
						<Sparkles size={12} style="color: #c66930;" />
						AI ASSISTANT
					</span>
					<div class="header-actions">
						<button class="icon-btn" onclick={(e) => { e.stopPropagation(); showRightSidebar = false; }} title="Close"><X size={12} /></button>
					</div>
				</div>
				{#if showAiSection}
					{#if !notes.apiKey}
						<div class="ai-key-alert">
							<Sparkles size={18} class="alert-icon" />
							<p class="alert-text">To begin, please add your <strong>Gemini API Key</strong> in the Settings menu (top right of the window).</p>
						</div>
					{:else}
						<div class="ai-chat-container">
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

							<!-- Prompt Chips -->
							<div class="prompt-chips">
								<button class="chip" onclick={() => injectPrompt('summarise')} disabled={isGenerating}>
									✨ Summarise Note
								</button>
								<button class="chip" onclick={() => injectPrompt('metadata')} disabled={isGenerating}>
									📊 Extract Metadata
								</button>
								<button class="chip" onclick={() => injectPrompt('clean')} disabled={isGenerating}>
									📝 Clean Text
								</button>
							</div>

							<!-- Sticky input area -->
							<div class="chat-input-wrapper">
								<textarea
									placeholder="Ask Gemini anything..."
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
				{/if}
			</div>
		</aside>
	{/if}
</div>

{#if selectedTargetName}
	<div class="modal-backdrop" onclick={() => selectedTargetName = null}>
		<div class="modal-content" onclick={(e) => e.stopPropagation()}>
			<div class="modal-header">
				<h3>Graduate to {selectedTargetName}</h3>
				<button class="close-btn" onclick={() => selectedTargetName = null}>×</button>
			</div>
			<div class="modal-body">
				<p>Select your export package format for <strong>{selectedTargetName}</strong>:</p>
				
				<div class="export-options">
					<button class="export-option-btn" onclick={exportAsMarkdown}>
						<span class="option-icon">📝</span>
						<div class="option-details">
							<span class="option-title">Copy Clean Markdown</span>
							<span class="option-desc">Copies note content & metadata tags formatted as Markdown to clipboard</span>
						</div>
					</button>

					<button class="export-option-btn" onclick={exportAsJson}>
						<span class="option-icon">📦</span>
						<div class="option-details">
							<span class="option-title">Download JSON Package</span>
							<span class="option-desc">Downloads a .json file containing note title, content, attributes and created_at date</span>
						</div>
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

{#if slashMenuOpen}
	<div class="slash-menu" style="position: fixed; top: {slashMenuCoords.top + 4}px; left: {slashMenuCoords.left}px;">
		{#each filteredCommands as cmd, idx}
			<button
				class="slash-item"
				class:active={idx === selectedIndex}
				onclick={() => runCommand(cmd)}
			>
				<div class="slash-icon">
					{#if cmd.id === 'h1'}<Heading1Icon size={14} />{/if}
					{#if cmd.id === 'h2'}<Heading2Icon size={14} />{/if}
					{#if cmd.id === 'h3'}<Heading3Icon size={14} />{/if}
					{#if cmd.id === 'bullet'}<ListIcon size={14} />{/if}
					{#if cmd.id === 'code'}<CodeIcon size={14} />{/if}
					{#if cmd.id === 'table'}<TableIcon size={14} />{/if}
				</div>
				<div class="slash-info">
					<span class="slash-title">{cmd.title}</span>
					<span class="slash-desc">{cmd.description}</span>
				</div>
			</button>
		{/each}
		{#if filteredCommands.length === 0}
			<div class="slash-empty">No matching commands</div>
		{/if}
	</div>
{/if}

<style>
	.editor-workspace {
		display: flex;
		height: 100%;
		min-height: 0;
		gap: 1.5rem;
	}

	.editor {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
		height: 100%;
	}

	.titlebar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
	}

	.bookmark-toggle {
		display: flex;
		align-items: center;
		justify-content: center;
		background: none;
		border: none;
		cursor: pointer;
		padding: 0.375rem;
		border-radius: 6px;
		color: #8b929e;
		transition: background 0.15s ease, color 0.15s ease, transform 0.15s ease;
	}

	.bookmark-toggle:hover {
		background: #f1f3f5;
		color: #e0a800;
		transform: scale(1.08);
	}

	.bookmark-toggle.bookmarked {
		color: #ffc107;
	}

	.view-selector-tabs {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		border-bottom: 1px solid #e2e8f0;
		margin-bottom: 1rem;
		padding-bottom: 2px;
	}

	.view-tab {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		padding: 0.5rem 0.75rem;
		font-size: 0.8125rem;
		font-weight: 550;
		color: #64748b;
		cursor: pointer;
		transition: all 0.15s ease;
		margin-bottom: -3px;
		font-family: inherit;
		outline: none;
	}

	.view-tab:hover {
		color: #0f172a;
		border-bottom-color: #cbd5e1;
	}

	.view-tab.active {
		color: #c66930;
		border-bottom-color: #c66930;
	}

	.tab-icon {
		opacity: 0.8;
	}

	.title {
		flex: 1;
		min-width: 0;
		border: none;
		padding: 0;
		font-size: 1.5rem;
		font-weight: 700;
		font-family: inherit;
		color: inherit;
		background: none;
	}

	.title:focus {
		outline: none;
	}

	.meta-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-shrink: 0;
	}

	.clone-note-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		border: 1px solid #cfd3da;
		background: #fff;
		border-radius: 6px;
		padding: 0.375rem 0.75rem;
		font-family: inherit;
		font-size: 0.8125rem;
		font-weight: 500;
		color: #4c525d;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.clone-note-btn:hover {
		border-color: #c66930;
		color: #c66930;
		background: #fffbf9;
	}

	.sidebar-toggle-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		border: 1px solid #cfd3da;
		background: #fff;
		border-radius: 6px;
		padding: 0.375rem 0.75rem;
		font-family: inherit;
		font-size: 0.8125rem;
		font-weight: 500;
		color: #4c525d;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.sidebar-toggle-btn:hover {
		border-color: #c66930;
		color: #c66930;
		background: #fffbf9;
	}

	.sidebar-toggle-btn.active {
		border-color: #c66930;
		color: #ffffff;
		background: #c66930;
	}

	.share-container {
		position: relative;
		display: inline-block;
	}

	.share-web-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		border: 1px solid #cfd3da;
		background: #ffffff;
		border-radius: 6px;
		padding: 0.375rem 0.75rem;
		font-family: inherit;
		font-size: 0.8125rem;
		font-weight: 500;
		color: #4c525d;
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.share-web-btn:hover {
		border-color: #c66930;
		color: #c66930;
		background: #fffbf9;
	}

	.share-web-btn.shared {
		background: #0d9488;
		border-color: #0d9488;
		color: #ffffff;
	}

	.share-web-btn.shared:hover {
		background: #0f766e;
		border-color: #0f766e;
	}

	.share-popover {
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 6px;
		background: #ffffff;
		border: 1px solid #cfd3da;
		border-radius: 8px;
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.12);
		z-index: 1000;
		width: 260px;
		padding: 1rem;
		box-sizing: border-box;
	}

	.share-popover-content {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.share-desc {
		margin: 0;
		font-size: 0.75rem;
		color: #6c737f;
		line-height: 1.4;
	}

	.share-title {
		margin: 0;
		font-size: 0.75rem;
		font-weight: 600;
		color: #1d2129;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.primary-share-btn {
		background: #c66930;
		border: none;
		border-radius: 6px;
		color: #ffffff;
		padding: 0.5rem 1rem;
		font-size: 0.8125rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s ease;
		text-align: center;
	}

	.primary-share-btn:hover {
		background: #b25824;
	}

	.copy-box {
		display: flex;
		align-items: center;
		border: 1px solid #cfd3da;
		border-radius: 6px;
		overflow: hidden;
		background: #f8f9fa;
	}

	.copy-input {
		flex: 1;
		border: none;
		background: none;
		font-size: 0.75rem;
		color: #2e3338;
		padding: 6px 8px;
		min-width: 0;
	}

	.copy-input:focus {
		outline: none;
	}

	.copy-btn {
		border: none;
		background: none;
		border-left: 1px solid #cfd3da;
		padding: 6px 10px;
		color: #6c737f;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s ease;
	}

	.copy-btn:hover {
		color: #c66930;
		background: rgba(198, 105, 48, 0.05);
	}

	.copy-btn .success-icon {
		color: #0d9488;
	}

	.stop-sharing-btn {
		background: #ffffff;
		border: 1px solid #d9383a;
		border-radius: 6px;
		color: #d9383a;
		padding: 0.5rem 1rem;
		font-size: 0.8125rem;
		font-weight: 600;
		cursor: pointer;
		transition: all 0.15s ease;
		text-align: center;
	}

	.stop-sharing-btn:hover {
		background: #fef0f0;
	}

	.status {
		flex: none;
		font-size: 0.75rem;
		color: #99a;
		visibility: hidden;
	}

	.status.visible {
		visibility: visible;
	}

	/* Sleek Formatting Toolbar */
	.toolbar {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0.375rem;
		border: 1px solid #e2e4e8;
		border-radius: 6px;
		background: #f8f9fa;
		margin-bottom: 1rem;
		flex-wrap: wrap;
	}

	.note-paths {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
		padding: 0.25rem 0 0.125rem;
		flex: none;
	}

	.path-chip {
		font-size: 0.6875rem;
		color: #667;
		background: #f0f2f5;
		border: 1px solid #e2e4e8;
		border-radius: 4px;
		padding: 0.0625rem 0.4375rem;
		font-variant-numeric: tabular-nums;
	}

	.backlinks-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem;
		padding: 0.125rem 0;
		flex: none;
	}

	.backlinks-label {
		font-size: 0.6875rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.5px;
		color: #99a;
	}

	.backlink-chip {
		border: 1px solid #e0e7ff;
		background: #eef2ff;
		color: #4f46e5;
		border-radius: 4px;
		padding: 0.0625rem 0.4375rem;
		font-family: inherit;
		font-size: 0.6875rem;
		cursor: pointer;
	}

	.backlink-chip:hover {
		background: #e0e7ff;
	}

	.backlink-chip em {
		font-style: normal;
		opacity: 0.65;
	}

	.uploading-hint {
		font-size: 0.75rem;
		color: #99a;
		padding: 0 0.375rem;
		white-space: nowrap;
	}

	.uploading-hint.voice-error {
		color: #d64545;
	}

	.voice-btn.recording {
		width: auto;
		padding: 0 0.5rem;
		border: 1px solid #d64545 !important;
		color: #d64545 !important;
		background: rgba(214, 69, 69, 0.08) !important;
		animation: voice-pulse 1.6s ease-in-out infinite;
	}

	.voice-elapsed {
		font-size: 0.6875rem;
		font-weight: 600;
		margin-left: 0.25rem;
	}

	@keyframes voice-pulse {
		0%,
		100% {
			box-shadow: 0 0 0 0 rgba(214, 69, 69, 0.25);
		}
		50% {
			box-shadow: 0 0 0 3px rgba(214, 69, 69, 0.12);
		}
	}

	.voice-btn :global(.spin) {
		animation: voice-spin 1s linear infinite;
	}

	@keyframes voice-spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}

	.voice-cancel {
		color: #99a !important;
	}

	.voice-cancel:hover {
		color: #d64545 !important;
	}

	.toolbar-btn {
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
		transition: all 0.15s ease;
	}

	.toolbar-btn:hover {
		background: #eceef2;
		color: #1d2129;
	}

	.toolbar-btn.active {
		background: #e3e9fd;
		color: #4a6cf7;
	}

	.divider {
		width: 1px;
		height: 16px;
		background: #cfd3da;
		margin: 0 0.25rem;
	}

	.editor-content-wrapper {
		flex: 1;
		margin-top: 0.5rem;
		overflow-y: auto;
		position: relative;
	}

	/* Link popover */
	.link-popover {
		position: absolute;
		top: 100%;
		left: 0;
		margin-top: 0.375rem;
		background: #ffffff;
		border: 1px solid #e2e4e8;
		border-radius: 8px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
		z-index: 50;
		padding: 0.75rem;
		width: 260px;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.popover-form {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.form-group label {
		font-size: 0.6875rem;
		font-weight: 600;
		color: #889;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.form-group input {
		border: 1px solid #cfd3da;
		border-radius: 4px;
		padding: 0.375rem;
		font-size: 0.8125rem;
		font-family: inherit;
		color: #1d2129;
		background: #ffffff;
		outline: none;
		width: 100%;
		box-sizing: border-box;
	}

	.form-group input:focus {
		border-color: #4a6cf7;
	}

	.popover-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.375rem;
		margin-top: 0.25rem;
	}

	.popover-actions button {
		border: 1px solid #cfd3da;
		border-radius: 4px;
		padding: 0.25rem 0.5rem;
		font-size: 0.75rem;
		cursor: pointer;
		font-family: inherit;
		background: #ffffff;
		color: #4c525d;
		transition: all 0.15s ease;
	}

	.popover-actions button:hover {
		background: #f4f5f7;
	}

	.popover-actions button.save {
		background: #4a6cf7;
		border-color: #4a6cf7;
		color: #ffffff;
	}

	.popover-actions button.save:hover:not(:disabled) {
		background: #3b5bdb;
	}

	.popover-actions button.remove-btn {
		background: #ef4444;
		border-color: #ef4444;
		color: #ffffff;
		margin-right: auto;
	}

	.popover-actions button.remove-btn:hover {
		background: #dc2626;
	}

	/* ToC Sidebar Styles */
	.editor-sidebar-right {
		width: 240px;
		flex-shrink: 0;
		border-left: 1px solid #e2e4e8;
		padding-left: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 2rem;
		background: #fafafa;
		padding-right: 0.5rem;
		padding-top: 0.5rem;
		padding-bottom: 1rem;
		position: sticky;
		top: 0;
		height: fit-content;
		max-height: calc(100vh - 3rem);
		overflow-y: auto;
	}

	.sidebar-section {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		border-bottom: 1px solid #e2e4e8;
		padding-bottom: 1rem;
		margin-bottom: 0.5rem;
	}

	.ai-key-alert {
		padding: 1rem;
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 0.5rem;
		background: rgba(198, 105, 48, 0.05);
		border: 1px dashed rgba(198, 105, 48, 0.3);
		border-radius: 6px;
		margin: 0.25rem 0;
	}

	.ai-key-alert :global(.alert-icon) {
		color: #c66930;
	}

	.ai-key-alert .alert-text {
		font-size: 0.75rem;
		color: #4c525d;
		line-height: 1.4;
		margin: 0;
	}

	.ai-chat-container {
		display: flex;
		flex-direction: column;
		background: #ffffff;
		border: 1px solid #e2e4e8;
		border-radius: 6px;
		overflow: hidden;
		max-height: 380px;
	}

	.chat-messages {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.75rem;
		overflow-y: auto;
		height: 180px;
		background: #fafafa;
	}

	.chat-message {
		display: flex;
		width: 100%;
	}

	.chat-message.user {
		justify-content: flex-end;
	}

	.chat-message.assistant {
		justify-content: flex-start;
	}

	.message-bubble {
		max-width: 90%;
		padding: 6px 10px;
		font-size: 0.75rem;
		line-height: 1.4;
		border-radius: 8px;
		white-space: pre-wrap;
		box-sizing: border-box;
	}

	.chat-message.user .message-bubble {
		background: #c66930;
		color: #ffffff;
		border-bottom-right-radius: 2px;
	}

	.chat-message.assistant .message-bubble {
		background: #f1f2f4;
		color: #1d2129;
		border-bottom-left-radius: 2px;
	}

	.chat-message.assistant.generating .message-bubble {
		color: #8b929e;
		background: #f8f9fa;
		border: 1px dashed #cfd3da;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.6; }
	}

	.pulse {
		animation: pulse 1.5s ease-in-out infinite;
	}

	.prompt-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 6px;
		background: #f8f9fa;
		border-top: 1px solid #e2e4e8;
	}

	.chip {
		background: #ffffff;
		border: 1px solid #cfd3da;
		border-radius: 12px;
		padding: 2px 6px;
		font-size: 0.625rem;
		color: #4c525d;
		cursor: pointer;
		transition: all 0.15s ease;
		white-space: nowrap;
	}

	.chip:hover {
		border-color: #c66930;
		color: #c66930;
		background: rgba(198, 105, 48, 0.02);
	}

	.chip:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.chat-input-wrapper {
		display: flex;
		align-items: stretch;
		border-top: 1px solid #e2e4e8;
		background: #ffffff;
	}

	.chat-input-wrapper textarea {
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

	.chat-input-wrapper textarea:focus {
		outline: none;
	}

	.chat-input-wrapper textarea:disabled {
		background: #f8f9fa;
		color: #8b929e;
	}

	.chat-input-wrapper .send-btn {
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

	.chat-input-wrapper .send-btn:hover:not(:disabled) {
		background: rgba(198, 105, 48, 0.05);
	}

	.chat-input-wrapper .send-btn:disabled {
		color: #8b929e;
		cursor: not-allowed;
	}

	.sidebar-section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 0.6875rem;
		font-weight: 700;
		color: #889;
		letter-spacing: 0.05em;
		padding-bottom: 0.25rem;
		border-bottom: 1px solid #eee;
	}

	.header-actions {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}

	.icon-btn {
		background: none;
		border: none;
		padding: 2px;
		color: #889;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 3px;
		transition: all 0.15s;
	}

	.icon-btn:hover {
		background: rgba(0, 0, 0, 0.05);
		color: #1d2129;
	}

	.toc-list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.toc-item {
		display: block;
		width: 100%;
		text-align: left;
		background: none;
		border: none;
		padding: 4px 6px;
		border-radius: 4px;
		font-family: inherit;
		font-size: 0.8125rem;
		color: #4c525d;
		cursor: pointer;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		transition: all 0.15s;
	}

	.toc-item:hover {
		background: #f1f3f5;
		color: #c66930;
		font-weight: 500;
	}

	.toc-item.level-1 {
		font-weight: 600;
		padding-left: 0.375rem;
	}

	.toc-item.level-2 {
		padding-left: 1.25rem;
		color: #5c626d;
	}

	.toc-item.level-3 {
		padding-left: 2rem;
		color: #7c828d;
		font-size: 0.75rem;
	}

	.toc-empty, .highlights-empty {
		font-size: 0.75rem;
		color: #99a;
		font-style: italic;
		padding: 4px;
	}

	.highlights-list {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.highlight-item {
		display: flex;
		gap: 0.375rem;
		font-size: 0.8125rem;
		line-height: 1.4;
		color: #4c525d;
	}

	.highlight-num {
		color: #889;
		font-weight: 500;
		flex-shrink: 0;
	}

	.highlight-text {
		word-break: break-word;
	}

	/* Tiptap content styling (prose equivalent) */
	:global(.tiptap) {
		min-height: 350px;
		outline: none;
		font-family: inherit;
		font-size: 0.9375rem;
		line-height: 1.6;
		color: #1d2129;
		padding-bottom: 2rem;
	}

	:global(.tiptap::after) {
		content: "";
		display: table;
		clear: both;
	}

	:global(.tiptap img) {
		max-width: 100%;
		height: auto;
		border-radius: 6px;
		cursor: pointer;
		transition: outline 0.15s ease;
		border: 1px solid rgba(0,0,0,0.1);
	}

	:global(.tiptap img.ProseMirror-selectednode) {
		outline: 3px solid #c66930;
	}

	:global(.resizable-image-container) {
		max-width: 100%;
		transition: outline 0.15s ease;
	}

	:global(.resizable-image-container.ProseMirror-selectednode) {
		outline: none;
	}

	:global(.resizable-image-container:hover .resize-handle) {
		display: block !important;
	}

	/* Custom Link Styling in the Canvas */
	:global(.tiptap a) {
		color: #c66930;
		text-decoration: underline;
		text-underline-offset: 3px;
		font-weight: 500;
		transition: color 0.15s ease;
	}

	:global(.tiptap a:hover) {
		color: #00361f;
	}

	:global(.tiptap a::after) {
		content: "↗";
		display: inline-block;
		font-size: 0.8em;
		margin-left: 2px;
		text-decoration: none !important;
		vertical-align: super;
		line-height: 0;
	}

	:global(.tiptap p) {
		margin: 0 0 0.75rem 0;
	}

	:global(.tiptap h1) {
		font-size: 1.625rem;
		font-weight: 700;
		margin: 1.5rem 0 0.75rem 0;
		color: #1d2129;
	}

	:global(.tiptap h2) {
		font-size: 1.3125rem;
		font-weight: 700;
		margin: 1.25rem 0 0.5rem 0;
		color: #1d2129;
	}

	:global(.tiptap h3) {
		font-size: 1.125rem;
		font-weight: 700;
		margin: 1rem 0 0.375rem 0;
		color: #1d2129;
	}

	:global(.tiptap ul) {
		list-style-type: disc;
		padding-left: 1.5rem;
		margin: 0 0 0.75rem 0;
	}

	:global(.tiptap ol) {
		list-style-type: decimal;
		padding-left: 1.5rem;
		margin: 0 0 0.75rem 0;
	}

	:global(.tiptap li) {
		margin-bottom: 0.25rem;
	}

	:global(.tiptap code) {
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		background: #f1f3f5;
		padding: 0.125rem 0.25rem;
		border-radius: 4px;
		font-size: 0.875rem;
		color: #d9383a;
	}

	:global(.tiptap pre) {
		background: #1e1e24;
		color: #f8f8f2;
		padding: 0.75rem 1rem;
		border-radius: 6px;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
		font-size: 0.875rem;
		overflow-x: auto;
		margin: 0 0 1rem 0;
	}

	:global(.tiptap pre code) {
		background: none;
		padding: 0;
		color: inherit;
		font-size: inherit;
	}

	/* Placeholder styling */
	:global(.tiptap p.is-editor-empty:first-child::before) {
		color: #adb5bd;
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
	}

	/* Tables styling */
	:global(.tiptap table) {
		border-collapse: collapse;
		margin: 1.5rem 0;
		overflow: hidden;
		table-layout: fixed;
		width: 100%;
		border: 1px solid #e2e8f0;
		border-radius: 6px;
	}

	:global(.tiptap table td, .tiptap table th) {
		border: 1px solid #cbd5e1;
		box-sizing: border-box;
		min-width: 1em;
		padding: 8px 12px;
		position: relative;
		vertical-align: top;
		text-align: left;
	}

	:global(.tiptap table th) {
		background-color: #f8fafc;
		font-weight: 600;
		color: #1e293b;
		border-bottom: 2px solid #cbd5e1;
	}

	:global(.tiptap table p) {
		margin: 0 !important;
	}

	:global(.tiptap table .selectedCell:after) {
		background: rgba(198, 105, 48, 0.08);
		content: "";
		left: 0;
		right: 0;
		top: 0;
		bottom: 0;
		pointer-events: none;
		position: absolute;
		z-index: 2;
	}

	:global(.tiptap table .column-resize-handle) {
		background-color: #c66930;
		bottom: -2px;
		pointer-events: none;
		position: absolute;
		right: -2px;
		top: 0;
		width: 4px;
	}

	:global(.tableWrapper) {
		overflow-x: auto;
		margin: 1.5rem 0;
	}

	/* Toolbar Dropdown Menu Styling */
	.toolbar-dropdown-container {
		position: relative;
		display: inline-block;
	}

	.toolbar-dropdown-menu {
		position: absolute;
		top: 100%;
		left: 0;
		margin-top: 4px;
		background: #ffffff;
		border: 1px solid #cfd3da;
		border-radius: 6px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
		z-index: 1000;
		padding: 4px;
		display: flex;
		flex-direction: column;
		min-width: 140px;
		gap: 2px;
	}

	.toolbar-dropdown-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 6px 10px;
		background: none;
		border: none;
		border-radius: 4px;
		font-family: inherit;
		font-size: 0.8125rem;
		color: #4c525d;
		cursor: pointer;
		text-align: left;
		width: 100%;
		white-space: nowrap;
		box-sizing: border-box;
	}

	.toolbar-dropdown-item:hover {
		background: #eceef2;
		color: #1d2129;
	}

	.toolbar-dropdown-item.active {
		background: #e3e9fd;
		color: #4a6cf7;
	}

	/* Slash Menu Overlay */
	.slash-menu {
		background: #ffffff;
		border: 1px solid #e2e4e8;
		border-radius: 8px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
		z-index: 10000;
		min-width: 240px;
		max-height: 300px;
		overflow-y: auto;
		padding: 4px;
		display: flex;
		flex-direction: column;
	}

	.slash-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 6px 8px;
		border: none;
		background: none;
		border-radius: 6px;
		text-align: left;
		cursor: pointer;
		width: 100%;
		transition: background 0.15s;
		color: #1d2129;
	}

	.slash-item.active,
	.slash-item:hover {
		background: #f4f5f7;
	}

	.slash-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		background: #f1f3f5;
		color: #4c525d;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		flex-shrink: 0;
	}

	.slash-item.active .slash-icon {
		background: #e9ecef;
		color: #1d2129;
	}

	.slash-info {
		display: flex;
		flex-direction: column;
	}

	.slash-title {
		font-size: 0.8125rem;
		font-weight: 500;
		color: #1d2129;
		line-height: 1.2;
	}

	.slash-desc {
		font-size: 0.6875rem;
		color: #889;
		line-height: 1.2;
		margin-top: 1px;
	}

	.slash-empty {
		padding: 8px;
		font-size: 0.75rem;
		color: #889;
		text-align: center;
	}

	/* Note Attributes Styling */
	.attributes-container {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		margin-bottom: 0.75rem;
		font-family: inherit;
	}

	.attribute-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		background: #f1f3f5;
		border: 1px solid #e2e4e8;
		border-radius: 9999px;
		padding: 0.125rem 0.625rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: #4c525d;
		transition: all 0.15s ease;
	}

	.attribute-pill:hover {
		background: #e9ecef;
		border-color: #cfd3da;
	}

	.attribute-pill.relation {
		background: #eef2ff;
		border-color: #e0e7ff;
		color: #4f46e5;
	}

	.attribute-pill.relation:hover {
		background: #e0e7ff;
		border-color: #c7d2fe;
	}

	.attr-text {
		border: none;
		background: none;
		padding: 0;
		font: inherit;
		color: inherit;
		cursor: pointer;
	}

	.attr-text:hover {
		color: #c66930;
	}

	.attribute-pill.relation .attr-text {
		cursor: default;
	}

	.attribute-pill.relation .attr-text:hover {
		color: inherit;
	}

	.attr-search-btn {
		background: none;
		border: none;
		padding: 0 1px;
		color: #99a;
		cursor: pointer;
		font-size: 0.875rem;
		line-height: 1;
	}

	.attr-search-btn:hover {
		color: #c66930;
	}

	.attr-edit-input,
	.quick-tag-input {
		border: 1px dashed #cfd3da;
		border-radius: 9999px;
		padding: 0.125rem 0.625rem;
		font-family: inherit;
		font-size: 0.75rem;
		color: #4c525d;
		background: #ffffff;
		outline: none;
		width: 11rem;
	}

	.attr-edit-input {
		border-style: solid;
		border-color: #c66930;
	}

	.quick-tag-input:focus {
		border-style: solid;
		border-color: #c66930;
	}

	.quick-tag-wrapper {
		position: relative;
		display: inline-flex;
	}

	.quick-tag-wrapper .suggestions-list {
		min-width: 13rem;
	}

	.remove-attr-btn {
		background: none;
		border: none;
		padding: 0 2px;
		color: #99a;
		cursor: pointer;
		font-size: 0.875rem;
		line-height: 1;
		border-radius: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		transition: all 0.15s ease;
	}

	.remove-attr-btn:hover {
		background: rgba(0, 0, 0, 0.08);
		color: #e11d48;
	}

	.add-attr-wrapper {
		position: relative;
		display: inline-block;
	}

	.add-attr-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		background: none;
		border: 1px dashed #cfd3da;
		border-radius: 9999px;
		padding: 0.125rem 0.625rem;
		font-size: 0.75rem;
		font-weight: 500;
		color: #889;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.add-attr-btn:hover {
		border-color: #4a6cf7;
		color: #4a6cf7;
		background: #f0f3ff;
	}

	.add-attr-popover {
		position: absolute;
		top: 100%;
		left: 0;
		margin-top: 0.375rem;
		background: #ffffff;
		border: 1px solid #e2e4e8;
		border-radius: 8px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
		z-index: 2000;
		padding: 0.75rem;
		width: 200px;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.autocomplete-wrapper {
		position: relative;
	}

	.suggestions-list {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		background: #ffffff;
		border: 1px solid #cfd3da;
		border-radius: 6px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		z-index: 2100;
		margin: 4px 0 0 0;
		padding: 4px 0;
		list-style: none;
		max-height: 160px;
		overflow-y: auto;
	}

	.suggestions-list li {
		padding: 6px 12px;
		font-size: 0.8125rem;
		color: #1d2129;
		cursor: pointer;
		transition: background 0.1s ease;
	}

	.suggestions-list li:hover,
	.suggestions-list li.selected {
		background: rgba(198, 105, 48, 0.08);
		color: #c66930;
	}

	.popover-form {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.form-group label {
		font-size: 0.6875rem;
		font-weight: 600;
		color: #889;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.form-group select,
	.form-group input {
		border: 1px solid #cfd3da;
		border-radius: 4px;
		padding: 0.25rem 0.375rem;
		font-size: 0.75rem;
		font-family: inherit;
		color: #1d2129;
		background: #ffffff;
		outline: none;
	}

	.form-group select:focus,
	.form-group input:focus {
		border-color: #4a6cf7;
	}

	.popover-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.375rem;
		margin-top: 0.25rem;
	}

	.popover-actions button {
		border: 1px solid #cfd3da;
		border-radius: 4px;
		padding: 0.25rem 0.5rem;
		font-size: 0.75rem;
		cursor: pointer;
		font-family: inherit;
		background: #ffffff;
		color: #4c525d;
		transition: all 0.15s ease;
	}

	.popover-actions button:hover {
		background: #f4f5f7;
	}

	.popover-actions button.save {
		background: #4a6cf7;
		border-color: #4a6cf7;
		color: #ffffff;
	}

	.popover-actions button.save:hover:not(:disabled) {
		background: #3b5bdb;
	}

	.popover-actions button.save:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.toolbar-select {
		border: 1px solid #cfd3da;
		background: #fff;
		border-radius: 4px;
		padding: 0.125rem 0.25rem;
		font-family: inherit;
		font-size: 0.8125rem;
		color: #4c525d;
		cursor: pointer;
		outline: none;
		height: 28px;
		box-sizing: border-box;
		margin-right: 0.25rem;
	}

	.toolbar-select:hover {
		border-color: #c66930;
		color: #c66930;
	}

	.image-bubble-menu {
		background: #ffffff;
		border: 1px solid #e2e4e8;
		border-radius: 6px;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
		z-index: 100;
		padding: 4px;
		display: flex;
		gap: 4px;
		pointer-events: auto;
	}

	.bubble-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		border: none;
		background: none;
		border-radius: 4px;
		padding: 0.25rem 0.5rem;
		font-family: inherit;
		font-size: 0.75rem;
		font-weight: 500;
		color: #4c525d;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.bubble-btn:hover {
		background: #eceef2;
		color: #1d2129;
	}

	.bubble-btn.active {
		background: #c66930;
		color: #ffffff;
	}

	.image-menu-dropdown {
		box-sizing: border-box;
	}

	.media-library-section {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.media-grid-item:hover {
		border-color: #c66930 !important;
		background: #fff8f5 !important;
		box-shadow: 0 0 0 1px #c66930;
	}

	/* Attribute-driven custom themes */
	.editor-content-wrapper.serif :global(.tiptap) {
		font-family: Georgia, Garamond, Cambria, 'Times New Roman', Times, serif !important;
		line-height: 1.8 !important;
	}

	.editor-content-wrapper.typewriter :global(.tiptap) {
		font-family: 'Courier New', Courier, monospace !important;
		line-height: 2.2 !important;
		font-size: 1.0625rem !important;
	}

	.editor-content-wrapper.reading-mode {
		padding: 3rem 2rem;
		background: #fdfbf7 !important; /* Soft warm background off-white */
		transition: background 0.3s ease;
	}

	.editor-content-wrapper.reading-mode :global(.tiptap) {
		font-size: 1.2rem !important;
		max-width: 65ch !important; /* Enforces elite typographic standard of 65ch */
		margin: 0 auto;
		line-height: 1.85 !important; /* leading-relaxed / comfort height */
		color: #2e2a24 !important; /* Soft low-contrast warm tone to prevent eye strain */
		font-family: Georgia, Garamond, Cambria, 'Times New Roman', Times, serif !important; /* Highly readable serif for long form reading */
	}

	.split-toggle-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.5rem;
		background: #ffffff;
		border: 1px solid #cfd3da;
		border-radius: 4px;
		color: #4c525d;
		font-size: 0.75rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.split-toggle-btn:hover {
		background: #eceef2;
		border-color: #abb2bf;
	}

	.split-toggle-btn.active {
		background: rgba(198, 105, 48, 0.1);
		border-color: #c66930;
		color: #c66930;
	}

	.editor-content-wrapper.split-mode {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.5rem;
		height: 100%;
		overflow: hidden;
	}

	.editor-content-wrapper.split-mode #editor-container {
		overflow-y: auto;
		height: 100%;
		border-right: 1px solid #e2e4e8;
		padding-right: 1.5rem;
	}

	.right-viewer-pane {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
		background: #ffffff;
		border: 1px solid #e2e4e8;
		border-radius: 8px;
		box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.05);
	}

	.pdf-viewer {
		width: 100%;
		height: 100%;
		border: none;
		border-radius: 8px;
	}

	.image-viewer {
		width: 100%;
		height: 100%;
		overflow: auto;
		display: flex;
		align-items: center;
		justify-content: center;
		background: #f1f2f4;
		padding: 1rem;
		box-sizing: border-box;
		border-radius: 8px;
	}

	.image-viewer img {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
	}

	.viewer-placeholder {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		height: 100%;
		padding: 2rem;
		box-sizing: border-box;
		background: #fafafa;
		border: 2px dashed #cfd3da;
		border-radius: 8px;
		color: #8b929e;
	}

	.placeholder-icon {
		font-size: 3rem;
		margin: 0 0 1rem 0;
	}

	.placeholder-title {
		font-size: 0.9375rem;
		font-weight: 600;
		color: #4c525d;
		margin: 0 0 0.5rem 0;
	}

	.placeholder-desc {
		font-size: 0.75rem;
		color: #8b929e;
		max-width: 280px;
		margin: 0;
		line-height: 1.4;
	}

	.drag-drop-overlay {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(255, 255, 255, 0.95);
		border: 2px dashed #c66930;
		border-radius: 8px;
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		pointer-events: none;
		animation: fadeIn 0.2s ease-in-out;
	}

	.drag-drop-message {
		text-align: center;
		color: #c66930;
	}

	.drag-drop-message .icon {
		font-size: 2.5rem;
		display: block;
		margin-bottom: 0.5rem;
		animation: bounce 1s infinite alternate;
	}

	.drag-drop-message p {
		font-size: 1rem;
		font-weight: 600;
		margin: 0;
	}

	@keyframes fadeIn {
		from { opacity: 0; }
		to { opacity: 1; }
	}

	@keyframes bounce {
		from { transform: translateY(0); }
		to { transform: translateY(-5px); }
	}

	.toolbar-label {
		font-size: 0.6875rem;
		font-weight: 700;
		color: #8b929e;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin: 0 0.5rem;
		align-self: center;
	}

	.triage-btn {
		background: #ffffff;
		border: 1px solid #cfd3da;
		border-radius: 4px;
		color: #4c525d;
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.25rem 0.5rem;
		height: 28px;
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		cursor: pointer;
		margin-right: 0.25rem;
		transition: all 0.15s ease;
	}

	.triage-btn:hover {
		background: #f1f2f4;
		border-color: #abb2bf;
		color: #1d2129;
	}

	.graduate-container {
		position: relative;
		display: inline-block;
	}

	.graduate-btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.5rem;
		background: #ffffff;
		border: 1px solid #cfd3da;
		border-radius: 4px;
		color: #4c525d;
		font-size: 0.75rem;
		font-weight: 500;
		cursor: pointer;
		height: 28px;
		box-sizing: border-box;
		transition: all 0.15s ease;
	}

	.graduate-btn:hover {
		background: #eceef2;
		border-color: #abb2bf;
	}

	.graduate-dropdown {
		position: absolute;
		top: 100%;
		right: 0;
		margin-top: 4px;
		background: #ffffff;
		border: 1px solid #e2e4e8;
		border-radius: 6px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
		z-index: 1000;
		width: 240px;
		padding: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.graduate-header {
		font-size: 0.6875rem;
		font-weight: 700;
		color: #8b929e;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 4px 8px;
		border-bottom: 1px solid #f1f2f4;
		margin-bottom: 4px;
	}

	.target-item {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		background: none;
		border: none;
		padding: 8px;
		border-radius: 4px;
		cursor: pointer;
		text-align: left;
		width: 100%;
		transition: background 0.15s ease;
	}

	.target-item:hover {
		background: #f1f2f4;
	}

	.target-item .icon {
		font-size: 1.25rem;
	}

	.target-item .details {
		display: flex;
		flex-direction: column;
	}

	.target-item .name {
		font-size: 0.8125rem;
		font-weight: 600;
		color: #1d2129;
	}

	.target-item .url {
		font-size: 0.6875rem;
		color: #8b929e;
	}

	/* Modal Backdrop & Content Styles */
	.modal-backdrop {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(29, 33, 41, 0.6);
		backdrop-filter: blur(4px);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 2000;
	}

	.modal-content {
		background: #ffffff;
		border-radius: 8px;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.15);
		width: 100%;
		max-width: 480px;
		overflow: hidden;
		animation: modalFadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
	}

	@keyframes modalFadeIn {
		from {
			opacity: 0;
			transform: scale(0.96) translateY(8px);
		}
		to {
			opacity: 1;
			transform: scale(1) translateY(0);
		}
	}

	.modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid #e2e4e8;
	}

	.modal-header h3 {
		font-size: 1rem;
		font-weight: 600;
		color: #1d2129;
		margin: 0;
	}

	.modal-header .close-btn {
		background: none;
		border: none;
		font-size: 1.5rem;
		color: #8b929e;
		cursor: pointer;
		line-height: 1;
		padding: 0;
	}

	.modal-header .close-btn:hover {
		color: #1d2129;
	}

	.modal-body {
		padding: 1.25rem;
	}

	.modal-body p {
		font-size: 0.875rem;
		color: #4c525d;
		margin: 0 0 1.25rem 0;
	}

	.export-options {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.export-option-btn {
		display: flex;
		align-items: flex-start;
		gap: 1rem;
		background: #ffffff;
		border: 1px solid #cfd3da;
		border-radius: 6px;
		padding: 1rem;
		cursor: pointer;
		text-align: left;
		transition: all 0.2s ease;
	}

	.export-option-btn:hover {
		border-color: #c66930;
		background: rgba(198, 105, 48, 0.02);
		box-shadow: 0 2px 8px rgba(198, 105, 48, 0.08);
	}

	.export-option-btn .option-icon {
		font-size: 1.5rem;
		line-height: 1;
	}

	.export-option-btn .option-details {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.export-option-btn .option-title {
		font-size: 0.875rem;
		font-weight: 600;
		color: #1d2129;
	}

	.export-option-btn .option-desc {
		font-size: 0.75rem;
		color: #8b929e;
		line-height: 1.4;
	}

	@media (max-width: 768px) {
		.editor-sidebar-right {
			display: none !important;
		}

		.sidebar-toggle-btn,
		.split-toggle-btn {
			display: none !important;
		}

		.editor-workspace {
			gap: 0;
		}

		.toolbar {
			flex-wrap: nowrap !important;
			overflow-x: auto !important;
			-webkit-overflow-scrolling: touch;
			padding: 0.25rem;
			gap: 0.25rem;
			margin-bottom: 0.5rem;
			scrollbar-width: none;
		}

		.toolbar::-webkit-scrollbar {
			display: none;
		}

		.font-family-select,
		.font-size-select,
		.toolbar-label,
		.triage-btn,
		.divider {
			display: none !important;
		}

		/* Mobile favours reading and quick capture: secondary note actions
		   (clone / share / graduate) hide so the titlebar fits the viewport
		   instead of forcing a horizontal scroll on <main>. */
		.clone-note-btn,
		.graduate-container,
		.share-container {
			display: none !important;
		}

		.titlebar {
			flex-wrap: wrap;
		}

		.title {
			font-size: 1.25rem;
			min-width: 0;
		}

		/* Desktop image resizing stores fixed pixel widths; cap them to the
		   screen so a 800px image can't push the note sideways. */
		.editor-content-wrapper :global(img),
		.editor-content-wrapper :global(.resizable-image-container) {
			max-width: 100% !important;
			height: auto !important;
		}

		.editor-content-wrapper :global(table) {
			display: block;
			max-width: 100%;
			overflow-x: auto;
		}
	}
</style>

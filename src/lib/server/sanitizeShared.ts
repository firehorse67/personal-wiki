// Defense-in-depth sanitizer for publicly served note HTML. Content is
// self-authored (Tiptap) or already cleaned by the clipper, but published
// pages must never execute anything even if something hostile sneaks into
// a note body. Framework-free so it can be tested outside SvelteKit.

// Paired dangerous elements go with their contents; stray open/close tags
// (unclosed or orphaned) are stripped tag-only, leaving inert text.
const PAIRED_BLOCKS = /<(script|style|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const STRAY_TAGS = /<\/?(script|style|iframe|object|embed|form|link|meta|base)\b[^>]*>/gi;
const EVENT_ATTRS = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const BAD_URLS = /\s+(href|src|xlink:href|formaction)\s*=\s*("|')?\s*(javascript|vbscript|data:text)[^"'\s>]*("|')?/gi;

export function sanitizeSharedHtml(html: string): string {
	let previous = '';
	let current = html;
	// Repeat until stable so nested/overlapping payloads can't survive one
	// pass (removing an inner block can splice an outer one together).
	while (current !== previous) {
		previous = current;
		current = current
			.replace(PAIRED_BLOCKS, '')
			.replace(STRAY_TAGS, '')
			.replace(EVENT_ATTRS, '')
			.replace(BAD_URLS, ' $1="#"');
	}
	return current;
}

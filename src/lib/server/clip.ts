// Payload cleaning for the web clipper endpoint. Framework-free on purpose
// so it can be tested outside SvelteKit.

const MAX_TITLE = 300;
const MAX_URL = 2_000;
const MAX_TEXT = 200_000; // final note content cap
const MAX_HTML = 1_000_000; // raw HTML accepted before conversion

/** Strip C0/C1 control characters, keeping tabs and newlines. */
function stripControl(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

function decodeEntities(text: string): string {
	const named: Record<string, string> = {
		amp: '&',
		lt: '<',
		gt: '>',
		quot: '"',
		apos: "'",
		nbsp: ' ',
		mdash: '—',
		ndash: '–',
		hellip: '…',
		rsquo: '’',
		lsquo: '‘',
		rdquo: '”',
		ldquo: '“'
	};
	return text
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
		.replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function safeCodePoint(code: number): string {
	if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return '';
	try {
		return String.fromCodePoint(code);
	} catch {
		return '';
	}
}

/** Convert clipped HTML to readable plain text (notes are plain text). */
export function htmlToText(html: string): string {
	const text = html
		.replace(/<(script|style|noscript|template|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<li\b[^>]*>/gi, '\n- ')
		.replace(/<\/(p|div|h[1-6]|tr|blockquote|pre|section|article|ul|ol|table)\s*>/gi, '\n\n')
		.replace(/<(br|hr)\b[^>]*\/?>/gi, '\n')
		.replace(/<[^>]+>/g, ' ');
	// Entities are decoded AFTER tag stripping; any tags they encoded arrive
	// as inert text (note content is only ever rendered as plain text).
	return stripControl(decodeEntities(text))
		.replace(/\r/g, '')
		.replace(/[ \t]+/g, ' ')
		.replace(/ ?\n ?/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

// Vercel serverless functions reject request bodies over 4.5 MB (413 before
// the handler runs), so the whole JSON payload — screenshot included — must
// stay under that. The extension's JPEG-q50 captures fit comfortably.
const MAX_SCREENSHOT = 4_000_000;
const SCREENSHOT_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

export interface CleanClip {
	title: string;
	content: string;
	/** Validated image data URL; the endpoint uploads it to Storage and appends the URL. */
	screenshot?: string;
}

/**
 * Validate and normalize an incoming clip. Returns the cleaned note fields,
 * or an error message describing the first problem found.
 */
export function normalizeClip(input: unknown): CleanClip | { error: string } {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		return { error: 'Body must be a JSON object' };
	}
	const { title, url, excerpt, html, description, screenshot } = input as Record<string, unknown>;

	for (const [name, value] of Object.entries({ title, url, excerpt, html, description, screenshot })) {
		if (value !== undefined && typeof value !== 'string') {
			return { error: `"${name}" must be a string` };
		}
	}

	let sourceUrl: string | null = null;
	if (url !== undefined) {
		if ((url as string).length > MAX_URL) return { error: '"url" is too long' };
		let parsed: URL;
		try {
			parsed = new URL(url as string);
		} catch {
			return { error: '"url" is not a valid URL' };
		}
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return { error: '"url" must be http or https' };
		}
		sourceUrl = parsed.toString();
	}

	if (html !== undefined && (html as string).length > MAX_HTML) {
		return { error: '"html" is too large' };
	}
	if (excerpt !== undefined && (excerpt as string).length > MAX_TEXT) {
		return { error: '"excerpt" is too large' };
	}
	if (description !== undefined && (description as string).length > MAX_TEXT) {
		return { error: '"description" is too large' };
	}
	if (screenshot !== undefined) {
		if ((screenshot as string).length > MAX_SCREENSHOT) {
			return { error: '"screenshot" is too large (max ~4 MB — downscale or compress harder)' };
		}
		if (!SCREENSHOT_RE.test(screenshot as string)) {
			return { error: '"screenshot" must be a base64 png/jpeg/webp/gif data URL' };
		}
	}

	// Prefer the caller's plain-text excerpt; fall back to converted HTML.
	let text = '';
	if (typeof excerpt === 'string' && excerpt.trim()) {
		text = stripControl(excerpt).replace(/\r/g, '').trim();
	} else if (typeof html === 'string' && html.trim()) {
		text = htmlToText(html);
	}

	if (!text && !sourceUrl && !description && !screenshot) {
		return { error: 'Provide at least one of "url", "excerpt", "html", "description" or "screenshot"' };
	}

	let cleanTitle = typeof title === 'string' ? stripControl(title).trim() : '';
	if (!cleanTitle) {
		cleanTitle = sourceUrl ? new URL(sourceUrl).hostname : 'Clipped note';
	}
	cleanTitle = cleanTitle.slice(0, MAX_TITLE);

	// Format final note content as rich HTML for Tiptap
	const parts = [];
	if (typeof description === 'string' && description.trim()) {
		parts.push(`<h2>Description</h2><p>${escapeHtml(description.trim())}</p>`);
	}
	if (sourceUrl) {
		parts.push(`<p>Clipped from: <a href="${sourceUrl}" target="_blank">${escapeHtml(sourceUrl)}</a></p>`);
	}
	if (text) {
		const paragraphHtml = escapeHtml(text)
			.split('\n\n')
			.map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
			.join('');
		parts.push(paragraphHtml);
	}
	// The screenshot is NOT inlined: base64 in note content bloats every sync
	// pull and IndexedDB copy. The endpoint uploads it to Supabase Storage and
	// appends an <img> pointing at the public URL instead.
	const content = parts.join('\n').slice(0, MAX_TEXT);

	return { title: cleanTitle, content, screenshot: screenshot as string | undefined };
}

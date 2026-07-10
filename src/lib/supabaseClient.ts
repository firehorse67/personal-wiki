import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';

// Type aliases (not interfaces) so they satisfy postgrest-js's
// Record<string, unknown> constraint via the implicit index signature.

/**
 * A note's content, independent of where it sits in the tree. Tree placement
 * lives in branches — one note can appear in many places (Trilium-style
 * clones). RLS requires an aal2 (MFA-verified) session for all access.
 */
export type Note = {
	id: string;
	title: string;
	content: string;
	is_shared: boolean;
	/** Optional: rows predating migration 0008 lack a true creation time. */
	created_at?: string;
	/** Server-managed change clock (see supabase/migrations/0001). Never sent by the client. */
	updated_at: string;
};

/** One placement of a note in the tree. `parent_id` null means tree root. */
export type Branch = {
	id: string;
	note_id: string;
	parent_id: string | null;
	updated_at: string;
};

/** Metadata for one stored file (Media Library): description + alt text. */
export type AttachmentMeta = {
	id: string;
	file_path: string;
	description: string;
	alt_text: string;
	created_at: string;
	/** Server-managed change clock. Never sent by the client. */
	updated_at: string;
};

/**
 * Arbitrary metadata on a note: labels (tags / key-value pairs like
 * cssClass, status, archived) and relations (value holds a target note id).
 */
export type NoteAttribute = {
	id: string;
	note_id: string;
	type: 'label' | 'relation';
	key: string;
	value: string;
	updated_at: string;
};

export interface Database {
	public: {
		Tables: {
			notes: {
				Row: Note;
				Insert: Omit<Note, 'id' | 'updated_at'> & { id?: string };
				Update: Partial<Omit<Note, 'updated_at'>>;
				Relationships: [];
			};
			branches: {
				Row: Branch;
				Insert: Omit<Branch, 'id' | 'updated_at'> & { id?: string };
				Update: Partial<Omit<Branch, 'updated_at'>>;
				Relationships: [];
			};
			attributes: {
				Row: NoteAttribute;
				Insert: Omit<NoteAttribute, 'id' | 'updated_at'> & { id?: string };
				Update: Partial<Omit<NoteAttribute, 'updated_at'>>;
				Relationships: [];
			};
			attachments: {
				Row: AttachmentMeta;
				Insert: Omit<AttachmentMeta, 'id' | 'updated_at' | 'created_at'> & {
					id?: string;
					created_at?: string;
				};
				Update: Partial<Omit<AttachmentMeta, 'updated_at'>>;
				Relationships: [];
			};
		};
		Views: Record<string, never>;
		Functions: Record<string, never>;
		Enums: Record<string, never>;
		CompositeTypes: Record<string, never>;
	};
}

export const supabase = createClient<Database>(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY, {
	auth: {
		persistSession: true,
		autoRefreshToken: true,
		detectSessionInUrl: true
	}
});

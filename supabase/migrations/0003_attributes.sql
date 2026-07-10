-- Note attributes: arbitrary label/relation metadata per note (Trilium-style).
-- Run once in the Supabase SQL editor.

create table if not exists public.attributes (
	id uuid primary key default gen_random_uuid(),
	note_id uuid not null references public.notes (id) on delete cascade,
	type text not null check (type in ('label', 'relation')),
	key text not null,
	value text not null default '',
	updated_at timestamptz not null default now()
);

-- Mirror the aal2-only access rule used on notes and branches.
alter table public.attributes enable row level security;

create policy "aal2 full access" on public.attributes
	for all to authenticated
	using ((select auth.jwt() ->> 'aal') = 'aal2')
	with check ((select auth.jwt() ->> 'aal') = 'aal2');

drop trigger if exists attributes_set_updated_at on public.attributes;
create trigger attributes_set_updated_at
	before update on public.attributes
	for each row execute function extensions.moddatetime(updated_at);

create index if not exists attributes_updated_at_idx on public.attributes (updated_at);
create index if not exists attributes_note_id_idx on public.attributes (note_id);
create index if not exists attributes_key_idx on public.attributes (key);

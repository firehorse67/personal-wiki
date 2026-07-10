-- Multi-parent note cloning: a note appears in the tree once per branch row.
-- Run ONCE in the Supabase SQL editor (the backfill reads the legacy
-- notes.parent_id column, which new clients no longer maintain).

create table if not exists public.branches (
	id uuid primary key default gen_random_uuid(),
	note_id uuid not null references public.notes (id) on delete cascade,
	parent_id uuid references public.notes (id) on delete cascade, -- null = tree root
	updated_at timestamptz not null default now(),
	unique nulls not distinct (note_id, parent_id)
);

-- Mirror the aal2-only access rule used on notes.
alter table public.branches enable row level security;

create policy "aal2 full access" on public.branches
	for all to authenticated
	using ((select auth.jwt() ->> 'aal') = 'aal2')
	with check ((select auth.jwt() ->> 'aal') = 'aal2');

drop trigger if exists branches_set_updated_at on public.branches;
create trigger branches_set_updated_at
	before update on public.branches
	for each row execute function extensions.moddatetime(updated_at);

create index if not exists branches_updated_at_idx on public.branches (updated_at);
create index if not exists branches_note_id_idx on public.branches (note_id);
create index if not exists branches_parent_id_idx on public.branches (parent_id);

-- Backfill: one branch per existing note from the legacy pointer.
insert into public.branches (note_id, parent_id)
	select id, parent_id from public.notes
	on conflict do nothing;

-- notes.parent_id is now legacy; kept for rollback safety. Once the branches
-- model has bedded in: alter table public.notes drop column parent_id;
comment on column public.notes.parent_id is 'DEPRECATED: replaced by public.branches';

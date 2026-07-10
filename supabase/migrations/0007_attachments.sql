-- Attachment metadata for the Media Library Manager. Run once in the SQL
-- editor. One row per stored file (descriptions, alt text); rows sync
-- through the same push/pull engine as notes/branches/attributes, so
-- updated_at + moddatetime are required (the pull watermark reads them).

create table if not exists public.attachments (
	id uuid primary key default gen_random_uuid(),
	file_path text not null unique,
	description text not null default '',
	alt_text text not null default '',
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

-- Mirror the aal2-only access rule used on the other tables.
alter table public.attachments enable row level security;

create policy "aal2 full access" on public.attachments
	for all to authenticated
	using ((select auth.jwt() ->> 'aal') = 'aal2')
	with check ((select auth.jwt() ->> 'aal') = 'aal2');

drop trigger if exists attachments_set_updated_at on public.attachments;
create trigger attachments_set_updated_at
	before update on public.attachments
	for each row execute function extensions.moddatetime(updated_at);

create index if not exists attachments_updated_at_idx on public.attachments (updated_at);
create index if not exists attachments_file_path_idx on public.attachments (file_path);

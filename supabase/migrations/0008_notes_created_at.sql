-- Creation timestamp for the dashboard's "Recent Notes" feed. Run once in
-- the SQL editor. Existing notes backfill to the migration moment (their
-- true creation time was never recorded); new notes carry the real time.

alter table public.notes
	add column if not exists created_at timestamptz not null default now();

create index if not exists notes_created_at_idx on public.notes (created_at);

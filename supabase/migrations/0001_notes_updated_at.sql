-- Change tracking for the client sync engine (src/lib/sync.ts).
-- Run once in the Supabase SQL editor: the pull side of sync fetches rows
-- where updated_at > the client's last-sync watermark.

alter table public.notes
  add column if not exists updated_at timestamptz not null default now();

-- moddatetime keeps updated_at current on every UPDATE.
create extension if not exists moddatetime with schema extensions;

drop trigger if exists notes_set_updated_at on public.notes;
create trigger notes_set_updated_at
  before update on public.notes
  for each row execute function extensions.moddatetime(updated_at);

create index if not exists notes_updated_at_idx on public.notes (updated_at);

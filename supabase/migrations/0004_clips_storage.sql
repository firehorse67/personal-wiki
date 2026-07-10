-- Storage bucket for web-clipper screenshots. Run once in the SQL editor.
-- Clipped images are uploaded here by /api/clip (service role) and the note
-- content references their public URL — inline base64 in note rows hit
-- request-size ceilings (Vercel 4.5 MB, Supabase REST) and bloated IndexedDB.

insert into storage.buckets (id, name, public)
values ('clips', 'clips', true)
on conflict (id) do nothing;

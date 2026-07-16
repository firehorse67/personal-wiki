-- Identity-scoped RLS: tighten every table policy from "any MFA-verified
-- session" to "the owner's MFA-verified session". Previously the aal2 check
-- alone was the gate, which was safe only because project-level signups are
-- disabled — a dashboard setting, not schema. This makes the database
-- self-defending even if signups were ever re-enabled.
--
-- Run once in the Supabase SQL editor AFTER replacing the placeholder:
-- find your user id under Authentication → Users (a UUID), and substitute
-- it for OWNER-USER-ID below. Verify afterwards by confirming the app still
-- loads notes when signed in.

create or replace function public.is_owner_aal2()
returns boolean
language sql
stable
as $$
  select auth.uid() = 'OWNER-USER-ID'::uuid
     and (select auth.jwt() ->> 'aal') = 'aal2';
$$;

-- Drop EVERY existing policy on these tables before recreating: policies
-- are permissive (OR'd), so a leftover broad policy — e.g. the notes policy
-- created before this repo's migrations, whose name isn't recorded here —
-- would silently keep granting the old access.

do $$
declare
  pol record;
begin
  for pol in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename in ('notes', 'branches', 'attributes', 'attachments')
  loop
    execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $$;

create policy "owner aal2 full access" on public.notes
  for all to authenticated
  using (public.is_owner_aal2())
  with check (public.is_owner_aal2());

create policy "owner aal2 full access" on public.branches
  for all to authenticated
  using (public.is_owner_aal2())
  with check (public.is_owner_aal2());

create policy "owner aal2 full access" on public.attributes
  for all to authenticated
  using (public.is_owner_aal2())
  with check (public.is_owner_aal2());

create policy "owner aal2 full access" on public.attachments
  for all to authenticated
  using (public.is_owner_aal2())
  with check (public.is_owner_aal2());

-- Expose storage object list in the clips bucket via an RPC function in the public schema.
create or replace function public.list_storage_files()
returns table (name text, created_at timestamptz, mimetype text, size bigint)
language plpgsql
security definer
as $$
begin
  return query
  select o.name, o.created_at, (o.metadata->>'mimetype')::text, (o.metadata->>'size')::bigint
  from storage.objects o
  where o.bucket_id = 'clips';
end;
$$;

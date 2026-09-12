-- Non-mutating deployment smoke check. Run as one SQL request/connection.
-- No actual identity, family ID, photo ID or family content is used.
begin read only;
set local statement_timeout = '10s';
set local lock_timeout = '2s';

do $check$
begin
  if not exists (
    select 1 from supabase_migrations.schema_migrations where version = '20260912000100'
  ) then raise exception 'Journal deletion migration is not recorded'; end if;
  if not (select relrowsecurity from pg_catalog.pg_class
    where oid = 'public.deleted_family_journal_photos'::regclass)
  then raise exception 'Journal deletion RLS is disabled'; end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.deleted_family_journal_photos'::regclass and contype = 'p'
      and pg_catalog.pg_get_constraintdef(oid) = 'PRIMARY KEY (circle_id, uploader_id, photo_id)'
  ) then raise exception 'Journal deletion identity key is incorrect'; end if;
  if not exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.family_journal_photos'::regclass
      and tgname = 'reject_deleted_journal_photo' and tgenabled = 'O'
  ) then raise exception 'Journal resurrection guard is missing'; end if;
  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'deleted_family_journal_photos'
  ) then raise exception 'Journal deletion realtime feed is missing'; end if;
  if not has_function_privilege('authenticated', 'public.delete_family_journal_photo(uuid,uuid)', 'execute')
    or has_function_privilege('anon', 'public.delete_family_journal_photo(uuid,uuid)', 'execute')
    or not has_table_privilege('authenticated', 'public.deleted_family_journal_photos', 'select')
    or has_table_privilege('authenticated', 'public.deleted_family_journal_photos', 'insert,update,delete')
  then raise exception 'Journal deletion grants are incorrect'; end if;
end;
$check$;

select set_config('request.jwt.claims', '{"role":"anon"}', true),
  set_config('request.jwt.claim', '{"role":"anon"}', true),
  set_config('request.jwt.claim.sub', '', true);
set local role anon;
do $smoke$
begin
  begin
    perform public.delete_family_journal_photo(null::uuid, null::uuid);
  exception when insufficient_privilege then
    return;
  end;
  raise exception 'Anonymous Journal deletion was not rejected';
end;
$smoke$;

reset role;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true),
  set_config('request.jwt.claim', '{"role":"authenticated"}', true),
  set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
do $smoke$
begin
  if public.current_app_user_id() is not null then
    raise exception 'Smoke connection unexpectedly has a user identity';
  end if;
  begin
    perform public.delete_family_journal_photo(null::uuid, null::uuid);
  exception when insufficient_privilege then
    if sqlerrm = 'authentication_required' then return; end if;
    raise;
  end;
  raise exception 'Missing-identity Journal deletion was not rejected';
end;
$smoke$;
rollback;

select 'PASS: Journal deletion schema, grants, anonymous denial and missing-identity denial; read-only transaction rolled back' as deployment_smoke;

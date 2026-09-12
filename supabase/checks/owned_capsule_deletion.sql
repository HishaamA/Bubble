-- Non-mutating deployment smoke check. Run as one SQL request/connection.
-- Reads catalogs only; RPC calls have null IDs and explicitly cleared identity.
-- This does not replace the isolated pgTAP ownership/concurrency fixtures.
begin read only;
set local statement_timeout = '10s';
set local lock_timeout = '2s';

do $check$
declare
  v_table text;
  v_function text;
begin
  if not exists (
    select 1 from supabase_migrations.schema_migrations where version = '20260912000200'
  ) then raise exception 'Capsule deletion migration is not recorded'; end if;
  if not exists (
    select 1 from pg_catalog.pg_attribute
    where attrelid = 'public.family_capsules'::regclass and attname = 'deleted_at'
      and atttypid = 'timestamptz'::regtype and not attnotnull and not attisdropped
  ) then raise exception 'Capsule soft-deletion column is missing or incorrect'; end if;

  foreach v_table in array array['deleted_family_capsules', 'deleted_family_capsule_photos'] loop
    if not (select relrowsecurity from pg_catalog.pg_class where oid = ('public.' || v_table)::regclass)
    then raise exception 'RLS is disabled on %', v_table; end if;
    if not has_table_privilege('authenticated', 'public.' || v_table, 'select')
      or has_table_privilege('authenticated', 'public.' || v_table, 'insert,update,delete')
      or has_table_privilege('anon', 'public.' || v_table, 'select,insert,update,delete')
    then raise exception 'Incorrect client grants on %', v_table; end if;
    if not exists (
      select 1 from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
    ) then raise exception 'Deletion realtime feed is missing for %', v_table; end if;
  end loop;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.deleted_family_capsules'::regclass and contype = 'p'
      and pg_catalog.pg_get_constraintdef(oid) = 'PRIMARY KEY (circle_id, creator_id, capsule_id)'
  ) or not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.deleted_family_capsule_photos'::regclass and contype = 'p'
      and pg_catalog.pg_get_constraintdef(oid) = 'PRIMARY KEY (circle_id, uploader_id, photo_id)'
  ) then raise exception 'Deletion identity keys are incorrect'; end if;
  if not exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.family_capsules'::regclass and tgname = 'guard_deleted_capsule_creation'
      and tgenabled = 'O' and tgfoid = 'public.guard_deleted_capsule_creation()'::regprocedure
  ) or not exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.family_capsule_items'::regclass and tgname = 'guard_deleted_capsule_photo'
      and tgenabled = 'O' and tgfoid = 'public.guard_deleted_capsule_photo()'::regprocedure
  ) then raise exception 'Capsule resurrection guards are missing'; end if;
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'deleted_family_capsules'
      and policyname = 'deleted_capsules_read_by_family' and cmd = 'SELECT'
      and qual like '%is_approved_circle_member%' and qual like '%was_published%'
      and qual like '%creator_id%current_app_user_id%'
  ) or not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'deleted_family_capsule_photos'
      and policyname = 'deleted_capsule_photos_read_by_family' and cmd = 'SELECT'
      and qual like '%is_approved_circle_member%' and qual like '%was_published%'
      and qual like '%opens_at%' and qual like '%deleted_at IS NULL%'
  ) then raise exception 'Deletion marker privacy policies are missing'; end if;
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'family_capsules'
      and policyname = 'family_capsules_read_by_approved_members' and cmd = 'SELECT'
      and qual like '%deleted_at IS NULL%'
  ) or not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'family_capsule_items'
      and policyname = 'family_capsule_items_read_at_unlock_or_own' and cmd = 'SELECT'
      and qual like '%deleted_at IS NULL%'
  ) then raise exception 'Deleted-parent read policies are missing'; end if;
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'capsule_media_excludes_deleted_parent'
      and permissive = 'RESTRICTIVE' and cmd = 'SELECT'
      and qual like '%capsule_media_has_no_deleted_parent%'
  ) then raise exception 'Deleted-parent Storage guard is missing'; end if;

  foreach v_function in array array[
    'public.delete_family_capsule(uuid,uuid)',
    'public.delete_family_capsule_photo(uuid,uuid,uuid)',
    'public.capsule_media_has_no_deleted_parent(text)',
    'public.list_capsule_photo_reactions(uuid)',
    'public.set_capsule_photo_reaction(uuid,text)'
  ] loop
    if not has_function_privilege('authenticated', v_function, 'execute')
      or has_function_privilege('anon', v_function, 'execute')
      or not (select prosecdef from pg_catalog.pg_proc where oid = v_function::regprocedure)
    then raise exception 'Incorrect function grants or security mode for %', v_function; end if;
  end loop;
  if pg_catalog.pg_get_functiondef('public.capsule_media_has_no_deleted_parent(text)'::regprocedure)
    not like '%is_approved_circle_member%storage_object_circle_id%'
  then raise exception 'Storage helper is missing its own membership guard'; end if;
  if pg_catalog.pg_get_functiondef('public.list_capsule_photo_reactions(uuid)'::regprocedure)
      not like '%deleted_at is null%'
    or pg_catalog.pg_get_functiondef('public.set_capsule_photo_reaction(uuid,text)'::regprocedure)
      not like '%deleted_at is null%'
  then raise exception 'Reaction RPCs are missing deleted-parent guards'; end if;
end;
$check$;

select set_config('request.jwt.claims', '{"role":"anon"}', true),
  set_config('request.jwt.claim', '{"role":"anon"}', true),
  set_config('request.jwt.claim.sub', '', true);
set local role anon;
do $smoke$
declare v_denied boolean;
begin
  v_denied := false;
  begin
    perform public.delete_family_capsule(null::uuid, null::uuid);
  exception when insufficient_privilege then v_denied := true;
  end;
  if not v_denied then raise exception 'Anonymous Capsule deletion was not rejected'; end if;
  v_denied := false;
  begin
    perform public.delete_family_capsule_photo(null::uuid, null::uuid, null::uuid);
  exception when insufficient_privilege then v_denied := true;
  end;
  if not v_denied then raise exception 'Anonymous Capsule photo deletion was not rejected'; end if;
end;
$smoke$;

reset role;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true),
  set_config('request.jwt.claim', '{"role":"authenticated"}', true),
  set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
do $smoke$
declare v_denied boolean;
begin
  if public.current_app_user_id() is not null then
    raise exception 'Smoke connection unexpectedly has a user identity';
  end if;
  v_denied := false;
  begin
    perform public.delete_family_capsule(null::uuid, null::uuid);
  exception when insufficient_privilege then
    if sqlerrm <> 'authentication_required' then raise; end if;
    v_denied := true;
  end;
  if not v_denied then raise exception 'Missing-identity Capsule deletion was not rejected'; end if;
  v_denied := false;
  begin
    perform public.delete_family_capsule_photo(null::uuid, null::uuid, null::uuid);
  exception when insufficient_privilege then
    if sqlerrm <> 'authentication_required' then raise; end if;
    v_denied := true;
  end;
  if not v_denied then raise exception 'Missing-identity Capsule photo deletion was not rejected'; end if;
  if public.capsule_media_has_no_deleted_parent('invalid/path') is distinct from false then
    raise exception 'Storage helper did not deny a malformed path without identity';
  end if;
end;
$smoke$;
rollback;

select 'PASS: Capsule deletion schema, privacy guards, grants, anonymous denial and missing-identity denial; read-only transaction rolled back' as deployment_smoke;

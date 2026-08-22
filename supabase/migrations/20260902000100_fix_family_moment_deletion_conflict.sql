begin;

-- The function returns a column named moment_id, so PL/pgSQL can interpret
-- `on conflict (moment_id)` as either that output variable or the table
-- column. Name the primary-key constraint explicitly to keep deletion
-- idempotent without relying on ambiguous identifier resolution.
create or replace function public.begin_delete_own_family_moment(
  p_circle_id uuid,
  p_moment_id uuid
)
returns table (moment_id uuid, media_paths text[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_moment public.family_moments%rowtype;
  v_media_paths text[];
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'profile_bootstrap_required';
  end if;

  if p_circle_id is null
    or not public.is_approved_circle_member(p_circle_id)
  then
    raise exception using errcode = '42501', message = 'approved_circle_membership_required';
  end if;

  select family_moment.*
    into v_moment
  from public.family_moments as family_moment
  where family_moment.id = p_moment_id
    and family_moment.circle_id = p_circle_id
  for update;

  if not found then
    if exists (
      select 1
      from public.family_moment_deletions as deletion
      where deletion.moment_id = p_moment_id
        and deletion.circle_id = p_circle_id
        and deletion.uploader_id = v_user_id
    ) then
      return query select p_moment_id, array[]::text[];
      return;
    end if;
    raise exception using errcode = 'P0002', message = 'family_moment_not_found';
  end if;

  if v_moment.uploader_id <> v_user_id then
    raise exception using errcode = '42501', message = 'moment_uploader_required';
  end if;

  select pg_catalog.array_remove(
    array[v_moment.panorama_path, v_moment.thumbnail_path]
      || coalesce(
        pg_catalog.array_agg(annotation.audio_path order by annotation.sort_order)
          filter (where annotation.audio_path is not null),
        array[]::text[]
      ),
    null
  )
    into v_media_paths
  from public.family_moment_annotations as annotation
  where annotation.moment_id = v_moment.id;

  update public.family_moments as family_moment
  set status = 'deleting'
  where family_moment.id = v_moment.id;

  insert into public.family_moment_deletions (
    moment_id,
    circle_id,
    uploader_id
  )
  values (
    v_moment.id,
    v_moment.circle_id,
    v_moment.uploader_id
  )
  on conflict on constraint family_moment_deletions_pkey do nothing;

  return query select v_moment.id, v_media_paths;
end;
$$;

comment on function public.begin_delete_own_family_moment(uuid, uuid) is
  'Authenticates the uploader, hides the ready moment, and creates a durable family tombstone before returning exact private media paths for Storage cleanup.';

commit;

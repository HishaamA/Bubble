begin;

-- A tombstone is deliberately retained after media cleanup. It gives every
-- family device a durable, offline-safe way to evict a deleted local cache and
-- provides a Realtime INSERT that remains visible under SELECT RLS.
create table public.family_moment_deletions (
  moment_id uuid primary key,
  circle_id uuid not null references public.circles (id) on delete cascade,
  uploader_id uuid not null references public.profiles (id) on delete restrict,
  deleted_at timestamptz not null default now()
);

create index family_moment_deletions_circle_deleted_idx
  on public.family_moment_deletions (circle_id, deleted_at desc);

comment on table public.family_moment_deletions is
  'Durable family-visible tombstones for owner-deleted 360 moments. Rows remain after private Storage cleanup so offline devices can reconcile.';

alter table public.family_moments
  drop constraint family_moments_ready_only;

alter table public.family_moments
  add constraint family_moments_status
  check (status in ('ready', 'deleting'));

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
  on conflict (moment_id) do nothing;

  return query select v_moment.id, v_media_paths;
end;
$$;

comment on function public.begin_delete_own_family_moment(uuid, uuid) is
  'Authenticates the uploader, hides the ready moment, and creates a durable family tombstone before returning exact private media paths for Storage cleanup.';

create or replace function public.list_pending_own_family_moment_deletions(
  p_circle_id uuid
)
returns table (moment_id uuid, media_paths text[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'profile_bootstrap_required';
  end if;

  if p_circle_id is null then
    raise exception using errcode = '22004', message = 'circle_id_required';
  end if;

  return query
  select
    family_moment.id,
    pg_catalog.array_remove(
      array[family_moment.panorama_path, family_moment.thumbnail_path]
        || coalesce(
          pg_catalog.array_agg(annotation.audio_path order by annotation.sort_order)
            filter (where annotation.audio_path is not null),
          array[]::text[]
        ),
      null
    )
  from public.family_moments as family_moment
  left join public.family_moment_annotations as annotation
    on annotation.moment_id = family_moment.id
  join public.family_moment_deletions as deletion
    on deletion.moment_id = family_moment.id
    and deletion.circle_id = family_moment.circle_id
    and deletion.uploader_id = family_moment.uploader_id
  where family_moment.circle_id = p_circle_id
    and (
      family_moment.uploader_id = v_user_id
      or public.is_circle_owner(p_circle_id)
    )
    and family_moment.status = 'deleting'
  group by family_moment.id;
end;
$$;

comment on function public.list_pending_own_family_moment_deletions(uuid) is
  'Returns exact media paths for the caller''s already-started deletions, or every already-started deletion when the caller is circle owner, so cleanup can safely resume after relaunch, reconnect, or later family removal.';

create or replace function public.can_delete_own_pending_family_media(
  p_name text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    public.current_app_user_id() is not null
    and exists (
      select 1
      from public.family_moments as family_moment
      left join public.family_moment_annotations as annotation
        on annotation.moment_id = family_moment.id
      where family_moment.status = 'deleting'
        and (
          family_moment.uploader_id = public.current_app_user_id()
          or public.is_circle_owner(family_moment.circle_id)
        )
        and exists (
          select 1
          from public.family_moment_deletions as deletion
          where deletion.moment_id = family_moment.id
            and deletion.circle_id = family_moment.circle_id
            and deletion.uploader_id = family_moment.uploader_id
        )
        and (
          family_moment.panorama_path = p_name
          or family_moment.thumbnail_path = p_name
          or annotation.audio_path = p_name
        )
    );
$$;

comment on function public.can_delete_own_pending_family_media(text) is
  'Storage RLS helper that allows only exact media referenced by a tombstoned deleting moment to its uploader or circle owner, including cleanup after later family removal.';

create policy family_media_delete_pending_by_uploader_or_owner
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'family-media'
  and public.can_delete_own_pending_family_media(name)
);

create or replace function public.finish_delete_own_family_moment(
  p_circle_id uuid,
  p_moment_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_moment public.family_moments%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'profile_bootstrap_required';
  end if;

  if p_circle_id is null then
    raise exception using errcode = '22004', message = 'circle_id_required';
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
        and (
          deletion.uploader_id = v_user_id
          or public.is_circle_owner(p_circle_id)
        )
    ) then
      return p_moment_id;
    end if;
    raise exception using errcode = 'P0002', message = 'family_moment_not_found';
  end if;

  if v_moment.uploader_id <> v_user_id
    and not public.is_circle_owner(v_moment.circle_id)
  then
    raise exception using errcode = '42501', message = 'moment_uploader_or_circle_owner_required';
  end if;

  if v_moment.status <> 'deleting' then
    raise exception using errcode = 'P0001', message = 'moment_deletion_not_started';
  end if;

  if not exists (
    select 1
    from public.family_moment_deletions as deletion
    where deletion.moment_id = v_moment.id
      and deletion.circle_id = v_moment.circle_id
      and deletion.uploader_id = v_moment.uploader_id
  ) then
    raise exception using errcode = '42501', message = 'owned_deletion_tombstone_required';
  end if;

  if exists (
    select 1
    from storage.objects as object
    where object.bucket_id = 'family-media'
      and (
        object.name = v_moment.panorama_path
        or object.name = v_moment.thumbnail_path
        or exists (
          select 1
          from public.family_moment_annotations as annotation
          where annotation.moment_id = v_moment.id
            and annotation.audio_path = object.name
        )
      )
  ) then
    raise exception using errcode = 'P0001', message = 'family_moment_media_cleanup_incomplete';
  end if;

  delete from public.family_moments as family_moment
  where family_moment.id = v_moment.id;

  return v_moment.id;
end;
$$;

comment on function public.finish_delete_own_family_moment(uuid, uuid) is
  'Finalizes a tombstoned deletion for its uploader or circle owner only after the panorama, thumbnail, and every voice object are absent from private Storage, including cleanup after family removal.';

alter table public.family_moment_deletions enable row level security;

create policy family_moment_deletions_read_by_approved_members
on public.family_moment_deletions
for select
to authenticated
using (public.is_approved_circle_member(circle_id));

revoke all on table public.family_moment_deletions
  from public, anon, authenticated;
grant select on table public.family_moment_deletions to authenticated;
grant all on table public.family_moment_deletions to service_role;

revoke all on function public.begin_delete_own_family_moment(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.list_pending_own_family_moment_deletions(uuid)
  from public, anon, authenticated;
revoke all on function public.can_delete_own_pending_family_media(text)
  from public, anon, authenticated;
revoke all on function public.finish_delete_own_family_moment(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.begin_delete_own_family_moment(uuid, uuid)
  to authenticated, service_role;
grant execute on function public.list_pending_own_family_moment_deletions(uuid)
  to authenticated, service_role;
grant execute on function public.can_delete_own_pending_family_media(text)
  to authenticated, service_role;
grant execute on function public.finish_delete_own_family_moment(uuid, uuid)
  to authenticated, service_role;

do $$
begin
  if exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'family_moment_deletions'
  ) then
    alter publication supabase_realtime
      add table public.family_moment_deletions;
  end if;
end;
$$;

commit;

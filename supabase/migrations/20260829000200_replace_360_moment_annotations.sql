begin;

-- Annotation identity is also the reply target for family comments. Keep the
-- identity key stable and defer only the per-moment ordering constraint so an
-- uploader can reorder existing points without deleting and recreating them.
alter table public.family_moment_annotations
  drop constraint family_moment_annotations_moment_order_unique;

alter table public.family_moment_annotations
  add constraint family_moment_annotations_moment_order_unique
  unique (moment_id, sort_order)
  deferrable initially immediate;

create or replace function public.replace_360_moment_annotations(
  p_circle_id uuid,
  p_moment_id uuid,
  p_annotations jsonb default '[]'::jsonb
)
returns table (moment_id uuid, stale_audio_paths text[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_moment public.family_moments%rowtype;
  v_annotations jsonb := coalesce(p_annotations, '[]'::jsonb);
  v_annotation jsonb;
  v_annotation_id text;
  v_annotation_ids text[] := array[]::text[];
  v_incoming_audio_paths text[] := array[]::text[];
  v_stale_audio_paths text[] := array[]::text[];
  v_kind text;
  v_message text;
  v_audio_path text;
  v_existing_audio_path text;
  v_audio_mime_type text;
  v_audio_extension text;
  v_expected_audio_path_pattern text;
  v_duration numeric;
  v_sort_order smallint;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'profile_bootstrap_required';
  end if;

  -- Membership is checked before the private moment lookup to avoid exposing
  -- whether a moment ID exists in another family.
  if p_circle_id is null
    or not public.is_approved_circle_member(p_circle_id)
  then
    raise exception using
      errcode = '42501',
      message = 'approved_circle_membership_required';
  end if;

  select family_moment.*
    into v_moment
  from public.family_moments as family_moment
  where family_moment.id = p_moment_id
    and family_moment.circle_id = p_circle_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'family_moment_not_found';
  end if;

  if v_moment.uploader_id <> v_user_id then
    raise exception using
      errcode = '42501',
      message = 'moment_uploader_required';
  end if;

  if v_moment.status <> 'ready' then
    raise exception using
      errcode = 'P0001',
      message = 'ready_family_moment_required';
  end if;

  if jsonb_typeof(v_annotations) <> 'array' then
    raise exception using
      errcode = '22023',
      message = 'annotations_must_be_an_array';
  end if;

  if jsonb_array_length(v_annotations) > 8 then
    raise exception using
      errcode = '22023',
      message = 'too_many_annotations';
  end if;

  for v_annotation, v_sort_order in
    select item.value, (item.ordinality - 1)::smallint
    from jsonb_array_elements(v_annotations)
      with ordinality as item(value, ordinality)
  loop
    if jsonb_typeof(v_annotation) <> 'object' then
      raise exception using
        errcode = '22023',
        message = 'annotation_must_be_an_object';
    end if;

    if jsonb_typeof(v_annotation -> 'id') is distinct from 'string'
      or coalesce(v_annotation ->> 'id', '') !~
        '^[a-z0-9][a-z0-9_-]{0,79}$'
    then
      raise exception using
        errcode = '22023',
        message = 'invalid_annotation_id';
    end if;

    v_annotation_id := v_annotation ->> 'id';
    if v_annotation_id = any(v_annotation_ids) then
      raise exception using
        errcode = '22023',
        message = 'duplicate_annotation_id';
    end if;
    v_annotation_ids := pg_catalog.array_append(
      v_annotation_ids,
      v_annotation_id
    );

    v_kind := v_annotation ->> 'kind';
    if jsonb_typeof(v_annotation -> 'kind') is distinct from 'string'
      or v_kind not in ('text', 'voice')
    then
      raise exception using
        errcode = '22023',
        message = 'invalid_annotation_kind';
    end if;

    if jsonb_typeof(v_annotation -> 'pitch') is distinct from 'number'
      or jsonb_typeof(v_annotation -> 'yaw') is distinct from 'number'
      or (v_annotation ->> 'pitch')::numeric not between -90 and 90
      or (v_annotation ->> 'yaw')::numeric not between -180 and 180
    then
      raise exception using
        errcode = '22023',
        message = 'annotation_coordinates_out_of_bounds';
    end if;

    if jsonb_typeof(v_annotation -> 'message') is distinct from 'string' then
      raise exception using
        errcode = '22023',
        message = 'annotation_text_out_of_bounds';
    end if;

    v_message := btrim(v_annotation ->> 'message');
    if char_length(v_message) not between 1 and 180 then
      raise exception using
        errcode = '22023',
        message = 'annotation_text_out_of_bounds';
    end if;

    v_audio_path := nullif(v_annotation ->> 'audio_path', '');
    v_audio_mime_type := nullif(v_annotation ->> 'audio_mime_type', '');

    if v_annotation ? 'duration_ms'
      and jsonb_typeof(v_annotation -> 'duration_ms') <> 'null'
    then
      if jsonb_typeof(v_annotation -> 'duration_ms') <> 'number' then
        raise exception using
          errcode = '22023',
          message = 'invalid_voice_duration';
      end if;

      v_duration := (v_annotation ->> 'duration_ms')::numeric;
      if v_duration <> trunc(v_duration)
        or v_duration not between 0 and 60000
      then
        raise exception using
          errcode = '22023',
          message = 'invalid_voice_duration';
      end if;
    else
      v_duration := null;
    end if;

    if v_kind = 'text' then
      if v_audio_path is not null
        or v_audio_mime_type is not null
        or v_duration is not null
      then
        raise exception using
          errcode = '22023',
          message = 'text_annotation_cannot_have_audio';
      end if;
      continue;
    end if;

    v_audio_extension := case v_audio_mime_type
      when 'audio/aac' then 'aac'
      when 'audio/mp4' then 'm4a'
      when 'audio/mpeg' then 'mp3'
      when 'audio/wav' then 'wav'
      when 'audio/webm' then 'webm'
      else null
    end;
    if v_audio_extension is null then
      raise exception using
        errcode = '22023',
        message = 'unsupported_voice_audio_type';
    end if;

    -- A pre-migration immutable path may remain attached to an unchanged
    -- annotation ID. Every newly selected clip must use a fresh 128-bit token,
    -- which prevents overwrites and makes stale-path cleanup race-safe.
    v_existing_audio_path := null;
    select annotation.audio_path
      into v_existing_audio_path
    from public.family_moment_annotations as annotation
    where annotation.moment_id = p_moment_id
      and annotation.id = v_annotation_id
      and annotation.kind = 'voice';

    v_expected_audio_path_pattern :=
      '^' || p_circle_id::text
      || '/voice/' || v_user_id::text
      || '/' || p_moment_id::text
      || '-' || v_annotation_id
      || '-[0-9a-f]{32}\.' || v_audio_extension || '$';

    if (
        not (
          v_existing_audio_path is not null
          and v_audio_path is not distinct from v_existing_audio_path
        )
        and coalesce(v_audio_path, '') !~ v_expected_audio_path_pattern
      )
      or coalesce(v_audio_path, '') !~ ('\.' || v_audio_extension || '$')
    then
      raise exception using
        errcode = '22023',
        message = 'voice_path_must_match_authenticated_uploader_and_version';
    end if;

    -- Storage DELETE uses the same key through a non-blocking RLS helper. If
    -- cleanup started first, this wait completes before the following SELECT,
    -- which then observes the deletion and rejects the metadata update. If
    -- replacement started first, cleanup is denied instead of waiting with a
    -- stale command snapshot and deleting immediately after this commit.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'kinsphere-family-voice:' || v_audio_path,
        0
      )
    );

    perform 1
    from storage.objects as object
    where object.bucket_id = 'family-media'
      and object.name = v_audio_path
    for key share;

    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'voice_storage_object_not_found';
    end if;

    v_incoming_audio_paths := pg_catalog.array_append(
      v_incoming_audio_paths,
      v_audio_path
    );
  end loop;

  select coalesce(
      pg_catalog.array_agg(
        distinct annotation.audio_path
        order by annotation.audio_path
      ),
      array[]::text[]
    )
    into v_stale_audio_paths
  from public.family_moment_annotations as annotation
  where annotation.moment_id = p_moment_id
    and annotation.audio_path is not null
    and not (annotation.audio_path = any(v_incoming_audio_paths));

  -- The unique order check is deferred only for this transaction. This allows
  -- swaps such as [A, B] -> [B, A] while the primary keys (and comments that
  -- reference them) remain intact.
  set constraints public.family_moment_annotations_moment_order_unique deferred;

  insert into public.family_moment_annotations (
    id,
    moment_id,
    circle_id,
    kind,
    pitch,
    yaw,
    message,
    audio_path,
    audio_mime_type,
    duration_ms,
    sort_order
  )
  select
    item.value ->> 'id',
    p_moment_id,
    p_circle_id,
    item.value ->> 'kind',
    (item.value ->> 'pitch')::double precision,
    (item.value ->> 'yaw')::double precision,
    btrim(item.value ->> 'message'),
    nullif(item.value ->> 'audio_path', ''),
    nullif(item.value ->> 'audio_mime_type', ''),
    case
      when jsonb_typeof(item.value -> 'duration_ms') = 'number'
        then (item.value ->> 'duration_ms')::integer
      else null
    end,
    (item.ordinality - 1)::smallint
  from jsonb_array_elements(v_annotations)
    with ordinality as item(value, ordinality)
  on conflict on constraint family_moment_annotations_primary_key do update
  set circle_id = excluded.circle_id,
      kind = excluded.kind,
      pitch = excluded.pitch,
      yaw = excluded.yaw,
      message = excluded.message,
      audio_path = excluded.audio_path,
      audio_mime_type = excluded.audio_mime_type,
      duration_ms = excluded.duration_ms,
      sort_order = excluded.sort_order;

  delete from public.family_moment_annotations as annotation
  where annotation.moment_id = p_moment_id
    and not (annotation.id = any(v_annotation_ids));

  set constraints public.family_moment_annotations_moment_order_unique immediate;

  return query
  select p_moment_id, v_stale_audio_paths;
end;
$$;

comment on function public.replace_360_moment_annotations(uuid, uuid, jsonb) is
  'Lets the approved uploader replace at most eight annotations on their ready 360 moment, preserving unchanged annotation identities and replies while returning superseded voice paths for client cleanup.';

revoke all on function public.replace_360_moment_annotations(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_360_moment_annotations(uuid, uuid, jsonb)
  to authenticated, service_role;

create or replace function public.can_delete_own_unreferenced_family_voice(
  p_name text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_circle_id uuid;
begin
  if v_user_id is null
    or p_name is null
    or split_part(p_name, '/', 2) <> 'voice'
    or split_part(p_name, '/', 3) <> v_user_id::text
    or array_length(storage.foldername(p_name), 1) <> 3
    or split_part(p_name, '/', 4) = ''
  then
    return false;
  end if;

  begin
    v_circle_id := public.storage_object_circle_id(p_name);
  exception
    when invalid_text_representation then
      return false;
  end;

  if not public.is_approved_circle_member(v_circle_id) then
    return false;
  end if;

  -- Never wait here: a DELETE command that waited for replacement would keep
  -- its pre-commit READ COMMITTED snapshot and could erase the just-referenced
  -- object. A false result leaves the immutable upload for a later retry.
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('kinsphere-family-voice:' || p_name, 0)
  ) then
    return false;
  end if;

  return not exists (
    select 1
    from public.family_moment_annotations as annotation
    where annotation.audio_path = p_name
  );
end;
$$;

comment on function public.can_delete_own_unreferenced_family_voice(text) is
  'Storage RLS helper that safely serializes uploader-owned voice cleanup against annotation attachment and permits only currently unreferenced objects.';

revoke all on function public.can_delete_own_unreferenced_family_voice(text)
  from public, anon, authenticated;
grant execute on function public.can_delete_own_unreferenced_family_voice(text)
  to authenticated, service_role;

-- Split failed-upload cleanup by media type. Voice cleanup is deliberately
-- separate and permits only the authenticated uploader's exact, unreferenced
-- object after the RPC has stopped referencing it.
drop policy if exists family_media_delete_unfinalized_by_uploader
  on storage.objects;

create policy family_media_delete_unfinalized_by_uploader
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'family-media'
  and public.is_approved_circle_member(public.storage_object_circle_id(name))
  and split_part(name, '/', 2) in ('panoramas', 'thumbnails')
  and split_part(name, '/', 3) = public.current_app_user_id()::text
  and array_length(storage.foldername(name), 1) = 3
  and not exists (
    select 1
    from public.family_moments as moment
    where moment.panorama_path = storage.objects.name
      or moment.thumbnail_path = storage.objects.name
  )
);

-- Lets an approved uploader remove only their own unreferenced failed panorama
-- or thumbnail uploads.

create policy family_voice_delete_unreferenced_by_uploader
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'family-media'
  and public.can_delete_own_unreferenced_family_voice(name)
);

-- Lets an approved uploader delete only their own private voice object after it
-- is unreferenced, including stale paths returned by
-- replace_360_moment_annotations.

commit;

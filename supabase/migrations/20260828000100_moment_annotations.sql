begin;

-- A redundant composite key lets annotation rows carry circle_id for efficient
-- RLS and Realtime filtering while still proving that the circle belongs to
-- the referenced moment.
alter table public.family_moments
  add constraint family_moments_id_circle_unique unique (id, circle_id);

create table public.family_moment_annotations (
  id text not null,
  moment_id uuid not null,
  circle_id uuid not null,
  kind text not null,
  pitch double precision not null,
  yaw double precision not null,
  message text not null,
  audio_path text unique,
  audio_mime_type text,
  duration_ms integer,
  sort_order smallint not null,
  created_at timestamptz not null default now(),
  constraint family_moment_annotations_moment_circle_fk
    foreign key (moment_id, circle_id)
    references public.family_moments (id, circle_id)
    on delete cascade,
  constraint family_moment_annotations_kind
    check (kind in ('text', 'voice')),
  constraint family_moment_annotations_coordinates
    check (pitch between -90 and 90 and yaw between -180 and 180),
  constraint family_moment_annotations_message_length
    check (char_length(btrim(message)) between 1 and 180),
  constraint family_moment_annotations_sort_order
    check (sort_order between 0 and 7),
  constraint family_moment_annotations_duration
    check (duration_ms is null or duration_ms between 0 and 60000),
  constraint family_moment_annotations_audio_path_length
    check (audio_path is null or char_length(audio_path) between 1 and 500),
  constraint family_moment_annotations_payload
    check (
      (
        kind = 'text'
        and audio_path is null
        and audio_mime_type is null
        and duration_ms is null
      )
      or (
        kind = 'voice'
        and audio_path is not null
        and audio_mime_type in (
          'audio/aac',
          'audio/mp4',
          'audio/mpeg',
          'audio/wav',
          'audio/webm'
        )
      )
    ),
  constraint family_moment_annotations_primary_key
    primary key (moment_id, id),
  constraint family_moment_annotations_moment_order_unique
    unique (moment_id, sort_order)
);

comment on table public.family_moment_annotations is
  'Private, position-bound text and voice annotations finalized atomically with a ready family panorama.';

comment on column public.family_moment_annotations.message is
  'Visible text for a note, or the required accessible text alternative for a voice annotation.';

create index family_moment_annotations_moment_order_idx
  on public.family_moment_annotations (moment_id, sort_order);

create index family_moment_annotations_circle_created_idx
  on public.family_moment_annotations (circle_id, created_at desc);

create or replace function public.finalize_360_moment_with_annotations(
  p_circle_id uuid,
  p_moment_id uuid,
  p_capture_kind text,
  p_panorama_path text,
  p_thumbnail_path text,
  p_panorama_width integer,
  p_panorama_height integer,
  p_thumbnail_width integer,
  p_thumbnail_height integer,
  p_caption text default null,
  p_annotations jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_annotations jsonb := coalesce(p_annotations, '[]'::jsonb);
  v_annotation jsonb;
  v_annotation_id text;
  v_annotation_ids text[] := array[]::text[];
  v_kind text;
  v_message text;
  v_audio_path text;
  v_audio_mime_type text;
  v_audio_extension text;
  v_expected_audio_path text;
  v_duration numeric;
  v_sort_order smallint;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'profile_bootstrap_required';
  end if;

  -- Reject cross-circle probes before checking whether any private Storage
  -- object exists. The wrapped finalizer repeats this check as defense in depth.
  if p_circle_id is null
    or not public.is_approved_circle_member(p_circle_id)
  then
    raise exception using errcode = '42501', message = 'approved_circle_membership_required';
  end if;

  if jsonb_typeof(v_annotations) <> 'array' then
    raise exception using errcode = '22023', message = 'annotations_must_be_an_array';
  end if;

  if jsonb_array_length(v_annotations) > 8 then
    raise exception using errcode = '22023', message = 'too_many_annotations';
  end if;

  for v_annotation, v_sort_order in
    select item.value, (item.ordinality - 1)::smallint
    from jsonb_array_elements(v_annotations)
      with ordinality as item(value, ordinality)
  loop
    if jsonb_typeof(v_annotation) <> 'object' then
      raise exception using errcode = '22023', message = 'annotation_must_be_an_object';
    end if;

    if coalesce(v_annotation ->> 'id', '') !~
      '^[a-z0-9][a-z0-9_-]{0,79}$'
    then
      raise exception using errcode = '22023', message = 'invalid_annotation_id';
    end if;
    v_annotation_id := v_annotation ->> 'id';
    if v_annotation_id = any(v_annotation_ids) then
      raise exception using errcode = '22023', message = 'duplicate_annotation_id';
    end if;
    v_annotation_ids := pg_catalog.array_append(
      v_annotation_ids,
      v_annotation_id
    );

    v_kind := v_annotation ->> 'kind';
    if v_kind is null or v_kind not in ('text', 'voice') then
      raise exception using errcode = '22023', message = 'invalid_annotation_kind';
    end if;

    if jsonb_typeof(v_annotation -> 'pitch') is distinct from 'number'
      or jsonb_typeof(v_annotation -> 'yaw') is distinct from 'number'
      or (v_annotation ->> 'pitch')::numeric not between -90 and 90
      or (v_annotation ->> 'yaw')::numeric not between -180 and 180
    then
      raise exception using errcode = '22023', message = 'annotation_coordinates_out_of_bounds';
    end if;

    v_message := btrim(v_annotation ->> 'message');
    if v_message is null or char_length(v_message) not between 1 and 180 then
      raise exception using errcode = '22023', message = 'annotation_text_out_of_bounds';
    end if;

    v_audio_path := nullif(v_annotation ->> 'audio_path', '');
    v_audio_mime_type := nullif(v_annotation ->> 'audio_mime_type', '');

    if v_annotation ? 'duration_ms'
      and jsonb_typeof(v_annotation -> 'duration_ms') <> 'null'
    then
      if jsonb_typeof(v_annotation -> 'duration_ms') <> 'number' then
        raise exception using errcode = '22023', message = 'invalid_voice_duration';
      end if;
      v_duration := (v_annotation ->> 'duration_ms')::numeric;
      if v_duration <> trunc(v_duration) or v_duration not between 0 and 60000 then
        raise exception using errcode = '22023', message = 'invalid_voice_duration';
      end if;
    else
      v_duration := null;
    end if;

    if v_kind = 'text' then
      if v_audio_path is not null
        or v_audio_mime_type is not null
        or v_duration is not null
      then
        raise exception using errcode = '22023', message = 'text_annotation_cannot_have_audio';
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
      raise exception using errcode = '22023', message = 'unsupported_voice_audio_type';
    end if;

    v_expected_audio_path := pg_catalog.format(
      '%s/voice/%s/%s-%s.%s',
      p_circle_id,
      v_user_id,
      p_moment_id,
      v_annotation_id,
      v_audio_extension
    );
    if v_audio_path is distinct from v_expected_audio_path then
      raise exception using errcode = '22023', message = 'voice_path_must_match_authenticated_uploader';
    end if;

    if not exists (
      select 1
      from storage.objects as object
      where object.bucket_id = 'family-media'
        and object.name = v_expected_audio_path
    ) then
      raise exception using errcode = 'P0001', message = 'voice_storage_object_not_found';
    end if;
  end loop;

  -- PostgreSQL functions participate in the caller's transaction. Any later
  -- annotation failure therefore rolls back this ready-moment insertion too.
  perform public.finalize_360_moment(
    p_circle_id,
    p_moment_id,
    p_capture_kind,
    p_panorama_path,
    p_thumbnail_path,
    p_panorama_width,
    p_panorama_height,
    p_thumbnail_width,
    p_thumbnail_height,
    p_caption
  );

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
    with ordinality as item(value, ordinality);

  return p_moment_id;
end;
$$;

comment on function public.finalize_360_moment_with_annotations(
  uuid,
  uuid,
  text,
  text,
  text,
  integer,
  integer,
  integer,
  integer,
  text,
  jsonb
) is
  'Atomically finalizes one 360 moment and at most eight validated, private text or voice annotations after verifying every canonical voice object.';

alter table public.family_moment_annotations enable row level security;

create policy family_moment_annotations_read_by_approved_members
on public.family_moment_annotations
for select
to authenticated
using (public.is_approved_circle_member(circle_id));

revoke all on table public.family_moment_annotations
  from public, anon, authenticated;
grant select on table public.family_moment_annotations to authenticated;
grant all on table public.family_moment_annotations to service_role;

-- Uploads remain immutable after finalization, but the uploader may clean up
-- an object that was successfully stored before a later upload or database
-- finalization failed. Referenced panorama, thumbnail, and voice objects can
-- never satisfy this policy.
create policy family_media_delete_unfinalized_by_uploader
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'family-media'
  and public.is_approved_circle_member(public.storage_object_circle_id(name))
  and split_part(name, '/', 2) in ('panoramas', 'thumbnails', 'voice')
  and split_part(name, '/', 3) = public.current_app_user_id()::text
  and array_length(storage.foldername(name), 1) = 3
  and not exists (
    select 1
    from public.family_moments as moment
    where moment.panorama_path = storage.objects.name
      or moment.thumbnail_path = storage.objects.name
  )
  and not exists (
    select 1
    from public.family_moment_annotations as annotation
    where annotation.audio_path = storage.objects.name
  )
);

comment on policy family_media_delete_unfinalized_by_uploader
on storage.objects is
  'Lets an uploader remove only their own unreferenced failed-upload objects; finalized family media stays immutable.';

revoke all on function public.finalize_360_moment_with_annotations(
  uuid,
  uuid,
  text,
  text,
  text,
  integer,
  integer,
  integer,
  integer,
  text,
  jsonb
) from public, anon, authenticated;

grant execute on function public.finalize_360_moment_with_annotations(
  uuid,
  uuid,
  text,
  text,
  text,
  integer,
  integer,
  integer,
  integer,
  text,
  jsonb
) to authenticated, service_role;

commit;

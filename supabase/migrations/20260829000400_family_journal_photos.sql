begin;

create table public.family_journal_photos (
  id uuid primary key,
  circle_id uuid not null references public.circles (id) on delete cascade,
  uploader_id uuid not null references public.profiles (id) on delete restrict,
  image_path text not null unique,
  thumbnail_path text not null unique,
  image_width integer not null,
  image_height integer not null,
  thumbnail_width integer not null,
  thumbnail_height integer not null,
  caption text,
  captured_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint family_journal_photos_image_dimensions check (
    image_width between 1 and 4096 and image_height between 1 and 4096
  ),
  constraint family_journal_photos_thumbnail_dimensions check (
    thumbnail_width between 1 and 1024 and thumbnail_height between 1 and 1024
  ),
  constraint family_journal_photos_caption_length check (
    caption is null or char_length(caption) <= 240
  ),
  constraint family_journal_photos_path_lengths check (
    char_length(image_path) between 1 and 500
    and char_length(thumbnail_path) between 1 and 500
  ),
  constraint family_journal_photos_distinct_paths check (
    image_path <> thumbnail_path
  ),
  constraint family_journal_photos_plausible_date check (
    captured_at >= timestamptz '1800-01-01 00:00:00+00'
  )
);

create index family_journal_photos_circle_time_idx
  on public.family_journal_photos (circle_id, captured_at desc, id);
create index family_journal_photos_uploader_idx
  on public.family_journal_photos (uploader_id, created_at desc);

create or replace function public.finalize_journal_photo(
  p_circle_id uuid,
  p_photo_id uuid,
  p_image_path text,
  p_thumbnail_path text,
  p_image_width integer,
  p_image_height integer,
  p_thumbnail_width integer,
  p_thumbnail_height integer,
  p_caption text default null,
  p_captured_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_expected_image_path text;
  v_expected_thumbnail_path text;
  v_object_count integer;
  v_objects_valid boolean;
  v_caption text := nullif(btrim(p_caption), '');
  v_captured_at timestamptz := coalesce(p_captured_at, now());
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_circle_id is null or not public.is_approved_circle_member(p_circle_id) then
    raise exception using errcode = '42501', message = 'approved_circle_membership_required';
  end if;
  if p_photo_id is null then
    raise exception using errcode = '22023', message = 'photo_id_required';
  end if;

  v_expected_image_path := pg_catalog.format(
    '%s/journal-images/%s/%s.jpg',
    p_circle_id,
    v_user_id,
    p_photo_id
  );
  v_expected_thumbnail_path := pg_catalog.format(
    '%s/journal-thumbnails/%s/%s.jpg',
    p_circle_id,
    v_user_id,
    p_photo_id
  );

  if p_image_path is distinct from v_expected_image_path
    or p_thumbnail_path is distinct from v_expected_thumbnail_path
  then
    raise exception using errcode = '22023', message = 'media_paths_must_match_authenticated_uploader';
  end if;
  if p_image_width not between 1 and 4096 or p_image_height not between 1 and 4096
    or p_thumbnail_width not between 1 and 1024 or p_thumbnail_height not between 1 and 1024
  then
    raise exception using errcode = '22023', message = 'invalid_journal_photo_dimensions';
  end if;
  if v_caption is not null and char_length(v_caption) > 240 then
    raise exception using errcode = '22023', message = 'journal_photo_caption_too_long';
  end if;
  if v_captured_at < timestamptz '1800-01-01 00:00:00+00'
    or v_captured_at > now() + interval '2 days'
  then
    raise exception using errcode = '22023', message = 'invalid_journal_photo_date';
  end if;

  -- Quotas have different scopes. Lock them in the same fixed order for every
  -- finalization so concurrent members cannot race the family limit and one
  -- member cannot race their aggregate limits through multiple circles.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'family-journal-circle:' || p_circle_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'family-journal-uploader:' || v_user_id::text,
      0
    )
  );
  -- This exact key is also used by failed-upload cleanup. If cleanup wins,
  -- validation below sees the missing object and fails safely; if finalization
  -- wins, cleanup is denied without waiting on a stale statement snapshot.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'family-journal-photo:' || p_circle_id::text || ':' ||
        v_user_id::text || ':' || p_photo_id::text || '.jpg',
      0
    )
  );
  if (
    select count(*) >= 100000
    from public.family_journal_photos as photo
    where photo.circle_id = p_circle_id
  ) then
    raise exception using errcode = '54000', message = 'family_journal_photo_limit_reached';
  end if;
  if (
    select count(*) >= 20000
    from public.family_journal_photos as photo
    where photo.uploader_id = v_user_id
  ) then
    raise exception using errcode = '54000', message = 'member_journal_photo_limit_reached';
  end if;
  if (
    select count(*) >= 2000
    from public.family_journal_photos as photo
    where photo.uploader_id = v_user_id
      and photo.created_at >= now() - interval '24 hours'
  ) then
    raise exception using errcode = '54000', message = 'journal_photo_daily_limit_reached';
  end if;

  select
    count(*)::integer,
    coalesce(bool_and(
      lower(coalesce(object.metadata ->> 'mimetype', '')) in ('image/jpeg', 'image/jpg')
      and case
        when object.name = p_image_path then
          case
            when coalesce(object.metadata ->> 'size', '') ~ '^[0-9]+$'
              then (object.metadata ->> 'size')::bigint between 1 and 10485760
            else false
          end
        when object.name = p_thumbnail_path then
          case
            when coalesce(object.metadata ->> 'size', '') ~ '^[0-9]+$'
              then (object.metadata ->> 'size')::bigint between 1 and 1048576
            else false
          end
        else false
      end
    ), false)
    into v_object_count, v_objects_valid
  from storage.objects as object
  where object.bucket_id = 'family-media'
    and object.name in (p_image_path, p_thumbnail_path);

  if v_object_count <> 2 or not v_objects_valid then
    raise exception using errcode = '22023', message = 'valid_journal_photo_uploads_not_found';
  end if;

  insert into public.family_journal_photos (
    id,
    circle_id,
    uploader_id,
    image_path,
    thumbnail_path,
    image_width,
    image_height,
    thumbnail_width,
    thumbnail_height,
    caption,
    captured_at
  ) values (
    p_photo_id,
    p_circle_id,
    v_user_id,
    p_image_path,
    p_thumbnail_path,
    p_image_width,
    p_image_height,
    p_thumbnail_width,
    p_thumbnail_height,
    v_caption,
    v_captured_at
  );

  return p_photo_id;
end;
$$;

alter table public.family_journal_photos enable row level security;

create policy family_journal_photos_read_by_approved_members
on public.family_journal_photos
for select
to authenticated
using (public.is_approved_circle_member(circle_id));

revoke all on table public.family_journal_photos from anon, authenticated;
grant select on table public.family_journal_photos to authenticated;
grant all on table public.family_journal_photos to service_role;

revoke all on function public.finalize_journal_photo(
  uuid, uuid, text, text, integer, integer, integer, integer, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.finalize_journal_photo(
  uuid, uuid, text, text, integer, integer, integer, integer, text, timestamptz
) to authenticated, service_role;

create or replace function public.can_stage_family_journal_object(p_name text)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_circle_id uuid;
  v_photo_filename text := split_part(p_name, '/', 4);
  v_unfinalized_count integer;
  v_photo_already_staged boolean;
begin
  begin
    v_circle_id := public.storage_object_circle_id(p_name);
  exception
    when invalid_text_representation then
      return false;
  end;

  if v_user_id is null
    or v_circle_id is null
    or not public.is_approved_circle_member(v_circle_id)
    or split_part(p_name, '/', 2) not in ('journal-images', 'journal-thumbnails')
    or split_part(p_name, '/', 3) <> v_user_id::text
    or coalesce(array_length(storage.foldername(p_name), 1), 0) <> 3
    or split_part(p_name, '/', 4) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'
  then
    return false;
  end if;

  -- Serialize the reservation count. Image and thumbnail uploads for the same
  -- UUID count as one in-flight photo, so the client's parallel pair remains
  -- valid even at the limit.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'family-journal-stage:' || v_circle_id::text || ':' || v_user_id::text,
      0
    )
  );

  select
    count(distinct split_part(object.name, '/', 4)) filter (
      where object.created_at >= now() - interval '24 hours'
    )::integer,
    coalesce(bool_or(split_part(object.name, '/', 4) = v_photo_filename), false)
    into v_unfinalized_count, v_photo_already_staged
  from storage.objects as object
  where object.bucket_id = 'family-media'
    and public.storage_object_circle_id(object.name) = v_circle_id
    and split_part(object.name, '/', 2) in ('journal-images', 'journal-thumbnails')
    and split_part(object.name, '/', 3) = v_user_id::text
    and not exists (
      select 1
      from public.family_journal_photos as photo
      where photo.image_path = object.name
        or photo.thumbnail_path = object.name
    );

  return v_photo_already_staged or v_unfinalized_count < 20;
end;
$$;

revoke all on function public.can_stage_family_journal_object(text)
  from public, anon, authenticated;
grant execute on function public.can_stage_family_journal_object(text)
  to authenticated, service_role;

create or replace function public.can_delete_own_unreferenced_family_journal_media(
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
  v_photo_filename text := split_part(p_name, '/', 4);
begin
  if v_user_id is null
    or p_name is null
    or split_part(p_name, '/', 2) not in ('journal-images', 'journal-thumbnails')
    or split_part(p_name, '/', 3) <> v_user_id::text
    or coalesce(array_length(storage.foldername(p_name), 1), 0) <> 3
    or v_photo_filename !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$'
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

  -- Never wait here. Waiting would retain the DELETE statement's pre-commit
  -- snapshot and could erase media that a concurrent finalizer just attached.
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'family-journal-photo:' || v_circle_id::text || ':' ||
        v_user_id::text || ':' || v_photo_filename,
      0
    )
  ) then
    return false;
  end if;

  return not exists (
    select 1
    from public.family_journal_photos as photo
    where photo.image_path = p_name
      or photo.thumbnail_path = p_name
  );
end;
$$;

revoke all on function public.can_delete_own_unreferenced_family_journal_media(text)
  from public, anon, authenticated;
grant execute on function public.can_delete_own_unreferenced_family_journal_media(text)
  to authenticated, service_role;

drop policy if exists family_media_read_by_approved_members on storage.objects;
create policy family_media_read_by_approved_members
on storage.objects
for select
to authenticated
using (
  bucket_id = 'family-media'
  and public.is_approved_circle_member(public.storage_object_circle_id(name))
  and (
    split_part(name, '/', 2) not in (
      'capsule-images',
      'capsule-thumbnails',
      'journal-images',
      'journal-thumbnails'
    )
    or split_part(name, '/', 3) = public.current_app_user_id()::text
    or exists (
      select 1
      from public.family_capsule_items as item
      join public.family_capsules as capsule on capsule.id = item.capsule_id
      where (item.image_path = storage.objects.name or item.thumbnail_path = storage.objects.name)
        and capsule.opens_at <= now()
        and public.is_approved_circle_member(item.circle_id)
    )
    or exists (
      select 1
      from public.family_journal_photos as photo
      where (photo.image_path = storage.objects.name or photo.thumbnail_path = storage.objects.name)
        and public.is_approved_circle_member(photo.circle_id)
    )
  )
);

drop policy if exists family_media_insert_by_approved_members on storage.objects;
create policy family_media_insert_by_approved_members
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'family-media'
  and public.is_approved_circle_member(public.storage_object_circle_id(name))
  and split_part(name, '/', 2) in (
    'panoramas',
    'thumbnails',
    'voice',
    'capsule-images',
    'capsule-thumbnails',
    'journal-images',
    'journal-thumbnails'
  )
  and split_part(name, '/', 3) = public.current_app_user_id()::text
  and array_length(storage.foldername(name), 1) = 3
  and split_part(name, '/', 4) <> ''
  and (
    split_part(name, '/', 2) not in ('journal-images', 'journal-thumbnails')
    or public.can_stage_family_journal_object(name)
  )
);

create policy family_media_delete_unfinalized_journal_by_uploader
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'family-media'
  and public.can_delete_own_unreferenced_family_journal_media(name)
);

comment on policy family_media_delete_unfinalized_journal_by_uploader
on storage.objects is
  'Lets an approved uploader clean up only their own unreferenced Journal photo objects; finalized family photos remain immutable.';

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
      and tablename = 'family_journal_photos'
  ) then
    alter publication supabase_realtime add table public.family_journal_photos;
  end if;
end;
$$;

comment on table public.family_journal_photos is
  'Immediate ordinary family-photo library used by Journal People. Media is metadata-stripped before upload; biometric templates are never stored here.';
comment on function public.finalize_journal_photo(
  uuid, uuid, text, text, integer, integer, integer, integer, text, timestamptz
) is
  'Finalizes one immutable ordinary Journal photo after membership, quota, canonical-path, JPEG MIME, bounded object-size, dimensions, date, and Storage checks.';
comment on function public.can_stage_family_journal_object(text) is
  'Restricts Journal staging to canonical uploader UUID JPEG paths and twenty recent, concurrency-safe in-flight photos.';
comment on function public.can_delete_own_unreferenced_family_journal_media(text) is
  'Safely serializes uploader-owned Journal cleanup against finalization so referenced media cannot be deleted by a stale statement snapshot.';

commit;

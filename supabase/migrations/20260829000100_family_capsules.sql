begin;

create table public.family_capsules (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles (id) on delete cascade,
  created_by uuid not null references public.profiles (id) on delete restrict,
  kind text not null,
  title text not null,
  week_start date,
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  item_count integer not null default 0,
  created_at timestamptz not null default now(),
  constraint family_capsules_id_circle_unique unique (id, circle_id),
  constraint family_capsules_kind check (kind in ('weekly', 'special')),
  constraint family_capsules_title_length check (char_length(btrim(title)) between 1 and 64),
  constraint family_capsules_week_shape check (
    (kind = 'weekly' and week_start is not null)
    or (kind = 'special' and week_start is null)
  ),
  constraint family_capsules_window check (closes_at = opens_at),
  constraint family_capsules_item_count check (item_count between 0 and 10000)
);

create unique index family_capsules_one_weekly_per_circle_idx
  on public.family_capsules (circle_id, week_start)
  where kind = 'weekly';

create index family_capsules_circle_open_idx
  on public.family_capsules (circle_id, opens_at desc);

create table public.family_capsule_items (
  id uuid primary key,
  capsule_id uuid not null,
  circle_id uuid not null,
  uploader_id uuid not null references public.profiles (id) on delete restrict,
  image_path text not null unique,
  thumbnail_path text not null unique,
  image_width integer not null,
  image_height integer not null,
  thumbnail_width integer not null,
  thumbnail_height integer not null,
  caption text,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint family_capsule_items_capsule_circle_fk
    foreign key (capsule_id, circle_id)
    references public.family_capsules (id, circle_id)
    on delete cascade,
  constraint family_capsule_items_image_dimensions check (
    image_width between 1 and 4096 and image_height between 1 and 4096
  ),
  constraint family_capsule_items_thumbnail_dimensions check (
    thumbnail_width between 1 and 1024 and thumbnail_height between 1 and 1024
  ),
  constraint family_capsule_items_caption_length check (
    caption is null or char_length(btrim(caption)) between 1 and 240
  ),
  constraint family_capsule_items_path_lengths check (
    char_length(image_path) between 1 and 500
    and char_length(thumbnail_path) between 1 and 500
  )
);

create index family_capsule_items_capsule_time_idx
  on public.family_capsule_items (capsule_id, captured_at, id);

create or replace function public.get_or_create_weekly_capsule(
  p_circle_id uuid
)
returns public.family_capsules
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_time_zone text;
  v_week_start date;
  v_opens_at timestamptz;
  v_capsule public.family_capsules%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_circle_id is null or not public.is_approved_circle_member(p_circle_id) then
    raise exception using errcode = '42501', message = 'approved_circle_membership_required';
  end if;

  select preference.time_zone
    into v_time_zone
  from public.circles as circle
  left join public.profile_preferences as preference
    on preference.user_id = circle.owner_id
  where circle.id = p_circle_id;

  if v_time_zone is null or not exists (
    select 1 from pg_catalog.pg_timezone_names as zone
    where zone.name = v_time_zone
  ) then
    v_time_zone := 'UTC';
  end if;

  v_week_start := pg_catalog.date_trunc(
    'week',
    now() at time zone v_time_zone
  )::date;
  v_opens_at := (v_week_start + 7)::timestamp at time zone v_time_zone;

  insert into public.family_capsules (
    circle_id,
    created_by,
    kind,
    title,
    week_start,
    opens_at,
    closes_at
  ) values (
    p_circle_id,
    v_user_id,
    'weekly',
    'This week',
    v_week_start,
    v_opens_at,
    v_opens_at
  )
  on conflict (circle_id, week_start) where kind = 'weekly' do nothing;

  select capsule.*
    into strict v_capsule
  from public.family_capsules as capsule
  where capsule.circle_id = p_circle_id
    and capsule.kind = 'weekly'
    and capsule.week_start = v_week_start;

  return v_capsule;
end;
$$;

create or replace function public.create_special_capsule(
  p_circle_id uuid,
  p_title text,
  p_opens_at timestamptz,
  p_capsule_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_title text := nullif(btrim(p_title), '');
  v_capsule_id uuid := p_capsule_id;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_circle_id is null or not public.is_approved_circle_member(p_circle_id) then
    raise exception using errcode = '42501', message = 'approved_circle_membership_required';
  end if;
  if v_title is null or char_length(v_title) > 64 then
    raise exception using errcode = '22023', message = 'invalid_capsule_title';
  end if;
  if p_opens_at is null or p_opens_at <= now() or p_opens_at > now() + interval '2 years' then
    raise exception using errcode = '22023', message = 'capsule_open_time_must_be_future';
  end if;
  if v_capsule_id is null then
    raise exception using errcode = '22023', message = 'capsule_id_required';
  end if;

  insert into public.family_capsules (
    id,
    circle_id,
    created_by,
    kind,
    title,
    opens_at,
    closes_at
  ) values (
    v_capsule_id,
    p_circle_id,
    v_user_id,
    'special',
    v_title,
    p_opens_at,
    p_opens_at
  )
  on conflict (id) do nothing;

  if not exists (
    select 1
    from public.family_capsules as capsule
    where capsule.id = v_capsule_id
      and capsule.circle_id = p_circle_id
      and capsule.created_by = v_user_id
      and capsule.kind = 'special'
      and capsule.title = v_title
      and capsule.opens_at = p_opens_at
      and capsule.closes_at = p_opens_at
  ) then
    raise exception using errcode = '23505', message = 'capsule_id_conflict';
  end if;

  return v_capsule_id;
end;
$$;

create or replace function public.finalize_capsule_photo(
  p_circle_id uuid,
  p_capsule_id uuid,
  p_item_id uuid,
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
  v_capsule public.family_capsules%rowtype;
  v_expected_image_path text;
  v_expected_thumbnail_path text;
  v_object_count integer;
  v_caption text := nullif(btrim(p_caption), '');
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_circle_id is null or not public.is_approved_circle_member(p_circle_id) then
    raise exception using errcode = '42501', message = 'approved_circle_membership_required';
  end if;
  if p_capsule_id is null or p_item_id is null then
    raise exception using errcode = '22023', message = 'capsule_and_item_ids_required';
  end if;

  select capsule.*
    into strict v_capsule
  from public.family_capsules as capsule
  where capsule.id = p_capsule_id
    and capsule.circle_id = p_circle_id
  for update;

  if now() >= v_capsule.closes_at then
    raise exception using errcode = '22023', message = 'capsule_is_already_open';
  end if;

  v_expected_image_path := pg_catalog.format(
    '%s/capsule-images/%s/%s.jpg',
    p_circle_id,
    v_user_id,
    p_item_id
  );
  v_expected_thumbnail_path := pg_catalog.format(
    '%s/capsule-thumbnails/%s/%s.jpg',
    p_circle_id,
    v_user_id,
    p_item_id
  );

  if p_image_path is distinct from v_expected_image_path
    or p_thumbnail_path is distinct from v_expected_thumbnail_path
  then
    raise exception using errcode = '22023', message = 'media_paths_must_match_authenticated_uploader';
  end if;
  if p_image_width not between 1 and 4096 or p_image_height not between 1 and 4096
    or p_thumbnail_width not between 1 and 1024 or p_thumbnail_height not between 1 and 1024
  then
    raise exception using errcode = '22023', message = 'invalid_capsule_photo_dimensions';
  end if;
  if v_caption is not null and char_length(v_caption) > 240 then
    raise exception using errcode = '22023', message = 'capsule_photo_caption_too_long';
  end if;

  select count(*)::integer
    into v_object_count
  from storage.objects as object
  where object.bucket_id = 'family-media'
    and object.name in (p_image_path, p_thumbnail_path);

  if v_object_count <> 2 then
    raise exception using errcode = '22023', message = 'capsule_photo_uploads_not_found';
  end if;

  insert into public.family_capsule_items (
    id,
    capsule_id,
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
    p_item_id,
    p_capsule_id,
    p_circle_id,
    v_user_id,
    p_image_path,
    p_thumbnail_path,
    p_image_width,
    p_image_height,
    p_thumbnail_width,
    p_thumbnail_height,
    v_caption,
    coalesce(p_captured_at, now())
  );

  update public.family_capsules
  set item_count = item_count + 1
  where id = p_capsule_id;

  return p_item_id;
end;
$$;

alter table public.family_capsules enable row level security;
alter table public.family_capsule_items enable row level security;

create policy family_capsules_read_by_approved_members
on public.family_capsules
for select
to authenticated
using (public.is_approved_circle_member(circle_id));

create policy family_capsule_items_read_at_unlock_or_own
on public.family_capsule_items
for select
to authenticated
using (
  public.is_approved_circle_member(circle_id)
  and (
    uploader_id = public.current_app_user_id()
    or exists (
      select 1
      from public.family_capsules as capsule
      where capsule.id = family_capsule_items.capsule_id
        and capsule.circle_id = family_capsule_items.circle_id
        and capsule.opens_at <= now()
    )
  )
);

revoke all on table public.family_capsules from anon, authenticated;
revoke all on table public.family_capsule_items from anon, authenticated;
grant select on table public.family_capsules to authenticated;
grant select on table public.family_capsule_items to authenticated;
grant all on table public.family_capsules to service_role;
grant all on table public.family_capsule_items to service_role;

revoke all on function public.get_or_create_weekly_capsule(uuid) from public, anon, authenticated;
revoke all on function public.create_special_capsule(uuid, text, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.finalize_capsule_photo(
  uuid, uuid, uuid, text, text, integer, integer, integer, integer, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.get_or_create_weekly_capsule(uuid) to authenticated, service_role;
grant execute on function public.create_special_capsule(uuid, text, timestamptz, uuid) to authenticated, service_role;
grant execute on function public.finalize_capsule_photo(
  uuid, uuid, uuid, text, text, integer, integer, integer, integer, text, timestamptz
) to authenticated, service_role;

drop policy if exists family_media_read_by_approved_members on storage.objects;
create policy family_media_read_by_approved_members
on storage.objects
for select
to authenticated
using (
  bucket_id = 'family-media'
  and public.is_approved_circle_member(public.storage_object_circle_id(name))
  and (
    split_part(name, '/', 2) not in ('capsule-images', 'capsule-thumbnails')
    or split_part(name, '/', 3) = public.current_app_user_id()::text
    or exists (
      select 1
      from public.family_capsule_items as item
      join public.family_capsules as capsule on capsule.id = item.capsule_id
      where (item.image_path = storage.objects.name or item.thumbnail_path = storage.objects.name)
        and capsule.opens_at <= now()
        and public.is_approved_circle_member(item.circle_id)
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
    'capsule-thumbnails'
  )
  and split_part(name, '/', 3) = public.current_app_user_id()::text
  and array_length(storage.foldername(name), 1) = 3
  and split_part(name, '/', 4) <> ''
);

drop policy if exists family_media_delete_unfinalized_capsule_by_uploader
on storage.objects;
create policy family_media_delete_unfinalized_capsule_by_uploader
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'family-media'
  and public.is_approved_circle_member(public.storage_object_circle_id(name))
  and split_part(name, '/', 2) in ('capsule-images', 'capsule-thumbnails')
  and split_part(name, '/', 3) = public.current_app_user_id()::text
  and array_length(storage.foldername(name), 1) = 3
  and split_part(name, '/', 4) <> ''
  and not exists (
    select 1
    from public.family_capsule_items as item
    where item.image_path = storage.objects.name
      or item.thumbnail_path = storage.objects.name
  )
);

-- Lets an approved uploader remove only their own canonical, unreferenced
-- Capsule upload objects; finalized Capsule media stays immutable.

do $$
begin
  if exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) then
    if not exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'family_capsules'
    ) then
      alter publication supabase_realtime add table public.family_capsules;
    end if;

    if not exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'family_capsule_items'
    ) then
      alter publication supabase_realtime add table public.family_capsule_items;
    end if;
  end if;
end;
$$;

comment on table public.family_capsules is
  'Server-timed weekly and named special family photo Capsules. Metadata and total counts are visible before unlock; other members'' photos are not.';
comment on table public.family_capsule_items is
  'Metadata for ordinary, metadata-stripped Capsule JPEGs. No 2:1 panorama constraint applies.';
comment on function public.finalize_capsule_photo(
  uuid, uuid, uuid, text, text, integer, integer, integer, integer, text, timestamptz
) is
  'Finalizes one immutable regular-photo contribution after membership, server unlock, canonical path, dimensions, and Storage existence checks.';

commit;

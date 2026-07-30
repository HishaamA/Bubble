begin;

create table public.daily_capture_windows (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles (id) on delete cascade,
  local_date date not null,
  time_zone text not null,
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint daily_capture_windows_circle_date_unique
    unique (circle_id, local_date),
  constraint daily_capture_windows_id_circle_unique
    unique (id, circle_id),
  constraint daily_capture_windows_time_zone_length
    check (char_length(time_zone) between 1 and 64),
  constraint daily_capture_windows_duration
    check (closes_at = opens_at + interval '15 minutes')
);

comment on table public.daily_capture_windows is
  'Server-created, deterministic daily 360 capture windows. Clients can read but cannot choose or mutate window times.';

create index daily_capture_windows_circle_opens_idx
  on public.daily_capture_windows (circle_id, opens_at desc);

create table public.family_moments (
  id uuid primary key,
  circle_id uuid not null references public.circles (id) on delete cascade,
  uploader_id uuid not null references auth.users (id) on delete restrict,
  capture_window_id uuid,
  capture_kind text not null,
  panorama_path text not null unique,
  thumbnail_path text not null unique,
  panorama_width integer not null,
  panorama_height integer not null,
  thumbnail_width integer not null,
  thumbnail_height integer not null,
  status text not null default 'ready',
  caption text,
  captured_at timestamptz not null default now(),
  ready_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint family_moments_window_circle_fk
    foreign key (capture_window_id, circle_id)
    references public.daily_capture_windows (id, circle_id)
    on delete cascade,
  constraint family_moments_capture_kind
    check (capture_kind in ('scheduled', 'manual')),
  constraint family_moments_window_matches_kind
    check (
      (capture_kind = 'scheduled' and capture_window_id is not null)
      or (capture_kind = 'manual' and capture_window_id is null)
    ),
  constraint family_moments_ready_only
    check (status = 'ready'),
  constraint family_moments_panorama_dimensions
    check (
      panorama_height between 512 and 8192
      and panorama_width::bigint = panorama_height::bigint * 2
    ),
  constraint family_moments_thumbnail_dimensions
    check (
      thumbnail_height between 64 and 2048
      and thumbnail_width::bigint = thumbnail_height::bigint * 2
    ),
  constraint family_moments_path_lengths
    check (
      char_length(panorama_path) between 1 and 500
      and char_length(thumbnail_path) between 1 and 500
    ),
  constraint family_moments_caption_length
    check (caption is null or char_length(btrim(caption)) between 1 and 240)
);

comment on table public.family_moments is
  'Ready 2:1 panorama contributions finalized atomically after Storage existence and authorization checks.';

comment on column public.family_moments.capture_kind is
  'scheduled is limited to one contribution per uploader/window; manual supports the always-available side upload action.';

comment on column public.family_moments.panorama_width is
  'Client-reported metadata. PostgreSQL cannot inspect image pixels; finalization checks the declared 2:1 dimensions and Storage object existence.';

create unique index family_moments_one_scheduled_per_uploader_window_idx
  on public.family_moments (capture_window_id, uploader_id)
  where capture_kind = 'scheduled';

create index family_moments_circle_ready_idx
  on public.family_moments (circle_id, ready_at desc)
  where status = 'ready';

create index family_moments_uploader_ready_idx
  on public.family_moments (uploader_id, ready_at desc)
  where status = 'ready';

create or replace function public.get_or_create_daily_capture_window(
  p_circle_id uuid
)
returns public.daily_capture_windows
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window public.daily_capture_windows%rowtype;
  v_time_zone text;
  v_local_date date;
  v_digest bytea;
  v_seed bigint;
  v_offset_minutes integer;
  v_local_open timestamp without time zone;
  v_opens_at timestamptz;
  v_closes_at timestamptz;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  if p_circle_id is null or not public.is_approved_circle_member(p_circle_id) then
    raise exception using errcode = '42501', message = 'approved_circle_membership_required';
  end if;

  -- The owner's saved IANA zone is the circle's MVP scheduling zone. An
  -- invalid or missing preference safely falls back to UTC.
  select preference.time_zone
    into v_time_zone
  from public.circles as circle
  left join public.profile_preferences as preference
    on preference.user_id = circle.owner_id
  where circle.id = p_circle_id;

  if v_time_zone is null or not exists (
    select 1
    from pg_catalog.pg_timezone_names as zone
    where zone.name = v_time_zone
  ) then
    v_time_zone := 'UTC';
  end if;

  v_local_date := (now() at time zone v_time_zone)::date;
  v_digest := extensions.digest(
    p_circle_id::text || ':' || v_local_date::text,
    'sha256'
  );
  v_seed := (
      pg_catalog.get_byte(v_digest, 0)::bigint * 16777216
    + pg_catalog.get_byte(v_digest, 1)::bigint * 65536
    + pg_catalog.get_byte(v_digest, 2)::bigint * 256
    + pg_catalog.get_byte(v_digest, 3)::bigint
  );

  -- Open sometime from 10:00 through 18:30 local time. A 15-minute window
  -- therefore always closes by 18:45, avoiding overnight prompts.
  v_offset_minutes := pg_catalog.mod(v_seed, 511)::integer;
  v_local_open := v_local_date::timestamp
    + interval '10 hours'
    + pg_catalog.make_interval(mins => v_offset_minutes);
  v_opens_at := v_local_open at time zone v_time_zone;
  v_closes_at := (v_local_open + interval '15 minutes') at time zone v_time_zone;

  insert into public.daily_capture_windows (
    circle_id,
    local_date,
    time_zone,
    opens_at,
    closes_at
  )
  values (
    p_circle_id,
    v_local_date,
    v_time_zone,
    v_opens_at,
    v_closes_at
  )
  on conflict (circle_id, local_date) do nothing;

  select capture_window.*
    into strict v_window
  from public.daily_capture_windows as capture_window
  where capture_window.circle_id = p_circle_id
    and capture_window.local_date = v_local_date;

  return v_window;
end;
$$;

comment on function public.get_or_create_daily_capture_window(uuid) is
  'Lazily and idempotently creates today''s deterministic 15-minute circle window using server time and the owner''s saved IANA zone.';

create or replace function public.finalize_360_moment(
  p_circle_id uuid,
  p_moment_id uuid,
  p_capture_kind text,
  p_panorama_path text,
  p_thumbnail_path text,
  p_panorama_width integer,
  p_panorama_height integer,
  p_thumbnail_width integer,
  p_thumbnail_height integer,
  p_caption text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_window public.daily_capture_windows%rowtype;
  v_window_id uuid;
  v_expected_panorama_path text;
  v_expected_thumbnail_path text;
  v_object_count integer;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  if p_circle_id is null or not public.is_approved_circle_member(p_circle_id) then
    raise exception using errcode = '42501', message = 'approved_circle_membership_required';
  end if;

  if p_moment_id is null then
    raise exception using errcode = '22023', message = 'moment_id_required';
  end if;

  if p_capture_kind is null or p_capture_kind not in ('scheduled', 'manual') then
    raise exception using errcode = '22023', message = 'invalid_capture_kind';
  end if;

  v_expected_panorama_path := pg_catalog.format(
    '%s/panoramas/%s/%s.jpg',
    p_circle_id,
    v_user_id,
    p_moment_id
  );
  v_expected_thumbnail_path := pg_catalog.format(
    '%s/thumbnails/%s/%s.jpg',
    p_circle_id,
    v_user_id,
    p_moment_id
  );

  if p_panorama_path is distinct from v_expected_panorama_path
    or p_thumbnail_path is distinct from v_expected_thumbnail_path
  then
    raise exception using errcode = '22023', message = 'media_paths_must_match_authenticated_uploader';
  end if;

  if p_panorama_height is null
    or p_panorama_width is null
    or p_panorama_height not between 512 and 8192
    or p_panorama_width::bigint <> p_panorama_height::bigint * 2
  then
    raise exception using errcode = '22023', message = 'panorama_must_report_2_to_1_dimensions';
  end if;

  if p_thumbnail_height is null
    or p_thumbnail_width is null
    or p_thumbnail_height not between 64 and 2048
    or p_thumbnail_width::bigint <> p_thumbnail_height::bigint * 2
  then
    raise exception using errcode = '22023', message = 'thumbnail_must_report_2_to_1_dimensions';
  end if;

  if p_caption is not null
    and char_length(btrim(p_caption)) not between 1 and 240
  then
    raise exception using errcode = '22023', message = 'caption_length_out_of_bounds';
  end if;

  if p_capture_kind = 'scheduled' then
    select capture_window.*
      into strict v_window
    from public.get_or_create_daily_capture_window(p_circle_id) as capture_window;

    -- Device time is never trusted for the lock. Both bounds use transaction
    -- time from PostgreSQL, and the close bound is exclusive.
    if now() < v_window.opens_at or now() >= v_window.closes_at then
      raise exception using errcode = 'P0001', message = 'scheduled_capture_window_closed';
    end if;

    v_window_id := v_window.id;
  else
    v_window_id := null;
  end if;

  -- The existing immutable Storage INSERT policy owns these namespaces:
  -- <circle>/<kind>/<auth.uid()>/<moment-id>.jpg. No direct client UPDATE or
  -- DELETE policy exists, so exact-path existence is stable during finalize.
  select count(*)::integer
    into v_object_count
  from storage.objects as object
  where object.bucket_id = 'family-media'
    and object.name in (v_expected_panorama_path, v_expected_thumbnail_path);

  if v_object_count <> 2 then
    raise exception using errcode = 'P0001', message = 'required_storage_objects_not_found';
  end if;

  begin
    insert into public.family_moments (
      id,
      circle_id,
      uploader_id,
      capture_window_id,
      capture_kind,
      panorama_path,
      thumbnail_path,
      panorama_width,
      panorama_height,
      thumbnail_width,
      thumbnail_height,
      status,
      caption
    )
    values (
      p_moment_id,
      p_circle_id,
      v_user_id,
      v_window_id,
      p_capture_kind,
      v_expected_panorama_path,
      v_expected_thumbnail_path,
      p_panorama_width,
      p_panorama_height,
      p_thumbnail_width,
      p_thumbnail_height,
      'ready',
      nullif(btrim(p_caption), '')
    );
  exception
    when unique_violation then
      if v_window_id is not null and exists (
        select 1
        from public.family_moments as moment
        where moment.capture_window_id = v_window_id
          and moment.uploader_id = v_user_id
          and moment.capture_kind = 'scheduled'
      ) then
        raise exception using errcode = 'P0001', message = 'scheduled_contribution_already_finalized';
      end if;

      if exists (
        select 1
        from public.family_moments as moment
        where moment.id = p_moment_id
      ) then
        raise exception using errcode = 'P0001', message = 'moment_id_already_finalized';
      end if;

      raise exception using errcode = 'P0001', message = 'media_path_already_finalized';
  end;

  return p_moment_id;
end;
$$;

comment on function public.finalize_360_moment(
  uuid,
  uuid,
  text,
  text,
  text,
  integer,
  integer,
  integer,
  integer,
  text
) is
  'Atomically inserts ready 360 metadata after auth, current membership, canonical uploader paths, Storage existence, declared 2:1 dimensions, and scheduled-window checks. Dimensions are client-reported; the database cannot inspect pixels.';

alter table public.daily_capture_windows enable row level security;
alter table public.family_moments enable row level security;

create policy daily_capture_windows_read_by_approved_members
on public.daily_capture_windows
for select
to authenticated
using (public.is_approved_circle_member(circle_id));

create policy family_moments_read_ready_by_approved_members
on public.family_moments
for select
to authenticated
using (
  status = 'ready'
  and public.is_approved_circle_member(circle_id)
);

revoke all on table public.daily_capture_windows from anon, authenticated;
revoke all on table public.family_moments from anon, authenticated;
grant select on table public.daily_capture_windows to authenticated;
grant select on table public.family_moments to authenticated;
grant all on table public.daily_capture_windows to service_role;
grant all on table public.family_moments to service_role;

revoke all on function public.get_or_create_daily_capture_window(uuid)
  from public, anon, authenticated;
revoke all on function public.finalize_360_moment(
  uuid,
  uuid,
  text,
  text,
  text,
  integer,
  integer,
  integer,
  integer,
  text
) from public, anon, authenticated;

grant execute on function public.get_or_create_daily_capture_window(uuid)
  to authenticated, service_role;
grant execute on function public.finalize_360_moment(
  uuid,
  uuid,
  text,
  text,
  text,
  integer,
  integer,
  integer,
  integer,
  text
) to authenticated, service_role;

-- Supabase Realtime may not be installed in every test environment. Add the
-- ready-moment table only when the standard publication exists, and never add
-- it twice on a replayed or repaired environment.
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
      and tablename = 'family_moments'
  ) then
    alter publication supabase_realtime add table public.family_moments;
  end if;
end;
$$;

commit;

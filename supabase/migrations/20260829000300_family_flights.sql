begin;

create table public.family_flights (
  id uuid primary key,
  circle_id uuid not null references public.circles(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete cascade,
  traveler_name text not null,
  flight_number text not null,
  travel_date date not null,
  status_snapshot jsonb not null,
  status_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint family_flights_traveler_name_valid check (
    char_length(btrim(traveler_name)) between 1 and 60
  ),
  constraint family_flights_flight_number_valid check (
    flight_number = upper(flight_number)
    and flight_number ~ '^[A-Z0-9]{3,8}$'
    and flight_number ~ '[A-Z]'
    and flight_number ~ '[0-9]'
  ),
  constraint family_flights_snapshot_object check (
    jsonb_typeof(status_snapshot) = 'object'
    and octet_length(status_snapshot::text) <= 16384
    and coalesce(status_snapshot ->> 'provider', '') = 'flightaware'
    and coalesce(status_snapshot ->> 'flightNumber', '') = flight_number
    and coalesce(status_snapshot ->> 'dataQuality', '') in ('live', 'estimated', 'scheduled')
    and coalesce(jsonb_typeof(status_snapshot -> 'origin'), '') = 'object'
    and coalesce(jsonb_typeof(status_snapshot -> 'destination'), '') = 'object'
    and coalesce(status_snapshot #>> '{origin,timeZone}', '') <> ''
    and coalesce(status_snapshot #>> '{destination,timeZone}', '') <> ''
  )
);

create index family_flights_circle_travel_date_idx
  on public.family_flights(circle_id, travel_date, created_at);

alter table public.family_flights replica identity full;

create table public.family_flight_lookup_limits (
  user_id uuid not null references public.profiles(id) on delete cascade,
  bucket_started_at timestamptz not null,
  request_count integer not null default 0,
  primary key (user_id, bucket_started_at),
  constraint family_flight_lookup_count_positive check (request_count > 0)
);

create table public.family_flight_circle_lookup_limits (
  circle_id uuid not null references public.circles(id) on delete cascade,
  bucket_started_at timestamptz not null,
  request_count integer not null default 0,
  primary key (circle_id, bucket_started_at),
  constraint family_flight_circle_lookup_count_positive check (request_count > 0)
);

create or replace function public.begin_family_flight_lookup()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_circle_id uuid;
  v_bucket timestamptz := date_bin(
    interval '5 minutes',
    clock_timestamp(),
    timestamptz '2001-01-01 00:00:00+00'
  );
  v_request_count integer;
  v_circle_request_count integer;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'approved_family_membership_required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('family-flight-lookup:' || v_user_id::text, 0)
  );

  select member.circle_id
    into v_circle_id
  from public.circle_members as member
  where member.user_id = v_user_id
    and member.status = 'approved'
  order by member.created_at
  limit 1;

  if v_circle_id is null then
    raise exception using errcode = '42501', message = 'approved_family_membership_required';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('family-flight-circle-lookup:' || v_circle_id::text, 0)
  );

  insert into public.family_flight_lookup_limits (
    user_id,
    bucket_started_at,
    request_count
  ) values (
    v_user_id,
    v_bucket,
    1
  )
  on conflict (user_id, bucket_started_at)
  do update set request_count = public.family_flight_lookup_limits.request_count + 1
  returning request_count into v_request_count;

  if v_request_count > 12 then
    raise exception using errcode = 'P0001', message = 'family_flight_rate_limited';
  end if;

  insert into public.family_flight_circle_lookup_limits (
    circle_id,
    bucket_started_at,
    request_count
  ) values (
    v_circle_id,
    v_bucket,
    1
  )
  on conflict (circle_id, bucket_started_at)
  do update set request_count = public.family_flight_circle_lookup_limits.request_count + 1
  returning request_count into v_circle_request_count;

  if v_circle_request_count > 30 then
    raise exception using errcode = 'P0001', message = 'family_flight_rate_limited';
  end if;

  delete from public.family_flight_lookup_limits
  where user_id = v_user_id
    and bucket_started_at < v_bucket - interval '1 day';

  delete from public.family_flight_circle_lookup_limits
  where circle_id = v_circle_id
    and bucket_started_at < v_bucket - interval '1 day';

  return jsonb_build_object(
    'user_id', v_user_id,
    'circle_id', v_circle_id
  );
end;
$$;

create or replace function public.create_family_flight(
  p_id uuid,
  p_circle_id uuid,
  p_traveler_name text,
  p_flight_number text,
  p_travel_date date,
  p_status_snapshot jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_traveler_name text := btrim(p_traveler_name);
  v_flight_number text := upper(regexp_replace(btrim(p_flight_number), '[[:space:]-]+', '', 'g'));
begin
  if v_user_id is null or not public.is_approved_circle_member(p_circle_id) then
    raise exception using errcode = '42501', message = 'approved_family_membership_required';
  end if;
  if p_id is null
    or v_traveler_name is null
    or char_length(v_traveler_name) not between 1 and 60
    or v_flight_number is null
    or v_flight_number !~ '^[A-Z0-9]{3,8}$'
    or v_flight_number !~ '[A-Z]'
    or v_flight_number !~ '[0-9]'
    or p_travel_date is null
    or p_status_snapshot is null
    or jsonb_typeof(p_status_snapshot) <> 'object'
    or octet_length(p_status_snapshot::text) > 16384
    or coalesce(p_status_snapshot ->> 'provider', '') <> 'flightaware'
    or coalesce(p_status_snapshot ->> 'flightNumber', '') <> v_flight_number
    or coalesce(p_status_snapshot ->> 'dataQuality', '') not in ('live', 'estimated', 'scheduled')
    or coalesce(jsonb_typeof(p_status_snapshot -> 'origin'), '') <> 'object'
    or coalesce(jsonb_typeof(p_status_snapshot -> 'destination'), '') <> 'object'
    or coalesce(p_status_snapshot #>> '{origin,timeZone}', '') = ''
    or coalesce(p_status_snapshot #>> '{destination,timeZone}', '') = ''
  then
    raise exception using errcode = '22023', message = 'invalid_family_flight';
  end if;

  insert into public.family_flights (
    id,
    circle_id,
    created_by,
    traveler_name,
    flight_number,
    travel_date,
    status_snapshot
  ) values (
    p_id,
    p_circle_id,
    v_user_id,
    v_traveler_name,
    v_flight_number,
    p_travel_date,
    p_status_snapshot
  );
  return p_id;
end;
$$;

create or replace function public.update_family_flight_status(
  p_flight_id uuid,
  p_status_snapshot jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_circle_id uuid;
  v_flight_number text;
begin
  if p_status_snapshot is null
    or jsonb_typeof(p_status_snapshot) <> 'object'
    or octet_length(p_status_snapshot::text) > 16384
  then
    raise exception using errcode = '22023', message = 'invalid_flight_status_snapshot';
  end if;

  select flight.circle_id, flight.flight_number
    into v_circle_id, v_flight_number
  from public.family_flights as flight
  where flight.id = p_flight_id
  for update;

  if v_circle_id is null or not public.is_approved_circle_member(v_circle_id) then
    raise exception using errcode = '42501', message = 'approved_family_membership_required';
  end if;
  if coalesce(p_status_snapshot ->> 'provider', '') <> 'flightaware'
    or coalesce(p_status_snapshot ->> 'flightNumber', '') <> v_flight_number
    or coalesce(p_status_snapshot ->> 'dataQuality', '') not in ('live', 'estimated', 'scheduled')
    or coalesce(jsonb_typeof(p_status_snapshot -> 'origin'), '') <> 'object'
    or coalesce(jsonb_typeof(p_status_snapshot -> 'destination'), '') <> 'object'
    or coalesce(p_status_snapshot #>> '{origin,timeZone}', '') = ''
    or coalesce(p_status_snapshot #>> '{destination,timeZone}', '') = ''
  then
    raise exception using errcode = '22023', message = 'flight_status_identity_mismatch';
  end if;

  update public.family_flights
  set status_snapshot = p_status_snapshot,
      status_updated_at = now(),
      updated_at = now()
  where id = p_flight_id;
end;
$$;

create or replace function public.delete_family_flight(p_flight_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_circle_id uuid;
  v_created_by uuid;
  v_circle_owner uuid;
begin
  select flight.circle_id, flight.created_by, circle.owner_id
    into v_circle_id, v_created_by, v_circle_owner
  from public.family_flights as flight
  join public.circles as circle on circle.id = flight.circle_id
  where flight.id = p_flight_id
  for update of flight;

  if v_user_id is null
    or v_circle_id is null
    or not public.is_approved_circle_member(v_circle_id)
    or v_user_id not in (v_created_by, v_circle_owner)
  then
    raise exception using errcode = '42501', message = 'flight_delete_not_allowed';
  end if;

  delete from public.family_flights where id = p_flight_id;
end;
$$;

alter table public.family_flights enable row level security;
alter table public.family_flight_lookup_limits enable row level security;
alter table public.family_flight_circle_lookup_limits enable row level security;

create policy family_flights_read_by_approved_members
on public.family_flights
for select
to authenticated
using (public.is_approved_circle_member(circle_id));

revoke all on table public.family_flights from anon, authenticated;
revoke all on table public.family_flight_lookup_limits from anon, authenticated;
revoke all on table public.family_flight_circle_lookup_limits from anon, authenticated;
grant select on table public.family_flights to authenticated;
grant all on table public.family_flights to service_role;
grant all on table public.family_flight_lookup_limits to service_role;
grant all on table public.family_flight_circle_lookup_limits to service_role;

revoke all on function public.create_family_flight(uuid,uuid,text,text,date,jsonb)
  from public, anon, authenticated;
revoke all on function public.update_family_flight_status(uuid,jsonb)
  from public, anon, authenticated;
revoke all on function public.delete_family_flight(uuid)
  from public, anon, authenticated;
revoke all on function public.begin_family_flight_lookup()
  from public, anon, authenticated;
grant execute on function public.create_family_flight(uuid,uuid,text,text,date,jsonb)
  to service_role;
grant execute on function public.update_family_flight_status(uuid,jsonb)
  to service_role;
grant execute on function public.delete_family_flight(uuid)
  to authenticated, service_role;
grant execute on function public.begin_family_flight_lookup()
  to authenticated, service_role;

do $$
begin
  if exists (
    select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'family_flights'
  ) then
    alter publication supabase_realtime add table public.family_flights;
  end if;
end;
$$;

comment on table public.family_flights is
  'Approved-family flight trackers. Stores airline flight numbers and normalized provider snapshots; ticket numbers are never accepted or stored.';
comment on function public.update_family_flight_status(uuid,jsonb) is
  'Service-role-only status persistence for the authenticated flight-status Edge Function; clients cannot submit snapshots.';
comment on function public.begin_family_flight_lookup() is
  'Returns the caller''s approved family context and enforces fixed five-minute provider budgets per member and family circle.';

commit;

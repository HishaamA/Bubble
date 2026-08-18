begin;

alter table public.family_flights
  drop constraint family_flights_snapshot_object;

alter table public.family_flights
  add constraint family_flights_snapshot_object check (
    jsonb_typeof(status_snapshot) = 'object'
    and octet_length(status_snapshot::text) <= 16384
    and coalesce(status_snapshot ->> 'provider', '') in ('flightaware', 'aerodatabox')
    and coalesce(status_snapshot ->> 'flightNumber', '') = flight_number
    and coalesce(status_snapshot ->> 'dataQuality', '') in ('live', 'estimated', 'scheduled')
    and coalesce(jsonb_typeof(status_snapshot -> 'origin'), '') = 'object'
    and coalesce(jsonb_typeof(status_snapshot -> 'destination'), '') = 'object'
    and coalesce(status_snapshot #>> '{origin,timeZone}', '') <> ''
    and coalesce(status_snapshot #>> '{destination,timeZone}', '') <> ''
  );

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
    or coalesce(p_status_snapshot ->> 'provider', '') not in ('flightaware', 'aerodatabox')
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
  if coalesce(p_status_snapshot ->> 'provider', '') not in ('flightaware', 'aerodatabox')
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

comment on table public.family_flights is
  'Approved-family flight trackers. Existing FlightAware snapshots and new AeroDataBox snapshots are accepted; ticket numbers are never accepted or stored.';

commit;

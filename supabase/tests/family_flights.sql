begin;

create extension if not exists pgtap with schema extensions;
select plan(36);

insert into public.profiles (id, display_name)
values
  ('53000000-0000-4000-8000-000000000001', 'Flight Alice'),
  ('53000000-0000-4000-8000-000000000002', 'Flight Bob'),
  ('53000000-0000-4000-8000-000000000003', 'Flight Mallory'),
  ('53000000-0000-4000-8000-000000000004', 'Flight Nora');

insert into public.app_identities (subject, user_id, provider)
values
  ('flight_user_alice', '53000000-0000-4000-8000-000000000001', 'clerk'),
  ('flight_user_bob', '53000000-0000-4000-8000-000000000002', 'clerk'),
  ('flight_user_mallory', '53000000-0000-4000-8000-000000000003', 'clerk'),
  ('flight_user_nora', '53000000-0000-4000-8000-000000000004', 'clerk');

insert into public.circles (id, name, owner_id)
values
  (
    'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Flight Family A',
    '53000000-0000-4000-8000-000000000001'
  ),
  (
    'fbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Flight Family B',
    '53000000-0000-4000-8000-000000000003'
  );

insert into public.circle_members (
  circle_id,
  user_id,
  role,
  status,
  approved_by,
  approved_at
)
values (
  'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '53000000-0000-4000-8000-000000000002',
  'member',
  'approved',
  '53000000-0000-4000-8000-000000000001',
  now()
);

insert into public.family_flights (
  id,
  circle_id,
  created_by,
  traveler_name,
  flight_number,
  travel_date,
  status_snapshot
)
values
  (
    '73000000-0000-4000-8000-000000000001',
    'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '53000000-0000-4000-8000-000000000001',
    'Alice',
    'EK202',
    current_date + 1,
    '{"provider":"flightaware","flightNumber":"EK202","dataQuality":"live","origin":{"timeZone":"America/New_York"},"destination":{"timeZone":"Asia/Dubai"}}'
  ),
  (
    '73000000-0000-4000-8000-000000000002',
    'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '53000000-0000-4000-8000-000000000002',
    'Bob',
    'BA107',
    current_date + 2,
    '{"provider":"flightaware","flightNumber":"BA107","dataQuality":"estimated","origin":{"timeZone":"Europe/London"},"destination":{"timeZone":"Asia/Dubai"}}'
  ),
  (
    '73000000-0000-4000-8000-000000000003',
    'fbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '53000000-0000-4000-8000-000000000003',
    'Mallory',
    'QR815',
    current_date + 1,
    '{"provider":"flightaware","flightNumber":"QR815","dataQuality":"scheduled","origin":{"timeZone":"Asia/Hong_Kong"},"destination":{"timeZone":"Asia/Qatar"}}'
  ),
  (
    '73000000-0000-4000-8000-000000000004',
    'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '53000000-0000-4000-8000-000000000002',
    'Bob',
    'SQ495',
    current_date + 3,
    '{"provider":"flightaware","flightNumber":"SQ495","dataQuality":"scheduled","origin":{"timeZone":"Asia/Dubai"},"destination":{"timeZone":"Asia/Singapore"}}'
  ),
  (
    '73000000-0000-4000-8000-000000000005',
    'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '53000000-0000-4000-8000-000000000001',
    'Alice',
    'EY101',
    current_date + 4,
    '{"provider":"flightaware","flightNumber":"EY101","dataQuality":"scheduled","origin":{"timeZone":"Asia/Dubai"},"destination":{"timeZone":"America/New_York"}}'
  );

create or replace function pg_temp.direct_flight_insert_result()
returns text
language plpgsql
as $$
begin
  insert into public.family_flights (
    id,
    circle_id,
    created_by,
    traveler_name,
    flight_number,
    travel_date,
    status_snapshot
  ) values (
    '73999999-0000-4000-8000-000000000001',
    'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '53000000-0000-4000-8000-000000000002',
    'Forged traveler',
    'EK999',
    current_date,
    '{"provider":"flightaware","flightNumber":"EK999","dataQuality":"scheduled","origin":{"timeZone":"Asia/Dubai"},"destination":{"timeZone":"Europe/London"}}'
  );
  return 'ok';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.direct_flight_update_result(p_flight_id uuid)
returns text
language plpgsql
as $$
begin
  update public.family_flights
  set traveler_name = 'Forged update'
  where id = p_flight_id;
  return 'ok';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.direct_flight_delete_result(p_flight_id uuid)
returns text
language plpgsql
as $$
begin
  delete from public.family_flights where id = p_flight_id;
  return 'ok';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.delete_flight_result(p_flight_id uuid)
returns text
language plpgsql
as $$
begin
  perform public.delete_family_flight(p_flight_id);
  return 'ok';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.begin_lookup_result()
returns text
language plpgsql
as $$
declare
  v_context jsonb;
begin
  v_context := public.begin_family_flight_lookup();
  return (v_context ->> 'user_id') || ':' || (v_context ->> 'circle_id');
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.consume_lookups(p_count integer)
returns text
language plpgsql
as $$
begin
  for v_index in 1..p_count loop
    perform public.begin_family_flight_lookup();
  end loop;
  return 'ok';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.create_flight_result(
  p_id uuid,
  p_flight_number text,
  p_status_snapshot jsonb
)
returns text
language plpgsql
as $$
begin
  return public.create_family_flight(
    p_id,
    'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Provider Test',
    p_flight_number,
    current_date + 5,
    p_status_snapshot
  )::text;
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

select is(
  has_table_privilege('authenticated', 'public.family_flights', 'select')
  and not has_table_privilege('authenticated', 'public.family_flights', 'insert')
  and not has_table_privilege('authenticated', 'public.family_flights', 'update')
  and not has_table_privilege('authenticated', 'public.family_flights', 'delete')
  and not has_table_privilege(
    'authenticated',
    'public.family_flight_lookup_limits',
    'select'
  )
  and not has_table_privilege(
    'authenticated',
    'public.family_flight_circle_lookup_limits',
    'select'
  ),
  true,
  'authenticated clients can only select permitted flight rows and cannot inspect rate buckets'
);

select is(
  has_function_privilege(
    'authenticated',
    'public.delete_family_flight(uuid)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.begin_family_flight_lookup()',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.create_family_flight(uuid,uuid,text,text,date,jsonb)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.update_family_flight_status(uuid,jsonb)',
    'execute'
  ),
  true,
  'authenticated clients receive only the intended lookup and deletion RPC surface'
);

select is(
  has_function_privilege(
    'service_role',
    'public.create_family_flight(uuid,uuid,text,text,date,jsonb)',
    'execute'
  )
  and has_function_privilege(
    'service_role',
    'public.update_family_flight_status(uuid,jsonb)',
    'execute'
  ),
  true,
  'trusted service code can create flights and persist provider snapshots'
);

select is(
  not has_function_privilege(
    'anon',
    'public.delete_family_flight(uuid)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.begin_family_flight_lookup()',
    'execute'
  ),
  true,
  'anonymous callers cannot execute either authenticated flight RPC'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"flight_user_alice","role":"authenticated"}',
  true
);

select is(
  (select count(*) from public.family_flights),
  4::bigint,
  'the family owner reads every flight in her approved family and none from another family'
);

select is(
  (
    select count(*)
    from public.family_flights
    where circle_id = 'fbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ),
  0::bigint,
  'the family owner cannot select a flight from another family'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"flight_user_bob","role":"authenticated"}',
  true
);

select is(
  (select count(*) from public.family_flights),
  4::bigint,
  'an approved member reads every flight in his family and none from another family'
);

select is(
  (
    select count(*)
    from public.family_flights
    where circle_id = 'fbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ),
  0::bigint,
  'an approved member cannot select a flight from another family'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"flight_user_mallory","role":"authenticated"}',
  true
);

select is(
  (select count(*) from public.family_flights),
  1::bigint,
  'a member of another family sees only that family flight'
);

select is(
  (
    select count(*)
    from public.family_flights
    where circle_id = 'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  0::bigint,
  'the other-family member cannot select any primary-family flight'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"flight_user_bob","role":"authenticated"}',
  true
);

select like(
  pg_temp.direct_flight_insert_result(),
  '42501:%',
  'an authenticated member cannot bypass the service function with a direct insert'
);

select like(
  pg_temp.direct_flight_update_result(
    '73000000-0000-4000-8000-000000000001'
  ),
  '42501:%',
  'an authenticated member cannot directly alter a provider snapshot row'
);

select like(
  pg_temp.direct_flight_delete_result(
    '73000000-0000-4000-8000-000000000001'
  ),
  '42501:%',
  'an authenticated member cannot bypass the guarded delete RPC'
);

select is(
  pg_temp.delete_flight_result(
    '73000000-0000-4000-8000-000000000001'
  ),
  '42501:flight_delete_not_allowed',
  'an ordinary member cannot delete a flight created by the owner'
);

select is(
  (
    select count(*)
    from public.family_flights
    where id = '73000000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'a rejected member deletion leaves the owner flight intact'
);

select is(
  pg_temp.delete_flight_result(
    '73000000-0000-4000-8000-000000000002'
  ),
  'ok',
  'a flight creator can delete their own flight'
);

select is(
  (
    select count(*)
    from public.family_flights
    where id = '73000000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'the creator deletion removes the flight'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"flight_user_alice","role":"authenticated"}',
  true
);

select is(
  pg_temp.delete_flight_result(
    '73000000-0000-4000-8000-000000000004'
  ),
  'ok',
  'the family owner can delete a flight created by another member'
);

select is(
  (
    select count(*)
    from public.family_flights
    where id = '73000000-0000-4000-8000-000000000004'
  ),
  0::bigint,
  'the owner deletion removes the member flight'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"flight_user_mallory","role":"authenticated"}',
  true
);

select is(
  pg_temp.delete_flight_result(
    '73000000-0000-4000-8000-000000000005'
  ),
  '42501:flight_delete_not_allowed',
  'a user from another family cannot delete the flight'
);

reset role;

select is(
  (
    select count(*)
    from public.family_flights
    where id = '73000000-0000-4000-8000-000000000005'
  ),
  1::bigint,
  'a rejected cross-family deletion leaves the flight intact'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"flight_user_bob","role":"authenticated"}',
  true
);

select is(
  pg_temp.begin_lookup_result(),
  '53000000-0000-4000-8000-000000000002:faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'lookup derives the approved member and family context from the session'
);

reset role;

select is(
  (
    select sum(request_count)
    from public.family_flight_lookup_limits
    where user_id = '53000000-0000-4000-8000-000000000002'
  ),
  1::bigint,
  'a successful lookup consumes one member request'
);

select is(
  (
    select sum(request_count)
    from public.family_flight_circle_lookup_limits
    where circle_id = 'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  1::bigint,
  'a successful lookup consumes one family request'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"flight_user_nora","role":"authenticated"}',
  true
);

select is(
  pg_temp.begin_lookup_result(),
  '42501:approved_family_membership_required',
  'a signed-in user without approved family membership cannot begin a lookup'
);

reset role;

select is(
  (
    select count(*)
    from public.family_flight_lookup_limits
    where user_id = '53000000-0000-4000-8000-000000000004'
  ),
  0::bigint,
  'a denied membership check consumes no provider budget'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"flight_user_bob","role":"authenticated"}',
  true
);

select is(
  pg_temp.consume_lookups(11),
  'ok',
  'the member can use the remaining eleven requests in the five-minute allowance'
);

select is(
  pg_temp.begin_lookup_result(),
  'P0001:family_flight_rate_limited',
  'the thirteenth member lookup in one bucket is rejected'
);

reset role;

select is(
  (
    select sum(request_count)
    from public.family_flight_lookup_limits
    where user_id = '53000000-0000-4000-8000-000000000002'
  ),
  12::bigint,
  'a rejected member lookup does not commit an over-limit count'
);

select is(
  (
    select sum(request_count)
    from public.family_flight_circle_lookup_limits
    where circle_id = 'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  12::bigint,
  'member throttling also prevents an extra family-budget charge'
);

update public.family_flight_circle_lookup_limits
set request_count = 30
where circle_id = 'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"flight_user_alice","role":"authenticated"}',
  true
);

select is(
  pg_temp.begin_lookup_result(),
  'P0001:family_flight_rate_limited',
  'the family-wide thirty-request allowance rejects the next lookup'
);

reset role;

select is(
  (
    select count(*)
    from public.family_flight_lookup_limits
    where user_id = '53000000-0000-4000-8000-000000000001'
  ),
  0::bigint,
  'a family-limited lookup rolls back its tentative member-budget charge'
);

select is(
  (
    select sum(request_count)
    from public.family_flight_circle_lookup_limits
    where circle_id = 'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  30::bigint,
  'a rejected family lookup leaves the committed family count at the limit'
);

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"flight_user_alice","role":"service_role"}',
  true
);

select is(
  pg_temp.create_flight_result(
    '73000000-0000-4000-8000-000000000006',
    'EK203',
    '{"provider":"aerodatabox","flightNumber":"EK203","dataQuality":"live","origin":{"timeZone":"America/New_York"},"destination":{"timeZone":"Asia/Dubai"}}'
  ),
  '73000000-0000-4000-8000-000000000006',
  'the service-only creation path accepts an otherwise-valid AeroDataBox snapshot'
);

select is(
  pg_temp.create_flight_result(
    '73000000-0000-4000-8000-000000000007',
    'BA108',
    '{"provider":"flightaware","flightNumber":"BA108","dataQuality":"estimated","origin":{"timeZone":"Europe/London"},"destination":{"timeZone":"Asia/Dubai"}}'
  ),
  '73000000-0000-4000-8000-000000000007',
  'the service-only creation path continues to accept a legacy FlightAware snapshot'
);

select is(
  pg_temp.create_flight_result(
    '73000000-0000-4000-8000-000000000008',
    'QR816',
    '{"provider":"unknown","flightNumber":"QR816","dataQuality":"scheduled","origin":{"timeZone":"Asia/Hong_Kong"},"destination":{"timeZone":"Asia/Qatar"}}'
  ),
  '22023:invalid_family_flight',
  'the service-only creation path rejects an unknown snapshot provider'
);

reset role;

select * from finish();
rollback;

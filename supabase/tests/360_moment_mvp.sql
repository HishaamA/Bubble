begin;

create extension if not exists pgtap with schema extensions;
select plan(26);

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '20000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'moment-alice@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Moment Alice"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '20000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'moment-bob@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Moment Bob"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '20000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'moment-mallory@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Moment Mallory"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '20000000-0000-4000-8000-000000000004',
    'authenticated',
    'authenticated',
    'moment-eve@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Moment Eve"}'::jsonb,
    now(),
    now()
  );

insert into public.circles (id, name, owner_id)
values
  (
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'Moment Family A',
    '20000000-0000-4000-8000-000000000001'
  ),
  (
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'Moment Family B',
    '20000000-0000-4000-8000-000000000003'
  );

insert into public.circle_members (
  circle_id,
  user_id,
  role,
  status,
  approved_by,
  approved_at,
  removed_at
)
values
  (
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '20000000-0000-4000-8000-000000000002',
    'member',
    'approved',
    '20000000-0000-4000-8000-000000000001',
    now(),
    null
  ),
  (
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '20000000-0000-4000-8000-000000000004',
    'member',
    'removed',
    '20000000-0000-4000-8000-000000000001',
    now() - interval '1 day',
    now()
  );

-- Keep Family A open for the positive scheduled-finalization cases. Family B
-- is left empty so its first member query exercises server generation.
insert into public.daily_capture_windows (
  id,
  circle_id,
  local_date,
  time_zone,
  opens_at,
  closes_at
)
values (
  '30000000-0000-4000-8000-000000000001',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  (now() at time zone 'UTC')::date,
  'UTC',
  now() - interval '5 minutes',
  now() + interval '10 minutes'
);

insert into storage.objects (id, bucket_id, name)
select
  extensions.gen_random_uuid(),
  'family-media',
  object_name
from (
  values
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000001.jpg'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000001.jpg'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000002.jpg'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000002.jpg'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000003.jpg'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000003.jpg'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000006.jpg'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000006.jpg'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-000000000010.jpg'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-000000000010.jpg')
) as fixture(object_name);

create or replace function pg_temp.capture_window_result(p_circle_id uuid)
returns text
language plpgsql
as $$
begin
  perform public.get_or_create_daily_capture_window(p_circle_id);
  return 'ok';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.finalize_moment_result(
  p_circle_id uuid,
  p_moment_id uuid,
  p_capture_kind text,
  p_panorama_path text,
  p_thumbnail_path text,
  p_panorama_width integer default 4096,
  p_panorama_height integer default 2048
)
returns text
language plpgsql
as $$
begin
  perform public.finalize_360_moment(
    p_circle_id,
    p_moment_id,
    p_capture_kind,
    p_panorama_path,
    p_thumbnail_path,
    p_panorama_width,
    p_panorama_height,
    800,
    400,
    null
  );
  return 'ok';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

select is(
  has_function_privilege(
    'authenticated',
    'public.get_or_create_daily_capture_window(uuid)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.finalize_360_moment(uuid,uuid,text,text,text,integer,integer,integer,integer,text)',
    'execute'
  ),
  true,
  'authenticated users can execute only the intentional 360 RPC surface'
);

select is(
  not has_function_privilege(
    'anon',
    'public.get_or_create_daily_capture_window(uuid)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.finalize_360_moment(uuid,uuid,text,text,text,integer,integer,integer,integer,text)',
    'execute'
  ),
  true,
  'anonymous users cannot execute 360 RPCs'
);

select is(
  has_table_privilege('authenticated', 'public.family_moments', 'select')
  and not has_table_privilege('authenticated', 'public.family_moments', 'insert')
  and not has_table_privilege('authenticated', 'public.family_moments', 'update')
  and not has_table_privilege('authenticated', 'public.family_moments', 'delete')
  and not has_table_privilege('authenticated', 'public.daily_capture_windows', 'insert')
  and not has_table_privilege('authenticated', 'public.daily_capture_windows', 'update'),
  true,
  'clients can query ready data but cannot forge moments or window times directly'
);

set local role anon;

select is(
  pg_temp.capture_window_result('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  '42501:permission denied for function get_or_create_daily_capture_window',
  'anonymous callers are rejected before any window is disclosed'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000003', true);

select ok(
  (
    select
      (capture_window.opens_at at time zone capture_window.time_zone)::time >= time '10:00'
      and (capture_window.opens_at at time zone capture_window.time_zone)::time <= time '18:30'
      and (capture_window.closes_at at time zone capture_window.time_zone)::date = capture_window.local_date
    from public.get_or_create_daily_capture_window(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    ) as capture_window
  ),
  'the server-generated opening is inside the safe local daytime range'
);

select is(
  (
    select capture_window.closes_at - capture_window.opens_at
    from public.get_or_create_daily_capture_window(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    ) as capture_window
  ),
  interval '15 minutes',
  'the generated scheduled-capture window lasts exactly 15 minutes'
);

select is(
  (
    select count(*)
    from public.daily_capture_windows
    where circle_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  ),
  1::bigint,
  'daily window creation is deterministic and idempotent for one circle/date'
);

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', true);

select is(
  pg_temp.capture_window_result('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  '42501:approved_circle_membership_required',
  'a member cannot create or disclose another circle window'
);

select is(
  pg_temp.finalize_moment_result(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '40000000-0000-4000-8000-000000000001',
    'scheduled',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000001.jpg',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000001.jpg'
  ),
  'ok',
  'an approved member finalizes existing canonical panorama and thumbnail objects'
);

select is(
  (
    select uploader_id::text || ':' || status || ':' || capture_kind
    from public.family_moments
    where id = '40000000-0000-4000-8000-000000000001'
  ),
  '20000000-0000-4000-8000-000000000001:ready:scheduled',
  'finalization derives the uploader from auth and inserts ready metadata atomically'
);

select is(
  pg_temp.finalize_moment_result(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '40000000-0000-4000-8000-000000000002',
    'scheduled',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000002.jpg',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000002.jpg'
  ),
  'P0001:scheduled_contribution_already_finalized',
  'one uploader cannot finalize two scheduled moments in the same window'
);

select is(
  pg_temp.finalize_moment_result(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '40000000-0000-4000-8000-000000000004',
    'manual',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-000000000004.jpg',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-000000000004.jpg'
  ),
  '22023:media_paths_must_match_authenticated_uploader',
  'an uploader cannot spoof another user path'
);

select is(
  pg_temp.finalize_moment_result(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '40000000-0000-4000-8000-000000000005',
    'manual',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000005.jpg',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000005.jpg'
  ),
  'P0001:required_storage_objects_not_found',
  'metadata cannot become ready before both exact Storage objects exist'
);

select is(
  pg_temp.finalize_moment_result(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '40000000-0000-4000-8000-000000000009',
    'manual',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000009.jpg',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000009.jpg',
    4000,
    2048
  ),
  '22023:panorama_must_report_2_to_1_dimensions',
  'non-2:1 reported panorama metadata is rejected'
);

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000003', true);

select is(
  pg_temp.finalize_moment_result(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '40000000-0000-4000-8000-000000000007',
    'manual',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000003/40000000-0000-4000-8000-000000000007.jpg',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000003/40000000-0000-4000-8000-000000000007.jpg'
  ),
  '42501:approved_circle_membership_required',
  'a user from another circle cannot finalize into the target circle'
);

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000004', true);

select is(
  pg_temp.finalize_moment_result(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '40000000-0000-4000-8000-000000000008',
    'manual',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000004/40000000-0000-4000-8000-000000000008.jpg',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000004/40000000-0000-4000-8000-000000000008.jpg'
  ),
  '42501:approved_circle_membership_required',
  'a removed member cannot finalize a moment'
);

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);

select is(
  pg_temp.finalize_moment_result(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '40000000-0000-4000-8000-000000000010',
    'scheduled',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-000000000010.jpg',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-000000000010.jpg'
  ),
  'ok',
  'a regular approved family member can finalize their own scheduled moment'
);

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', true);

select is(
  (
    select count(*)
    from public.family_moments
    where uploader_id = '20000000-0000-4000-8000-000000000002'
  ),
  1::bigint,
  'the circle owner receives and can read another member moment'
);

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);

select is(
  (
    select count(*)
    from public.family_moments
    where uploader_id = '20000000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'an approved member receives and can read another same-circle moment'
);

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000003', true);

select is(
  (
    select count(*)
    from public.family_moments
    where circle_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  ),
  0::bigint,
  'cross-circle users cannot read ready moments'
);

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000004', true);

select is(
  (
    select count(*)
    from public.family_moments
    where circle_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  ),
  0::bigint,
  'removed members immediately lose access to ready moments'
);

reset role;

update public.daily_capture_windows
set opens_at = now() - interval '20 minutes',
    closes_at = now() - interval '5 minutes'
where id = '30000000-0000-4000-8000-000000000001';

set local role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', true);

select is(
  pg_temp.finalize_moment_result(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '40000000-0000-4000-8000-000000000006',
    'scheduled',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000006.jpg',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000006.jpg'
  ),
  'P0001:scheduled_capture_window_closed',
  'scheduled finalization remains locked outside the server window'
);

select is(
  pg_temp.finalize_moment_result(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '40000000-0000-4000-8000-000000000003',
    'manual',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000003.jpg',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000003.jpg'
  ),
  'ok',
  'the separate manual upload action remains available outside the random window'
);

select is(
  (
    select capture_window_id
    from public.family_moments
    where id = '40000000-0000-4000-8000-000000000003'
  ),
  null::uuid,
  'manual moments are not attributed to a scheduled prompt window'
);

reset role;

select is(
  (
    select count(*)
    from public.family_moments
    where capture_window_id = '30000000-0000-4000-8000-000000000001'
      and uploader_id = '20000000-0000-4000-8000-000000000001'
      and capture_kind = 'scheduled'
  ),
  1::bigint,
  'the database uniqueness invariant leaves at most one scheduled contribution per uploader/window'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) or exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'family_moments'
  ),
  'ready moments join Supabase Realtime when its standard publication exists'
);

select * from finish();
rollback;

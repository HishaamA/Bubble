begin;

create extension if not exists pgtap with schema extensions;
select plan(59);

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
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-000000000010.jpg'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000011.jpg'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000011.jpg'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/voice/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000011-voice-note.m4a'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000012.jpg'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000012.jpg'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000013.jpg'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000013.jpg'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000014.jpg'),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000014.jpg')
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

create or replace function pg_temp.finalize_annotated_moment_result(
  p_moment_id uuid,
  p_annotations jsonb
)
returns text
language plpgsql
as $$
begin
  perform public.finalize_360_moment_with_annotations(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    p_moment_id,
    'manual',
    pg_catalog.format(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/%s.jpg',
      p_moment_id
    ),
    pg_catalog.format(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000001/%s.jpg',
      p_moment_id
    ),
    4096,
    2048,
    800,
    400,
    'Annotated family moment',
    p_annotations
  );
  return 'ok';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.begin_moment_deletion_result(
  p_moment_id uuid
)
returns text
language plpgsql
as $$
begin
  perform public.begin_delete_own_family_moment(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    p_moment_id
  );
  return 'ok';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.finish_moment_deletion_result(
  p_moment_id uuid
)
returns text
language plpgsql
as $$
begin
  perform public.finish_delete_own_family_moment(
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    p_moment_id
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
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000003',
    'role', 'authenticated'
  )::text,
  true
);

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

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

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

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000003',
    'role', 'authenticated'
  )::text,
  true
);

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

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000004',
    'role', 'authenticated'
  )::text,
  true
);

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

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000002',
    'role', 'authenticated'
  )::text,
  true
);

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

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    select count(*)
    from public.family_moments
    where uploader_id = '20000000-0000-4000-8000-000000000002'
  ),
  1::bigint,
  'the circle owner receives and can read another member moment'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000002',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    select count(*)
    from public.family_moments
    where uploader_id = '20000000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'an approved member receives and can read another same-circle moment'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000003',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    select count(*)
    from public.family_moments
    where circle_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  ),
  0::bigint,
  'cross-circle users cannot read ready moments'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000004',
    'role', 'authenticated'
  )::text,
  true
);

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
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

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

select is(
  has_table_privilege(
    'authenticated',
    'public.family_moment_annotations',
    'select'
  )
  and not has_table_privilege(
    'authenticated',
    'public.family_moment_annotations',
    'insert'
  )
  and has_function_privilege(
    'authenticated',
    'public.finalize_360_moment_with_annotations(uuid,uuid,text,text,text,integer,integer,integer,integer,text,jsonb)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.finalize_360_moment_with_annotations(uuid,uuid,text,text,text,integer,integer,integer,integer,text,jsonb)',
    'execute'
  ),
  true,
  'annotation rows are read-only to authenticated clients and finalization is not exposed anonymously'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  pg_temp.finalize_annotated_moment_result(
    '40000000-0000-4000-8000-000000000011',
    jsonb_build_array(
      jsonb_build_object(
        'id', 'table-note',
        'kind', 'text',
        'pitch', 12,
        'yaw', -24,
        'message', 'Cake on the table',
        'audio_path', null,
        'audio_mime_type', null,
        'duration_ms', null
      ),
      jsonb_build_object(
        'id', 'voice-note',
        'kind', 'voice',
        'pitch', -4,
        'yaw', 31,
        'message', 'Dad describing Sunday dinner',
        'audio_path', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/voice/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000011-voice-note.m4a',
        'audio_mime_type', 'audio/mp4',
        'duration_ms', 8400
      )
    )
  ),
  'ok',
  'text and existing canonical voice media finalize with their panorama in one transaction'
);

select is(
  (
    select string_agg(
      annotation.id || ':' || annotation.kind || ':' || annotation.message,
      '|' order by annotation.sort_order
    )
    from public.family_moment_annotations as annotation
    where annotation.moment_id = '40000000-0000-4000-8000-000000000011'
  ),
  'table-note:text:Cake on the table|voice-note:voice:Dad describing Sunday dinner',
  'annotation order, kind, and accessible text survive finalization'
);

select is(
  pg_temp.finalize_annotated_moment_result(
    '40000000-0000-4000-8000-000000000012',
    jsonb_build_array(
      jsonb_build_object(
        'id', 'same-note',
        'kind', 'text',
        'pitch', 0,
        'yaw', 0,
        'message', 'First'
      ),
      jsonb_build_object(
        'id', 'same-note',
        'kind', 'text',
        'pitch', 1,
        'yaw', 1,
        'message', 'Second'
      )
    )
  ),
  '22023:duplicate_annotation_id',
  'one moment cannot finalize duplicate annotation IDs'
);

select is(
  pg_temp.finalize_annotated_moment_result(
    '40000000-0000-4000-8000-000000000013',
    jsonb_build_array(
      jsonb_build_object(
        'id', 'missing-voice',
        'kind', 'voice',
        'pitch', 0,
        'yaw', 0,
        'message', 'Accessible voice summary',
        'audio_path', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/voice/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000013-missing-voice.m4a',
        'audio_mime_type', 'audio/mp4',
        'duration_ms', 1000
      )
    )
  ),
  'P0001:voice_storage_object_not_found',
  'voice metadata cannot become ready before its exact private Storage object exists'
);

select is(
  pg_temp.finalize_annotated_moment_result(
    '40000000-0000-4000-8000-000000000014',
    jsonb_build_array(
      jsonb_build_object(
        'id', 'ceiling-note',
        'kind', 'text',
        'pitch', 91,
        'yaw', 0,
        'message', 'Outside the sphere'
      )
    )
  ),
  '22023:annotation_coordinates_out_of_bounds',
  'annotation coordinates are bounded to the panorama sphere'
);

select is(
  (
    select count(*)
    from public.family_moments
    where id in (
      '40000000-0000-4000-8000-000000000012',
      '40000000-0000-4000-8000-000000000013',
      '40000000-0000-4000-8000-000000000014'
    )
  ),
  0::bigint,
  'failed annotation validation leaves no partially finalized base moment'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000002',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    select count(*)
    from public.family_moment_annotations
    where moment_id = '40000000-0000-4000-8000-000000000011'
  ),
  2::bigint,
  'an approved family member can receive another member annotation'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000003',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    select count(*)
    from public.family_moment_annotations
    where moment_id = '40000000-0000-4000-8000-000000000011'
  ),
  0::bigint,
  'annotation RLS hides private points from users in another circle'
);

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

delete from storage.objects
where name = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000012.jpg';

select is(
  (
    select count(*)
    from storage.objects
    where name = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000012.jpg'
  ),
  0::bigint,
  'the uploader can clean up their own unreferenced object after failed finalization'
);

delete from storage.objects
where name = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000001.jpg';

select is(
  (
    select count(*)
    from storage.objects
    where name = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000001.jpg'
  ),
  1::bigint,
  'a finalized panorama remains immutable to its uploader'
);

delete from storage.objects
where name = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-000000000010.jpg';

select is(
  (
    select count(*)
    from storage.objects
    where name = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-000000000010.jpg'
  ),
  1::bigint,
  'one family member cannot clean up another uploader object'
);

reset role;

select is(
  has_table_privilege(
    'authenticated',
    'public.family_moment_deletions',
    'select'
  )
  and not has_table_privilege(
    'authenticated',
    'public.family_moment_deletions',
    'insert'
  )
  and not has_table_privilege(
    'authenticated',
    'public.family_moment_deletions',
    'update'
  )
  and not has_table_privilege(
    'authenticated',
    'public.family_moment_deletions',
    'delete'
  )
  and has_function_privilege(
    'authenticated',
    'public.begin_delete_own_family_moment(uuid,uuid)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.finish_delete_own_family_moment(uuid,uuid)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.begin_delete_own_family_moment(uuid,uuid)',
    'execute'
  ),
  true,
  'deletion tombstones are read-only and only authenticated callers receive the secure RPC surface'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000002',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  pg_temp.begin_moment_deletion_result(
    '40000000-0000-4000-8000-000000000011'
  ),
  '42501:moment_uploader_required',
  'an approved family member cannot delete another uploader''s moment'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000004',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  pg_temp.begin_moment_deletion_result(
    '40000000-0000-4000-8000-000000000011'
  ),
  '42501:approved_circle_membership_required',
  'a removed family member cannot start a moment deletion'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    select cardinality(deletion.media_paths)
    from public.begin_delete_own_family_moment(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      '40000000-0000-4000-8000-000000000011'
    ) as deletion
  ),
  3,
  'the uploader starts deletion with the exact panorama, thumbnail, and voice paths'
);

select is(
  (
    select cardinality(deletion.media_paths)
    from public.begin_delete_own_family_moment(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      '40000000-0000-4000-8000-000000000011'
    ) as deletion
  ),
  3,
  'restarting an in-progress deletion reuses its existing tombstone'
);

reset role;

select is(
  (
    select family_moment.status || ':' || deletion.uploader_id::text
    from public.family_moments as family_moment
    join public.family_moment_deletions as deletion
      on deletion.moment_id = family_moment.id
    where family_moment.id = '40000000-0000-4000-8000-000000000011'
  ),
  'deleting:20000000-0000-4000-8000-000000000001',
  'deletion intent atomically hides the ready row and records an uploader tombstone'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000002',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    select count(*)
    from public.family_moment_deletions
    where moment_id = '40000000-0000-4000-8000-000000000011'
  ),
  1::bigint,
  'approved family members receive the durable deletion tombstone'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000003',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    select count(*)
    from public.family_moment_deletions
    where moment_id = '40000000-0000-4000-8000-000000000011'
  ),
  0::bigint,
  'deletion tombstone RLS hides another circle''s private activity'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    select cardinality(deletion.media_paths)
    from public.list_pending_own_family_moment_deletions(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    ) as deletion
    where deletion.moment_id = '40000000-0000-4000-8000-000000000011'
  ),
  3,
  'an interrupted deletion can resume with every exact media path'
);

select is(
  pg_temp.finish_moment_deletion_result(
    '40000000-0000-4000-8000-000000000011'
  ),
  'P0001:family_moment_media_cleanup_incomplete',
  'metadata deletion cannot finish while any private media remains'
);

delete from storage.objects
where name in (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000011.jpg',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000011.jpg'
);

select is(
  (
    select count(*)
    from storage.objects
    where name in (
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000011.jpg',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000011.jpg'
    )
  ),
  0::bigint,
  'pending-delete Storage RLS allows only the uploader to remove referenced image media'
);

select is(
  pg_temp.finish_moment_deletion_result(
    '40000000-0000-4000-8000-000000000011'
  ),
  'P0001:family_moment_media_cleanup_incomplete',
  'one remaining voice object still blocks final deletion'
);

delete from storage.objects
where name = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc/voice/20000000-0000-4000-8000-000000000001/40000000-0000-4000-8000-000000000011-voice-note.m4a';

select is(
  pg_temp.finish_moment_deletion_result(
    '40000000-0000-4000-8000-000000000011'
  ),
  'ok',
  'the uploader finalizes deletion after every private media object is gone'
);

reset role;

select is(
  (
    select count(*)
    from public.family_moments as family_moment
    where family_moment.id = '40000000-0000-4000-8000-000000000011'
  ) + (
    select count(*)
    from public.family_moment_annotations as annotation
    where annotation.moment_id = '40000000-0000-4000-8000-000000000011'
  ),
  0::bigint,
  'final deletion removes moment metadata and cascades every annotation'
);

select is(
  (
    select count(*)
    from public.family_moment_deletions as deletion
    where deletion.moment_id = '40000000-0000-4000-8000-000000000011'
  ),
  1::bigint,
  'the family tombstone remains for offline cache reconciliation'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    select cardinality(deletion.media_paths)::text
    from public.begin_delete_own_family_moment(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      '40000000-0000-4000-8000-000000000011'
    ) as deletion
  ) || ':' || pg_temp.finish_moment_deletion_result(
    '40000000-0000-4000-8000-000000000011'
  ),
  '0:ok',
  'begin and finish deletion are idempotent after cleanup completes'
);

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000002',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  pg_temp.begin_moment_deletion_result(
    '40000000-0000-4000-8000-000000000010'
  ),
  'ok',
  'an approved uploader can start deleting their own moment before family removal'
);

reset role;

update public.circle_members
set status = 'removed',
    removed_at = now()
where circle_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  and user_id = '20000000-0000-4000-8000-000000000002';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000002',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    select cardinality(deletion.media_paths)
    from public.list_pending_own_family_moment_deletions(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    ) as deletion
    where deletion.moment_id = '40000000-0000-4000-8000-000000000010'
  ),
  2,
  'a removed uploader can resume only the deletion they already tombstoned'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '20000000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    select cardinality(deletion.media_paths)
    from public.list_pending_own_family_moment_deletions(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    ) as deletion
    where deletion.moment_id = '40000000-0000-4000-8000-000000000010'
  ),
  2,
  'the circle owner discovers a removed member''s pending deletion during normal recovery'
);

delete from storage.objects
where name in (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-000000000010.jpg',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-000000000010.jpg'
);

select is(
  (
    select count(*)
    from storage.objects
    where name in (
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc/panoramas/20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-000000000010.jpg',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnails/20000000-0000-4000-8000-000000000002/40000000-0000-4000-8000-000000000010.jpg'
    )
  ),
  0::bigint,
  'the circle owner can clean only exact media from a removed member''s pending deletion'
);

select is(
  pg_temp.finish_moment_deletion_result(
    '40000000-0000-4000-8000-000000000010'
  ),
  'ok',
  'the circle owner can finish a removed member''s started deletion without retaining private media'
);

reset role;

select ok(
  not exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) or exists (
    select 1
    from pg_catalog.pg_publication_tables as moment_publication
    where moment_publication.pubname = 'supabase_realtime'
      and moment_publication.schemaname = 'public'
      and moment_publication.tablename = 'family_moments'
  ) and (
    not exists (
      select 1
      from pg_catalog.pg_publication
      where pubname = 'supabase_realtime'
    ) or exists (
      select 1
      from pg_catalog.pg_publication_tables as deletion_publication
      where deletion_publication.pubname = 'supabase_realtime'
        and deletion_publication.schemaname = 'public'
        and deletion_publication.tablename = 'family_moment_deletions'
    )
  ),
  'ready moments and durable deletion tombstones join Supabase Realtime when its standard publication exists'
);

select * from finish();
rollback;

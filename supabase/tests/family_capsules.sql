begin;

-- Supabase Storage enables this transaction-local flag when its API removes
-- object metadata. The DELETE statements below simulate that step while RLS
-- remains enabled and continues to decide which rows the caller may remove.
set local storage.allow_delete_query = 'true';

create extension if not exists pgtap with schema extensions;
select plan(35);

-- Use non-UUID Clerk subjects to make sure every Capsule authorization check
-- resolves through current_app_user_id(), rather than accidentally relying on
-- auth.uid().
insert into public.profiles (id, display_name)
values
  ('51000000-0000-4000-8000-000000000001', 'Capsule Alice'),
  ('51000000-0000-4000-8000-000000000002', 'Capsule Bob'),
  ('51000000-0000-4000-8000-000000000003', 'Capsule Mallory'),
  ('51000000-0000-4000-8000-000000000004', 'Capsule Removed');

insert into public.profile_preferences (user_id, time_zone)
values
  ('51000000-0000-4000-8000-000000000001', 'UTC'),
  ('51000000-0000-4000-8000-000000000002', 'UTC'),
  ('51000000-0000-4000-8000-000000000003', 'UTC'),
  ('51000000-0000-4000-8000-000000000004', 'UTC');

insert into public.app_identities (subject, user_id, provider)
values
  ('capsule_user_alice', '51000000-0000-4000-8000-000000000001', 'clerk'),
  ('capsule_user_bob', '51000000-0000-4000-8000-000000000002', 'clerk'),
  ('capsule_user_mallory', '51000000-0000-4000-8000-000000000003', 'clerk'),
  ('capsule_user_removed', '51000000-0000-4000-8000-000000000004', 'clerk');

insert into public.circles (id, name, owner_id)
values
  (
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Capsule Family A',
    '51000000-0000-4000-8000-000000000001'
  ),
  (
    'cbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Capsule Family B',
    '51000000-0000-4000-8000-000000000003'
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
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '51000000-0000-4000-8000-000000000002',
    'member',
    'approved',
    '51000000-0000-4000-8000-000000000001',
    now(),
    null
  ),
  (
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '51000000-0000-4000-8000-000000000004',
    'member',
    'removed',
    '51000000-0000-4000-8000-000000000001',
    now() - interval '1 day',
    now()
  );

insert into public.family_capsules (
  id,
  circle_id,
  created_by,
  kind,
  title,
  week_start,
  opens_at,
  closes_at,
  item_count
)
values
  (
    '61000000-0000-4000-8000-000000000001',
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '51000000-0000-4000-8000-000000000001',
    'special',
    'Locked family day',
    null,
    now() + interval '1 day',
    now() + interval '1 day',
    2
  ),
  (
    '61000000-0000-4000-8000-000000000002',
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '51000000-0000-4000-8000-000000000001',
    'special',
    'Opened family day',
    null,
    now() - interval '1 hour',
    now() - interval '1 hour',
    1
  ),
  (
    '61000000-0000-4000-8000-000000000003',
    'cbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '51000000-0000-4000-8000-000000000003',
    'special',
    'Other family',
    null,
    now() + interval '1 day',
    now() + interval '1 day',
    0
  );

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
)
values
  (
    '71000000-0000-4000-8000-000000000001',
    '61000000-0000-4000-8000-000000000001',
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '51000000-0000-4000-8000-000000000001',
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000001/71000000-0000-4000-8000-000000000001.jpg',
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-thumbnails/51000000-0000-4000-8000-000000000001/71000000-0000-4000-8000-000000000001.jpg',
    1200,
    900,
    400,
    300,
    'Alice locked photo',
    now() - interval '10 minutes'
  ),
  (
    '71000000-0000-4000-8000-000000000002',
    '61000000-0000-4000-8000-000000000001',
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '51000000-0000-4000-8000-000000000002',
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000002/71000000-0000-4000-8000-000000000002.jpg',
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-thumbnails/51000000-0000-4000-8000-000000000002/71000000-0000-4000-8000-000000000002.jpg',
    1200,
    900,
    400,
    300,
    'Bob locked photo',
    now() - interval '9 minutes'
  ),
  (
    '71000000-0000-4000-8000-000000000003',
    '61000000-0000-4000-8000-000000000002',
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '51000000-0000-4000-8000-000000000001',
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000001/71000000-0000-4000-8000-000000000003.jpg',
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-thumbnails/51000000-0000-4000-8000-000000000001/71000000-0000-4000-8000-000000000003.jpg',
    1200,
    900,
    400,
    300,
    'Alice opened photo',
    now() - interval '2 hours'
  );

insert into storage.objects (id, bucket_id, name)
select
  extensions.gen_random_uuid(),
  'family-media',
  object_name
from (
  values
    ('caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000001/71000000-0000-4000-8000-000000000001.jpg'),
    ('caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-thumbnails/51000000-0000-4000-8000-000000000001/71000000-0000-4000-8000-000000000001.jpg'),
    ('caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000002/71000000-0000-4000-8000-000000000002.jpg'),
    ('caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-thumbnails/51000000-0000-4000-8000-000000000002/71000000-0000-4000-8000-000000000002.jpg'),
    ('caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000001/71000000-0000-4000-8000-000000000003.jpg'),
    ('caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-thumbnails/51000000-0000-4000-8000-000000000001/71000000-0000-4000-8000-000000000003.jpg'),
    ('caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000002/71000000-0000-4000-8000-000000000010.jpg'),
    ('caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-thumbnails/51000000-0000-4000-8000-000000000002/71000000-0000-4000-8000-000000000010.jpg')
) as fixture(object_name);

create or replace function pg_temp.weekly_capsule_result(p_circle_id uuid)
returns text
language plpgsql
as $$
begin
  perform public.get_or_create_weekly_capsule(p_circle_id);
  return 'ok';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.can_insert_capsule_media(p_name text)
returns boolean
language plpgsql
as $$
begin
  insert into storage.objects (bucket_id, name)
  values ('family-media', p_name);
  return true;
exception
  when insufficient_privilege then
    return false;
end;
$$;

create or replace function pg_temp.finalize_capsule_result(
  p_capsule_id uuid,
  p_item_id uuid,
  p_image_path text,
  p_thumbnail_path text
)
returns text
language plpgsql
as $$
begin
  perform public.finalize_capsule_photo(
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    p_capsule_id,
    p_item_id,
    p_image_path,
    p_thumbnail_path,
    1200,
    900,
    400,
    300,
    'Bob contribution',
    now()
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
    'public.get_or_create_weekly_capsule(uuid)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.create_special_capsule(uuid,text,timestamp with time zone,uuid)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.finalize_capsule_photo(uuid,uuid,uuid,text,text,integer,integer,integer,integer,text,timestamp with time zone)',
    'execute'
  ),
  true,
  'authenticated users can execute the intentional Capsule RPC surface'
);

select is(
  not has_function_privilege(
    'anon',
    'public.get_or_create_weekly_capsule(uuid)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.create_special_capsule(uuid,text,timestamp with time zone,uuid)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.finalize_capsule_photo(uuid,uuid,uuid,text,text,integer,integer,integer,integer,text,timestamp with time zone)',
    'execute'
  ),
  true,
  'anonymous users cannot execute Capsule RPCs'
);

select is(
  has_table_privilege('authenticated', 'public.family_capsules', 'select')
  and not has_table_privilege('authenticated', 'public.family_capsules', 'insert')
  and not has_table_privilege('authenticated', 'public.family_capsules', 'update')
  and not has_table_privilege('authenticated', 'public.family_capsules', 'delete')
  and has_table_privilege('authenticated', 'public.family_capsule_items', 'select')
  and not has_table_privilege('authenticated', 'public.family_capsule_items', 'insert')
  and not has_table_privilege('authenticated', 'public.family_capsule_items', 'update')
  and not has_table_privilege('authenticated', 'public.family_capsule_items', 'delete'),
  true,
  'clients can read permitted Capsule rows but cannot forge or mutate them directly'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) or (
    exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'family_capsules'
    )
    and exists (
      select 1
      from pg_catalog.pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'family_capsule_items'
    )
  ),
  'Capsule tables join Supabase Realtime when its standard publication exists'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"capsule_user_alice","role":"authenticated"}',
  true
);

select is(
  public.current_app_user_id(),
  '51000000-0000-4000-8000-000000000001'::uuid,
  'a non-UUID Clerk subject resolves to Alice''s internal app user ID'
);

select is(
  (select count(*) from public.family_capsules),
  2::bigint,
  'an approved member sees Capsule metadata only for their family'
);

select is(
  (
    select count(*)
    from public.family_capsule_items
    where capsule_id = '61000000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'before unlock Alice sees only her own item metadata'
);

select is(
  (
    select count(*)
    from public.family_capsule_items
    where capsule_id = '61000000-0000-4000-8000-000000000002'
  ),
  1::bigint,
  'after unlock Alice sees family item metadata'
);

select is(
  pg_temp.weekly_capsule_result('caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'ok',
  'an approved member can create the current weekly Capsule'
);

select is(
  pg_temp.weekly_capsule_result('caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'ok',
  'weekly Capsule creation is idempotent for a retry'
);

select is(
  (
    select count(*)
    from public.family_capsules
    where kind = 'weekly'
      and circle_id = 'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  1::bigint,
  'a retry creates only one weekly Capsule row'
);

select is(
  (
    select created_by
    from public.family_capsules
    where kind = 'weekly'
      and circle_id = 'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  '51000000-0000-4000-8000-000000000001'::uuid,
  'the weekly Capsule persists the Clerk-backed internal creator ID'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"capsule_user_bob","role":"authenticated"}',
  true
);

select is(
  public.current_app_user_id(),
  '51000000-0000-4000-8000-000000000002'::uuid,
  'Bob''s Clerk subject resolves to Bob''s internal app user ID'
);

select is(
  (select count(*) from public.family_capsules),
  3::bigint,
  'Bob sees every Capsule metadata row in his family and none from another family'
);

select is(
  (
    select count(*)
    from public.family_capsule_items
    where id = '71000000-0000-4000-8000-000000000002'
  ),
  1::bigint,
  'before unlock Bob sees his own item metadata'
);

select is(
  (
    select count(*)
    from public.family_capsule_items
    where id = '71000000-0000-4000-8000-000000000001'
  ),
  0::bigint,
  'before unlock Bob cannot see Alice''s item metadata'
);

select is(
  (
    select count(*)
    from public.family_capsule_items
    where id = '71000000-0000-4000-8000-000000000003'
  ),
  1::bigint,
  'after unlock Bob can see Alice''s item metadata'
);

select is(
  (
    select count(*)
    from storage.objects
    where name like 'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-%/51000000-0000-4000-8000-000000000002/71000000-0000-4000-8000-000000000002.jpg'
  ),
  2::bigint,
  'before unlock Bob can read both of his own Capsule objects'
);

select is(
  (
    select count(*)
    from storage.objects
    where name like 'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-%/51000000-0000-4000-8000-000000000001/71000000-0000-4000-8000-000000000001.jpg'
  ),
  0::bigint,
  'before unlock Bob cannot read Alice''s Capsule objects'
);

select is(
  (
    select count(*)
    from storage.objects
    where name like 'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-%/51000000-0000-4000-8000-000000000001/71000000-0000-4000-8000-000000000003.jpg'
  ),
  2::bigint,
  'after unlock Bob can read both of Alice''s Capsule objects'
);

select ok(
  pg_temp.can_insert_capsule_media(
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000002/72000000-0000-4000-8000-000000000001.jpg'
  ),
  'an approved member can upload to their exact Capsule namespace'
);

select is(
  pg_temp.can_insert_capsule_media(
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000001/72000000-0000-4000-8000-000000000002.jpg'
  ),
  false,
  'an approved member cannot upload under another family member''s ID'
);

select is(
  pg_temp.can_insert_capsule_media(
    'cbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/capsule-images/51000000-0000-4000-8000-000000000002/72000000-0000-4000-8000-000000000003.jpg'
  ),
  false,
  'an approved member cannot upload into another circle'
);

select is(
  pg_temp.can_insert_capsule_media(
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000002/nested/72000000-0000-4000-8000-000000000004.jpg'
  ),
  false,
  'Capsule upload paths cannot add nested or ambiguous segments'
);

select is(
  pg_temp.finalize_capsule_result(
    '61000000-0000-4000-8000-000000000001',
    '71000000-0000-4000-8000-000000000010',
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000002/71000000-0000-4000-8000-000000000010.jpg',
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-thumbnails/51000000-0000-4000-8000-000000000002/71000000-0000-4000-8000-000000000010.jpg'
  ),
  'ok',
  'the finalizer accepts an approved uploader''s exact immutable objects'
);

select is(
  (
    select uploader_id
    from public.family_capsule_items
    where id = '71000000-0000-4000-8000-000000000010'
  ),
  '51000000-0000-4000-8000-000000000002'::uuid,
  'the finalizer derives the uploader from the Clerk-backed session'
);

select is(
  (
    select item_count
    from public.family_capsules
    where id = '61000000-0000-4000-8000-000000000001'
  ),
  3,
  'finalization increments the family-visible item count exactly once'
);

select is(
  pg_temp.finalize_capsule_result(
    '61000000-0000-4000-8000-000000000002',
    '71000000-0000-4000-8000-000000000011',
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000002/71000000-0000-4000-8000-000000000011.jpg',
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-thumbnails/51000000-0000-4000-8000-000000000002/71000000-0000-4000-8000-000000000011.jpg'
  ),
  '22023:capsule_is_already_open',
  'the server clock rejects contributions after a Capsule unlocks'
);

select is(
  pg_temp.finalize_capsule_result(
    '61000000-0000-4000-8000-000000000001',
    '71000000-0000-4000-8000-000000000012',
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000001/71000000-0000-4000-8000-000000000012.jpg',
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-thumbnails/51000000-0000-4000-8000-000000000002/71000000-0000-4000-8000-000000000012.jpg'
  ),
  '22023:media_paths_must_match_authenticated_uploader',
  'the finalizer rejects a path that does not exactly match the authenticated uploader'
);

delete from storage.objects
where name = 'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000002/72000000-0000-4000-8000-000000000001.jpg';

select is(
  (
    select count(*)
    from storage.objects
    where name = 'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000002/72000000-0000-4000-8000-000000000001.jpg'
  ),
  0::bigint,
  'an uploader can clean up their own canonical object after finalization fails'
);

delete from storage.objects
where name = 'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000002/71000000-0000-4000-8000-000000000010.jpg';

select is(
  (
    select count(*)
    from storage.objects
    where name = 'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000002/71000000-0000-4000-8000-000000000010.jpg'
  ),
  1::bigint,
  'the orphan cleanup policy cannot delete a finalized Capsule object'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"capsule_user_mallory","role":"authenticated"}',
  true
);

select is(
  (
    select count(*)
    from public.family_capsules
    where circle_id = 'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  0::bigint,
  'an outsider cannot read another family''s Capsule metadata'
);

select is(
  pg_temp.weekly_capsule_result('caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  '42501:approved_circle_membership_required',
  'an outsider cannot create a Capsule in another family'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"capsule_user_removed","role":"authenticated"}',
  true
);

select is(
  (
    select count(*)
    from public.family_capsules
    where circle_id = 'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  0::bigint,
  'a removed member loses Capsule metadata access immediately'
);

select is(
  pg_temp.can_insert_capsule_media(
    'caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/51000000-0000-4000-8000-000000000004/72000000-0000-4000-8000-000000000005.jpg'
  ),
  false,
  'a removed member cannot upload new Capsule media'
);

reset role;
select * from finish();
rollback;

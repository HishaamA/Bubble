begin;

create extension if not exists pgtap with schema extensions;
select plan(19);

insert into public.profiles (id, display_name)
values
  ('52000000-0000-4000-8000-000000000001', 'Journal Alice'),
  ('52000000-0000-4000-8000-000000000002', 'Journal Bob'),
  ('52000000-0000-4000-8000-000000000003', 'Journal Mallory');

insert into public.profile_preferences (user_id, time_zone)
values
  ('52000000-0000-4000-8000-000000000001', 'UTC'),
  ('52000000-0000-4000-8000-000000000002', 'UTC'),
  ('52000000-0000-4000-8000-000000000003', 'UTC');

insert into public.app_identities (subject, user_id, provider)
values
  ('journal_user_alice', '52000000-0000-4000-8000-000000000001', 'clerk'),
  ('journal_user_bob', '52000000-0000-4000-8000-000000000002', 'clerk'),
  ('journal_user_mallory', '52000000-0000-4000-8000-000000000003', 'clerk');

insert into public.circles (id, name, owner_id)
values
  (
    'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Journal Family A',
    '52000000-0000-4000-8000-000000000001'
  ),
  (
    'dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Journal Family B',
    '52000000-0000-4000-8000-000000000003'
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
  'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '52000000-0000-4000-8000-000000000002',
  'member',
  'approved',
  '52000000-0000-4000-8000-000000000001',
  now()
);

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
)
values
  (
    '62000000-0000-4000-8000-000000000001',
    'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '52000000-0000-4000-8000-000000000001',
    'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-images/52000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000001.jpg',
    'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-thumbnails/52000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000001.jpg',
    1200,
    900,
    400,
    300,
    'Alice family photo',
    now() - interval '1 day'
  ),
  (
    '62000000-0000-4000-8000-000000000002',
    'dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '52000000-0000-4000-8000-000000000003',
    'dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/journal-images/52000000-0000-4000-8000-000000000003/62000000-0000-4000-8000-000000000002.jpg',
    'dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/journal-thumbnails/52000000-0000-4000-8000-000000000003/62000000-0000-4000-8000-000000000002.jpg',
    1200,
    900,
    400,
    300,
    'Other family photo',
    now() - interval '1 day'
  );

insert into storage.objects (id, bucket_id, name, metadata)
select
  extensions.gen_random_uuid(),
  'family-media',
  object_name,
  object_metadata::jsonb
from (
  values
    (
      'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-images/52000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000001.jpg',
      '{"mimetype":"image/jpeg","size":120000}'
    ),
    (
      'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-thumbnails/52000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000001.jpg',
      '{"mimetype":"image/jpeg","size":20000}'
    ),
    (
      'dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/journal-images/52000000-0000-4000-8000-000000000003/62000000-0000-4000-8000-000000000002.jpg',
      '{"mimetype":"image/jpeg","size":120000}'
    ),
    (
      'dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/journal-thumbnails/52000000-0000-4000-8000-000000000003/62000000-0000-4000-8000-000000000002.jpg',
      '{"mimetype":"image/jpeg","size":20000}'
    ),
    (
      'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-images/52000000-0000-4000-8000-000000000002/62000000-0000-4000-8000-000000000004.jpg',
      '{"mimetype":"audio/webm","size":120000}'
    ),
    (
      'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-thumbnails/52000000-0000-4000-8000-000000000002/62000000-0000-4000-8000-000000000004.jpg',
      '{"mimetype":"image/jpeg","size":20000}'
    )
) as fixture(object_name, object_metadata);

create or replace function pg_temp.can_stage_journal_media(
  p_name text,
  p_size integer
)
returns boolean
language plpgsql
as $$
begin
  insert into storage.objects (bucket_id, name, metadata)
  values (
    'family-media',
    p_name,
    jsonb_build_object('mimetype', 'image/jpeg', 'size', p_size)
  );
  return true;
exception
  when insufficient_privilege then
    return false;
end;
$$;

create or replace function pg_temp.finalize_journal_result(
  p_photo_id uuid,
  p_image_path text,
  p_thumbnail_path text
)
returns text
language plpgsql
as $$
begin
  perform public.finalize_journal_photo(
    'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    p_photo_id,
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
    'public.finalize_journal_photo(uuid,uuid,text,text,integer,integer,integer,integer,text,timestamp with time zone)',
    'execute'
  ),
  true,
  'authenticated members can execute only the Journal finalizer surface'
);

select is(
  has_function_privilege(
    'anon',
    'public.finalize_journal_photo(uuid,uuid,text,text,integer,integer,integer,integer,text,timestamp with time zone)',
    'execute'
  ),
  false,
  'anonymous callers cannot execute the Journal finalizer'
);

select is(
  has_table_privilege('authenticated', 'public.family_journal_photos', 'select')
  and not has_table_privilege('authenticated', 'public.family_journal_photos', 'insert')
  and not has_table_privilege('authenticated', 'public.family_journal_photos', 'update')
  and not has_table_privilege('authenticated', 'public.family_journal_photos', 'delete'),
  true,
  'clients can read permitted Journal rows but cannot forge or mutate them'
);

select ok(
  not exists (
    select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime'
  ) or exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'family_journal_photos'
  ),
  'Journal photos join Supabase Realtime when its standard publication exists'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"journal_user_alice","role":"authenticated"}',
  true
);

select is(
  (select count(*) from public.family_journal_photos),
  1::bigint,
  'Alice sees finalized photos only from her approved family'
);

select is(
  (
    select count(*)
    from storage.objects
    where name like 'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-%/52000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000001.jpg'
  ),
  2::bigint,
  'Alice can read both finalized private objects in her family photo'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"journal_user_bob","role":"authenticated"}',
  true
);

select is(
  (select count(*) from public.family_journal_photos),
  1::bigint,
  'Bob sees Alice''s finalized family photo and nothing from another family'
);

select is(
  (
    select count(*)
    from storage.objects
    where name like 'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-%/52000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000001.jpg'
  ),
  2::bigint,
  'Bob can read both finalized media objects uploaded by Alice'
);

select is(
  (
    select count(*)
    from storage.objects
    where name like 'dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/journal-%'
  ),
  0::bigint,
  'Bob cannot read Journal media from another family'
);

select ok(
  pg_temp.can_stage_journal_media(
    'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-images/52000000-0000-4000-8000-000000000002/62000000-0000-4000-8000-000000000003.jpg',
    120000
  ),
  'Bob can stage one canonical full JPEG in his own family namespace'
);

select ok(
  pg_temp.can_stage_journal_media(
    'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-thumbnails/52000000-0000-4000-8000-000000000002/62000000-0000-4000-8000-000000000003.jpg',
    20000
  ),
  'Bob can stage the matching canonical thumbnail JPEG'
);

select is(
  pg_temp.can_stage_journal_media(
    'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-images/52000000-0000-4000-8000-000000000002/not-a-uuid.jpg',
    120000
  ),
  false,
  'Journal staging rejects non-UUID filenames'
);

select is(
  pg_temp.can_stage_journal_media(
    'dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/journal-images/52000000-0000-4000-8000-000000000002/62000000-0000-4000-8000-000000000005.jpg',
    120000
  ),
  false,
  'Journal staging rejects another family circle'
);

select is(
  pg_temp.finalize_journal_result(
    '62000000-0000-4000-8000-000000000003',
    'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-images/52000000-0000-4000-8000-000000000002/62000000-0000-4000-8000-000000000003.jpg',
    'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-thumbnails/52000000-0000-4000-8000-000000000002/62000000-0000-4000-8000-000000000003.jpg'
  ),
  'ok',
  'the finalizer accepts Bob''s exact bounded JPEG pair'
);

select is(
  (
    select uploader_id
    from public.family_journal_photos
    where id = '62000000-0000-4000-8000-000000000003'
  ),
  '52000000-0000-4000-8000-000000000002'::uuid,
  'the finalizer derives the uploader from Bob''s Clerk-backed session'
);

select is(
  pg_temp.finalize_journal_result(
    '62000000-0000-4000-8000-000000000004',
    'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-images/52000000-0000-4000-8000-000000000002/62000000-0000-4000-8000-000000000004.jpg',
    'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-thumbnails/52000000-0000-4000-8000-000000000002/62000000-0000-4000-8000-000000000004.jpg'
  ),
  '22023:valid_journal_photo_uploads_not_found',
  'the trusted finalizer rejects a staged non-image object'
);

select is(
  pg_temp.finalize_journal_result(
    '62000000-0000-4000-8000-000000000006',
    'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-images/52000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000006.jpg',
    'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-thumbnails/52000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000006.jpg'
  ),
  '22023:media_paths_must_match_authenticated_uploader',
  'the finalizer rejects paths under another member''s identity'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"journal_user_alice","role":"authenticated"}',
  true
);

select is(
  (select count(*) from public.family_journal_photos),
  2::bigint,
  'Alice receives Bob''s newly finalized photo immediately'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"journal_user_mallory","role":"authenticated"}',
  true
);

select is(
  (select count(*) from public.family_journal_photos),
  1::bigint,
  'Mallory still sees only the other family''s photo'
);

select * from finish();
rollback;

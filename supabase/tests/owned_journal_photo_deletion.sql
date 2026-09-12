begin;

create extension if not exists pgtap with schema extensions;
select plan(33);

insert into public.profiles (id, display_name) values
  ('53000000-0000-4000-8000-000000000001', 'Delete Alice'),
  ('53000000-0000-4000-8000-000000000002', 'Delete Bob'),
  ('53000000-0000-4000-8000-000000000003', 'Delete Outsider');
insert into public.profile_preferences (user_id, time_zone) values
  ('53000000-0000-4000-8000-000000000001', 'UTC'),
  ('53000000-0000-4000-8000-000000000002', 'UTC'),
  ('53000000-0000-4000-8000-000000000003', 'UTC');
insert into public.app_identities (subject, user_id, provider) values
  ('journal_delete_alice', '53000000-0000-4000-8000-000000000001', 'clerk'),
  ('journal_delete_bob', '53000000-0000-4000-8000-000000000002', 'clerk'),
  ('journal_delete_outsider', '53000000-0000-4000-8000-000000000003', 'clerk');
insert into public.circles (id, name, owner_id) values
  ('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Deletion Family A', '53000000-0000-4000-8000-000000000001'),
  ('ebbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Deletion Family B', '53000000-0000-4000-8000-000000000003');
insert into public.circle_members (circle_id, user_id, role, status, approved_by, approved_at)
values ('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '53000000-0000-4000-8000-000000000002',
  'member', 'approved', '53000000-0000-4000-8000-000000000001', now());

insert into public.family_journal_photos (
  id, circle_id, uploader_id, image_path, thumbnail_path,
  image_width, image_height, thumbnail_width, thumbnail_height, caption, captured_at
) values (
  '63000000-0000-4000-8000-000000000001', 'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '53000000-0000-4000-8000-000000000001',
  'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-images/53000000-0000-4000-8000-000000000001/63000000-0000-4000-8000-000000000001.jpg',
  'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-thumbnails/53000000-0000-4000-8000-000000000001/63000000-0000-4000-8000-000000000001.jpg',
  1200, 900, 400, 300, 'Uploader-owned fixture', now() - interval '1 day'
);
insert into storage.objects (id, bucket_id, name, metadata)
select extensions.gen_random_uuid(), 'family-media', object_name,
  jsonb_build_object('mimetype', 'image/jpeg', 'size', object_size)
from (values
  ('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-images/53000000-0000-4000-8000-000000000001/63000000-0000-4000-8000-000000000001.jpg', 120000),
  ('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-thumbnails/53000000-0000-4000-8000-000000000001/63000000-0000-4000-8000-000000000001.jpg', 20000),
  ('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-images/53000000-0000-4000-8000-000000000001/63000000-0000-4000-8000-000000000099.jpg', 120000),
  ('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-thumbnails/53000000-0000-4000-8000-000000000001/63000000-0000-4000-8000-000000000099.jpg', 20000),
  ('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-images/53000000-0000-4000-8000-000000000002/63000000-0000-4000-8000-000000000099.jpg', 120000),
  ('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-thumbnails/53000000-0000-4000-8000-000000000002/63000000-0000-4000-8000-000000000099.jpg', 20000)
) as fixture(object_name, object_size);

select ok(has_function_privilege('authenticated', 'public.delete_family_journal_photo(uuid,uuid)', 'execute'),
  'authenticated uploaders can reach the guarded delete RPC');
select ok(not has_function_privilege('anon', 'public.delete_family_journal_photo(uuid,uuid)', 'execute'),
  'anonymous users cannot execute Journal deletion');
select ok(
  has_table_privilege('authenticated', 'public.deleted_family_journal_photos', 'select')
  and not has_table_privilege('authenticated', 'public.deleted_family_journal_photos', 'insert')
  and not has_table_privilege('authenticated', 'public.deleted_family_journal_photos', 'update')
  and not has_table_privilege('authenticated', 'public.deleted_family_journal_photos', 'delete'),
  'clients may only read permitted deletion markers, never forge or remove them'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"journal_delete_bob","role":"authenticated"}', true);
select is((select count(*) from public.family_journal_photos), 1::bigint,
  'another approved family member can see the uploaded photo');
select throws_ok(
  $$select public.delete_family_journal_photo('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '63000000-0000-4000-8000-000000000001')$$,
  '42501', 'journal_photo_uploader_required',
  'a same-family non-uploader cannot delete someone else’s photo'
);
select is((select count(*) from public.family_journal_photos), 1::bigint,
  'a rejected deletion leaves the shared photo intact');

select set_config('request.jwt.claims', '{"sub":"journal_delete_outsider","role":"authenticated"}', true);
select throws_ok(
  $$select public.delete_family_journal_photo('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '63000000-0000-4000-8000-000000000001')$$,
  '42501', 'approved_circle_membership_required',
  'an outsider cannot delete through a foreign family ID'
);
select throws_ok(
  $$select public.delete_family_journal_photo('ebbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '63000000-0000-4000-8000-000000000001')$$,
  '42501', 'journal_photo_uploader_required',
  'supplying an approved but unrelated family ID does not bypass ownership'
);

select set_config('request.jwt.claims', '{"sub":"journal_delete_alice","role":"authenticated"}', true);
select is(public.delete_family_journal_photo('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '63000000-0000-4000-8000-000000000001'),
  true, 'the original uploader can delete their shared Journal photo');
select is((select count(*) from public.family_journal_photos), 0::bigint,
  'successful deletion removes the visible Journal row');
select is((select count(*) from public.deleted_family_journal_photos
  where photo_id = '63000000-0000-4000-8000-000000000001'
    and circle_id = 'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    and uploader_id = public.current_app_user_id()), 1::bigint,
  'a durable marker retains the exact family/photo/uploader identity');
select is(public.delete_family_journal_photo('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '63000000-0000-4000-8000-000000000001'),
  true, 'retrying after a lost delete response is idempotent');
select is((select count(*) from public.deleted_family_journal_photos), 1::bigint,
  'idempotent retries do not duplicate or replace the deletion marker');
select is(public.delete_family_journal_photo('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '63000000-0000-4000-8000-000000000099'),
  true, 'a never-finalized local photo may be removed without remote metadata');
select is((select count(*) from public.deleted_family_journal_photos
  where photo_id = '63000000-0000-4000-8000-000000000099'
    and uploader_id = public.current_app_user_id() and not was_published), 1::bigint,
  'a pending cancellation is stored only for the requesting uploader’s identity');

select set_config('request.jwt.claims', '{"sub":"journal_delete_bob","role":"authenticated"}', true);
select is((select count(*) from public.deleted_family_journal_photos), 1::bigint,
  'another approved member receives the deletion marker for offline-cache cleanup');
select is((select count(*) from public.family_journal_photos), 0::bigint,
  'the deleted photo is no longer visible to the rest of the family');
select set_config('request.jwt.claims', '{"sub":"journal_delete_outsider","role":"authenticated"}', true);
select is((select count(*) from public.deleted_family_journal_photos), 0::bigint,
  'unrelated families cannot read deletion metadata');

select set_config('request.jwt.claims', '{"sub":"journal_delete_alice","role":"authenticated"}', true);
select throws_ok(
  $$select public.finalize_journal_photo(
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '63000000-0000-4000-8000-000000000001',
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-images/53000000-0000-4000-8000-000000000001/63000000-0000-4000-8000-000000000001.jpg',
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-thumbnails/53000000-0000-4000-8000-000000000001/63000000-0000-4000-8000-000000000001.jpg',
    1200, 900, 400, 300, 'Stale offline upload', now() - interval '1 day')$$,
  '22023', 'journal_photo_was_deleted',
  'a stale offline finalizer cannot resurrect an uploader-deleted photo'
);
select is((select count(*) from public.family_journal_photos), 0::bigint,
  'failed resurrection does not recreate any Journal metadata');

select is((select was_published from public.deleted_family_journal_photos
  where photo_id = '63000000-0000-4000-8000-000000000001'), true,
  'deleting a finalized photo marks its tombstone as family-visible');
select throws_ok(
  $$select public.finalize_journal_photo(
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '63000000-0000-4000-8000-000000000099',
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-images/53000000-0000-4000-8000-000000000001/63000000-0000-4000-8000-000000000099.jpg',
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-thumbnails/53000000-0000-4000-8000-000000000001/63000000-0000-4000-8000-000000000099.jpg',
    1200, 900, 400, 300, 'Late canceled request', now())$$,
  '22023', 'journal_photo_was_deleted',
  'a timed-out self-upload cannot finalize after its pending cancellation'
);

select set_config('request.jwt.claims', '{"sub":"journal_delete_bob","role":"authenticated"}', true);
select is((select count(*) from public.deleted_family_journal_photos
  where photo_id = '63000000-0000-4000-8000-000000000099'), 0::bigint,
  'pending cancellations are not exposed to other family members’ caches');
select is(public.finalize_journal_photo(
  'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '63000000-0000-4000-8000-000000000099',
  'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-images/53000000-0000-4000-8000-000000000002/63000000-0000-4000-8000-000000000099.jpg',
  'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-thumbnails/53000000-0000-4000-8000-000000000002/63000000-0000-4000-8000-000000000099.jpg',
  1200, 900, 400, 300, 'A different uploader', now()),
  '63000000-0000-4000-8000-000000000099'::uuid,
  'another uploader’s same-ID photo is not blocked by someone else’s pending cancellation'
);
select is((select count(*) from public.family_journal_photos
  where id = '63000000-0000-4000-8000-000000000099'
    and uploader_id = public.current_app_user_id()), 1::bigint,
  'the other uploader’s own photo is finalized normally');
select set_config('request.jwt.claims', '{"sub":"journal_delete_alice","role":"authenticated"}', true);
select throws_ok(
  $$select public.delete_family_journal_photo('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '63000000-0000-4000-8000-000000000099')$$,
  '42501', 'journal_photo_uploader_required',
  'a private pending cancellation grants no authority over another uploader’s later photo'
);

-- Fill only private pending-cancellation metadata in this rolled-back test.
-- One earlier canceled upload already exists, making the total exactly 1,000.
reset role;
insert into public.deleted_family_journal_photos(photo_id, circle_id, uploader_id, was_published)
select ('64000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '53000000-0000-4000-8000-000000000001', false
from generate_series(1, 999) as fixture(n);
insert into public.family_journal_photos (
  id, circle_id, uploader_id, image_path, thumbnail_path,
  image_width, image_height, thumbnail_width, thumbnail_height, caption, captured_at
) values (
  '63000000-0000-4000-8000-000000000002', 'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '53000000-0000-4000-8000-000000000001',
  'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-images/53000000-0000-4000-8000-000000000001/63000000-0000-4000-8000-000000000002.jpg',
  'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/journal-thumbnails/53000000-0000-4000-8000-000000000001/63000000-0000-4000-8000-000000000002.jpg',
  1200, 900, 400, 300, 'Actual published photo remains removable', now()
);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"journal_delete_alice","role":"authenticated"}', true);
select is((select count(*) from public.deleted_family_journal_photos
  where uploader_id = public.current_app_user_id() and not was_published), 1000::bigint,
  'the fixture reaches the exact daily pending-cancellation allowance');
select throws_ok(
  $$select public.delete_family_journal_photo('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '63000000-0000-4000-8000-000000000100')$$,
  '54000', 'journal_photo_cancellation_limit_reached',
  'new arbitrary-ID cancellations cannot exceed the daily uploader allowance'
);
select is((select count(*) from public.deleted_family_journal_photos
  where photo_id = '63000000-0000-4000-8000-000000000100'), 0::bigint,
  'a quota-rejected cancellation does not write a marker');
select is(public.delete_family_journal_photo('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '64000000-0000-4000-8000-000000000001'),
  true, 'an existing pending cancellation remains idempotent at the cap');
select is(public.delete_family_journal_photo('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '63000000-0000-4000-8000-000000000001'),
  true, 'a completed published deletion remains retryable at the cap');
select is(public.delete_family_journal_photo('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '63000000-0000-4000-8000-000000000002'),
  true, 'actual uploader-owned photo deletion is never blocked by the pending cap');
select is((select was_published from public.deleted_family_journal_photos
  where photo_id = '63000000-0000-4000-8000-000000000002'), true,
  'a real deletion still broadcasts a family-visible marker at the cap');

select * from finish();
rollback;

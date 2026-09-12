begin;
create extension if not exists pgtap with schema extensions;
select plan(48);

insert into public.profiles(id, display_name) values
  ('54000000-0000-4000-8000-000000000001', 'Capsule Delete Alice'),
  ('54000000-0000-4000-8000-000000000002', 'Capsule Delete Bob'),
  ('54000000-0000-4000-8000-000000000003', 'Capsule Delete Outsider');
insert into public.profile_preferences(user_id, time_zone)
select id, 'UTC' from public.profiles where id in (
  '54000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000002', '54000000-0000-4000-8000-000000000003');
insert into public.app_identities(subject, user_id, provider) values
  ('capsule_delete_alice', '54000000-0000-4000-8000-000000000001', 'clerk'),
  ('capsule_delete_bob', '54000000-0000-4000-8000-000000000002', 'clerk'),
  ('capsule_delete_outsider', '54000000-0000-4000-8000-000000000003', 'clerk');
insert into public.circles(id, name, owner_id) values
  ('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Capsule Deletion A', '54000000-0000-4000-8000-000000000001'),
  ('fbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Capsule Deletion B', '54000000-0000-4000-8000-000000000003');
insert into public.circle_members(circle_id, user_id, role, status, approved_by, approved_at)
values ('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '54000000-0000-4000-8000-000000000002', 'member', 'approved', '54000000-0000-4000-8000-000000000001', now());

insert into public.family_capsules(id, circle_id, created_by, kind, title, week_start, opens_at, closes_at, item_count) values
  ('64000000-0000-4000-8000-000000000001', 'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '54000000-0000-4000-8000-000000000001', 'special', 'Opened', null, now() - interval '1 hour', now() - interval '1 hour', 2),
  ('64000000-0000-4000-8000-000000000002', 'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '54000000-0000-4000-8000-000000000001', 'special', 'Sealed', null, now() + interval '1 day', now() + interval '1 day', 2),
  ('64000000-0000-4000-8000-000000000003', 'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '54000000-0000-4000-8000-000000000001', 'weekly', 'This week', date_trunc('week', now() at time zone 'UTC')::date, date_trunc('week', now()) + interval '7 days', date_trunc('week', now()) + interval '7 days', 0);
insert into public.family_capsule_items(id, capsule_id, circle_id, uploader_id, image_path, thumbnail_path, image_width, image_height, thumbnail_width, thumbnail_height, caption)
select photo_id::uuid, capsule_id::uuid, 'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', uploader_id::uuid,
  'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/' || uploader_id || '/' || photo_id || '.jpg',
  'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-thumbnails/' || uploader_id || '/' || photo_id || '.jpg', 1200, 900, 400, 300, 'fixture'
from (values
  ('74000000-0000-4000-8000-000000000001', '64000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000001'),
  ('74000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000002'),
  ('74000000-0000-4000-8000-000000000003', '64000000-0000-4000-8000-000000000002', '54000000-0000-4000-8000-000000000001'),
  ('74000000-0000-4000-8000-000000000004', '64000000-0000-4000-8000-000000000002', '54000000-0000-4000-8000-000000000001')
) as fixture(photo_id, capsule_id, uploader_id);
insert into storage.objects(id, bucket_id, name)
select extensions.gen_random_uuid(), 'family-media', image_path from public.family_capsule_items where circle_id = 'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
union all select extensions.gen_random_uuid(), 'family-media', thumbnail_path from public.family_capsule_items where circle_id = 'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
insert into storage.objects(id, bucket_id, name)
select extensions.gen_random_uuid(), 'family-media', 'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/' || folder || '/' || uploader_id || '/' || photo_id || '.jpg'
from (values
  ('54000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000099'),
  ('54000000-0000-4000-8000-000000000002', '74000000-0000-4000-8000-000000000099'),
  ('54000000-0000-4000-8000-000000000002', '74000000-0000-4000-8000-000000000100')
) as uploads(uploader_id, photo_id) cross join (values ('capsule-images'), ('capsule-thumbnails')) as folders(folder);

select ok(not has_function_privilege('anon', 'public.delete_family_capsule(uuid,uuid)', 'execute') and not has_function_privilege('anon', 'public.delete_family_capsule_photo(uuid,uuid,uuid)', 'execute'), 'anonymous deletion is not granted');
select ok(not has_table_privilege('authenticated', 'public.deleted_family_capsules', 'insert,update,delete') and not has_table_privilege('authenticated', 'public.deleted_family_capsule_photos', 'insert,update,delete'), 'clients cannot forge deletion markers');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"capsule_delete_bob","role":"authenticated"}', true);
select throws_ok($$select public.delete_family_capsule_photo('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000001')$$, '42501','capsule_photo_uploader_required','family membership does not permit deleting another uploader’s photo');
select throws_ok($$select public.delete_family_capsule('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000001')$$, '42501','capsule_creator_required','family membership does not permit deleting another creator’s Capsule');
select set_config('request.jwt.claims', '{"sub":"capsule_delete_outsider","role":"authenticated"}', true);
select throws_ok($$select public.delete_family_capsule('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000001')$$, '42501','approved_circle_membership_required','outsider cannot delete a Capsule');
select throws_ok($$select public.delete_family_capsule_photo('fbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','64000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000001')$$, '42501','capsule_photo_uploader_required','substituting an approved foreign circle cannot bypass photo ownership');
select set_config('request.jwt.claims', '{"sub":"capsule_delete_alice","role":"authenticated"}', true);
select is(public.delete_family_capsule_photo('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000001'), true, 'uploader may remove their own opened photo');
select is((select item_count from public.family_capsules where id='64000000-0000-4000-8000-000000000001'), 1, 'photo deletion decrements shared count');
select is(public.delete_family_capsule_photo('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000001'), true, 'photo deletion retry is idempotent');
select is((select item_count from public.family_capsules where id='64000000-0000-4000-8000-000000000001'), 1, 'photo deletion retry does not decrement twice');
select is(public.delete_family_capsule_photo('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000003'), true, 'uploader may remove their own sealed contribution');
select throws_ok($$select public.finalize_capsule_photo('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000003','faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/54000000-0000-4000-8000-000000000001/74000000-0000-4000-8000-000000000003.jpg','faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-thumbnails/54000000-0000-4000-8000-000000000001/74000000-0000-4000-8000-000000000003.jpg',1200,900,400,300,'stale',now())$$, '22023','capsule_photo_was_deleted','offline finalizer cannot restore an intentionally removed contribution');
select is(public.delete_family_capsule_photo('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000099'), true, 'a timed-out pending upload may be cancelled');
select throws_ok($$select public.finalize_capsule_photo('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000099','faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/54000000-0000-4000-8000-000000000001/74000000-0000-4000-8000-000000000099.jpg','faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-thumbnails/54000000-0000-4000-8000-000000000001/74000000-0000-4000-8000-000000000099.jpg',1200,900,400,300,'late',now())$$, '22023','capsule_photo_was_deleted','pending cancellation stops a late self-finalizer');
select set_config('request.jwt.claims', '{"sub":"capsule_delete_bob","role":"authenticated"}', true);
select is((select count(*) from public.deleted_family_capsule_photos), 1::bigint, 'family sees opened photo removal but not sealed or private pending markers');
select is(public.finalize_capsule_photo('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000099','faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/54000000-0000-4000-8000-000000000002/74000000-0000-4000-8000-000000000099.jpg','faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-thumbnails/54000000-0000-4000-8000-000000000002/74000000-0000-4000-8000-000000000099.jpg',1200,900,400,300,'other author',now()), '74000000-0000-4000-8000-000000000099'::uuid, 'a private cancellation cannot poison a different uploader’s same-ID contribution');
select set_config('request.jwt.claims', '{"sub":"capsule_delete_alice","role":"authenticated"}', true);
select throws_ok($$select public.delete_family_capsule_photo('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000099')$$, '42501','capsule_photo_uploader_required','pending marker is not authority over another uploader’s finalized photo');

select is(public.delete_family_capsule('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000099'), true, 'creator may cancel a never-finalized local special draft');
select throws_ok($$select public.create_special_capsule('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Cancelled draft',now()+interval '1 day','64000000-0000-4000-8000-000000000099')$$, '22023','capsule_was_deleted','late draft creation cannot resurrect a creator cancellation');
select set_config('request.jwt.claims', '{"sub":"capsule_delete_bob","role":"authenticated"}', true);
select is((select count(*) from public.deleted_family_capsules), 0::bigint, 'private draft cancellation does not leak to another family member');
select is(public.create_special_capsule('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Bob’s own draft',now()+interval '1 day','64000000-0000-4000-8000-000000000099'), '64000000-0000-4000-8000-000000000099'::uuid, 'another creator is not blocked by someone else’s draft cancellation');
select set_config('request.jwt.claims', '{"sub":"capsule_delete_alice","role":"authenticated"}', true);
select throws_ok($$select public.delete_family_capsule('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000099')$$, '42501','capsule_creator_required','family owner cannot delete Bob’s Capsule using a private marker');

select is(public.delete_family_capsule('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000001'), true, 'original creator may remove their opened Capsule');
select is(public.delete_family_capsule('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000001'), true, 'Capsule removal retry is idempotent');
select is((select count(*) from public.family_capsules where id='64000000-0000-4000-8000-000000000001'), 0::bigint, 'soft-deleted parent disappears from normal family reads');
select set_config('request.jwt.claims', '{"sub":"capsule_delete_bob","role":"authenticated"}', true);
select is((select count(*) from public.family_capsule_items where id='74000000-0000-4000-8000-000000000002'), 0::bigint, 'even an uploader cannot read items contained in a deleted Capsule');
select is((select count(*) from storage.objects where bucket_id='family-media' and name='faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/54000000-0000-4000-8000-000000000002/74000000-0000-4000-8000-000000000002.jpg'), 0::bigint, 'uploader Storage bypass cannot mint new signed URLs for a deleted parent');
select throws_ok($$select * from public.list_capsule_photo_reactions('74000000-0000-4000-8000-000000000002')$$, '42501','capsule_photo_not_available','reaction-count definer RPC does not reveal deleted parent content');
select throws_ok($$select * from public.set_capsule_photo_reaction('74000000-0000-4000-8000-000000000002','❤️')$$, '42501','capsule_photo_not_available','reaction mutation rejects a deleted parent');
select is((select count(*) from public.deleted_family_capsules), 1::bigint, 'published parent removal is shared with approved relatives');
select set_config('request.jwt.claims', '{"sub":"capsule_delete_outsider","role":"authenticated"}', true);
select is((select count(*) from public.deleted_family_capsules), 0::bigint, 'parent removals are private to the family');
select is(public.capsule_media_has_no_deleted_parent('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/54000000-0000-4000-8000-000000000002/74000000-0000-4000-8000-000000000002.jpg'), false, 'direct storage-guard calls cannot expose a foreign deleted path');
select is(public.capsule_media_has_no_deleted_parent('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/54000000-0000-4000-8000-000000000002/74000000-0000-4000-8000-000000000199.jpg'), false, 'foreign unknown paths return the same denial as foreign deleted paths');
select is(public.capsule_media_has_no_deleted_parent('malformed/path'), false, 'malformed circle paths are safely denied by the storage guard');

-- Fill pending cancellation caps without affecting real deletion or retries.
reset role;
insert into public.deleted_family_capsule_photos(circle_id,capsule_id,photo_id,uploader_id)
select 'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000002',('84000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'54000000-0000-4000-8000-000000000001' from generate_series(1,999) as fixture(n);
insert into public.deleted_family_capsules(circle_id,capsule_id,creator_id)
select 'faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',('85000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'54000000-0000-4000-8000-000000000001' from generate_series(1,999) as fixture(n);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"capsule_delete_alice","role":"authenticated"}', true);
select throws_ok($$select public.delete_family_capsule_photo('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000101')$$, '54000','capsule_photo_cancellation_limit_reached','new pending photo cancellations have a bounded daily quota');
select is((select count(*) from public.deleted_family_capsule_photos where photo_id='74000000-0000-4000-8000-000000000101'), 0::bigint, 'quota failure does not write a pending photo marker');
select is(public.delete_family_capsule_photo('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000002','84000000-0000-4000-8000-000000000001'), true, 'existing pending photo cancellation is retryable at quota');
select is(public.delete_family_capsule_photo('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000003'), true, 'actual photo deletion stays idempotent at quota');
select is(public.delete_family_capsule_photo('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000004'), true, 'a real owned photo remains removable after pending-cancellation quota');
select throws_ok($$select public.delete_family_capsule('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000101')$$, '54000','capsule_cancellation_limit_reached','new draft cancellations have a bounded daily quota');
select is((select count(*) from public.deleted_family_capsules where capsule_id='64000000-0000-4000-8000-000000000101'), 0::bigint, 'quota failure does not write a pending Capsule marker');
select is(public.delete_family_capsule('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','85000000-0000-4000-8000-000000000001'), true, 'existing pending draft cancellation is retryable at quota');
select is(public.delete_family_capsule('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000002'), true, 'real parent deletion is not blocked by speculative-cancellation quota');
select set_config('request.jwt.claims', '{"sub":"capsule_delete_bob","role":"authenticated"}', true);
select throws_ok($$select public.finalize_capsule_photo('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000100','faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-images/54000000-0000-4000-8000-000000000002/74000000-0000-4000-8000-000000000100.jpg','faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/capsule-thumbnails/54000000-0000-4000-8000-000000000002/74000000-0000-4000-8000-000000000100.jpg',1200,900,400,300,'late after parent removal',now())$$, '22023','capsule_was_deleted','late upload cannot add to a deleted sealed parent');
select set_config('request.jwt.claims', '{"sub":"capsule_delete_alice","role":"authenticated"}', true);
select is(public.delete_family_capsule('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','64000000-0000-4000-8000-000000000003'), true, 'creator may remove the current weekly Capsule');
select is((select capsule_id from public.deleted_family_capsules where capsule_id='64000000-0000-4000-8000-000000000003' and week_start=date_trunc('week',now() at time zone 'UTC')::date), '64000000-0000-4000-8000-000000000003'::uuid, 'weekly deletion marker carries the verified offline week key');
select is((public.get_or_create_weekly_capsule('faaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).id, '64000000-0000-4000-8000-000000000003'::uuid, 'weekly ensure returns the same shell instead of recreating deleted content');
select is((select count(*) from public.family_capsules where kind='weekly'), 0::bigint, 'ensuring the weekly pointer does not expose its deleted shell');

select * from finish();
rollback;

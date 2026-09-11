begin;
create extension if not exists pgtap with schema extensions;
select plan(20);

insert into public.profiles (id, display_name) values
  ('52000000-0000-4000-8000-000000000001', 'Reaction Alice'),
  ('52000000-0000-4000-8000-000000000002', 'Reaction Bob'),
  ('52000000-0000-4000-8000-000000000003', 'Reaction Mallory');
insert into public.app_identities (subject, user_id, provider) values
  ('reaction_alice', '52000000-0000-4000-8000-000000000001', 'clerk'),
  ('reaction_bob', '52000000-0000-4000-8000-000000000002', 'clerk'),
  ('reaction_mallory', '52000000-0000-4000-8000-000000000003', 'clerk');
insert into public.circles (id, name, owner_id) values
  ('ceaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Reaction Family A', '52000000-0000-4000-8000-000000000001'),
  ('cebbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Reaction Family B', '52000000-0000-4000-8000-000000000003');
insert into public.circle_members (circle_id, user_id, role, status, approved_by, approved_at)
values ('ceaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '52000000-0000-4000-8000-000000000002',
  'member', 'approved', '52000000-0000-4000-8000-000000000001', now());
insert into public.family_capsules (id, circle_id, created_by, kind, title, opens_at, closes_at) values
  ('62000000-0000-4000-8000-000000000001', 'ceaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '52000000-0000-4000-8000-000000000001', 'special', 'Unlocked', now(), now()),
  ('62000000-0000-4000-8000-000000000002', 'ceaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '52000000-0000-4000-8000-000000000001', 'special', 'Sealed', now() + interval '1 day', now() + interval '1 day'),
  ('62000000-0000-4000-8000-000000000003', 'cebbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '52000000-0000-4000-8000-000000000003', 'special', 'Other family', now(), now());
insert into public.family_capsule_items (
  id, capsule_id, circle_id, uploader_id, image_path, thumbnail_path,
  image_width, image_height, thumbnail_width, thumbnail_height
)
select item.id, capsule.id, capsule.circle_id, capsule.created_by,
  item.id::text || '.jpg', item.id::text || '-thumb.jpg', 800, 600, 400, 300
from (values
  ('72000000-0000-4000-8000-000000000001'::uuid, '62000000-0000-4000-8000-000000000001'::uuid),
  ('72000000-0000-4000-8000-000000000002'::uuid, '62000000-0000-4000-8000-000000000002'::uuid),
  ('72000000-0000-4000-8000-000000000003'::uuid, '62000000-0000-4000-8000-000000000003'::uuid)
) as item(id, capsule_id)
join public.family_capsules as capsule on capsule.id = item.capsule_id;

select has_table('public', 'family_capsule_photo_reactions', 'Shared reactions table exists');
select ok(
  not has_table_privilege('authenticated', 'public.family_capsule_photo_reactions', 'INSERT')
  and not has_table_privilege('authenticated', 'public.family_capsule_photo_reactions', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.family_capsule_photo_reactions', 'DELETE'),
  'Direct writes cannot spoof a reaction author'
);
select ok(
  not has_function_privilege('anon', 'public.list_capsule_photo_reactions(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.set_capsule_photo_reaction(uuid,text)', 'EXECUTE'),
  'Anonymous callers cannot read or set reactions'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"reaction_alice","role":"authenticated"}', true);

select is((select count(*) from public.list_capsule_photo_reactions('72000000-0000-4000-8000-000000000001')),
  0::bigint, 'A capsule is reactable at its exact unlock time');
select results_eq(
  $$select * from public.set_capsule_photo_reaction('72000000-0000-4000-8000-000000000001', '❤️')$$,
  $$values ('❤️'::text, 1::integer, true)$$,
  'The server assigns the first reaction to the signed-in member'
);
select results_eq(
  $$select * from public.set_capsule_photo_reaction('72000000-0000-4000-8000-000000000001', '❤️')$$,
  $$values ('❤️'::text, 1::integer, true)$$,
  'Retrying the same reaction is idempotent'
);
select results_eq(
  $$select * from public.set_capsule_photo_reaction('72000000-0000-4000-8000-000000000001', '👏')$$,
  $$values ('👏'::text, 1::integer, true)$$,
  'Choosing a new emoji replaces the existing reaction'
);

select set_config('request.jwt.claims', '{"sub":"reaction_bob","role":"authenticated"}', true);
select results_eq(
  $$select * from public.set_capsule_photo_reaction('72000000-0000-4000-8000-000000000001', '👏')$$,
  $$values ('👏'::text, 2::integer, true)$$,
  'Family members contribute to a shared count'
);

select set_config('request.jwt.claims', '{"sub":"reaction_alice","role":"authenticated"}', true);
select results_eq(
  $$select * from public.set_capsule_photo_reaction('72000000-0000-4000-8000-000000000001', null)$$,
  $$values ('👏'::text, 1::integer, false)$$,
  'Clearing a reaction removes only the current member selection'
);
select throws_ok(
  $$select * from public.set_capsule_photo_reaction('72000000-0000-4000-8000-000000000001', '🔥')$$,
  '22023', 'invalid_photo_reaction', 'Unsupported emoji is rejected'
);
select throws_ok(
  $$select * from public.set_capsule_photo_reaction('72000000-0000-4000-8000-000000000002', '❤️')$$,
  '42501', 'capsule_photo_not_available', 'Even the uploader cannot react before unlock'
);
select throws_ok(
  $$select * from public.list_capsule_photo_reactions('72000000-0000-4000-8000-000000000002')$$,
  '42501', 'capsule_photo_not_available', 'Sealed capsule reactions are unreadable'
);
select throws_ok(
  $$select * from public.set_capsule_photo_reaction('72000000-0000-4000-8000-000000000003', '❤️')$$,
  '42501', 'capsule_photo_not_available', 'Another family cannot receive a reaction'
);
select throws_ok(
  $$select * from public.list_capsule_photo_reactions('72000000-0000-4000-8000-000000000003')$$,
  '42501', 'capsule_photo_not_available', 'Another family cannot be inspected through the RPC'
);
select throws_ok(
  $$select * from public.list_capsule_photo_reactions('72000000-0000-4000-8000-000000000099')$$,
  '42501', 'capsule_photo_not_available', 'Unknown photos use the same non-disclosing error'
);

select set_config('request.jwt.claims', '{"sub":"reaction_mallory","role":"authenticated"}', true);
select is((select count(*) from public.family_capsule_photo_reactions), 0::bigint,
  'RLS also hides other-family reactions from direct reads');

reset role;
update public.circle_members set status = 'removed', removed_at = now()
where circle_id = 'ceaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  and user_id = '52000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"reaction_bob","role":"authenticated"}', true);
select throws_ok(
  $$select * from public.list_capsule_photo_reactions('72000000-0000-4000-8000-000000000001')$$,
  '42501', 'capsule_photo_not_available', 'Removed members lose access immediately'
);
select is((select count(*) from public.family_capsule_photo_reactions), 0::bigint,
  'Removed members cannot read even their own reaction row');
select set_config('request.jwt.claims', '{"sub":"reaction_unknown","role":"authenticated"}', true);
select throws_ok(
  $$select * from public.set_capsule_photo_reaction('72000000-0000-4000-8000-000000000001', '❤️')$$,
  '42501', 'authentication_required', 'A bootstrapped app identity is required'
);

reset role;
delete from public.family_capsule_items where id = '72000000-0000-4000-8000-000000000001';
select is((select count(*) from public.family_capsule_photo_reactions), 0::bigint,
  'Deleting a photo removes both its reactions and cleared selections');
select * from finish();
rollback;

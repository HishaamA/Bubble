begin;

create extension if not exists pgtap with schema extensions;
select plan(7);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"user_avatar_alice","role":"authenticated"}', true);
select set_config('test.avatar_alice_id', (
  select user_id::text from public.bootstrap_current_user('Alice', 'alice-avatar@example.test')
), true);
select set_config('test.avatar_family', (
  select row_to_json(created)::text
  from public.create_family_with_share_code('Avatar test family') as created
), true);

select lives_ok(
  $$update public.profiles set avatar_path = 'https://img.clerk.com/alice.jpg'
    where id = public.current_app_user_id()$$,
  'a verified Clerk user can save their own profile image'
);
select is(
  (select avatar_path from public.profiles where id = public.current_app_user_id()),
  'https://img.clerk.com/alice.jpg',
  'the saved image is available to the profile owner'
);

select set_config('request.jwt.claims', '{"sub":"user_avatar_bob","role":"authenticated"}', true);
select user_id from public.bootstrap_current_user('Bob', 'bob-avatar@example.test');
select family_id from public.join_family_by_share_code(
  current_setting('test.avatar_family')::jsonb ->> 'share_code'
);
select is(
  (select avatar_path from public.profiles where id = current_setting('test.avatar_alice_id')::uuid),
  'https://img.clerk.com/alice.jpg',
  'another approved family member can see the uploader profile image'
);
with changed as (
  update public.profiles set avatar_path = 'https://img.clerk.com/forged.jpg'
  where id = current_setting('test.avatar_alice_id')::uuid returning id
)
select is(count(*), 0::bigint, 'a family member cannot overwrite another uploader’s image') from changed;

select set_config('request.jwt.claims', '{"sub":"user_avatar_outsider","role":"authenticated"}', true);
select user_id from public.bootstrap_current_user('Outsider', 'outsider-avatar@example.test');
select is(
  (select count(*) from public.profiles where id = current_setting('test.avatar_alice_id')::uuid),
  0::bigint,
  'an unrelated account cannot read private family profile metadata'
);

select set_config('request.jwt.claims', '{"sub":"user_avatar_alice","role":"authenticated"}', true);
select lives_ok(
  $$update public.profiles set avatar_path = null where id = public.current_app_user_id()$$,
  'the uploader can remove their own profile image'
);
select is(
  (select avatar_path from public.profiles where id = public.current_app_user_id()),
  null::text,
  'removing an avatar restores the initials fallback for the family'
);

select * from finish();
rollback;

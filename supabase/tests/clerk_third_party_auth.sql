begin;

create extension if not exists pgtap with schema extensions;
select plan(31);

create or replace function pg_temp.create_family_result(p_name text)
returns text
language plpgsql
as $$
begin
  insert into public.circles (name, owner_id)
  values (p_name, public.current_app_user_id());
  return 'ok';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.request_join_result(p_invite_code text)
returns text
language plpgsql
as $$
begin
  perform public.request_circle_join(p_invite_code);
  return 'ok';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.decide_join_result(
  p_request_id uuid,
  p_decision text
)
returns text
language plpgsql
as $$
begin
  perform public.decide_join_request(p_request_id, p_decision);
  return 'ok';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"user_clerk_alice","role":"authenticated"}',
  true
);

select set_config(
  'test.alice_id',
  (
    select user_id::text
    from public.bootstrap_current_user('Alice', 'alice@example.test')
  ),
  true
);

select matches(
  current_setting('test.alice_id'),
  '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  'a text Clerk subject bootstraps a stable internal UUID'
);

select is(
  (
    select onboarding_completed
    from public.bootstrap_current_user('Alice', 'alice@example.test')
  ),
  false,
  'a new Clerk profile starts with an incomplete tutorial'
);

select ok(
  public.complete_current_user_onboarding() is not null,
  'tutorial completion is persisted by an authenticated RPC'
);

select is(
  (
    select onboarding_completed
    from public.bootstrap_current_user('Alice', 'alice@example.test')
  ),
  true,
  'tutorial completion survives profile bootstrap and login refresh'
);

with inserted as (
  insert into public.circles (name, owner_id)
  values ('Alice family', public.current_app_user_id())
  returning id
)
select set_config('test.circle_id', id::text, true) from inserted;

select is(
  (
    select owner_id::text
    from public.circles
    where id = current_setting('test.circle_id')::uuid
  ),
  current_setting('test.alice_id'),
  'family ownership uses the internal identity resolved from Clerk sub'
);

select is(
  (
    select count(*)
    from public.circle_members
    where circle_id = current_setting('test.circle_id')::uuid
      and role = 'owner'
      and status = 'approved'
  ),
  1::bigint,
  'creating a family atomically creates its approved owner membership'
);

select set_config(
  'test.invite_code',
  (
    select invite_code
    from public.create_circle_invite(
      current_setting('test.circle_id')::uuid,
      interval '1 day',
      1
    )
  ),
  true
);

select set_config(
  'request.jwt.claims',
  '{"sub":"user_clerk_bob","role":"authenticated"}',
  true
);
select set_config(
  'test.bob_id',
  (
    select user_id::text
    from public.bootstrap_current_user('Bob', 'bob@example.test')
  ),
  true
);

select isnt(
  current_setting('test.bob_id'),
  current_setting('test.alice_id'),
  'different Clerk subjects never share an internal user'
);

select is(
  (select count(*) from public.circles),
  0::bigint,
  'an unapproved Clerk user cannot read another family'
);

select set_config(
  'test.join_request_id',
  public.request_circle_join(current_setting('test.invite_code'))::text,
  true
);

select is(
  (
    select count(*)
    from public.join_requests
    where id = current_setting('test.join_request_id')::uuid
      and requester_id = current_setting('test.bob_id')::uuid
      and status = 'pending'
  ),
  1::bigint,
  'joining by code creates a durable pending request for the Clerk identity'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"user_clerk_mallory","role":"authenticated"}',
  true
);
select set_config(
  'test.mallory_id',
  (
    select user_id::text
    from public.bootstrap_current_user('Mallory', 'mallory@example.test')
  ),
  true
);

with inserted as (
  insert into public.circles (name, owner_id)
  values ('Mallory family', public.current_app_user_id())
  returning id
)
select set_config('test.mallory_circle_id', id::text, true) from inserted;

select set_config(
  'test.mallory_invite_code',
  (
    select invite_code
    from public.create_circle_invite(
      current_setting('test.mallory_circle_id')::uuid,
      interval '1 day',
      2
    )
  ),
  true
);

select set_config(
  'request.jwt.claims',
  '{"sub":"user_clerk_bob","role":"authenticated"}',
  true
);
select set_config(
  'test.bob_second_request_id',
  public.request_circle_join(
    current_setting('test.mallory_invite_code')
  )::text,
  true
);

select is(
  (
    select count(*)
    from public.join_requests
    where requester_id = current_setting('test.bob_id')::uuid
      and status = 'pending'
  ),
  2::bigint,
  'multiple pending requests may coexist before a user joins one family'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"user_clerk_alice","role":"authenticated"}',
  true
);
select public.decide_join_request(
  current_setting('test.join_request_id')::uuid,
  'approved'
);

select is(
  (
    select count(*)
    from public.circle_members
    where user_id = current_setting('test.bob_id')::uuid
      and status = 'approved'
  ),
  1::bigint,
  'owner approval persists the Clerk-backed membership'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"user_clerk_mallory","role":"authenticated"}',
  true
);

select is(
  pg_temp.decide_join_result(
    current_setting('test.bob_second_request_id')::uuid,
    'approved'
  ),
  'P0001:already_a_member',
  'a second family owner cannot approve an already joined user'
);

select is(
  (
    select status
    from public.join_requests
    where id = current_setting('test.bob_second_request_id')::uuid
  ),
  'pending',
  'a rejected second approval leaves the existing request pending'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"user_clerk_bob","role":"authenticated"}',
  true
);

select is(
  (select count(*) from public.circles),
  1::bigint,
  'an approved Clerk member can read their family after a new request'
);

select is(
  pg_temp.request_join_result(
    current_setting('test.mallory_invite_code')
  ),
  'P0001:already_a_member',
  'an approved user cannot submit or refresh a join request elsewhere'
);

select is(
  pg_temp.create_family_result('Bob second family'),
  'P0001:already_a_member',
  'an approved user cannot create a second family'
);

update public.profile_preferences
set notifications_enabled = false,
    quiet_hours_start = time '22:00',
    quiet_hours_end = time '08:00'
where user_id = public.current_app_user_id();

select is(
  (
    select notifications_enabled::text
      || ':' || quiet_hours_start::text
      || ':' || quiet_hours_end::text
    from public.profile_preferences
    where user_id = public.current_app_user_id()
  ),
  'false:22:00:00:08:00:00',
  'a Clerk user can persist private notification and quiet-hour preferences'
);

select set_config(
  'test.event_id',
  public.create_family_event(
    current_setting('test.circle_id')::uuid,
    'Future picnic',
    '2099-09-01T12:00:00Z'::timestamptz,
    'Family park',
    null,
    null
  )::text,
  true
);

select is(
  (
    select created_by::text
    from public.events
    where id = current_setting('test.event_id')::uuid
  ),
  current_setting('test.bob_id'),
  'events persist with the Clerk-backed creator identity'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"user_clerk_alice","role":"authenticated"}',
  true
);

select is(
  (
    select count(*)
    from public.profile_preferences
    where user_id = current_setting('test.bob_id')::uuid
  ),
  0::bigint,
  'another family member cannot read private preference rows'
);

select is(
  (
    select count(*)
    from public.events
    where id = current_setting('test.event_id')::uuid
  ),
  1::bigint,
  'family events persist across users and login sessions'
);

select is(
  (
    select count(*)
    from public.profiles
    where id = current_setting('test.bob_id')::uuid
  ),
  1::bigint,
  'approved members can read shared public display profiles'
);

reset role;

select isnt(
  has_table_privilege('authenticated', 'public.app_identities', 'select'),
  true,
  'authenticated clients cannot enumerate JWT subject mappings'
);

select isnt(
  has_table_privilege('authenticated', 'public.profile_private', 'select'),
  true,
  'shared-circle profile reads cannot expose private email rows'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"user_clerk_mallory","role":"authenticated"}',
  true
);
select public.bootstrap_current_user('Mallory', 'mallory@example.test');

select is(
  (
    select count(*)
    from public.profiles
    where id = current_setting('test.alice_id')::uuid
  ),
  0::bigint,
  'a Clerk user outside the family cannot read another profile'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"user_clerk_bob","role":"authenticated"}',
  true
);

select is(
  (
    select user_id::text
    from public.bootstrap_current_user('Bob', 'bob@example.test')
  ),
  current_setting('test.bob_id'),
  'logging out and back in resolves the same persistent database identity'
);

reset role;

select is(
  (
    select count(*)
    from pg_catalog.pg_constraint as constraint_record
    join (values
      ('profile_preferences_user_id_fkey', 'c'),
      ('circles_owner_id_fkey', 'r'),
      ('circle_members_user_id_fkey', 'c'),
      ('circle_members_approved_by_fkey', 'n'),
      ('circle_invites_created_by_fkey', 'n'),
      ('join_requests_requester_id_fkey', 'c'),
      ('join_requests_decided_by_fkey', 'n'),
      ('family_moments_uploader_id_fkey', 'r'),
      ('events_created_by_fkey', 'r'),
      ('event_guestbook_entries_author_id_fkey', 'r'),
      ('event_reminders_user_id_fkey', 'c'),
      ('notifications_recipient_id_fkey', 'c')
    ) as expected_constraint(constraint_name, delete_action)
      on expected_constraint.constraint_name = constraint_record.conname
      and expected_constraint.delete_action = constraint_record.confdeltype::text
    where constraint_record.confrelid = 'public.profiles'::regclass
  ),
  12::bigint,
  'all former auth.users relationships retain app-owned foreign keys and delete semantics'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_proc as proc
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and case
        when proc.prokind in ('f', 'p') then pg_catalog.strpos(
          pg_catalog.pg_get_functiondef(proc.oid),
          'auth.uid()'
        ) > 0
        else false
      end
  ),
  0::bigint,
  'application functions no longer cast Clerk subjects through auth.uid()'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_policies
    where schemaname in ('public', 'storage')
      and pg_catalog.strpos(
        coalesce(qual, '') || coalesce(with_check, ''),
        'auth.uid()'
      ) > 0
  ),
  0::bigint,
  'application policies no longer cast Clerk subjects through auth.uid()'
);

select is(
  (
    select count(*)
    from pg_catalog.pg_index as index_record
    join pg_catalog.pg_class as index_relation
      on index_relation.oid = index_record.indexrelid
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = index_relation.relnamespace
    where namespace.nspname = 'public'
      and index_relation.relname = 'circle_members_one_approved_family_per_user'
      and index_record.indisunique
      and index_record.indpred is not null
  ),
  1::bigint,
  'a partial unique index enforces one approved family per user'
);

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
values (
  '00000000-0000-0000-0000-000000000000',
  '90000000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'legacy-delete@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{"display_name":"Legacy delete"}'::jsonb,
  now(),
  now()
);

select is(
  (
    select count(*)
    from public.profiles
    where id = '90000000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'legacy Supabase Auth creation still provisions an app profile'
);

delete from auth.users
where id = '90000000-0000-4000-8000-000000000001';

select is(
  (
    select count(*)
    from public.profiles
    where id = '90000000-0000-4000-8000-000000000001'
  ),
  0::bigint,
  'legacy Supabase Auth deletion removes its mapped app profile'
);

select * from finish();
rollback;

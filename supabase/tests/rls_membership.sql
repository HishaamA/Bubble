begin;

create extension if not exists pgtap with schema extensions;
select plan(42);

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
    '10000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'alice@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Alice"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'bob@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Bob"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'mallory@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Mallory"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-8000-000000000004',
    'authenticated',
    'authenticated',
    'dave@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Dave"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-4000-8000-000000000005',
    'authenticated',
    'authenticated',
    'eve@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Eve"}'::jsonb,
    now(),
    now()
  );

insert into public.circles (id, name, owner_id)
values
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Family A',
    '10000000-0000-4000-8000-000000000001'
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Family B',
    '10000000-0000-4000-8000-000000000003'
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
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000002',
    'member',
    'approved',
    '10000000-0000-4000-8000-000000000001',
    now(),
    null
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000005',
    'member',
    'removed',
    '10000000-0000-4000-8000-000000000001',
    now() - interval '1 day',
    now()
  );

insert into public.circle_invites (
  id,
  circle_id,
  created_by,
  code_hash,
  expires_at,
  max_uses,
  use_count,
  revoked_at,
  created_at
)
values
  (
    'aaaaaaaa-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000001',
    repeat('a', 64),
    now() + interval '1 day',
    2,
    0,
    null,
    now()
  ),
  (
    'aaaaaaaa-0000-4000-8000-000000000010',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000001',
    pg_catalog.encode(
      extensions.digest('ks1_' || repeat('b', 64), 'sha256'),
      'hex'
    ),
    now() - interval '1 day',
    1,
    0,
    null,
    now() - interval '2 days'
  ),
  (
    'aaaaaaaa-0000-4000-8000-000000000011',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000001',
    pg_catalog.encode(
      extensions.digest('ks1_' || repeat('c', 64), 'sha256'),
      'hex'
    ),
    now() + interval '1 day',
    1,
    0,
    now(),
    now()
  ),
  (
    'aaaaaaaa-0000-4000-8000-000000000012',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000001',
    pg_catalog.encode(
      extensions.digest('ks1_' || repeat('d', 64), 'sha256'),
      'hex'
    ),
    now() + interval '1 day',
    1,
    1,
    null,
    now()
  );

insert into public.join_requests (
  id,
  circle_id,
  requester_id,
  invite_id
)
values (
  'aaaaaaaa-0000-4000-8000-000000000002',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000004',
  'aaaaaaaa-0000-4000-8000-000000000001'
);

insert into storage.objects (id, bucket_id, name)
values (
  'aaaaaaaa-0000-4000-8000-000000000003',
  'family-media',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/panoramas/10000000-0000-4000-8000-000000000001/alice.jpg'
);

create or replace function pg_temp.can_insert_family_media(p_name text)
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

create or replace function pg_temp.invite_request_result(p_invite_code text)
returns text
language plpgsql
as $$
begin
  perform public.request_circle_join(p_invite_code);
  return 'ok';
exception
  when others then
    return sqlstate;
end;
$$;

create or replace function pg_temp.invite_admin_result(p_operation text)
returns text
language plpgsql
as $$
begin
  case p_operation
    when 'create' then
      perform 1
      from public.create_circle_invite(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        interval '1 day',
        1
      );
    when 'revoke' then
      perform public.revoke_circle_invite(
        'aaaaaaaa-0000-4000-8000-000000000001'
      );
    when 'decide' then
      perform public.decide_join_request(
        'aaaaaaaa-0000-4000-8000-000000000002',
        'approved'
      );
    when 'remove' then
      perform public.remove_circle_member(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '10000000-0000-4000-8000-000000000002'
      );
    when 'transfer' then
      perform public.transfer_circle_ownership(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '10000000-0000-4000-8000-000000000002'
      );
    else
      raise exception 'unknown test operation';
  end case;

  return 'ok';
exception
  when others then
    return sqlstate;
end;
$$;

select is(
  (
    select bool_and(
      has_function_privilege('authenticated', signature, 'execute')
    )
    from unnest(array[
      'public.create_circle_invite(uuid,interval,integer)',
      'public.revoke_circle_invite(uuid)',
      'public.request_circle_join(text)',
      'public.decide_join_request(uuid,text)',
      'public.cancel_join_request(uuid)',
      'public.remove_circle_member(uuid,uuid)',
      'public.transfer_circle_ownership(uuid,uuid)'
    ]) as rpc(signature)
  ),
  true,
  'authenticated users can execute the intentionally exposed invite RPCs'
);

select is(
  (
    select bool_and(
      not has_function_privilege('anon', signature, 'execute')
    )
    from unnest(array[
      'public.create_circle_invite(uuid,interval,integer)',
      'public.revoke_circle_invite(uuid)',
      'public.request_circle_join(text)',
      'public.decide_join_request(uuid,text)',
      'public.cancel_join_request(uuid)',
      'public.remove_circle_member(uuid,uuid)',
      'public.transfer_circle_ownership(uuid,uuid)'
    ]) as rpc(signature)
  ),
  true,
  'anonymous users cannot execute invite or membership RPCs'
);

select is(
  not has_any_column_privilege(
    'authenticated',
    'public.circle_invites',
    'insert'
  )
  and not has_any_column_privilege(
    'authenticated',
    'public.circle_invites',
    'update'
  )
  and not has_table_privilege(
    'authenticated',
    'public.circle_invites',
    'delete'
  ),
  true,
  'authenticated users cannot mutate invite records directly'
);

select is(
  has_column_privilege(
    'authenticated',
    'public.circle_invites',
    'code_hash',
    'select'
  ),
  false,
  'authenticated users cannot read stored invite digests'
);

set local role anon;

select is(
  pg_temp.invite_admin_result('create'),
  '42501',
  'anonymous callers cannot create invites through the RPC'
);

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '10000000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (select count(*) from public.circles),
  1::bigint,
  'an owner sees only their approved circle'
);

select is(
  (select count(*) from public.profiles where id = '10000000-0000-4000-8000-000000000002'),
  1::bigint,
  'approved members can read basic profiles in a shared circle'
);

select is(
  (select count(*) from public.join_requests where requester_id = '10000000-0000-4000-8000-000000000004'),
  1::bigint,
  'the circle owner can read pending join requests'
);

select is(
  (select count(id) from public.circle_invites where circle_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  4::bigint,
  'the circle owner can read invite records'
);

select
  set_config('test.invite_code', created.invite_code, true),
  set_config('test.invite_id', created.invite_id::text, true)
from public.create_circle_invite(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  interval '1 day',
  3
) as created;

select ok(
  current_setting('test.invite_code') ~ '^ks1_[0-9a-f]{64}$',
  'invite creation returns one versioned 256-bit raw code'
);

reset role;

select set_config(
  'test.invite_digest',
  (
    select code_hash
    from public.circle_invites
    where id = current_setting('test.invite_id')::uuid
  ),
  true
);

select is(
  current_setting('test.invite_digest'),
  pg_catalog.encode(
    extensions.digest(current_setting('test.invite_code'), 'sha256'),
    'hex'
  ),
  'invite creation persists only the server-computed digest'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '10000000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '10000000-0000-4000-8000-000000000002',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (select count(*) from public.circles where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  1::bigint,
  'an approved member can read their circle'
);

select is(
  (select count(*) from public.profile_preferences where user_id = '10000000-0000-4000-8000-000000000001'),
  0::bigint,
  'profile preferences remain private from other approved members'
);

select is(
  (select count(*) from public.profile_preferences where user_id = '10000000-0000-4000-8000-000000000002'),
  1::bigint,
  'a user can read their own profile preferences'
);

select is(
  (select count(*) from storage.objects where name like 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/%'),
  1::bigint,
  'an approved member can read their circle media'
);

select ok(
  pg_temp.can_insert_family_media(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/thumbnails/10000000-0000-4000-8000-000000000002/bob.jpg'
  ),
  'an approved member can insert into their own immutable media namespace'
);

select is(
  (select count(*) from public.join_requests where requester_id = '10000000-0000-4000-8000-000000000004'),
  0::bigint,
  'a non-owner member cannot read another user join request'
);

select is(
  pg_temp.invite_admin_result('create'),
  '42501',
  'a non-owner cannot create an invite'
);

select is(
  pg_temp.invite_admin_result('revoke'),
  '42501',
  'a non-owner cannot revoke an invite'
);

select is(
  pg_temp.invite_admin_result('decide'),
  '42501',
  'a non-owner cannot decide a join request'
);

select is(
  pg_temp.invite_admin_result('remove'),
  '42501',
  'a non-owner cannot remove another member'
);

select is(
  pg_temp.invite_admin_result('transfer'),
  '42501',
  'a non-owner cannot transfer circle ownership'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '10000000-0000-4000-8000-000000000004',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (select count(*) from public.circles where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  0::bigint,
  'a pending requester cannot read the circle'
);

select is(
  (select count(*) from public.join_requests where requester_id = '10000000-0000-4000-8000-000000000004'),
  1::bigint,
  'a requester can read their own pending request'
);

select is(
  public.is_approved_circle_member('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  false,
  'a pending request is not an approved membership'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '10000000-0000-4000-8000-000000000005',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (select count(*) from public.circles where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  0::bigint,
  'a removed member immediately loses circle access'
);

select is(
  pg_temp.invite_request_result('not-an-invite-code'),
  '22023',
  'malformed raw invite codes are rejected'
);

select is(
  pg_temp.invite_request_result('ks1_' || repeat('b', 64)),
  'P0001',
  'expired invite codes are rejected using server time'
);

select is(
  pg_temp.invite_request_result('ks1_' || repeat('c', 64)),
  'P0001',
  'revoked invite codes are rejected'
);

select is(
  pg_temp.invite_request_result('ks1_' || repeat('d', 64)),
  'P0001',
  'exhausted invite codes are rejected'
);

select is(
  pg_temp.invite_request_result(current_setting('test.invite_digest')),
  '22023',
  'a stored digest cannot be replayed as a raw invite code'
);

select is(
  pg_temp.invite_request_result(current_setting('test.invite_code')),
  'ok',
  'a valid raw invite code creates a pending request'
);

select is(
  (select count(*) from public.circles where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  0::bigint,
  'a valid invite request still grants no circle access before approval'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '10000000-0000-4000-8000-000000000003',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (select count(*) from public.circles where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  0::bigint,
  'a user from another circle cannot read the circle'
);

update public.circles
set name = 'Compromised'
where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

select is(
  (select count(*) from public.profiles where id = '10000000-0000-4000-8000-000000000002'),
  0::bigint,
  'a user from another circle cannot read member profiles'
);

select is(
  (select count(*) from storage.objects where name like 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/%'),
  0::bigint,
  'a user from another circle cannot read media'
);

select is(
  pg_temp.can_insert_family_media(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/thumbnails/10000000-0000-4000-8000-000000000003/mallory.jpg'
  ),
  false,
  'a user from another circle cannot insert media'
);

select is(
  (select count(id) from public.circle_invites where circle_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  0::bigint,
  'a user from another circle cannot enumerate invites'
);

reset role;

select is(
  (select name from public.circles where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'Family A',
  'a cross-circle update affects no rows'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '10000000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);
select public.decide_join_request(
  'aaaaaaaa-0000-4000-8000-000000000002',
  'approved'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '10000000-0000-4000-8000-000000000004',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (select count(*) from public.circles where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  1::bigint,
  'approval atomically grants circle access'
);

reset role;

select is(
  (select use_count from public.circle_invites where id = 'aaaaaaaa-0000-4000-8000-000000000001'),
  1,
  'approval increments invite usage on the server'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '10000000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);
select public.remove_circle_member(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '10000000-0000-4000-8000-000000000004'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '10000000-0000-4000-8000-000000000004',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (select count(*) from public.circles where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  0::bigint,
  'removal immediately revokes newly approved access'
);

reset role;

select * from finish();
rollback;

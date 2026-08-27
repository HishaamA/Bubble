begin;

create extension if not exists pgtap with schema extensions;
select plan(27);

create or replace function pg_temp.join_family_result(p_code text)
returns text
language plpgsql
as $$
begin
  perform public.join_family_by_share_code(p_code);
  return 'ok';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.read_family_code_result(p_circle_id uuid)
returns text
language plpgsql
as $$
begin
  return public.get_or_create_family_share_code(p_circle_id);
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.leave_family_result()
returns text
language plpgsql
as $$
begin
  return public.leave_current_family()::text;
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.create_family_result(p_name text)
returns text
language plpgsql
as $$
begin
  perform public.create_family_with_share_code(p_name);
  return 'ok';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

select is(
  (
    select rowsecurity
    from pg_catalog.pg_tables
    where schemaname = 'public'
      and tablename = 'family_share_codes'
  ),
  true,
  'family share codes have row level security enabled'
);

select is(
  (
    select bool_and(
      has_function_privilege('authenticated', signature, 'execute')
    )
    from unnest(array[
      'public.get_or_create_family_share_code(uuid)',
      'public.rotate_family_share_code(uuid)',
      'public.create_family_with_share_code(text)',
      'public.join_family_by_share_code(text)',
      'public.get_current_family()',
      'public.list_current_family_members()',
      'public.leave_current_family()'
    ]) as rpc(signature)
  ),
  true,
  'authenticated users can call the guarded family RPCs'
);

select is(
  (
    select bool_and(
      not has_function_privilege('anon', signature, 'execute')
    )
    from unnest(array[
      'public.get_or_create_family_share_code(uuid)',
      'public.rotate_family_share_code(uuid)',
      'public.create_family_with_share_code(text)',
      'public.join_family_by_share_code(text)',
      'public.get_current_family()',
      'public.list_current_family_members()',
      'public.leave_current_family()'
    ]) as rpc(signature)
  ),
  true,
  'anonymous users cannot call family membership RPCs'
);

select is(
  has_table_privilege('authenticated', 'public.family_share_codes', 'select')
    or has_table_privilege('authenticated', 'public.family_share_codes', 'insert')
    or has_table_privilege('authenticated', 'public.family_share_codes', 'update')
    or has_table_privilege('authenticated', 'public.family_share_codes', 'delete'),
  false,
  'clients cannot read or mutate stored family credentials directly'
);

select matches(
  public.generate_family_share_code(),
  '^BUB-[0-9A-F]{4}(-[0-9A-F]{4}){5}$',
  'the generator produces a readable 96-bit family code'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"user_family_alice","role":"authenticated"}',
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
select set_config(
  'test.created_family',
  (
    select row_to_json(created)::text
    from public.create_family_with_share_code('The Ahmed family') as created
  ),
  true
);
select set_config(
  'test.family_id',
  current_setting('test.created_family')::jsonb ->> 'family_id',
  true
);
select set_config(
  'test.family_code',
  current_setting('test.created_family')::jsonb ->> 'share_code',
  true
);

select is(
  current_setting('test.created_family')::jsonb ->> 'family_name',
  'The Ahmed family',
  'creating a family returns its persisted name'
);

select is(
  current_setting('test.created_family')::jsonb ->> 'family_role',
  'owner',
  'the creator is immediately the family owner'
);

select matches(
  current_setting('test.family_code'),
  '^BUB-[0-9A-F]{4}(-[0-9A-F]{4}){5}$',
  'family creation returns its secure share code'
);

select is(
  (
    select share_code
    from public.get_current_family()
  ),
  current_setting('test.family_code'),
  'the owner can recover the same code after signing in again'
);

select is(
  (select count(*) from public.list_current_family_members()),
  1::bigint,
  'a new family roster contains its owner'
);

select is(
  public.get_or_create_family_share_code(
    current_setting('test.family_id')::uuid
  ),
  current_setting('test.family_code'),
  'get-or-create is idempotent for an existing family'
);

select set_config(
  'test.rotated_code',
  public.rotate_family_share_code(
    current_setting('test.family_id')::uuid
  ),
  true
);
select isnt(
  current_setting('test.rotated_code'),
  current_setting('test.family_code'),
  'rotating a code invalidates the previously displayed credential'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"user_family_bob","role":"authenticated"}',
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

select is(
  pg_temp.join_family_result(current_setting('test.family_code')),
  'P0001:family_code_not_found',
  'a rotated code can no longer join the family'
);

select set_config(
  'test.joined_family',
  (
    select row_to_json(joined)::text
    from public.join_family_by_share_code(
      lower(current_setting('test.rotated_code'))
    ) as joined
  ),
  true
);
select is(
  current_setting('test.joined_family')::jsonb ->> 'family_name',
  'The Ahmed family',
  'a valid code joins the intended family directly'
);

select is(
  current_setting('test.joined_family')::jsonb ->> 'family_role',
  'member',
  'a code join creates an approved member'
);

select is(
  (
    select family_id::text
    from public.get_current_family()
  ),
  current_setting('test.family_id'),
  'the joined family persists for the Clerk subject'
);

select is(
  pg_temp.read_family_code_result(
    current_setting('test.family_id')::uuid
  ),
  current_setting('test.rotated_code'),
  'approved members can retrieve the family code to share it'
);

select is(
  (select count(*) from public.list_current_family_members()),
  2::bigint,
  'approved members can read the current family roster'
);

select is(
  pg_temp.join_family_result(current_setting('test.rotated_code')),
  'ok',
  'joining the same family again is idempotent'
);

select is(
  (
    select count(*)
    from public.circle_members
    where circle_id = current_setting('test.family_id')::uuid
      and user_id = current_setting('test.bob_id')::uuid
      and status = 'approved'
  ),
  1::bigint,
  'an idempotent join never duplicates membership'
);

select is(
  pg_temp.create_family_result('A second family'),
  'P0001:already_a_member',
  'a joined user cannot create another family'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"user_family_alice","role":"authenticated"}',
  true
);
select is(
  pg_temp.leave_family_result(),
  'P0001:transfer_ownership_before_leaving',
  'an owner cannot orphan a family with other members'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"user_family_bob","role":"authenticated"}',
  true
);
select is(
  public.leave_current_family(),
  true,
  'a member can leave their current family'
);

select is(
  (select count(*) from public.get_current_family()),
  0::bigint,
  'a left membership stays detached on the next login'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"user_family_alice","role":"authenticated"}',
  true
);
select is(
  (select count(*) from public.list_current_family_members()),
  1::bigint,
  'removed members no longer appear in the family roster'
);

select is(
  public.leave_current_family(),
  true,
  'a sole owner can leave by deleting the empty family'
);

select is(
  (select count(*) from public.get_current_family()),
  0::bigint,
  'the deleted family is absent after signing in again'
);

select * from finish();
rollback;

-- Local test fixtures only. Never rotate a real family's code for validation.
begin;
create extension if not exists pgtap with schema extensions;
select plan(16);

create function pg_temp.rotation_result(p_family uuid)
returns text language plpgsql as $$
begin
  return public.rotate_family_share_code(p_family);
exception when others then return sqlstate || ':' || sqlerrm;
end;
$$;
create function pg_temp.join_result(p_code text)
returns text language plpgsql as $$
begin
  perform public.join_family_by_share_code(p_code);
  return 'ok';
exception when others then return sqlstate || ':' || sqlerrm;
end;
$$;
create function pg_temp.code_result(p_family uuid)
returns text language plpgsql as $$
begin
  return public.get_or_create_family_share_code(p_family);
exception when others then return sqlstate || ':' || sqlerrm;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"user_family_safety_owner","role":"authenticated"}', true);
select set_config('test.owner_id', (select user_id::text from public.bootstrap_current_user('Owner', 'owner-safety@example.test')), true);
select set_config('test.family', (select row_to_json(family)::text from public.create_family_with_share_code('Safety family') family), true);
select set_config('test.family_id', current_setting('test.family')::jsonb ->> 'family_id', true);
select set_config('test.original_code', current_setting('test.family')::jsonb ->> 'share_code', true);

select is(pg_temp.join_result(current_setting('test.original_code')), 'ok', 'owner can reuse the current family code idempotently');
select is((select family_role from public.get_current_family()), 'owner', 'idempotent join preserves ownership');

select set_config('test.replacement_code', public.rotate_family_share_code(current_setting('test.family_id')::uuid), true);
select isnt(current_setting('test.replacement_code'), current_setting('test.original_code'), 'owner replacement produces a different code');

select set_config('request.jwt.claims', '{"sub":"user_family_safety_member","role":"authenticated"}', true);
select set_config('test.member_id', (select user_id::text from public.bootstrap_current_user('Member', 'member-safety@example.test')), true);
select is(pg_temp.join_result(current_setting('test.original_code')), 'P0001:family_code_not_found', 'outdated code cannot join');
select is((select count(*) from public.get_current_family()), 0::bigint, 'failed outdated-code join creates no partial membership');
select is(pg_temp.join_result(current_setting('test.replacement_code')), 'ok', 'replacement code joins the intended family');
select is(pg_temp.rotation_result(current_setting('test.family_id')::uuid), '42501:circle_owner_required', 'approved members cannot replace the owner code');
select is(pg_temp.code_result(current_setting('test.family_id')::uuid), current_setting('test.replacement_code'), 'failed member rotation leaves the valid code unchanged');
select is((select count(*) from public.list_current_family_members()), 2::bigint, 'member sees only the approved roster for their own family');

select set_config('request.jwt.claims', '{"sub":"user_family_safety_other","role":"authenticated"}', true);
select set_config('test.other_id', (select user_id::text from public.bootstrap_current_user('Other owner', 'other-safety@example.test')), true);
select is((select count(*) from public.list_current_family_members()), 0::bigint, 'unjoined user cannot inspect another family roster');
select set_config('test.other_family', (select row_to_json(family)::text from public.create_family_with_share_code('Other safety family') family), true);
select is(pg_temp.rotation_result(current_setting('test.family_id')::uuid), '42501:circle_owner_required', 'ownership of another family does not authorize this rotation');
select is(pg_temp.code_result(current_setting('test.family_id')::uuid), '42501:approved_family_member_required', 'other-family owner cannot read this share credential');
select is(pg_temp.join_result(current_setting('test.replacement_code')), 'P0001:already_a_member', 'cross-family join is rejected without abandoning the existing family');
select is((select family_id::text from public.get_current_family()), current_setting('test.other_family')::jsonb ->> 'family_id', 'rejected cross-family join preserves the original membership');

-- Simulate a generator outage inside the rollback-only local fixture. Restoring
-- the exact definition also proves the transaction does not replace a stored
-- code until a complete successful value exists.
reset role;
select set_config('test.generator_definition', pg_get_functiondef('public.generate_family_share_code()'::regprocedure), true);
create or replace function public.generate_family_share_code()
returns text language plpgsql volatile security definer set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'test_generator_unavailable';
end;
$$;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"user_family_safety_owner","role":"authenticated"}', true);
select is(pg_temp.rotation_result(current_setting('test.family_id')::uuid), 'P0001:test_generator_unavailable', 'failed replacement surfaces its failure');
select is(pg_temp.code_result(current_setting('test.family_id')::uuid), current_setting('test.replacement_code'), 'failed replacement rolls back without invalidating the current code');
reset role;
do $$ begin execute current_setting('test.generator_definition'); end; $$;

select * from finish();
rollback;

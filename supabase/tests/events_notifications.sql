begin;

create extension if not exists pgtap with schema extensions;
select plan(27);

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
    '60000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'owner@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Owner"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '60000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'member@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Member"}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '60000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'outsider@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Outsider"}'::jsonb,
    now(),
    now()
  );

insert into public.circles (id, name, owner_id)
values
  (
    'eeeeeeee-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Family A',
    '60000000-0000-4000-8000-000000000001'
  ),
  (
    'eeeeeeee-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Family B',
    '60000000-0000-4000-8000-000000000003'
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
  'eeeeeeee-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '60000000-0000-4000-8000-000000000002',
  'member',
  'approved',
  '60000000-0000-4000-8000-000000000001',
  now()
);

create or replace function pg_temp.create_event_result(p_circle_id uuid)
returns text
language plpgsql
as $$
declare
  v_event_id uuid;
begin
  v_event_id := public.create_family_event(
    p_circle_id,
    'Sunday lunch',
    now() + interval '2 hours',
    'Family home',
    null,
    null
  );
  return v_event_id::text;
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.set_reminder_result(p_event_id uuid)
returns text
language plpgsql
as $$
begin
  perform public.set_event_reminder(p_event_id, interval '1 hour');
  return 'ok';
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.complete_event_result(p_event_id uuid)
returns text
language plpgsql
as $$
declare
  v_completed boolean;
begin
  v_completed := public.complete_family_event(p_event_id);
  return v_completed::text;
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.update_event_details_result(
  p_event_id uuid,
  p_details text
)
returns text
language plpgsql
as $$
declare
  v_updated boolean;
begin
  v_updated := public.update_family_event_details(p_event_id, p_details);
  return v_updated::text;
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

create or replace function pg_temp.dispatch_result(p_limit integer)
returns text
language plpgsql
as $$
declare
  v_count integer;
begin
  v_count := public.dispatch_due_event_reminders(p_limit);
  return v_count::text;
exception
  when others then
    return sqlstate || ':' || sqlerrm;
end;
$$;

select is(
  has_function_privilege(
    'authenticated',
    'public.create_family_event(uuid,text,timestamptz,text,text,interval)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.set_event_reminder(uuid,interval)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.cancel_event_reminder(uuid)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.complete_family_event(uuid)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.update_family_event_details(uuid,text)',
    'execute'
  ),
  true,
  'authenticated users can execute only the intended event mutation RPCs'
);

select is(
  not has_function_privilege(
    'anon',
    'public.create_family_event(uuid,text,timestamptz,text,text,interval)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.set_event_reminder(uuid,interval)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.complete_family_event(uuid)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.update_family_event_details(uuid,text)',
    'execute'
  ),
  true,
  'anonymous users cannot execute event or reminder RPCs'
);

select is(
  has_table_privilege('authenticated', 'public.events', 'select')
  and not has_table_privilege('authenticated', 'public.events', 'insert')
  and not has_table_privilege('authenticated', 'public.events', 'update')
  and not has_table_privilege('authenticated', 'public.event_reminders', 'insert')
  and not has_table_privilege('authenticated', 'public.notifications', 'insert')
  and not has_table_privilege('authenticated', 'public.scheduled_jobs', 'select'),
  true,
  'clients can read authorized records but cannot forge events, reminders, notifications, or jobs'
);

select is(
  has_function_privilege(
    'service_role',
    'public.dispatch_due_event_reminders(integer)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.dispatch_due_event_reminders(integer)',
    'execute'
  ),
  true,
  'only the trusted service role can dispatch due reminder jobs'
);

set local role anon;

select matches(
  pg_temp.create_event_result('eeeeeeee-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  '^42501:',
  'anonymous callers cannot create an event'
);

select matches(
  pg_temp.complete_event_result('ffffffff-ffff-4fff-8fff-ffffffffffff'),
  '^42501:',
  'anonymous callers cannot complete a family event'
);

select matches(
  pg_temp.update_event_details_result(
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'anonymous update'
  ),
  '^42501:',
  'anonymous callers cannot update family event details'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '60000000-0000-4000-8000-000000000002',
    'role', 'authenticated'
  )::text,
  true
);

select set_config(
  'test.event_id',
  pg_temp.create_event_result('eeeeeeee-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  true
);

select matches(
  current_setting('test.event_id'),
  '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
  'an approved non-owner member can create a family event'
);

select is(
  (
    select created_by
    from public.events
    where id = current_setting('test.event_id')::uuid
  ),
  '60000000-0000-4000-8000-000000000002'::uuid,
  'event creation derives the creator from the authenticated session'
);

select is(
  (
    select count(*)
    from public.events
    where id = current_setting('test.event_id')::uuid
  ),
  1::bigint,
  'the creating member can read the event'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '60000000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    select count(*)
    from public.events
    where id = current_setting('test.event_id')::uuid
  ),
  1::bigint,
  'another approved member receives the shared family event'
);

select is(
  pg_temp.set_reminder_result(current_setting('test.event_id')::uuid),
  'ok',
  'an approved member can opt in to their own event reminder'
);

select is(
  (
    select count(*)
    from public.event_reminders
    where event_id = current_setting('test.event_id')::uuid
  ),
  1::bigint,
  'the reminder owner can read their reminder preference'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '60000000-0000-4000-8000-000000000002',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    select count(*)
    from public.event_reminders
    where event_id = current_setting('test.event_id')::uuid
  ),
  0::bigint,
  'another approved member cannot read someone else reminder preference'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '60000000-0000-4000-8000-000000000003',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    select count(*)
    from public.events
    where id = current_setting('test.event_id')::uuid
  ),
  0::bigint,
  'a user from another circle cannot read the family event'
);

select is(
  pg_temp.create_event_result('eeeeeeee-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  '42501:approved_membership_required',
  'a cross-circle user cannot create an event in another family'
);

select is(
  pg_temp.set_reminder_result(current_setting('test.event_id')::uuid),
  '42501:approved_membership_required',
  'a cross-circle user cannot opt in to another family event reminder'
);

select is(
  pg_temp.complete_event_result(current_setting('test.event_id')::uuid),
  '42501:approved_membership_required',
  'a cross-circle user cannot complete another family event'
);

select is(
  pg_temp.update_event_details_result(
    current_setting('test.event_id')::uuid,
    'cross-circle update'
  ),
  '42501:approved_membership_required',
  'a cross-circle user cannot update another family event details'
);

reset role;

update public.scheduled_jobs
set run_at = now() - interval '1 minute'
where payload ->> 'event_id' = current_setting('test.event_id');

set local role service_role;

select is(
  pg_temp.dispatch_result(null),
  '22023:dispatch_limit_out_of_range',
  'a null dispatch limit cannot accidentally create an unbounded batch'
);

select is(
  pg_temp.dispatch_result(10),
  '1',
  'the trusted dispatcher turns one due reminder into a durable notification'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '60000000-0000-4000-8000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    select count(*)
    from public.notifications
    where event_id = current_setting('test.event_id')::uuid
      and recipient_id = '60000000-0000-4000-8000-000000000001'
      and kind = 'event_reminder'
  ),
  1::bigint,
  'the reminder owner can read the dispatched notification'
);

select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '60000000-0000-4000-8000-000000000002',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (
    select count(*)
    from public.notifications
    where event_id = current_setting('test.event_id')::uuid
  ),
  0::bigint,
  'another family member cannot read a notification addressed to someone else'
);

select is(
  pg_temp.update_event_details_result(
    current_setting('test.event_id')::uuid,
    '  kinsphere-plan-category:v1:other  '
  ),
  'true',
  'an approved family member can update shared event details'
);

select is(
  (
    select details
    from public.events
    where id = current_setting('test.event_id')::uuid
  ),
  'kinsphere-plan-category:v1:other',
  'shared event details are trimmed and persisted'
);

select is(
  pg_temp.complete_event_result(current_setting('test.event_id')::uuid),
  'true',
  'an approved family member can complete a shared event'
);

reset role;

select is(
  (
    select count(*)
    from public.events
    where id = current_setting('test.event_id')::uuid
  ) + (
    select count(*)
    from public.event_reminders
    where event_id = current_setting('test.event_id')::uuid
  ),
  0::bigint,
  'completing a family event removes it and its reminder rows'
);

select * from finish();
rollback;

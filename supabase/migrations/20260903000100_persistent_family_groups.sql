begin;

-- A family share code is a long-lived, rotatable bearer credential. It is
-- intentionally isolated from the client-readable circle tables: signed-in
-- clients can obtain or use it only through the authorization-checking RPCs
-- below. Ninety-six random bits make online guessing impractical, while the
-- grouped representation remains reasonable to read or paste on a phone.
create table if not exists public.family_share_codes (
  circle_id uuid primary key
    references public.circles (id) on delete cascade,
  code text not null unique,
  created_by uuid not null
    references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now(),
  constraint family_share_codes_format
    check (code ~ '^BUB-[0-9A-F]{4}(-[0-9A-F]{4}){5}$')
);

comment on table public.family_share_codes is
  'Private, rotatable family join credentials. Clients access codes only through guarded RPCs.';

alter table public.family_share_codes enable row level security;

revoke all on table public.family_share_codes
  from public, anon, authenticated;
grant all on table public.family_share_codes to service_role;

create or replace function public.generate_family_share_code()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_hex text := pg_catalog.upper(
    pg_catalog.encode(extensions.gen_random_bytes(12), 'hex')
  );
begin
  return 'BUB-'
    || pg_catalog.substring(v_hex, 1, 4) || '-'
    || pg_catalog.substring(v_hex, 5, 4) || '-'
    || pg_catalog.substring(v_hex, 9, 4) || '-'
    || pg_catalog.substring(v_hex, 13, 4) || '-'
    || pg_catalog.substring(v_hex, 17, 4) || '-'
    || pg_catalog.substring(v_hex, 21, 4);
end;
$$;

revoke all on function public.generate_family_share_code()
  from public, anon, authenticated;

create or replace function public.get_or_create_family_share_code(
  p_circle_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_code text;
  v_attempt integer;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501', message = 'profile_bootstrap_required';
  end if;

  if not public.is_approved_circle_member(p_circle_id) then
    raise exception using
      errcode = '42501', message = 'approved_family_member_required';
  end if;

  select share_code.code
    into v_code
  from public.family_share_codes as share_code
  where share_code.circle_id = p_circle_id;

  if v_code is not null then
    return v_code;
  end if;

  -- Every member may share an existing family code. Only the owner may create
  -- a replacement if legacy or partially migrated data has no code yet.
  if not public.is_circle_owner(p_circle_id) then
    raise exception using
      errcode = '42501', message = 'family_code_missing';
  end if;

  for v_attempt in 1..5 loop
    v_code := public.generate_family_share_code();
    begin
      insert into public.family_share_codes (
        circle_id,
        code,
        created_by
      )
      values (
        p_circle_id,
        v_code,
        v_user_id
      )
      on conflict (circle_id) do nothing;
    exception
      when unique_violation then
        continue;
    end;

    select share_code.code
      into v_code
    from public.family_share_codes as share_code
    where share_code.circle_id = p_circle_id;

    if v_code is not null then
      return v_code;
    end if;
  end loop;

  raise exception using
    errcode = 'P0001', message = 'family_code_generation_failed';
end;
$$;

create or replace function public.rotate_family_share_code(
  p_circle_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_code text;
  v_attempt integer;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501', message = 'profile_bootstrap_required';
  end if;

  if not public.is_circle_owner(p_circle_id) then
    raise exception using
      errcode = '42501', message = 'circle_owner_required';
  end if;

  for v_attempt in 1..5 loop
    v_code := public.generate_family_share_code();
    begin
      insert into public.family_share_codes (
        circle_id,
        code,
        created_by,
        rotated_at
      )
      values (
        p_circle_id,
        v_code,
        v_user_id,
        now()
      )
      on conflict (circle_id) do update
      set code = excluded.code,
          created_by = excluded.created_by,
          rotated_at = excluded.rotated_at;

      return v_code;
    exception
      when unique_violation then
        continue;
    end;
  end loop;

  raise exception using
    errcode = 'P0001', message = 'family_code_generation_failed';
end;
$$;

create or replace function public.create_family_with_share_code(
  p_name text
)
returns table (
  family_id uuid,
  family_name text,
  family_role text,
  owner_id uuid,
  member_count bigint,
  share_code text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_name text := nullif(btrim(p_name), '');
  v_circle_id uuid;
  v_code text;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501', message = 'profile_bootstrap_required';
  end if;

  if v_name is null or char_length(v_name) > 80 then
    raise exception using
      errcode = '22023', message = 'invalid_family_name';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'bubble-family-membership:' || v_user_id::text,
      0
    )
  );

  if exists (
    select 1
    from public.circle_members as membership
    where membership.user_id = v_user_id
      and membership.status = 'approved'
  ) then
    raise exception using
      errcode = 'P0001', message = 'already_a_member';
  end if;

  insert into public.circles (name, owner_id)
  values (v_name, v_user_id)
  returning id into v_circle_id;

  v_code := public.get_or_create_family_share_code(v_circle_id);

  return query
  select
    v_circle_id,
    v_name,
    'owner'::text,
    v_user_id,
    1::bigint,
    v_code;
end;
$$;

create or replace function public.join_family_by_share_code(
  p_share_code text
)
returns table (
  family_id uuid,
  family_name text,
  family_role text,
  owner_id uuid,
  member_count bigint,
  share_code text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_code text := pg_catalog.upper(btrim(p_share_code));
  v_circle_id uuid;
  v_owner_id uuid;
  v_family_name text;
  v_existing_circle_id uuid;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501', message = 'profile_bootstrap_required';
  end if;

  if v_code is null
    or v_code !~ '^BUB-[0-9A-F]{4}(-[0-9A-F]{4}){5}$'
  then
    raise exception using
      errcode = '22023', message = 'invalid_family_code';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'bubble-family-membership:' || v_user_id::text,
      0
    )
  );

  select family_circle.id, family_circle.owner_id, family_circle.name
    into v_circle_id, v_owner_id, v_family_name
  from public.family_share_codes as family_code
  join public.circles as family_circle
    on family_circle.id = family_code.circle_id
  where family_code.code = v_code
  for share of family_code, family_circle;

  if not found then
    raise exception using
      errcode = 'P0001', message = 'family_code_not_found';
  end if;

  select membership.circle_id
    into v_existing_circle_id
  from public.circle_members as membership
  where membership.user_id = v_user_id
    and membership.status = 'approved'
  limit 1;

  if v_existing_circle_id is not null
    and v_existing_circle_id <> v_circle_id
  then
    raise exception using
      errcode = 'P0001', message = 'already_a_member';
  end if;

  if v_existing_circle_id is null then
    insert into public.circle_members (
      circle_id,
      user_id,
      role,
      status,
      approved_by,
      approved_at,
      removed_at
    )
    values (
      v_circle_id,
      v_user_id,
      'member',
      'approved',
      v_owner_id,
      now(),
      null
    )
    on conflict (circle_id, user_id) do update
    set role = 'member',
        status = 'approved',
        approved_by = excluded.approved_by,
        approved_at = excluded.approved_at,
        removed_at = null;
  end if;

  -- A direct share-code join supersedes any legacy approval requests made by
  -- this user. Keeping those requests pending would create misleading owner UI.
  update public.join_requests
  set status = 'cancelled',
      decided_by = null,
      decided_at = now()
  where requester_id = v_user_id
    and status = 'pending';

  return query
  select
    v_circle_id,
    v_family_name,
    case when v_owner_id = v_user_id then 'owner' else 'member' end,
    v_owner_id,
    (
      select count(*)
      from public.circle_members as membership
      where membership.circle_id = v_circle_id
        and membership.status = 'approved'
    ),
    v_code;
end;
$$;

create or replace function public.get_current_family()
returns table (
  family_id uuid,
  family_name text,
  family_role text,
  owner_id uuid,
  member_count bigint,
  share_code text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501', message = 'profile_bootstrap_required';
  end if;

  return query
  select
    family_circle.id,
    family_circle.name,
    membership.role,
    family_circle.owner_id,
    (
      select count(*)
      from public.circle_members as family_member
      where family_member.circle_id = family_circle.id
        and family_member.status = 'approved'
    ),
    family_code.code
  from public.circle_members as membership
  join public.circles as family_circle
    on family_circle.id = membership.circle_id
  left join public.family_share_codes as family_code
    on family_code.circle_id = family_circle.id
  where membership.user_id = v_user_id
    and membership.status = 'approved'
  order by membership.created_at asc
  limit 1;
end;
$$;

create or replace function public.list_current_family_members()
returns table (
  family_id uuid,
  user_id uuid,
  display_name text,
  avatar_path text,
  family_role text,
  joined_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_circle_id uuid;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501', message = 'profile_bootstrap_required';
  end if;

  select membership.circle_id
    into v_circle_id
  from public.circle_members as membership
  where membership.user_id = v_user_id
    and membership.status = 'approved'
  order by membership.created_at asc
  limit 1;

  if v_circle_id is null then
    return;
  end if;

  return query
  select
    membership.circle_id,
    membership.user_id,
    profile.display_name,
    profile.avatar_path,
    membership.role,
    membership.approved_at
  from public.circle_members as membership
  join public.profiles as profile
    on profile.id = membership.user_id
  where membership.circle_id = v_circle_id
    and membership.status = 'approved'
  order by
    case when membership.role = 'owner' then 0 else 1 end,
    membership.approved_at asc,
    membership.user_id asc;
end;
$$;

create or replace function public.leave_current_family()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_circle_id uuid;
  v_role text;
  v_member_count bigint;
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501', message = 'profile_bootstrap_required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'bubble-family-membership:' || v_user_id::text,
      0
    )
  );

  select membership.circle_id, membership.role
    into v_circle_id, v_role
  from public.circle_members as membership
  where membership.user_id = v_user_id
    and membership.status = 'approved'
  order by membership.created_at asc
  limit 1
  for update;

  if v_circle_id is null then
    return false;
  end if;

  if v_role = 'owner' then
    select count(*)
      into v_member_count
    from public.circle_members as membership
    where membership.circle_id = v_circle_id
      and membership.status = 'approved';

    if v_member_count > 1 then
      raise exception using
        errcode = 'P0001', message = 'transfer_ownership_before_leaving';
    end if;

    delete from public.circles
    where id = v_circle_id;
  else
    update public.circle_members
    set role = 'member',
        status = 'removed',
        removed_at = now()
    where circle_id = v_circle_id
      and user_id = v_user_id
      and status = 'approved';
  end if;

  return true;
end;
$$;

-- Existing families receive a code during migration, so users do not need to
-- recreate their group. Retry the globally unique value instead of silently
-- leaving a circle without a code in the extremely unlikely event of a clash.
do $$
declare
  v_circle record;
  v_code text;
  v_attempt integer;
begin
  for v_circle in
    select family_circle.id, family_circle.owner_id
    from public.circles as family_circle
    where not exists (
      select 1
      from public.family_share_codes as existing_code
      where existing_code.circle_id = family_circle.id
    )
  loop
    for v_attempt in 1..5 loop
      v_code := public.generate_family_share_code();
      begin
        insert into public.family_share_codes (
          circle_id,
          code,
          created_by
        )
        values (
          v_circle.id,
          v_code,
          v_circle.owner_id
        );
        exit;
      exception
        when unique_violation then
          if exists (
            select 1
            from public.family_share_codes as existing_code
            where existing_code.circle_id = v_circle.id
          ) then
            exit;
          end if;
      end;
    end loop;

    if not exists (
      select 1
      from public.family_share_codes as existing_code
      where existing_code.circle_id = v_circle.id
    ) then
      raise exception using
        errcode = 'P0001', message = 'family_code_generation_failed';
    end if;
  end loop;
end;
$$;

revoke all on function public.get_or_create_family_share_code(uuid)
  from public, anon, authenticated;
revoke all on function public.rotate_family_share_code(uuid)
  from public, anon, authenticated;
revoke all on function public.create_family_with_share_code(text)
  from public, anon, authenticated;
revoke all on function public.join_family_by_share_code(text)
  from public, anon, authenticated;
revoke all on function public.get_current_family()
  from public, anon, authenticated;
revoke all on function public.list_current_family_members()
  from public, anon, authenticated;
revoke all on function public.leave_current_family()
  from public, anon, authenticated;

grant execute on function public.get_or_create_family_share_code(uuid)
  to authenticated, service_role;
grant execute on function public.rotate_family_share_code(uuid)
  to authenticated, service_role;
grant execute on function public.create_family_with_share_code(text)
  to authenticated, service_role;
grant execute on function public.join_family_by_share_code(text)
  to authenticated, service_role;
grant execute on function public.get_current_family()
  to authenticated, service_role;
grant execute on function public.list_current_family_members()
  to authenticated, service_role;
grant execute on function public.leave_current_family()
  to authenticated, service_role;

commit;

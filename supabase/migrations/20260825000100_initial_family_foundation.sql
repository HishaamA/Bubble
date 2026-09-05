begin;

create extension if not exists pgcrypto with schema extensions;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_updated_at() from public, anon, authenticated;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  avatar_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_length
    check (char_length(btrim(display_name)) between 1 and 80),
  constraint profiles_avatar_path_length
    check (avatar_path is null or char_length(avatar_path) between 1 and 500)
);

comment on table public.profiles is
  'Basic profile fields that approved members of a shared circle may read.';

create table public.profile_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  time_zone text not null default 'UTC',
  quiet_hours_start time,
  quiet_hours_end time,
  prompt_preference text not null default 'scheduled',
  notifications_enabled boolean not null default true,
  low_data_mode boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profile_preferences_time_zone_length
    check (char_length(time_zone) between 1 and 64),
  constraint profile_preferences_prompt_preference
    check (prompt_preference in ('scheduled', 'manual', 'off')),
  constraint profile_preferences_quiet_hours_pair
    check (
      (quiet_hours_start is null and quiet_hours_end is null)
      or (quiet_hours_start is not null and quiet_hours_end is not null)
    )
);

comment on table public.profile_preferences is
  'Private per-user scheduling and data preferences; readable only by that user.';

create table public.circles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint circles_name_length
    check (char_length(btrim(name)) between 1 and 80)
);

create table public.circle_members (
  circle_id uuid not null references public.circles (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member',
  status text not null default 'approved',
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (circle_id, user_id),
  constraint circle_members_role
    check (role in ('owner', 'member')),
  constraint circle_members_status
    check (status in ('approved', 'removed')),
  constraint circle_members_state_dates
    check (
      (status = 'approved' and approved_at is not null and removed_at is null)
      or (status = 'removed' and removed_at is not null)
    ),
  constraint circle_members_owner_is_approved
    check (role <> 'owner' or status = 'approved')
);

comment on table public.circle_members is
  'Authorization table. Only rows with status=approved grant access.';

create unique index circle_members_one_approved_owner_idx
  on public.circle_members (circle_id)
  where role = 'owner' and status = 'approved';

create index circle_members_user_status_idx
  on public.circle_members (user_id, status, circle_id);

create index circle_members_circle_status_idx
  on public.circle_members (circle_id, status, user_id);

create table public.circle_invites (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  code_hash text not null unique,
  expires_at timestamptz not null,
  max_uses integer not null default 1,
  use_count integer not null default 0,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint circle_invites_sha256_hex
    check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint circle_invites_expiry_bounds
    check (
      expires_at >= created_at + interval '5 minutes'
      and expires_at <= created_at + interval '30 days'
    ),
  constraint circle_invites_usage_bounds
    check (max_uses between 1 and 25 and use_count between 0 and max_uses)
);

create index circle_invites_circle_active_idx
  on public.circle_invites (circle_id, expires_at)
  where revoked_at is null;

create table public.join_requests (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles (id) on delete cascade,
  requester_id uuid not null references auth.users (id) on delete cascade,
  invite_id uuid not null references public.circle_invites (id) on delete restrict,
  status text not null default 'pending',
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint join_requests_status
    check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  constraint join_requests_decision_fields
    check (
      (status = 'pending' and decided_by is null and decided_at is null)
      or (status in ('approved', 'rejected') and decided_at is not null)
      or (status = 'cancelled' and decided_by is null and decided_at is not null)
    )
);

create unique index join_requests_one_pending_per_user_circle_idx
  on public.join_requests (circle_id, requester_id)
  where status = 'pending';

create index join_requests_circle_status_created_idx
  on public.join_requests (circle_id, status, created_at desc);

create index join_requests_requester_created_idx
  on public.join_requests (requester_id, created_at desc);

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger profile_preferences_set_updated_at
before update on public.profile_preferences
for each row execute function public.set_updated_at();

create trigger circles_set_updated_at
before update on public.circles
for each row execute function public.set_updated_at();

create trigger circle_members_set_updated_at
before update on public.circle_members
for each row execute function public.set_updated_at();

create trigger circle_invites_set_updated_at
before update on public.circle_invites
for each row execute function public.set_updated_at();

create trigger join_requests_set_updated_at
before update on public.join_requests
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_display_name text;
begin
  v_display_name := left(
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Family member'
    ),
    80
  );

  insert into public.profiles (id, display_name)
  values (new.id, v_display_name)
  on conflict (id) do nothing;

  insert into public.profile_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.handle_new_circle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.circle_members (
    circle_id,
    user_id,
    role,
    status,
    approved_by,
    approved_at
  )
  values (
    new.id,
    new.owner_id,
    'owner',
    'approved',
    new.owner_id,
    now()
  );

  return new;
end;
$$;

revoke all on function public.handle_new_circle() from public, anon, authenticated;

create trigger on_circle_created
after insert on public.circles
for each row execute function public.handle_new_circle();

create or replace function public.is_approved_circle_member(p_circle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.circle_members as membership
    where membership.circle_id = p_circle_id
      and membership.user_id = auth.uid()
      and membership.status = 'approved'
  );
$$;

create or replace function public.is_circle_owner(p_circle_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.circle_members as membership
    where membership.circle_id = p_circle_id
      and membership.user_id = auth.uid()
      and membership.role = 'owner'
      and membership.status = 'approved'
  );
$$;

create or replace function public.shares_approved_circle(p_other_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() = p_other_user_id
    or exists (
      select 1
      from public.circle_members as mine
      join public.circle_members as theirs
        on theirs.circle_id = mine.circle_id
      where mine.user_id = auth.uid()
        and mine.status = 'approved'
        and theirs.user_id = p_other_user_id
        and theirs.status = 'approved'
    );
$$;

revoke all on function public.is_approved_circle_member(uuid) from public, anon, authenticated;
revoke all on function public.is_circle_owner(uuid) from public, anon, authenticated;
revoke all on function public.shares_approved_circle(uuid) from public, anon, authenticated;
grant execute on function public.is_approved_circle_member(uuid) to authenticated;
grant execute on function public.is_circle_owner(uuid) to authenticated;
grant execute on function public.shares_approved_circle(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.profile_preferences enable row level security;
alter table public.circles enable row level security;
alter table public.circle_members enable row level security;
alter table public.circle_invites enable row level security;
alter table public.join_requests enable row level security;

create policy profiles_read_self_or_shared_circle
on public.profiles
for select
to authenticated
using (id = auth.uid() or public.shares_approved_circle(id));

create policy profiles_insert_self
on public.profiles
for insert
to authenticated
with check (id = auth.uid());

create policy profiles_update_self
on public.profiles
for update
to authenticated
using (id = auth.uid())
with check (id = auth.uid());

create policy profile_preferences_read_self
on public.profile_preferences
for select
to authenticated
using (user_id = auth.uid());

create policy profile_preferences_insert_self
on public.profile_preferences
for insert
to authenticated
with check (user_id = auth.uid());

create policy profile_preferences_update_self
on public.profile_preferences
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create policy circles_read_approved_members
on public.circles
for select
to authenticated
using (public.is_approved_circle_member(id));

create policy circles_create_as_owner
on public.circles
for insert
to authenticated
with check (owner_id = auth.uid());

create policy circles_update_by_owner
on public.circles
for update
to authenticated
using (public.is_circle_owner(id))
with check (
  owner_id = auth.uid()
  and public.is_circle_owner(id)
);

create policy circles_delete_by_owner
on public.circles
for delete
to authenticated
using (public.is_circle_owner(id));

create policy circle_members_read_approved_roster
on public.circle_members
for select
to authenticated
using (
  public.is_approved_circle_member(circle_id)
  and (status = 'approved' or public.is_circle_owner(circle_id))
);

create policy circle_invites_read_by_owner
on public.circle_invites
for select
to authenticated
using (public.is_circle_owner(circle_id));

create policy join_requests_read_requester_or_owner
on public.join_requests
for select
to authenticated
using (
  requester_id = auth.uid()
  or public.is_circle_owner(circle_id)
);

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.profile_preferences from anon, authenticated;
revoke all on table public.circles from anon, authenticated;
revoke all on table public.circle_members from anon, authenticated;
revoke all on table public.circle_invites from anon, authenticated;
revoke all on table public.join_requests from anon, authenticated;

grant select on table public.profiles to authenticated;
grant insert (id, display_name, avatar_path) on table public.profiles to authenticated;
grant update (display_name, avatar_path) on table public.profiles to authenticated;
grant select on table public.profile_preferences to authenticated;
grant insert (
  user_id,
  time_zone,
  quiet_hours_start,
  quiet_hours_end,
  prompt_preference,
  notifications_enabled,
  low_data_mode
) on table public.profile_preferences to authenticated;
grant update (
  time_zone,
  quiet_hours_start,
  quiet_hours_end,
  prompt_preference,
  notifications_enabled,
  low_data_mode
) on table public.profile_preferences to authenticated;
grant select, delete on table public.circles to authenticated;
grant insert (name, owner_id) on table public.circles to authenticated;
grant update (name) on table public.circles to authenticated;
grant select on table public.circle_members to authenticated;
grant select (
  id,
  circle_id,
  created_by,
  expires_at,
  max_uses,
  use_count,
  revoked_at,
  created_at,
  updated_at
) on table public.circle_invites to authenticated;
grant select on table public.join_requests to authenticated;

grant all on table public.profiles to service_role;
grant all on table public.profile_preferences to service_role;
grant all on table public.circles to service_role;
grant all on table public.circle_members to service_role;
grant all on table public.circle_invites to service_role;
grant all on table public.join_requests to service_role;

create or replace function public.create_circle_invite(
  p_circle_id uuid,
  p_expires_in interval default interval '7 days',
  p_max_uses integer default 1
)
returns table (
  invite_id uuid,
  invite_code text,
  expires_at timestamptz,
  max_uses integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_invite_id uuid;
  v_invite_code text;
  v_code_hash text;
  v_expires_at timestamptz;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  if not public.is_circle_owner(p_circle_id) then
    raise exception using errcode = '42501', message = 'circle_owner_required';
  end if;

  if p_expires_in is null
    or p_expires_in < interval '5 minutes'
    or p_expires_in > interval '30 days'
  then
    raise exception using errcode = '22023', message = 'invite_expiry_out_of_bounds';
  end if;

  if p_max_uses is null or p_max_uses not between 1 and 25 then
    raise exception using errcode = '22023', message = 'invite_max_uses_out_of_bounds';
  end if;

  v_invite_code := 'ks1_' || pg_catalog.encode(
    extensions.gen_random_bytes(32),
    'hex'
  );
  v_code_hash := pg_catalog.encode(
    extensions.digest(v_invite_code, 'sha256'),
    'hex'
  );
  v_expires_at := now() + p_expires_in;

  insert into public.circle_invites (
    circle_id,
    created_by,
    code_hash,
    expires_at,
    max_uses
  )
  values (
    p_circle_id,
    v_user_id,
    v_code_hash,
    v_expires_at,
    p_max_uses
  )
  returning id into v_invite_id;

  return query
  select v_invite_id, v_invite_code, v_expires_at, p_max_uses;
end;
$$;

create or replace function public.revoke_circle_invite(p_invite_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  update public.circle_invites as invite
  set revoked_at = coalesce(invite.revoked_at, now())
  where invite.id = p_invite_id
    and public.is_circle_owner(invite.circle_id);

  if not found then
    raise exception using errcode = '42501', message = 'circle_owner_required';
  end if;
end;
$$;

create or replace function public.request_circle_join(p_invite_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_invite_id uuid;
  v_circle_id uuid;
  v_request_id uuid;
  v_code_hash text;
  v_has_pending_request boolean := false;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  if p_invite_code is null or p_invite_code !~ '^ks1_[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid_invite_code';
  end if;

  v_code_hash := pg_catalog.encode(
    extensions.digest(p_invite_code, 'sha256'),
    'hex'
  );

  select invite.id, invite.circle_id
    into v_invite_id, v_circle_id
  from public.circle_invites as invite
  where invite.code_hash = v_code_hash
    and invite.revoked_at is null
    and invite.expires_at > now()
    and invite.use_count < invite.max_uses;

  if not found then
    raise exception using errcode = 'P0001', message = 'invite_not_available';
  end if;

  -- Serialize first-time and repeat submissions for one user/circle pair. This
  -- prevents two first submissions racing the partial pending-request index.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_circle_id::text || ':' || v_user_id::text, 0)
  );

  select request.id
    into v_request_id
  from public.join_requests as request
  where request.circle_id = v_circle_id
    and request.requester_id = v_user_id
    and request.status = 'pending'
  for update;

  v_has_pending_request := found;

  if exists (
    select 1
    from public.circle_members as membership
    where membership.circle_id = v_circle_id
      and membership.user_id = v_user_id
      and membership.status = 'approved'
  ) then
    raise exception using errcode = 'P0001', message = 'already_a_member';
  end if;

  -- Existing requests are locked before invites, matching decide_join_request.
  -- For a first request there is no request row that an approver can lock yet.
  perform 1
  from public.circle_invites as invite
  where invite.id = v_invite_id
    and invite.circle_id = v_circle_id
    and invite.revoked_at is null
    and invite.expires_at > now()
    and invite.use_count < invite.max_uses
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'invite_not_available';
  end if;

  if v_has_pending_request then
    update public.join_requests
    set invite_id = v_invite_id
    where id = v_request_id;

    return v_request_id;
  end if;

  insert into public.join_requests (
    circle_id,
    requester_id,
    invite_id
  )
  values (
    v_circle_id,
    v_user_id,
    v_invite_id
  )
  returning id into v_request_id;

  return v_request_id;
end;
$$;

create or replace function public.decide_join_request(
  p_request_id uuid,
  p_decision text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_circle_id uuid;
  v_requester_id uuid;
  v_invite_id uuid;
  v_status text;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'invalid_join_decision';
  end if;

  select request.circle_id, request.requester_id, request.invite_id, request.status
    into v_circle_id, v_requester_id, v_invite_id, v_status
  from public.join_requests as request
  where request.id = p_request_id
  for update;

  if not found or v_status <> 'pending' then
    raise exception using errcode = 'P0001', message = 'join_request_not_pending';
  end if;

  if not public.is_circle_owner(v_circle_id) then
    raise exception using errcode = '42501', message = 'circle_owner_required';
  end if;

  if p_decision = 'approved' then
    perform 1
    from public.circle_invites as invite
    where invite.id = v_invite_id
      and invite.circle_id = v_circle_id
      and invite.revoked_at is null
      and invite.expires_at > now()
      and invite.use_count < invite.max_uses
    for update;

    if not found then
      raise exception using errcode = 'P0001', message = 'invite_not_available';
    end if;

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
      v_requester_id,
      'member',
      'approved',
      auth.uid(),
      now(),
      null
    )
    on conflict (circle_id, user_id) do update
      set role = 'member',
          status = 'approved',
          approved_by = excluded.approved_by,
          approved_at = excluded.approved_at,
          removed_at = null;

    update public.circle_invites
    set use_count = use_count + 1
    where id = v_invite_id;
  end if;

  update public.join_requests
  set status = p_decision,
      decided_by = auth.uid(),
      decided_at = now()
  where id = p_request_id;
end;
$$;

create or replace function public.cancel_join_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  update public.join_requests
  set status = 'cancelled',
      decided_at = now()
  where id = p_request_id
    and requester_id = auth.uid()
    and status = 'pending';

  if not found then
    raise exception using errcode = 'P0001', message = 'join_request_not_pending';
  end if;
end;
$$;

create or replace function public.remove_circle_member(
  p_circle_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
begin
  select circle.owner_id
    into v_owner_id
  from public.circles as circle
  where circle.id = p_circle_id
  for update;

  if not found or v_owner_id <> auth.uid() or not public.is_circle_owner(p_circle_id) then
    raise exception using errcode = '42501', message = 'circle_owner_required';
  end if;

  if p_user_id = v_owner_id then
    raise exception using errcode = '22023', message = 'transfer_ownership_before_removing_owner';
  end if;

  update public.circle_members
  set role = 'member',
      status = 'removed',
      removed_at = now()
  where circle_id = p_circle_id
    and user_id = p_user_id
    and status = 'approved';

  if not found then
    raise exception using errcode = 'P0001', message = 'approved_member_not_found';
  end if;
end;
$$;

create or replace function public.transfer_circle_ownership(
  p_circle_id uuid,
  p_new_owner_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_owner_id uuid;
begin
  select circle.owner_id
    into v_current_owner_id
  from public.circles as circle
  where circle.id = p_circle_id
  for update;

  if not found
    or v_current_owner_id <> auth.uid()
    or not public.is_circle_owner(p_circle_id)
  then
    raise exception using errcode = '42501', message = 'circle_owner_required';
  end if;

  if p_new_owner_id = v_current_owner_id then
    return;
  end if;

  if not exists (
    select 1
    from public.circle_members as membership
    where membership.circle_id = p_circle_id
      and membership.user_id = p_new_owner_id
      and membership.status = 'approved'
  ) then
    raise exception using errcode = '22023', message = 'new_owner_must_be_an_approved_member';
  end if;

  update public.circle_members
  set role = 'member'
  where circle_id = p_circle_id
    and user_id = v_current_owner_id;

  update public.circle_members
  set role = 'owner'
  where circle_id = p_circle_id
    and user_id = p_new_owner_id;

  update public.circles
  set owner_id = p_new_owner_id
  where id = p_circle_id;
end;
$$;

revoke all on function public.create_circle_invite(uuid, interval, integer) from public, anon, authenticated;
revoke all on function public.revoke_circle_invite(uuid) from public, anon, authenticated;
revoke all on function public.request_circle_join(text) from public, anon, authenticated;
revoke all on function public.decide_join_request(uuid, text) from public, anon, authenticated;
revoke all on function public.cancel_join_request(uuid) from public, anon, authenticated;
revoke all on function public.remove_circle_member(uuid, uuid) from public, anon, authenticated;
revoke all on function public.transfer_circle_ownership(uuid, uuid) from public, anon, authenticated;

grant execute on function public.create_circle_invite(uuid, interval, integer) to authenticated;
grant execute on function public.revoke_circle_invite(uuid) to authenticated;
grant execute on function public.request_circle_join(text) to authenticated;
grant execute on function public.decide_join_request(uuid, text) to authenticated;
grant execute on function public.cancel_join_request(uuid) to authenticated;
grant execute on function public.remove_circle_member(uuid, uuid) to authenticated;
grant execute on function public.transfer_circle_ownership(uuid, uuid) to authenticated;

create or replace function public.storage_object_circle_id(p_name text)
returns uuid
language sql
immutable
strict
set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 1)
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then split_part(p_name, '/', 1)::uuid
    else null
  end;
$$;

revoke all on function public.storage_object_circle_id(text) from public, anon, authenticated;
grant execute on function public.storage_object_circle_id(text) to authenticated;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'family-media',
  'family-media',
  false,
  26214400,
  array[
    'image/jpeg',
    'audio/aac',
    'audio/mp4',
    'audio/mpeg',
    'audio/wav',
    'audio/webm'
  ]::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

comment on function public.storage_object_circle_id(text) is
  'Parses the circle UUID from <circle>/<kind>/<uploader>/<immutable-file>.';

create policy family_media_read_by_approved_members
on storage.objects
for select
to authenticated
using (
  bucket_id = 'family-media'
  and public.is_approved_circle_member(public.storage_object_circle_id(name))
);

create policy family_media_insert_by_approved_members
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'family-media'
  and public.is_approved_circle_member(public.storage_object_circle_id(name))
  and split_part(name, '/', 2) in ('panoramas', 'thumbnails', 'voice')
  and split_part(name, '/', 3) = auth.uid()::text
  and array_length(storage.foldername(name), 1) = 3
  and split_part(name, '/', 4) <> ''
);

-- Objects are immutable to clients. Deletion/finalization is reserved for
-- trusted backend jobs.

commit;

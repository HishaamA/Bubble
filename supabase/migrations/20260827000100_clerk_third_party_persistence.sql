begin;

-- Clerk's native Supabase integration authenticates with an OIDC `sub` claim.
-- Clerk subjects are strings such as `user_...`, not Supabase Auth UUIDs. Keep
-- the existing internal UUID model, but map every trusted JWT subject to one
-- durable app user. The mapping preserves all existing foreign keys and avoids
-- creating synthetic rows inside Supabase's managed auth.users schema.

alter table public.profiles
  drop constraint if exists profiles_id_fkey;
alter table public.profile_preferences
  drop constraint if exists profile_preferences_user_id_fkey;
alter table public.circles
  drop constraint if exists circles_owner_id_fkey;
alter table public.circle_members
  drop constraint if exists circle_members_user_id_fkey,
  drop constraint if exists circle_members_approved_by_fkey;
alter table public.circle_invites
  drop constraint if exists circle_invites_created_by_fkey;
alter table public.join_requests
  drop constraint if exists join_requests_requester_id_fkey,
  drop constraint if exists join_requests_decided_by_fkey;
alter table public.family_moments
  drop constraint if exists family_moments_uploader_id_fkey;
alter table public.events
  drop constraint if exists events_created_by_fkey;
alter table public.event_guestbook_entries
  drop constraint if exists event_guestbook_entries_author_id_fkey;
alter table public.event_reminders
  drop constraint if exists event_reminders_user_id_fkey;
alter table public.notifications
  drop constraint if exists notifications_recipient_id_fkey;

alter table public.profile_preferences
  add column if not exists onboarding_completed_at timestamptz;

-- Repoint the former auth.users references to the app-owned profile identity.
-- This retains the original delete semantics without writing synthetic Clerk
-- users into Supabase's managed auth schema.
alter table public.profile_preferences
  add constraint profile_preferences_user_id_fkey
    foreign key (user_id) references public.profiles (id) on delete cascade;
alter table public.circles
  add constraint circles_owner_id_fkey
    foreign key (owner_id) references public.profiles (id) on delete restrict;
alter table public.circle_members
  add constraint circle_members_user_id_fkey
    foreign key (user_id) references public.profiles (id) on delete cascade,
  add constraint circle_members_approved_by_fkey
    foreign key (approved_by) references public.profiles (id) on delete set null;
alter table public.circle_invites
  add constraint circle_invites_created_by_fkey
    foreign key (created_by) references public.profiles (id) on delete set null;
alter table public.join_requests
  add constraint join_requests_requester_id_fkey
    foreign key (requester_id) references public.profiles (id) on delete cascade,
  add constraint join_requests_decided_by_fkey
    foreign key (decided_by) references public.profiles (id) on delete set null;
alter table public.family_moments
  add constraint family_moments_uploader_id_fkey
    foreign key (uploader_id) references public.profiles (id) on delete restrict;
alter table public.events
  add constraint events_created_by_fkey
    foreign key (created_by) references public.profiles (id) on delete restrict;
alter table public.event_guestbook_entries
  add constraint event_guestbook_entries_author_id_fkey
    foreign key (author_id) references public.profiles (id) on delete restrict;
alter table public.event_reminders
  add constraint event_reminders_user_id_fkey
    foreign key (user_id) references public.profiles (id) on delete cascade;
alter table public.notifications
  add constraint notifications_recipient_id_fkey
    foreign key (recipient_id) references public.profiles (id) on delete cascade;

-- The MVP intentionally has one active family per person. The unique index is
-- the final concurrency-safe guard; migrations fail atomically rather than
-- silently choosing or deleting one family if legacy data already violates
-- the invariant.
create unique index circle_members_one_approved_family_per_user
  on public.circle_members (user_id)
  where status = 'approved';

comment on index public.circle_members_one_approved_family_per_user is
  'MVP invariant: one approved family membership per app user; pending and removed rows may coexist.';

create or replace function public.enforce_single_approved_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'approved' then
    return new;
  end if;

  -- Serialize family creation and approvals for one person so callers receive
  -- the domain error before the unique index has to resolve a race.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'kinsphere-approved-family:' || new.user_id::text,
      0
    )
  );

  if exists (
    select 1
    from public.circle_members as membership
    where membership.user_id = new.user_id
      and membership.status = 'approved'
      and membership.circle_id <> new.circle_id
  ) then
    raise exception using errcode = 'P0001', message = 'already_a_member';
  end if;

  return new;
end;
$$;

create or replace function public.reject_join_when_already_approved()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'pending' then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'kinsphere-approved-family:' || new.requester_id::text,
      0
    )
  );

  if exists (
    select 1
    from public.circle_members as membership
    where membership.user_id = new.requester_id
      and membership.status = 'approved'
  ) then
    raise exception using errcode = 'P0001', message = 'already_a_member';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_single_approved_membership()
  from public, anon, authenticated;
revoke all on function public.reject_join_when_already_approved()
  from public, anon, authenticated;

create trigger circle_members_enforce_one_approved_family
before insert or update of user_id, circle_id, status
on public.circle_members
for each row execute function public.enforce_single_approved_membership();

create trigger join_requests_reject_approved_user
before insert or update
on public.join_requests
for each row execute function public.reject_join_when_already_approved();

-- Email is intentionally separated from the circle-readable profile table.
create table public.profile_private (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profile_private_email_length
    check (email is null or char_length(email) between 3 and 320)
);

create trigger profile_private_set_updated_at
before update on public.profile_private
for each row execute function public.set_updated_at();

alter table public.profile_private enable row level security;
revoke all on table public.profile_private from public, anon, authenticated;
grant all on table public.profile_private to service_role;

create table public.app_identities (
  subject text primary key,
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  provider text not null default 'clerk',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint app_identities_subject_length
    check (char_length(subject) between 1 and 255),
  constraint app_identities_provider
    check (provider in ('clerk', 'supabase'))
);

comment on table public.app_identities is
  'Private mapping from a verified OIDC JWT subject to the stable internal UUID used by Bubble rows. Never writable or directly readable by clients.';

comment on column public.profile_private.email is
  'Display-only email metadata supplied by the signed-in client. It is not independently verified here and must never be used for authorization or contact until a trusted Clerk webhook or verified JWT claim supplies it.';

insert into public.app_identities (subject, user_id, provider)
select profile.id::text, profile.id, 'supabase'
from public.profiles as profile
on conflict (subject) do nothing;

alter table public.app_identities enable row level security;
revoke all on table public.app_identities from public, anon, authenticated;
grant all on table public.app_identities to service_role;

create or replace function public.current_auth_subject()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(auth.jwt() ->> 'sub', '');
$$;

create or replace function public.current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select identity.user_id
  from public.app_identities as identity
  where identity.subject = public.current_auth_subject();
$$;

revoke all on function public.current_auth_subject()
  from public, anon, authenticated;
revoke all on function public.current_app_user_id()
  from public, anon, authenticated;
grant execute on function public.current_auth_subject()
  to authenticated, service_role;
grant execute on function public.current_app_user_id()
  to authenticated, service_role;

create or replace function public.bootstrap_current_user(
  p_display_name text default null,
  p_email text default null
)
returns table (
  user_id uuid,
  subject text,
  display_name text,
  email text,
  onboarding_completed boolean,
  onboarding_completed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject text := public.current_auth_subject();
  v_user_id uuid;
  v_display_name text;
  v_email text;
begin
  if v_subject is null or char_length(v_subject) > 255 then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  -- Serialize the first request for one subject without exposing the mapping.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('kinsphere-identity:' || v_subject, 0)
  );

  select identity.user_id
    into v_user_id
  from public.app_identities as identity
  where identity.subject = v_subject;

  if v_user_id is null then
    -- Preserve an existing Supabase Auth profile when migrating a UUID subject;
    -- Clerk subjects receive a fresh internal UUID.
    if v_subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and exists (
        select 1 from public.profiles where id = v_subject::uuid
      )
    then
      v_user_id := v_subject::uuid;
    else
      v_user_id := extensions.gen_random_uuid();
    end if;
  end if;

  v_display_name := left(
    coalesce(
      nullif(btrim(p_display_name), ''),
      nullif(btrim(auth.jwt() ->> 'name'), ''),
      'Family member'
    ),
    80
  );
  v_email := left(nullif(btrim(p_email), ''), 320);

  insert into public.profiles (id, display_name)
  values (v_user_id, v_display_name)
  on conflict (id) do update
  set display_name = case
        when nullif(btrim(p_display_name), '') is not null
          then excluded.display_name
        else public.profiles.display_name
      end;

  insert into public.profile_private (user_id, email)
  values (v_user_id, v_email)
  on conflict (user_id) do update
  set email = coalesce(excluded.email, public.profile_private.email);

  insert into public.profile_preferences (user_id)
  values (v_user_id)
  on conflict (user_id) do nothing;

  insert into public.app_identities (subject, user_id, provider)
  values (
    v_subject,
    v_user_id,
    case when left(v_subject, 5) = 'user_' then 'clerk' else 'supabase' end
  )
  on conflict (subject) do update
  set last_seen_at = now();

  return query
  select
    profile.id,
    v_subject,
    profile.display_name,
    private_profile.email,
    preference.onboarding_completed_at is not null,
    preference.onboarding_completed_at
  from public.profiles as profile
  join public.profile_private as private_profile
    on private_profile.user_id = profile.id
  join public.profile_preferences as preference
    on preference.user_id = profile.id
  where profile.id = v_user_id;
end;
$$;

create or replace function public.complete_current_user_onboarding()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_completed_at timestamptz;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'profile_bootstrap_required';
  end if;

  update public.profile_preferences
  set onboarding_completed_at = coalesce(onboarding_completed_at, now())
  where user_id = v_user_id
  returning onboarding_completed_at into v_completed_at;

  if not found then
    raise exception using errcode = 'P0001', message = 'profile_preferences_missing';
  end if;

  return v_completed_at;
end;
$$;

revoke all on function public.bootstrap_current_user(text, text)
  from public, anon, authenticated;
revoke all on function public.complete_current_user_onboarding()
  from public, anon, authenticated;
grant execute on function public.bootstrap_current_user(text, text)
  to authenticated, service_role;
grant execute on function public.complete_current_user_onboarding()
  to authenticated, service_role;

-- Keep the legacy Supabase Auth trigger functional while Clerk becomes the
-- primary identity provider. Production Clerk users are provisioned through
-- bootstrap_current_user because third-party auth does not create auth.users.
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
      nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Family member'
    ),
    80
  );

  insert into public.profiles (id, display_name)
  values (new.id, v_display_name)
  on conflict (id) do nothing;

  insert into public.profile_private (user_id, email)
  values (new.id, new.email)
  on conflict (user_id) do update
  set email = coalesce(excluded.email, public.profile_private.email);

  insert into public.profile_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  insert into public.app_identities (subject, user_id, provider)
  values (new.id::text, new.id, 'supabase')
  on conflict (subject) do update set last_seen_at = now();

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

-- Dropping profiles(id) -> auth.users(id) is required for Clerk subjects, but
-- legacy Supabase Auth users must retain the former deletion lifecycle. This
-- trusted trigger removes only the profile mapped to the deleted legacy UUID;
-- app-owned children then follow their declared cascade/restrict semantics.
create or replace function public.handle_deleted_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.profiles as profile
  where profile.id = old.id
    and exists (
      select 1
      from public.app_identities as identity
      where identity.subject = old.id::text
        and identity.user_id = old.id
        and identity.provider = 'supabase'
    );

  return old;
end;
$$;

revoke all on function public.handle_deleted_auth_user()
  from public, anon, authenticated;

drop trigger if exists on_auth_user_deleted on auth.users;
create trigger on_auth_user_deleted
after delete on auth.users
for each row execute function public.handle_deleted_auth_user();

-- Upgrade every existing application function that used auth.uid(). This is
-- deliberately limited to the known Bubble functions and preserves their
-- signatures, validation, grants and fixed search paths.
do $$
declare
  v_function oid;
  v_definition text;
begin
  for v_function in
    select proc.oid
    from pg_catalog.pg_proc as proc
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = proc.pronamespace
    where namespace.nspname = 'public'
      and proc.proname = any (array[
        'is_approved_circle_member',
        'is_circle_owner',
        'shares_approved_circle',
        'create_circle_invite',
        'revoke_circle_invite',
        'request_circle_join',
        'decide_join_request',
        'cancel_join_request',
        'remove_circle_member',
        'transfer_circle_ownership',
        'get_or_create_daily_capture_window',
        'finalize_360_moment',
        'create_family_event',
        'set_event_reminder',
        'mark_notification_read',
        'cancel_event_reminder'
      ])
  loop
    v_definition := pg_catalog.pg_get_functiondef(v_function);
    if pg_catalog.strpos(v_definition, 'auth.uid()') > 0 then
      execute pg_catalog.replace(
        v_definition,
        'auth.uid()',
        'public.current_app_user_id()'
      );
    end if;
  end loop;
end;
$$;

drop policy if exists profiles_read_self_or_shared_circle on public.profiles;
drop policy if exists profiles_insert_self on public.profiles;
drop policy if exists profiles_update_self on public.profiles;
drop policy if exists profile_preferences_read_self on public.profile_preferences;
drop policy if exists profile_preferences_insert_self on public.profile_preferences;
drop policy if exists profile_preferences_update_self on public.profile_preferences;
drop policy if exists circles_create_as_owner on public.circles;
drop policy if exists circles_update_by_owner on public.circles;
drop policy if exists join_requests_read_requester_or_owner on public.join_requests;
drop policy if exists event_guestbook_add_by_approved_members on public.event_guestbook_entries;
drop policy if exists event_reminders_read_own on public.event_reminders;
drop policy if exists notifications_read_own on public.notifications;

create policy profiles_read_self_or_shared_circle
on public.profiles
for select
to authenticated
using (
  id = public.current_app_user_id()
  or public.shares_approved_circle(id)
);

create policy profiles_insert_self
on public.profiles
for insert
to authenticated
with check (id = public.current_app_user_id());

create policy profiles_update_self
on public.profiles
for update
to authenticated
using (id = public.current_app_user_id())
with check (id = public.current_app_user_id());

create policy profile_preferences_read_self
on public.profile_preferences
for select
to authenticated
using (user_id = public.current_app_user_id());

create policy profile_preferences_insert_self
on public.profile_preferences
for insert
to authenticated
with check (user_id = public.current_app_user_id());

create policy profile_preferences_update_self
on public.profile_preferences
for update
to authenticated
using (user_id = public.current_app_user_id())
with check (user_id = public.current_app_user_id());

create policy circles_create_as_owner
on public.circles
for insert
to authenticated
with check (owner_id = public.current_app_user_id());

create policy circles_update_by_owner
on public.circles
for update
to authenticated
using (public.is_circle_owner(id))
with check (
  owner_id = public.current_app_user_id()
  and public.is_circle_owner(id)
);

create policy join_requests_read_requester_or_owner
on public.join_requests
for select
to authenticated
using (
  requester_id = public.current_app_user_id()
  or public.is_circle_owner(circle_id)
);

create policy event_guestbook_add_by_approved_members
on public.event_guestbook_entries
for insert
to authenticated
with check (
  author_id = public.current_app_user_id()
  and exists (
    select 1
    from public.events as family_event
    where family_event.id = event_id
      and public.is_approved_circle_member(family_event.circle_id)
  )
);

create policy event_reminders_read_own
on public.event_reminders
for select
to authenticated
using (
  user_id = public.current_app_user_id()
  and exists (
    select 1
    from public.events as family_event
    where family_event.id = event_id
      and public.is_approved_circle_member(family_event.circle_id)
  )
);

create policy notifications_read_own
on public.notifications
for select
to authenticated
using (
  recipient_id = public.current_app_user_id()
  and public.is_approved_circle_member(circle_id)
);

drop policy if exists family_media_insert_by_approved_members on storage.objects;

create policy family_media_insert_by_approved_members
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'family-media'
  and public.is_approved_circle_member(public.storage_object_circle_id(name))
  and split_part(name, '/', 2) in ('panoramas', 'thumbnails', 'voice')
  and split_part(name, '/', 3) = public.current_app_user_id()::text
  and array_length(storage.foldername(name), 1) = 3
  and split_part(name, '/', 4) <> ''
);

-- Immutable uploads are scoped to the internal app user resolved from the
-- verified Clerk JWT subject.

comment on column public.profile_preferences.onboarding_completed_at is
  'Durable tutorial completion for the authenticated identity; null until the user finishes onboarding.';

commit;

begin;

-- RETURNS TABLE exposes user_id and subject as PL/pgSQL variables. Explicit
-- constraint names keep ON CONFLICT from ambiguously resolving those names.
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('kinsphere-identity:' || v_subject, 0)
  );

  select identity.user_id
    into v_user_id
  from public.app_identities as identity
  where identity.subject = v_subject;

  if v_user_id is null then
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
  on conflict on constraint profiles_pkey do update
  set display_name = case
        when nullif(btrim(p_display_name), '') is not null
          then excluded.display_name
        else public.profiles.display_name
      end;

  insert into public.profile_private (user_id, email)
  values (v_user_id, v_email)
  on conflict on constraint profile_private_pkey do update
  set email = coalesce(excluded.email, public.profile_private.email);

  insert into public.profile_preferences (user_id)
  values (v_user_id)
  on conflict on constraint profile_preferences_pkey do nothing;

  insert into public.app_identities (subject, user_id, provider)
  values (
    v_subject,
    v_user_id,
    case when left(v_subject, 5) = 'user_' then 'clerk' else 'supabase' end
  )
  on conflict on constraint app_identities_pkey do update
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

revoke all on function public.bootstrap_current_user(text, text)
  from public, anon, authenticated;
grant execute on function public.bootstrap_current_user(text, text)
  to authenticated, service_role;

commit;

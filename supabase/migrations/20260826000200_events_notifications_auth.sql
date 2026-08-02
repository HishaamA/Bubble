begin;

-- OAuth and phone-only accounts do not always include an email address. Keep
-- profile creation deterministic across Google, Apple, and SMS identities.
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

  insert into public.profile_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

create table public.events (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete restrict,
  title text not null,
  details text,
  location text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint events_title_length
    check (char_length(btrim(title)) between 1 and 120),
  constraint events_details_length
    check (details is null or char_length(details) <= 2000),
  constraint events_location_length
    check (location is null or char_length(location) <= 240),
  constraint events_time_order
    check (ends_at is null or ends_at > starts_at)
);

create index events_circle_starts_idx
  on public.events (circle_id, starts_at, id);

create table public.event_guestbook_entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  author_id uuid not null references auth.users (id) on delete restrict,
  body text not null,
  created_at timestamptz not null default now(),
  constraint event_guestbook_body_length
    check (char_length(btrim(body)) between 1 and 500)
);

create index event_guestbook_event_created_idx
  on public.event_guestbook_entries (event_id, created_at, id);

create table public.event_reminders (
  event_id uuid not null references public.events (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  remind_at timestamptz not null,
  status text not null default 'scheduled',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id),
  constraint event_reminders_status
    check (status in ('scheduled', 'sent', 'cancelled'))
);

create index event_reminders_due_idx
  on public.event_reminders (remind_at, event_id, user_id)
  where status = 'scheduled';

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles (id) on delete cascade,
  recipient_id uuid not null references auth.users (id) on delete cascade,
  event_id uuid references public.events (id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  available_at timestamptz not null default now(),
  read_at timestamptz,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  constraint notifications_kind
    check (kind in ('event_reminder', 'family_moment', 'family_invite')),
  constraint notifications_title_length
    check (char_length(btrim(title)) between 1 and 160),
  constraint notifications_body_length
    check (body is null or char_length(body) <= 500),
  constraint notifications_idempotency_length
    check (char_length(idempotency_key) between 1 and 240)
);

create index notifications_recipient_available_idx
  on public.notifications (recipient_id, available_at desc, id desc);

create table public.scheduled_jobs (
  id uuid primary key default gen_random_uuid(),
  circle_id uuid not null references public.circles (id) on delete cascade,
  kind text not null,
  run_at timestamptz not null,
  status text not null default 'pending',
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text not null unique,
  attempt_count integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduled_jobs_kind
    check (kind in ('event_reminder')),
  constraint scheduled_jobs_status
    check (status in ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  constraint scheduled_jobs_attempt_count
    check (attempt_count between 0 and 20),
  constraint scheduled_jobs_idempotency_length
    check (char_length(idempotency_key) between 1 and 240)
);

create index scheduled_jobs_due_idx
  on public.scheduled_jobs (run_at, id)
  where status in ('pending', 'failed');

create trigger events_set_updated_at
before update on public.events
for each row execute function public.set_updated_at();

create trigger event_reminders_set_updated_at
before update on public.event_reminders
for each row execute function public.set_updated_at();

create trigger scheduled_jobs_set_updated_at
before update on public.scheduled_jobs
for each row execute function public.set_updated_at();

alter table public.events enable row level security;
alter table public.event_guestbook_entries enable row level security;
alter table public.event_reminders enable row level security;
alter table public.notifications enable row level security;
alter table public.scheduled_jobs enable row level security;

create policy events_read_by_approved_members
on public.events
for select
to authenticated
using (public.is_approved_circle_member(circle_id));

create policy event_guestbook_read_by_approved_members
on public.event_guestbook_entries
for select
to authenticated
using (
  exists (
    select 1
    from public.events as family_event
    where family_event.id = event_id
      and public.is_approved_circle_member(family_event.circle_id)
  )
);

create policy event_guestbook_add_by_approved_members
on public.event_guestbook_entries
for insert
to authenticated
with check (
  author_id = auth.uid()
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
  user_id = auth.uid()
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
  recipient_id = auth.uid()
  and public.is_approved_circle_member(circle_id)
);

-- Creation is intentionally an RPC so membership, the server clock, and the
-- optional reminder job are committed together.
create or replace function public.create_family_event(
  p_circle_id uuid,
  p_title text,
  p_starts_at timestamptz,
  p_location text default null,
  p_details text default null,
  p_remind_before interval default interval '1 day'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_event_id uuid;
  v_remind_at timestamptz;
  v_idempotency_key text;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  if not public.is_approved_circle_member(p_circle_id) then
    raise exception using errcode = '42501', message = 'approved_membership_required';
  end if;

  if p_title is null or char_length(btrim(p_title)) not between 1 and 120 then
    raise exception using errcode = '22023', message = 'event_title_out_of_range';
  end if;

  if p_location is not null and char_length(btrim(p_location)) > 240 then
    raise exception using errcode = '22023', message = 'event_location_out_of_range';
  end if;

  if p_details is not null and char_length(btrim(p_details)) > 2000 then
    raise exception using errcode = '22023', message = 'event_details_out_of_range';
  end if;

  if p_starts_at is null or p_starts_at <= now() then
    raise exception using errcode = '22023', message = 'event_must_be_in_the_future';
  end if;

  if p_remind_before is not null
    and (p_remind_before < interval '5 minutes' or p_remind_before > interval '30 days')
  then
    raise exception using errcode = '22023', message = 'reminder_interval_out_of_range';
  end if;

  insert into public.events (
    circle_id,
    created_by,
    title,
    details,
    location,
    starts_at
  )
  values (
    p_circle_id,
    v_user_id,
    btrim(p_title),
    nullif(btrim(p_details), ''),
    nullif(btrim(p_location), ''),
    p_starts_at
  )
  returning id into v_event_id;

  if p_remind_before is not null then
    v_remind_at := greatest(now(), p_starts_at - p_remind_before);
    v_idempotency_key := 'event-reminder:' || v_event_id::text || ':' || v_user_id::text;

    insert into public.event_reminders (event_id, user_id, remind_at)
    values (v_event_id, v_user_id, v_remind_at);

    insert into public.scheduled_jobs (
      circle_id,
      kind,
      run_at,
      payload,
      idempotency_key
    )
    values (
      p_circle_id,
      'event_reminder',
      v_remind_at,
      jsonb_build_object('event_id', v_event_id, 'recipient_id', v_user_id),
      v_idempotency_key
    );
  end if;

  return v_event_id;
end;
$$;

create or replace function public.set_event_reminder(
  p_event_id uuid,
  p_remind_before interval
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_event public.events%rowtype;
  v_remind_at timestamptz;
  v_idempotency_key text;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select * into v_event
  from public.events
  where id = p_event_id;

  if v_event.id is null
    or not public.is_approved_circle_member(v_event.circle_id)
  then
    raise exception using errcode = '42501', message = 'approved_membership_required';
  end if;

  if v_event.starts_at <= now() then
    raise exception using errcode = '22023', message = 'event_has_started';
  end if;

  if p_remind_before is null
    or p_remind_before < interval '5 minutes'
    or p_remind_before > interval '30 days'
  then
    raise exception using errcode = '22023', message = 'reminder_interval_out_of_range';
  end if;

  v_remind_at := greatest(now(), v_event.starts_at - p_remind_before);
  v_idempotency_key := 'event-reminder:' || p_event_id::text || ':' || v_user_id::text;

  insert into public.event_reminders (event_id, user_id, remind_at, status)
  values (p_event_id, v_user_id, v_remind_at, 'scheduled')
  on conflict (event_id, user_id) do update
  set remind_at = excluded.remind_at,
      status = 'scheduled';

  insert into public.scheduled_jobs (
    circle_id,
    kind,
    run_at,
    payload,
    idempotency_key
  )
  values (
    v_event.circle_id,
    'event_reminder',
    v_remind_at,
    jsonb_build_object('event_id', p_event_id, 'recipient_id', v_user_id),
    v_idempotency_key
  )
  on conflict (idempotency_key) do update
  set run_at = excluded.run_at,
      payload = excluded.payload,
      status = 'pending',
      attempt_count = 0,
      last_error = null;

  return v_remind_at;
end;
$$;

create or replace function public.mark_notification_read(p_notification_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.notifications
  set read_at = coalesce(read_at, now())
  where id = p_notification_id
    and recipient_id = auth.uid();

  if not found then
    raise exception using errcode = '42501', message = 'notification_not_available';
  end if;
end;
$$;

create or replace function public.cancel_event_reminder(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_idempotency_key text;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  v_idempotency_key := 'event-reminder:' || p_event_id::text || ':' || v_user_id::text;

  update public.event_reminders as reminder
  set status = 'cancelled'
  where reminder.event_id = p_event_id
    and reminder.user_id = v_user_id;

  update public.scheduled_jobs
  set status = 'cancelled'
  where idempotency_key = v_idempotency_key
    and status in ('pending', 'failed');
end;
$$;

-- Invoke from a trusted Supabase cron/Edge Function. This writes the durable
-- in-app notification first; a push transport can then send only a generic nudge.
create or replace function public.dispatch_due_event_reminders(p_limit integer default 100)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.scheduled_jobs%rowtype;
  v_event public.events%rowtype;
  v_recipient uuid;
  v_processed integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception using errcode = '22023', message = 'dispatch_limit_out_of_range';
  end if;

  for v_job in
    select *
    from public.scheduled_jobs
    where kind = 'event_reminder'
      and status in ('pending', 'failed')
      and run_at <= now()
    order by run_at, id
    limit p_limit
    for update skip locked
  loop
    v_recipient := (v_job.payload ->> 'recipient_id')::uuid;
    select * into v_event
    from public.events
    where id = (v_job.payload ->> 'event_id')::uuid;

    if v_event.id is null
      or v_event.circle_id <> v_job.circle_id
      or not exists (
        select 1
        from public.circle_members
        where circle_id = v_job.circle_id
          and user_id = v_recipient
          and status = 'approved'
      )
      or not exists (
        select 1
        from public.event_reminders as reminder
        where reminder.event_id = v_event.id
          and reminder.user_id = v_recipient
          and reminder.status = 'scheduled'
      )
    then
      update public.scheduled_jobs
      set status = 'cancelled',
          last_error = 'event_or_membership_unavailable'
      where id = v_job.id;
      continue;
    end if;

    insert into public.notifications (
      circle_id,
      recipient_id,
      event_id,
      kind,
      title,
      body,
      available_at,
      idempotency_key
    )
    values (
      v_event.circle_id,
      v_recipient,
      v_event.id,
      'event_reminder',
      'A family event is coming up',
      v_event.title,
      now(),
      v_job.idempotency_key
    )
    on conflict (idempotency_key) do nothing;

    update public.event_reminders
    set status = 'sent'
    where event_id = v_event.id
      and user_id = v_recipient;

    update public.scheduled_jobs
    set status = 'succeeded',
        attempt_count = least(attempt_count + 1, 20),
        last_error = null
    where id = v_job.id;

    v_processed := v_processed + 1;
  end loop;

  return v_processed;
end;
$$;

revoke all on table public.events from public, anon, authenticated;
revoke all on table public.event_guestbook_entries from public, anon, authenticated;
revoke all on table public.event_reminders from public, anon, authenticated;
revoke all on table public.notifications from public, anon, authenticated;
revoke all on table public.scheduled_jobs from public, anon, authenticated;

grant select on table public.events to authenticated;
grant select, insert on table public.event_guestbook_entries to authenticated;
grant select on table public.event_reminders to authenticated;
grant select on table public.notifications to authenticated;

revoke all on function public.create_family_event(uuid,text,timestamptz,text,text,interval)
  from public, anon, authenticated;
revoke all on function public.set_event_reminder(uuid,interval)
  from public, anon, authenticated;
revoke all on function public.mark_notification_read(uuid)
  from public, anon, authenticated;
revoke all on function public.cancel_event_reminder(uuid)
  from public, anon, authenticated;
revoke all on function public.dispatch_due_event_reminders(integer)
  from public, anon, authenticated;

grant execute on function public.create_family_event(uuid,text,timestamptz,text,text,interval)
  to authenticated;
grant execute on function public.set_event_reminder(uuid,interval)
  to authenticated;
grant execute on function public.mark_notification_read(uuid)
  to authenticated;
grant execute on function public.cancel_event_reminder(uuid)
  to authenticated;
grant execute on function public.dispatch_due_event_reminders(integer)
  to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'events'
    ) then
      alter publication supabase_realtime add table public.events;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'notifications'
    ) then
      alter publication supabase_realtime add table public.notifications;
    end if;
  end if;
end;
$$;

commit;

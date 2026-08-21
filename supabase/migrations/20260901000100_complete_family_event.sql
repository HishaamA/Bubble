begin;

-- Plans are collaborative family tasks. Completing one removes it from the
-- shared calendar for every approved member and lets the existing foreign-key
-- cascades clean up its reminders and guestbook entries in the same transaction.
create or replace function public.complete_family_event(
  p_event_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_circle_id uuid;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  select family_event.circle_id
    into v_circle_id
  from public.events as family_event
  where family_event.id = p_event_id
  for update;

  if not found then
    return false;
  end if;

  if not public.is_approved_circle_member(v_circle_id) then
    raise exception using errcode = '42501', message = 'approved_membership_required';
  end if;

  delete from public.events as family_event
  where family_event.id = p_event_id;

  return found;
end;
$$;

comment on function public.complete_family_event(uuid) is
  'Completes a shared family plan by deleting it and its cascading reminders for every approved circle member.';

revoke all on function public.complete_family_event(uuid)
  from public, anon, authenticated;
grant execute on function public.complete_family_event(uuid)
  to authenticated;

commit;

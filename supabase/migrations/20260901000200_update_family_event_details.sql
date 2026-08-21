begin;

-- Any approved member can collaborate on a plan checklist, but this narrowly
-- scoped RPC cannot mutate its title, schedule, location, circle, or creator.
create or replace function public.update_family_event_details(
  p_event_id uuid,
  p_details text
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

  if p_details is not null and char_length(btrim(p_details)) > 2000 then
    raise exception using errcode = '22023', message = 'event_details_out_of_range';
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

  update public.events as family_event
  set
    details = nullif(btrim(p_details), ''),
    updated_at = now()
  where family_event.id = p_event_id;

  return found;
end;
$$;

comment on function public.update_family_event_details(uuid, text) is
  'Lets an approved family member update only the shared details of a family event.';

revoke all on function public.update_family_event_details(uuid, text)
  from public, anon, authenticated;
grant execute on function public.update_family_event_details(uuid, text)
  to authenticated;

commit;

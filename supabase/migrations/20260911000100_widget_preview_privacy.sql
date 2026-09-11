begin;

-- Widget content can be visible while a phone is locked or sitting nearby.
-- Keep names and family photos private until each account explicitly opts in.
alter table public.profile_preferences
  add column if not exists widget_previews_enabled boolean not null default false;

comment on column public.profile_preferences.widget_previews_enabled is
  'Whether the account permits task names and family photos in Home Screen widgets.';

grant insert (widget_previews_enabled)
  on table public.profile_preferences to authenticated;
grant update (widget_previews_enabled)
  on table public.profile_preferences to authenticated;

commit;

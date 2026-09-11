begin;

create table public.family_capsule_photo_reactions (
  item_id uuid not null references public.family_capsule_items (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  emoji text,
  updated_at timestamptz not null default now(),
  primary key (item_id, author_id),
  constraint family_capsule_photo_reactions_emoji
    check (emoji is null or emoji in ('❤️', '🥰', '😂', '😮', '👏'))
);

comment on table public.family_capsule_photo_reactions is
  'One current reaction per family member on an unlocked capsule photo. A null emoji clears the reaction while retaining a photo-filterable Realtime UPDATE.';

create index family_capsule_photo_reactions_author_idx
  on public.family_capsule_photo_reactions (author_id);

alter table public.family_capsule_photo_reactions enable row level security;

create policy family_capsule_photo_reactions_read_unlocked
on public.family_capsule_photo_reactions
for select to authenticated
using (
  exists (
    select 1
    from public.family_capsule_items as item
    join public.family_capsules as capsule
      on capsule.id = item.capsule_id and capsule.circle_id = item.circle_id
    where item.id = family_capsule_photo_reactions.item_id
      and capsule.opens_at <= now()
      and public.is_approved_circle_member(capsule.circle_id)
  )
);

create or replace function public.list_capsule_photo_reactions(p_item_id uuid)
returns table (emoji text, reaction_count integer, reacted_by_me boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  -- Use the same error for missing, sealed, and another family's photos.
  if not exists (
    select 1
    from public.family_capsule_items as item
    join public.family_capsules as capsule
      on capsule.id = item.capsule_id and capsule.circle_id = item.circle_id
    where item.id = p_item_id
      and capsule.opens_at <= now()
      and public.is_approved_circle_member(capsule.circle_id)
  ) then
    raise exception using errcode = '42501', message = 'capsule_photo_not_available';
  end if;

  return query
  select reaction.emoji,
    count(*)::integer,
    bool_or(reaction.author_id = v_user_id)
  from public.family_capsule_photo_reactions as reaction
  where reaction.item_id = p_item_id and reaction.emoji is not null
  group by reaction.emoji;
end;
$$;

create or replace function public.set_capsule_photo_reaction(p_item_id uuid, p_emoji text)
returns table (emoji text, reaction_count integer, reacted_by_me boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;

  if p_emoji is not null and p_emoji not in ('❤️', '🥰', '😂', '😮', '👏') then
    raise exception using errcode = '22023', message = 'invalid_photo_reaction';
  end if;

  perform 1
  from public.family_capsule_items as item
  join public.family_capsules as capsule
    on capsule.id = item.capsule_id and capsule.circle_id = item.circle_id
  where item.id = p_item_id
    and capsule.opens_at <= now()
    and public.is_approved_circle_member(capsule.circle_id)
  for share of item, capsule;

  if not found then
    raise exception using errcode = '42501', message = 'capsule_photo_not_available';
  end if;

  if p_emoji is null then
    update public.family_capsule_photo_reactions as reaction
    set emoji = null, updated_at = now()
    where reaction.item_id = p_item_id and reaction.author_id = v_user_id;
  else
    insert into public.family_capsule_photo_reactions (item_id, author_id, emoji)
    values (p_item_id, v_user_id, p_emoji)
    on conflict on constraint family_capsule_photo_reactions_pkey
    do update set emoji = excluded.emoji, updated_at = now();
  end if;

  return query select * from public.list_capsule_photo_reactions(p_item_id);
end;
$$;

revoke all on table public.family_capsule_photo_reactions from public, anon, authenticated;
grant select on table public.family_capsule_photo_reactions to authenticated;
grant all on table public.family_capsule_photo_reactions to service_role;

revoke all on function public.list_capsule_photo_reactions(uuid) from public, anon, authenticated;
revoke all on function public.set_capsule_photo_reaction(uuid, text) from public, anon, authenticated;
grant execute on function public.list_capsule_photo_reactions(uuid) to authenticated;
grant execute on function public.set_capsule_photo_reaction(uuid, text) to authenticated;

do $$
begin
  if exists (
    select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'family_capsule_photo_reactions'
  ) then
    alter publication supabase_realtime add table public.family_capsule_photo_reactions;
  end if;
end;
$$;

commit;

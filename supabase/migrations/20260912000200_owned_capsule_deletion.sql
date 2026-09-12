begin;

-- Keep the unique weekly shell so an automatic ensure() cannot recreate a
-- family week that its creator removed. Media remains hidden by parent RLS.
alter table public.family_capsules add column deleted_at timestamptz;

create table public.deleted_family_capsules (
  circle_id uuid not null references public.circles(id) on delete cascade,
  capsule_id uuid not null,
  creator_id uuid not null references public.profiles(id) on delete restrict,
  week_start date,
  was_published boolean not null default false,
  deleted_at timestamptz not null default now(),
  primary key (circle_id, creator_id, capsule_id)
);
create table public.deleted_family_capsule_photos (
  circle_id uuid not null references public.circles(id) on delete cascade,
  capsule_id uuid not null,
  photo_id uuid not null,
  uploader_id uuid not null references public.profiles(id) on delete restrict,
  was_published boolean not null default false,
  deleted_at timestamptz not null default now(),
  primary key (circle_id, uploader_id, photo_id)
);
create index deleted_capsules_pending_creator_time_idx
  on public.deleted_family_capsules(creator_id, deleted_at) where not was_published;
create index deleted_capsule_photos_pending_uploader_time_idx
  on public.deleted_family_capsule_photos(uploader_id, deleted_at) where not was_published;
alter table public.deleted_family_capsules enable row level security;
alter table public.deleted_family_capsule_photos enable row level security;
create policy deleted_capsules_read_by_family on public.deleted_family_capsules
  for select to authenticated using (
    public.is_approved_circle_member(circle_id)
    and (was_published or creator_id = public.current_app_user_id())
  );
create policy deleted_capsule_photos_read_by_family on public.deleted_family_capsule_photos
  for select to authenticated using (
    public.is_approved_circle_member(circle_id)
    and (
      uploader_id = public.current_app_user_id()
      or (was_published and exists (
        select 1 from public.family_capsules as capsule
        where capsule.id = deleted_family_capsule_photos.capsule_id and capsule.circle_id = deleted_family_capsule_photos.circle_id
          and capsule.opens_at <= now() and capsule.deleted_at is null
      ))
    )
  );
revoke all on public.deleted_family_capsules, public.deleted_family_capsule_photos from public, anon, authenticated;
grant select on public.deleted_family_capsules, public.deleted_family_capsule_photos to authenticated;
grant all on public.deleted_family_capsules, public.deleted_family_capsule_photos to service_role;

create function public.guard_deleted_capsule_creation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Same order as deletion; serialize pending create/cancel for this author.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('family-capsule-author:' || new.created_by::text, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('family-capsule:' || new.circle_id::text || ':' || new.created_by::text || ':' || new.id::text, 0));
  if exists (
    select 1 from public.deleted_family_capsules
    where circle_id = new.circle_id and creator_id = new.created_by and capsule_id = new.id
  ) then
    raise exception using errcode = '22023', message = 'capsule_was_deleted';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_deleted_capsule_creation() from public, anon, authenticated;
create trigger guard_deleted_capsule_creation before insert on public.family_capsules
  for each row execute function public.guard_deleted_capsule_creation();

create function public.guard_deleted_capsule_photo()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_deleted_at timestamptz;
begin
  -- Finalization already locks this parent. Direct privileged inserts use the
  -- same order, preventing a photo from racing a parent deletion.
  select deleted_at into v_deleted_at from public.family_capsules
    where id = new.capsule_id and circle_id = new.circle_id for update;
  if found and v_deleted_at is not null then
    raise exception using errcode = '22023', message = 'capsule_was_deleted';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('family-capsule-photo:' || new.circle_id::text || ':' || new.uploader_id::text || ':' || new.id::text, 0));
  if exists (
    select 1 from public.deleted_family_capsule_photos
    where circle_id = new.circle_id and uploader_id = new.uploader_id and photo_id = new.id
  ) then
    raise exception using errcode = '22023', message = 'capsule_photo_was_deleted';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_deleted_capsule_photo() from public, anon, authenticated;
create trigger guard_deleted_capsule_photo before insert on public.family_capsule_items
  for each row execute function public.guard_deleted_capsule_photo();

create function public.delete_family_capsule_photo(p_circle_id uuid, p_capsule_id uuid, p_photo_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_item public.family_capsule_items%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_circle_id is null or not public.is_approved_circle_member(p_circle_id) then
    raise exception using errcode = '42501', message = 'approved_circle_membership_required';
  end if;
  if p_capsule_id is null or p_photo_id is null then
    raise exception using errcode = '22023', message = 'capsule_and_photo_ids_required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('family-capsule-author:' || v_user_id::text, 0));
  perform 1 from public.family_capsules where id = p_capsule_id and circle_id = p_circle_id for update;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('family-capsule-photo:' || p_circle_id::text || ':' || v_user_id::text || ':' || p_photo_id::text, 0));
  select * into v_item from public.family_capsule_items where id = p_photo_id for update;
  if not found then
    if exists (select 1 from public.deleted_family_capsule_photos
      where circle_id = p_circle_id and uploader_id = v_user_id and photo_id = p_photo_id) then
      return true;
    end if;
    if (select count(*) from public.deleted_family_capsule_photos
      where uploader_id = v_user_id and not was_published and deleted_at >= now() - interval '24 hours') >= 1000 then
      raise exception using errcode = '54000', message = 'capsule_photo_cancellation_limit_reached';
    end if;
    insert into public.deleted_family_capsule_photos(circle_id, capsule_id, photo_id, uploader_id)
      values (p_circle_id, p_capsule_id, p_photo_id, v_user_id) on conflict do nothing;
    return true;
  end if;
  if v_item.circle_id <> p_circle_id or v_item.capsule_id <> p_capsule_id or v_item.uploader_id <> v_user_id then
    raise exception using errcode = '42501', message = 'capsule_photo_uploader_required';
  end if;
  insert into public.deleted_family_capsule_photos(circle_id, capsule_id, photo_id, uploader_id, was_published)
    values (p_circle_id, p_capsule_id, p_photo_id, v_user_id, true)
    on conflict (circle_id, uploader_id, photo_id) do update set was_published = true, capsule_id = excluded.capsule_id;
  delete from public.family_capsule_items where id = p_photo_id;
  update public.family_capsules set item_count = greatest(0, item_count - 1) where id = p_capsule_id;
  return true;
end;
$$;

create function public.delete_family_capsule(p_circle_id uuid, p_capsule_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_capsule public.family_capsules%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_circle_id is null or not public.is_approved_circle_member(p_circle_id) then
    raise exception using errcode = '42501', message = 'approved_circle_membership_required';
  end if;
  if p_capsule_id is null then
    raise exception using errcode = '22023', message = 'capsule_id_required';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('family-capsule-author:' || v_user_id::text, 0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('family-capsule:' || p_circle_id::text || ':' || v_user_id::text || ':' || p_capsule_id::text, 0));
  select * into v_capsule from public.family_capsules where id = p_capsule_id for update;
  if not found then
    if exists (select 1 from public.deleted_family_capsules
      where circle_id = p_circle_id and creator_id = v_user_id and capsule_id = p_capsule_id) then
      return true;
    end if;
    if (select count(*) from public.deleted_family_capsules
      where creator_id = v_user_id and not was_published and deleted_at >= now() - interval '24 hours') >= 1000 then
      raise exception using errcode = '54000', message = 'capsule_cancellation_limit_reached';
    end if;
    insert into public.deleted_family_capsules(circle_id, capsule_id, creator_id)
      values (p_circle_id, p_capsule_id, v_user_id) on conflict do nothing;
    return true;
  end if;
  if v_capsule.circle_id <> p_circle_id or v_capsule.created_by <> v_user_id then
    raise exception using errcode = '42501', message = 'capsule_creator_required';
  end if;
  insert into public.deleted_family_capsules(circle_id, capsule_id, creator_id, week_start, was_published)
    values (p_circle_id, p_capsule_id, v_user_id, v_capsule.week_start, true)
    on conflict (circle_id, creator_id, capsule_id) do update set was_published = true, week_start = excluded.week_start;
  update public.family_capsules set deleted_at = coalesce(deleted_at, now()), item_count = 0 where id = p_capsule_id;
  return true;
end;
$$;
revoke all on function public.delete_family_capsule_photo(uuid, uuid, uuid), public.delete_family_capsule(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_family_capsule_photo(uuid, uuid, uuid), public.delete_family_capsule(uuid, uuid) to authenticated;

drop policy family_capsules_read_by_approved_members on public.family_capsules;
create policy family_capsules_read_by_approved_members on public.family_capsules
  for select to authenticated using (deleted_at is null and public.is_approved_circle_member(circle_id));
drop policy family_capsule_items_read_at_unlock_or_own on public.family_capsule_items;
create policy family_capsule_items_read_at_unlock_or_own on public.family_capsule_items
  for select to authenticated using (
    public.is_approved_circle_member(circle_id) and exists (
      select 1 from public.family_capsules as capsule
      where capsule.id = family_capsule_items.capsule_id and capsule.circle_id = family_capsule_items.circle_id
        and capsule.deleted_at is null
        and (family_capsule_items.uploader_id = public.current_app_user_id() or capsule.opens_at <= now())
    )
  );

-- Existing Storage SELECT permits uploaders to read their canonical paths.
-- An additional restrictive guard must therefore look through RLS to exclude
-- media retained under a deleted parent, including for that media's uploader.
create function public.capsule_media_has_no_deleted_parent(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select case when public.is_approved_circle_member(public.storage_object_circle_id(p_name)) then
    not exists (
      select 1 from public.family_capsule_items as item
      join public.family_capsules as capsule on capsule.id = item.capsule_id
      where (item.image_path = p_name or item.thumbnail_path = p_name) and capsule.deleted_at is not null
    )
    else false
  end;
$$;
revoke all on function public.capsule_media_has_no_deleted_parent(text) from public, anon, authenticated;
grant execute on function public.capsule_media_has_no_deleted_parent(text) to authenticated;
create policy capsule_media_excludes_deleted_parent on storage.objects as restrictive
  for select to authenticated using (
    bucket_id <> 'family-media' or split_part(name, '/', 2) not in ('capsule-images', 'capsule-thumbnails')
    or public.capsule_media_has_no_deleted_parent(name)
  );

-- These RPCs are security-definer, so unlike normal reads they need an
-- explicit deleted-parent guard in addition to the table's RLS policy.
create or replace function public.list_capsule_photo_reactions(p_item_id uuid)
returns table (emoji text, reaction_count integer, reacted_by_me boolean)
language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid := public.current_app_user_id();
begin
  if v_user_id is null then raise exception using errcode = '42501', message = 'authentication_required'; end if;
  if not exists (
    select 1 from public.family_capsule_items as item
    join public.family_capsules as capsule on capsule.id = item.capsule_id and capsule.circle_id = item.circle_id
    where item.id = p_item_id and capsule.deleted_at is null and capsule.opens_at <= now()
      and public.is_approved_circle_member(capsule.circle_id)
  ) then raise exception using errcode = '42501', message = 'capsule_photo_not_available'; end if;
  return query select reaction.emoji, count(*)::integer, bool_or(reaction.author_id = v_user_id)
    from public.family_capsule_photo_reactions as reaction
    where reaction.item_id = p_item_id and reaction.emoji is not null group by reaction.emoji;
end;
$$;
create or replace function public.set_capsule_photo_reaction(p_item_id uuid, p_emoji text)
returns table (emoji text, reaction_count integer, reacted_by_me boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_capsule_id uuid;
begin
  if v_user_id is null then raise exception using errcode = '42501', message = 'authentication_required'; end if;
  if p_emoji is not null and p_emoji not in ('❤️', '🥰', '😂', '😮', '👏') then
    raise exception using errcode = '22023', message = 'invalid_photo_reaction';
  end if;
  select capsule_id into v_capsule_id from public.family_capsule_items where id = p_item_id;
  -- Explicit parent -> item ordering matches deletion and finalization even
  -- when the planner changes the join order of the availability lookup.
  perform 1 from public.family_capsules as capsule
    where capsule.id = v_capsule_id and capsule.deleted_at is null and capsule.opens_at <= now()
      and public.is_approved_circle_member(capsule.circle_id) for share;
  if not found then raise exception using errcode = '42501', message = 'capsule_photo_not_available'; end if;
  perform 1 from public.family_capsule_items where id = p_item_id and capsule_id = v_capsule_id for share;
  if not found then raise exception using errcode = '42501', message = 'capsule_photo_not_available'; end if;
  if p_emoji is null then
    update public.family_capsule_photo_reactions as reaction set emoji = null, updated_at = now()
      where reaction.item_id = p_item_id and reaction.author_id = v_user_id;
  else
    insert into public.family_capsule_photo_reactions(item_id, author_id, emoji) values (p_item_id, v_user_id, p_emoji)
      on conflict on constraint family_capsule_photo_reactions_pkey
      do update set emoji = excluded.emoji, updated_at = now();
  end if;
  return query select * from public.list_capsule_photo_reactions(p_item_id);
end;
$$;

do $$ begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.deleted_family_capsules, public.deleted_family_capsule_photos;
  end if;
end; $$;
commit;

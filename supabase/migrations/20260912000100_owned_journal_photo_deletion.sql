begin;

-- Retain only IDs, not photos or captions, to stop stale offline clients from
-- restoring an upload that its author deliberately removed.
create table public.deleted_family_journal_photos (
  photo_id uuid not null,
  circle_id uuid not null references public.circles(id) on delete cascade,
  uploader_id uuid not null references public.profiles(id) on delete restrict,
  deleted_at timestamptz not null default now(),
  was_published boolean not null default false,
  primary key (circle_id, uploader_id, photo_id)
);
create index deleted_family_journal_photos_circle_idx
  on public.deleted_family_journal_photos(circle_id, photo_id);
create index deleted_family_journal_photos_pending_uploader_time_idx
  on public.deleted_family_journal_photos(uploader_id, deleted_at)
  where not was_published;
alter table public.deleted_family_journal_photos enable row level security;
create policy deleted_journal_photos_read_by_family
  on public.deleted_family_journal_photos for select to authenticated
  using (
    public.is_approved_circle_member(circle_id)
    and (was_published or uploader_id = public.current_app_user_id())
  );
revoke all on public.deleted_family_journal_photos from public, anon, authenticated;
grant select on public.deleted_family_journal_photos to authenticated;
grant all on public.deleted_family_journal_photos to service_role;

create function public.reject_deleted_journal_photo()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.deleted_family_journal_photos
    where photo_id = new.id and circle_id = new.circle_id and uploader_id = new.uploader_id
  ) then
    raise exception using errcode = '22023', message = 'journal_photo_was_deleted';
  end if;
  return new;
end;
$$;
revoke all on function public.reject_deleted_journal_photo() from public, anon, authenticated;
create trigger reject_deleted_journal_photo before insert on public.family_journal_photos
  for each row execute function public.reject_deleted_journal_photo();

create function public.delete_family_journal_photo(p_circle_id uuid, p_photo_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_photo public.family_journal_photos%rowtype;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'authentication_required';
  end if;
  if p_circle_id is null or not public.is_approved_circle_member(p_circle_id) then
    raise exception using errcode = '42501', message = 'approved_circle_membership_required';
  end if;
  if p_photo_id is null then
    raise exception using errcode = '22023', message = 'photo_id_required';
  end if;
  -- Match finalization's uploader -> photo lock order. The uploader lock also
  -- makes the pending-cancellation quota safe under concurrent random-ID calls.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'family-journal-uploader:' || v_user_id::text, 0
  ));
  -- Same photo lock as finalization and unreferenced-object cleanup.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'family-journal-photo:' || p_circle_id::text || ':' || v_user_id::text || ':' || p_photo_id::text || '.jpg', 0
  ));
  select * into v_photo from public.family_journal_photos where id = p_photo_id for update;
  if not found then
    -- A timed-out upload may still be finalizing on the server. Cancel this
    -- exact uploader/family/photo identity under the finalizer's lock so it
    -- cannot resurrect later. Pending cancellations are visible only to their
    -- uploader and do not block another member using the same photo UUID.
    -- Existing retries and actual published-photo removals do not consume this
    -- allowance. Only new arbitrary-ID cancellations need a bounded daily cap.
    if exists (
      select 1 from public.deleted_family_journal_photos
      where photo_id = p_photo_id and circle_id = p_circle_id and uploader_id = v_user_id
    ) then
      return true;
    end if;
    if (
      select count(*) from public.deleted_family_journal_photos
      where uploader_id = v_user_id and not was_published
        and deleted_at >= now() - interval '24 hours'
    ) >= 1000 then
      raise exception using errcode = '54000', message = 'journal_photo_cancellation_limit_reached';
    end if;
    insert into public.deleted_family_journal_photos(photo_id, circle_id, uploader_id, was_published)
      values (p_photo_id, p_circle_id, v_user_id, false)
      on conflict (circle_id, uploader_id, photo_id) do nothing;
    return true;
  end if;
  if v_photo.circle_id <> p_circle_id or v_photo.uploader_id <> v_user_id then
    raise exception using errcode = '42501', message = 'journal_photo_uploader_required';
  end if;
  insert into public.deleted_family_journal_photos(photo_id, circle_id, uploader_id, was_published)
    values (v_photo.id, v_photo.circle_id, v_photo.uploader_id, true)
    on conflict (circle_id, uploader_id, photo_id) do update set was_published = true;
  delete from public.family_journal_photos where id = v_photo.id;
  return true;
end;
$$;
revoke all on function public.delete_family_journal_photo(uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_family_journal_photo(uuid, uuid) to authenticated;

do $$ begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.deleted_family_journal_photos;
  end if;
end; $$;

comment on function public.delete_family_journal_photo(uuid, uuid) is
  'Uploader-only, family-scoped Journal removal and in-flight cancellation. Published tombstones sync to family; pending cancellations stay uploader-private. Storage cleanup uses its existing uploader-only policy.';
commit;

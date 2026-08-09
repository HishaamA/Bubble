begin;

create table public.family_moment_comments (
  id uuid primary key default gen_random_uuid(),
  moment_id uuid not null,
  circle_id uuid not null,
  annotation_id text,
  author_id uuid not null references public.profiles (id) on delete restrict,
  author_display_name text not null,
  body text not null,
  created_at timestamptz not null default now(),
  constraint family_moment_comments_moment_circle_fk
    foreign key (moment_id, circle_id)
    references public.family_moments (id, circle_id)
    on delete cascade,
  constraint family_moment_comments_annotation_fk
    foreign key (moment_id, annotation_id)
    references public.family_moment_annotations (moment_id, id)
    on delete cascade,
  constraint family_moment_comments_annotation_id
    check (
      annotation_id is null
      or annotation_id ~ '^[a-z0-9][a-z0-9_-]{0,79}$'
    ),
  constraint family_moment_comments_author_name_length
    check (char_length(btrim(author_display_name)) between 1 and 80),
  constraint family_moment_comments_body_length
    check (char_length(btrim(body)) between 1 and 500)
);

comment on table public.family_moment_comments is
  'Family-visible discussion on a 360 moment. A null annotation_id targets the whole panorama; a non-null value replies to one embedded note.';

comment on column public.family_moment_comments.author_display_name is
  'Server-derived profile-name snapshot for stable Realtime and offline rendering; never supplied by the client.';

create index family_moment_comments_moment_created_idx
  on public.family_moment_comments (moment_id, created_at, id);

create index family_moment_comments_circle_created_idx
  on public.family_moment_comments (circle_id, created_at desc, id);

alter table public.family_moment_comments enable row level security;

create policy family_moment_comments_read_by_approved_members
on public.family_moment_comments
for select
to authenticated
using (
  public.is_approved_circle_member(family_moment_comments.circle_id)
  and exists (
    select 1
    from public.family_moments as family_moment
    where family_moment.id = family_moment_comments.moment_id
      and family_moment.circle_id = family_moment_comments.circle_id
      and family_moment.status = 'ready'
  )
);

-- Inserts go through this RPC so callers cannot spoof either their author ID
-- or display name, target a different circle, or reply to an annotation from
-- another private panorama.
create or replace function public.add_family_moment_comment(
  p_circle_id uuid,
  p_moment_id uuid,
  p_annotation_id text default null,
  p_body text default null
)
returns setof public.family_moment_comments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_app_user_id();
  v_display_name text;
  v_annotation_id text := nullif(btrim(p_annotation_id), '');
  v_body text := btrim(p_body);
begin
  if v_user_id is null then
    raise exception using
      errcode = '42501',
      message = 'profile_bootstrap_required';
  end if;

  -- Check membership before looking up a private moment or annotation so a
  -- caller cannot use error differences to probe another family.
  if p_circle_id is null
    or not public.is_approved_circle_member(p_circle_id)
  then
    raise exception using
      errcode = '42501',
      message = 'approved_circle_membership_required';
  end if;

  if p_moment_id is null or not exists (
    select 1
    from public.family_moments as family_moment
    where family_moment.id = p_moment_id
      and family_moment.circle_id = p_circle_id
      and family_moment.status = 'ready'
  ) then
    raise exception using
      errcode = 'P0002',
      message = 'family_moment_not_found';
  end if;

  if v_annotation_id is not null then
    if v_annotation_id !~ '^[a-z0-9][a-z0-9_-]{0,79}$' then
      raise exception using
        errcode = '22023',
        message = 'invalid_annotation_id';
    end if;

    if not exists (
      select 1
      from public.family_moment_annotations as annotation
      where annotation.moment_id = p_moment_id
        and annotation.circle_id = p_circle_id
        and annotation.id = v_annotation_id
    ) then
      raise exception using
        errcode = 'P0002',
        message = 'family_moment_annotation_not_found';
    end if;
  end if;

  if v_body is null or char_length(v_body) not between 1 and 500 then
    raise exception using
      errcode = '22023',
      message = 'comment_body_out_of_bounds';
  end if;

  select btrim(profile.display_name)
    into v_display_name
  from public.profiles as profile
  where profile.id = v_user_id;

  if v_display_name is null
    or char_length(v_display_name) not between 1 and 80
  then
    raise exception using
      errcode = '42501',
      message = 'valid_profile_required';
  end if;

  return query
  insert into public.family_moment_comments (
    moment_id,
    circle_id,
    annotation_id,
    author_id,
    author_display_name,
    body
  )
  values (
    p_moment_id,
    p_circle_id,
    v_annotation_id,
    v_user_id,
    v_display_name,
    v_body
  )
  returning family_moment_comments.*;
end;
$$;

comment on function public.add_family_moment_comment(uuid, uuid, text, text) is
  'Adds a server-authored family comment to a ready 360 moment or one of its embedded annotations after validating current approved membership.';

revoke all on table public.family_moment_comments
  from public, anon, authenticated;
grant select on table public.family_moment_comments to authenticated;
grant all on table public.family_moment_comments to service_role;

revoke all on function public.add_family_moment_comment(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.add_family_moment_comment(uuid, uuid, text, text)
  to authenticated, service_role;

do $$
begin
  if exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) and not exists (
    select 1
    from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'family_moment_comments'
  ) then
    alter publication supabase_realtime
      add table public.family_moment_comments;
  end if;
end;
$$;

commit;

begin;

create extension if not exists pgtap with schema extensions;
select plan(14);

insert into public.profiles (id, display_name)
values
  ('31000000-0000-4000-8000-000000000001', 'Alice'),
  ('31000000-0000-4000-8000-000000000002', 'Bob'),
  ('31000000-0000-4000-8000-000000000003', 'Mallory');

insert into public.app_identities (subject, user_id, provider)
values
  ('comment_user_alice', '31000000-0000-4000-8000-000000000001', 'clerk'),
  ('comment_user_bob', '31000000-0000-4000-8000-000000000002', 'clerk'),
  ('comment_user_mallory', '31000000-0000-4000-8000-000000000003', 'clerk');

insert into public.circles (id, name, owner_id)
values
  (
    'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Comment Test Family',
    '31000000-0000-4000-8000-000000000001'
  ),
  (
    'dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Other Family',
    '31000000-0000-4000-8000-000000000003'
  );

insert into public.circle_members (
  circle_id,
  user_id,
  role,
  status,
  approved_by,
  approved_at
)
values (
  'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '31000000-0000-4000-8000-000000000002',
  'member',
  'approved',
  '31000000-0000-4000-8000-000000000001',
  now()
);

insert into public.family_moments (
  id,
  circle_id,
  uploader_id,
  capture_kind,
  panorama_path,
  thumbnail_path,
  panorama_width,
  panorama_height,
  thumbnail_width,
  thumbnail_height,
  status
)
values (
  '41000000-0000-4000-8000-000000000001',
  'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '31000000-0000-4000-8000-000000000001',
  'manual',
  'comment-test/panorama.jpg',
  'comment-test/thumbnail.jpg',
  4096,
  2048,
  800,
  400,
  'ready'
);

insert into public.family_moment_annotations (
  id,
  moment_id,
  circle_id,
  kind,
  pitch,
  yaw,
  message,
  sort_order
)
values (
  'clock-note',
  '41000000-0000-4000-8000-000000000001',
  'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'text',
  4,
  12,
  'Grandma''s clock',
  0
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', 'comment_user_alice', 'role', 'authenticated')::text,
  true
);

select is(
  (
    select comment.author_display_name
    from public.add_family_moment_comment(
      'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '41000000-0000-4000-8000-000000000001',
      null,
      '  Whole panorama comment  '
    ) as comment
  ),
  'Alice',
  'the comment RPC derives its author display name from the current profile'
);

select is(
  (
    select count(*)
    from public.family_moment_comments as comment
    where comment.moment_id = '41000000-0000-4000-8000-000000000001'
      and comment.annotation_id is null
      and comment.body = 'Whole panorama comment'
  ),
  1::bigint,
  'a whole-panorama comment stores a null target and trimmed body'
);

select is(
  (
    select comment.author_id
    from public.family_moment_comments as comment
    where comment.body = 'Whole panorama comment'
  ),
  '31000000-0000-4000-8000-000000000001'::uuid,
  'the RPC derives the internal author ID instead of trusting client input'
);

select set_config(
  'request.jwt.claims',
  json_build_object('sub', 'comment_user_bob', 'role', 'authenticated')::text,
  true
);

select is(
  (
    select comment.annotation_id
    from public.add_family_moment_comment(
      'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '41000000-0000-4000-8000-000000000001',
      'clock-note',
      'I remember that clock.'
    ) as comment
  ),
  'clock-note',
  'an approved member can reply to an annotation on the same panorama'
);

select is(
  (
    select comment.author_display_name
    from public.family_moment_comments as comment
    where comment.annotation_id = 'clock-note'
  ),
  'Bob',
  'annotation replies retain the server-derived family-member name'
);

select throws_ok(
  $$
    select *
    from public.add_family_moment_comment(
      'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '41000000-0000-4000-8000-000000000001',
      null,
      repeat('x', 501)
    )
  $$,
  '22023',
  'comment_body_out_of_bounds',
  'the RPC rejects an oversized comment body'
);

select throws_ok(
  $$
    select *
    from public.add_family_moment_comment(
      'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '41000000-0000-4000-8000-000000000001',
      'another-moment-note',
      'Cross-target reply'
    )
  $$,
  'P0002',
  'family_moment_annotation_not_found',
  'the RPC rejects an annotation that is not attached to this panorama'
);

select throws_ok(
  $$
    insert into public.family_moment_comments (
      moment_id,
      circle_id,
      author_id,
      author_display_name,
      body
    ) values (
      '41000000-0000-4000-8000-000000000001',
      'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '31000000-0000-4000-8000-000000000002',
      'Spoofed',
      'Direct write'
    )
  $$,
  '42501',
  'permission denied for table family_moment_comments',
  'authenticated clients cannot bypass the server-authored comment RPC'
);

select is(
  (
    select count(*)
    from public.family_moment_comments
    where moment_id = '41000000-0000-4000-8000-000000000001'
  ),
  2::bigint,
  'approved family members can read the shared panorama conversation'
);

select set_config(
  'request.jwt.claims',
  json_build_object('sub', 'comment_user_mallory', 'role', 'authenticated')::text,
  true
);

select throws_ok(
  $$
    select *
    from public.add_family_moment_comment(
      'daaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '41000000-0000-4000-8000-000000000001',
      null,
      'Private-family probe'
    )
  $$,
  '42501',
  'approved_circle_membership_required',
  'a user from another family cannot comment on the panorama'
);

select is(
  (
    select count(*)
    from public.family_moment_comments
    where moment_id = '41000000-0000-4000-8000-000000000001'
  ),
  0::bigint,
  'RLS hides the whole conversation from users outside the family'
);

reset role;

update public.family_moments
set status = 'deleting'
where id = '41000000-0000-4000-8000-000000000001';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', 'comment_user_alice', 'role', 'authenticated')::text,
  true
);

select is(
  (
    select count(*)
    from public.family_moment_comments
    where moment_id = '41000000-0000-4000-8000-000000000001'
  ),
  0::bigint,
  'comments become unreadable as soon as owner deletion hides the moment'
);

reset role;

select ok(
  not exists (
    select 1
    from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) or exists (
    select 1
    from pg_catalog.pg_publication_tables as comment_publication
    where comment_publication.pubname = 'supabase_realtime'
      and comment_publication.schemaname = 'public'
      and comment_publication.tablename = 'family_moment_comments'
  ),
  'family comments join Supabase Realtime when its standard publication exists'
);

select has_policy(
  'public',
  'family_moment_comments',
  'family_moment_comments_read_by_approved_members',
  'the family comments table has an explicit approved-member read policy'
);

select * from finish();
rollback;

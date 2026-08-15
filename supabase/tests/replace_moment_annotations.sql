begin;

create extension if not exists pgtap with schema extensions;
select plan(26);

insert into public.profiles (id, display_name)
values
  ('32000000-0000-4000-8000-000000000001', 'Annotation Alice'),
  ('32000000-0000-4000-8000-000000000002', 'Annotation Bob'),
  ('32000000-0000-4000-8000-000000000003', 'Annotation Mallory');

insert into public.app_identities (subject, user_id, provider)
values
  ('annotation_user_alice', '32000000-0000-4000-8000-000000000001', 'clerk'),
  ('annotation_user_bob', '32000000-0000-4000-8000-000000000002', 'clerk'),
  ('annotation_user_mallory', '32000000-0000-4000-8000-000000000003', 'clerk');

insert into public.circles (id, name, owner_id)
values
  (
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'Annotation Test Family',
    '32000000-0000-4000-8000-000000000001'
  ),
  (
    'ebbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'Other Annotation Family',
    '32000000-0000-4000-8000-000000000003'
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
  'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '32000000-0000-4000-8000-000000000002',
  'member',
  'approved',
  '32000000-0000-4000-8000-000000000001',
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
  '42000000-0000-4000-8000-000000000001',
  'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '32000000-0000-4000-8000-000000000001',
  'manual',
  'annotation-test/panorama.jpg',
  'annotation-test/thumbnail.jpg',
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
  audio_path,
  audio_mime_type,
  duration_ms,
  sort_order,
  created_at
)
values
  (
    'keep-note',
    '42000000-0000-4000-8000-000000000001',
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'text',
    1,
    2,
    'Original note',
    null,
    null,
    null,
    0,
    '2026-01-01 00:00:00+00'
  ),
  (
    'remove-voice',
    '42000000-0000-4000-8000-000000000001',
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'voice',
    3,
    4,
    'Old voice to remove',
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001-remove-voice-11111111111111111111111111111111.m4a',
    'audio/mp4',
    1000,
    1,
    '2026-01-02 00:00:00+00'
  ),
  (
    'keep-voice',
    '42000000-0000-4000-8000-000000000001',
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'voice',
    5,
    6,
    'Original kept voice',
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001-keep-voice-22222222222222222222222222222222.m4a',
    'audio/mp4',
    2000,
    2,
    '2026-01-03 00:00:00+00'
  );

insert into public.family_moment_comments (
  moment_id,
  circle_id,
  annotation_id,
  author_id,
  author_display_name,
  body
)
values
  (
    '42000000-0000-4000-8000-000000000001',
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'keep-note',
    '32000000-0000-4000-8000-000000000002',
    'Annotation Bob',
    'Keep this text reply'
  ),
  (
    '42000000-0000-4000-8000-000000000001',
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'keep-voice',
    '32000000-0000-4000-8000-000000000002',
    'Annotation Bob',
    'Keep this voice reply'
  ),
  (
    '42000000-0000-4000-8000-000000000001',
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'remove-voice',
    '32000000-0000-4000-8000-000000000002',
    'Annotation Bob',
    'Remove this reply with its target'
  );

insert into storage.objects (id, bucket_id, name)
select extensions.gen_random_uuid(), 'family-media', fixture.name
from (
  values
    ('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001-remove-voice-11111111111111111111111111111111.m4a'),
    ('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001-keep-voice-22222222222222222222222222222222.m4a'),
    ('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001-keep-voice-33333333333333333333333333333333.m4a'),
    ('eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/failed-voice.webm')
) as fixture(name);

select ok(
  has_function_privilege(
    'authenticated',
    'public.replace_360_moment_annotations(uuid,uuid,jsonb)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.replace_360_moment_annotations(uuid,uuid,jsonb)',
    'execute'
  )
  and has_function_privilege(
    'authenticated',
    'public.can_delete_own_unreferenced_family_voice(text)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.can_delete_own_unreferenced_family_voice(text)',
    'execute'
  ),
  'only authenticated application callers can invoke replacement and its Storage cleanup helper'
);

select ok(
  (
    select routine.prosecdef
    from pg_catalog.pg_proc as routine
    where routine.oid =
      'public.replace_360_moment_annotations(uuid,uuid,jsonb)'::regprocedure
  ),
  'annotation replacement is a security-definer RPC'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  json_build_object('sub', 'annotation_user_alice', 'role', 'authenticated')::text,
  true
);

create temporary table replacement_result on commit drop as
select *
from public.replace_360_moment_annotations(
  'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '42000000-0000-4000-8000-000000000001',
  jsonb_build_array(
    jsonb_build_object(
      'id', 'keep-voice',
      'kind', 'voice',
      'pitch', -7,
      'yaw', 21,
      'message', '  Updated voice  ',
      'audio_path', 'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001-keep-voice-33333333333333333333333333333333.m4a',
      'audio_mime_type', 'audio/mp4',
      'duration_ms', 3456
    ),
    jsonb_build_object(
      'id', 'keep-note',
      'kind', 'text',
      'pitch', 9,
      'yaw', -40,
      'message', '  Updated note  '
    )
  )
);

select is(
  (select moment_id from replacement_result),
  '42000000-0000-4000-8000-000000000001'::uuid,
  'the RPC returns the updated moment ID'
);

select is(
  (select stale_audio_paths from replacement_result),
  array[
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001-keep-voice-22222222222222222222222222222222.m4a',
    'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001-remove-voice-11111111111111111111111111111111.m4a'
  ]::text[],
  'the RPC returns removed and superseded audio paths in stable order'
);

select is(
  (
    select count(*)
    from public.family_moment_annotations
    where moment_id = '42000000-0000-4000-8000-000000000001'
  ),
  2::bigint,
  'replacement deletes only annotation IDs omitted from the new set'
);

select is(
  (
    select string_agg(id || ':' || sort_order || ':' || message, '|' order by sort_order)
    from public.family_moment_annotations
    where moment_id = '42000000-0000-4000-8000-000000000001'
  ),
  'keep-voice:0:Updated voice|keep-note:1:Updated note',
  'existing annotation IDs can be reordered and their validated text is trimmed'
);

select is(
  (
    select created_at
    from public.family_moment_annotations
    where moment_id = '42000000-0000-4000-8000-000000000001'
      and id = 'keep-note'
  ),
  '2026-01-01 00:00:00+00'::timestamptz,
  'upsert preserves the creation identity of an unchanged annotation ID'
);

select is(
  (
    select count(*)
    from public.family_moment_comments
    where moment_id = '42000000-0000-4000-8000-000000000001'
      and annotation_id in ('keep-note', 'keep-voice')
  ),
  2::bigint,
  'comments remain attached to annotation IDs preserved by upsert'
);

select is(
  (
    select count(*)
    from public.family_moment_comments
    where moment_id = '42000000-0000-4000-8000-000000000001'
      and annotation_id = 'remove-voice'
  ),
  0::bigint,
  'comments cascade only when their removed annotation ID is deleted'
);

select is(
  (
    select audio_path
    from public.family_moment_annotations
    where moment_id = '42000000-0000-4000-8000-000000000001'
      and id = 'keep-voice'
  ),
  'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001-keep-voice-33333333333333333333333333333333.m4a',
  'the replacement references the uploader-owned immutable voice version'
);

select set_config(
  'request.jwt.claims',
  json_build_object('sub', 'annotation_user_bob', 'role', 'authenticated')::text,
  true
);

select throws_ok(
  $$
    select * from public.replace_360_moment_annotations(
      'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '42000000-0000-4000-8000-000000000001',
      '[]'::jsonb
    )
  $$,
  '42501',
  'moment_uploader_required',
  'an approved family member cannot edit another uploader''s moment'
);

select set_config(
  'request.jwt.claims',
  json_build_object('sub', 'annotation_user_mallory', 'role', 'authenticated')::text,
  true
);

select throws_ok(
  $$
    select * from public.replace_360_moment_annotations(
      'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '42000000-0000-4000-8000-000000000001',
      '[]'::jsonb
    )
  $$,
  '42501',
  'approved_circle_membership_required',
  'a caller outside the approved circle cannot probe or edit the moment'
);

select set_config(
  'request.jwt.claims',
  json_build_object('sub', 'annotation_user_alice', 'role', 'authenticated')::text,
  true
);

select throws_ok(
  $$
    select * from public.replace_360_moment_annotations(
      'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '42000000-0000-4000-8000-000000000001',
      (select jsonb_agg(jsonb_build_object(
        'id', 'note-' || value,
        'kind', 'text',
        'pitch', 0,
        'yaw', 0,
        'message', 'note'
      )) from generate_series(1, 9) as value)
    )
  $$,
  '22023',
  'too_many_annotations',
  'a moment cannot be replaced with more than eight annotations'
);

select throws_ok(
  $$
    select * from public.replace_360_moment_annotations(
      'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '42000000-0000-4000-8000-000000000001',
      '[{"id":"same","kind":"text","pitch":0,"yaw":0,"message":"one"},{"id":"same","kind":"text","pitch":1,"yaw":1,"message":"two"}]'::jsonb
    )
  $$,
  '22023',
  'duplicate_annotation_id',
  'duplicate annotation IDs are rejected'
);

select throws_ok(
  $$
    select * from public.replace_360_moment_annotations(
      'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '42000000-0000-4000-8000-000000000001',
      '[{"id":"Invalid ID","kind":"text","pitch":0,"yaw":0,"message":"note"}]'::jsonb
    )
  $$,
  '22023',
  'invalid_annotation_id',
  'annotation IDs must use the bounded lowercase canonical format'
);

select throws_ok(
  $$
    select * from public.replace_360_moment_annotations(
      'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '42000000-0000-4000-8000-000000000001',
      '[{"id":"bad-coordinate","kind":"text","pitch":91,"yaw":0,"message":"note"}]'::jsonb
    )
  $$,
  '22023',
  'annotation_coordinates_out_of_bounds',
  'coordinates outside the sphere are rejected'
);

select throws_ok(
  $$
    select * from public.replace_360_moment_annotations(
      'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '42000000-0000-4000-8000-000000000001',
      '[{"id":"blank-note","kind":"text","pitch":0,"yaw":0,"message":"   "}]'::jsonb
    )
  $$,
  '22023',
  'annotation_text_out_of_bounds',
  'blank annotation messages are rejected'
);

select throws_ok(
  $$
    select * from public.replace_360_moment_annotations(
      'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '42000000-0000-4000-8000-000000000001',
      '[{"id":"bad-kind","kind":"video","pitch":0,"yaw":0,"message":"note"}]'::jsonb
    )
  $$,
  '22023',
  'invalid_annotation_kind',
  'unsupported annotation types are rejected'
);

select throws_ok(
  $$
    select * from public.replace_360_moment_annotations(
      'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '42000000-0000-4000-8000-000000000001',
      '[{"id":"bad-duration","kind":"voice","pitch":0,"yaw":0,"message":"voice","audio_path":"unused","audio_mime_type":"audio/mp4","duration_ms":60001}]'::jsonb
    )
  $$,
  '22023',
  'invalid_voice_duration',
  'voice durations above one minute are rejected before path lookup'
);

select throws_ok(
  $$
    select * from public.replace_360_moment_annotations(
      'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '42000000-0000-4000-8000-000000000001',
      '[{"id":"wrong-path","kind":"voice","pitch":0,"yaw":0,"message":"voice","audio_path":"eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/not-versioned.m4a","audio_mime_type":"audio/mp4","duration_ms":1}]'::jsonb
    )
  $$,
  '22023',
  'voice_path_must_match_authenticated_uploader_and_version',
  'new voice clips require the canonical moment, annotation, and 32-hex version path'
);

select throws_ok(
  $$
    select * from public.replace_360_moment_annotations(
      'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '42000000-0000-4000-8000-000000000001',
      '[{"id":"missing-voice","kind":"voice","pitch":0,"yaw":0,"message":"voice","audio_path":"eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001-missing-voice-44444444444444444444444444444444.m4a","audio_mime_type":"audio/mp4","duration_ms":1}]'::jsonb
    )
  $$,
  'P0001',
  'voice_storage_object_not_found',
  'a versioned voice path must exist before annotation metadata can reference it'
);

select is(
  (
    select string_agg(id, ',' order by sort_order)
    from public.family_moment_annotations
    where moment_id = '42000000-0000-4000-8000-000000000001'
  ),
  'keep-voice,keep-note',
  'failed validation leaves the last valid annotation set unchanged'
);

delete from storage.objects
where name in (
  'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001-remove-voice-11111111111111111111111111111111.m4a',
  'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001-keep-voice-22222222222222222222222222222222.m4a'
);

select is(
  (
    select count(*)
    from storage.objects
    where name in (
      'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001-remove-voice-11111111111111111111111111111111.m4a',
      'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001-keep-voice-22222222222222222222222222222222.m4a'
    )
  ),
  0::bigint,
  'the uploader can delete exact stale voice paths after the RPC unreferenced them'
);

delete from storage.objects
where name = 'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001-keep-voice-33333333333333333333333333333333.m4a';

select is(
  (
    select count(*)
    from storage.objects
    where name = 'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/42000000-0000-4000-8000-000000000001-keep-voice-33333333333333333333333333333333.m4a'
  ),
  1::bigint,
  'a voice path still referenced by an annotation remains immutable'
);

select set_config(
  'request.jwt.claims',
  json_build_object('sub', 'annotation_user_bob', 'role', 'authenticated')::text,
  true
);

delete from storage.objects
where name = 'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/failed-voice.webm';

select is(
  (
    select count(*)
    from storage.objects
    where name = 'eaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/voice/32000000-0000-4000-8000-000000000001/failed-voice.webm'
  ),
  1::bigint,
  'one approved member cannot delete another uploader''s unreferenced voice object'
);

reset role;

select has_policy(
  'storage',
  'objects',
  'family_voice_delete_unreferenced_by_uploader',
  'Storage has an explicit uploader-owned unreferenced voice cleanup policy'
);

select * from finish();
rollback;

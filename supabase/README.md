# Supabase foundation

This directory is the reproducible backend baseline for KinSphere. The first
migration creates profiles, private profile preferences, Family Circles,
approved/removed memberships, server-generated hashed expiring invites, join requests, atomic
membership workflow functions, and the private `family-media` Storage bucket.

## Authorization invariant

Only this state grants access to circle rows and Storage objects:

```sql
circle_members.user_id = auth.uid()
and circle_members.status = 'approved'
```

An invite or join request never grants access. Pending and removed users fail
the same helper used by all circle policies. Membership decisions, removals,
irreversible invite revocation, and ownership transfer use `security definer`
functions with a fixed empty search path and explicit authorization checks.

## Media paths

Client uploads use one immutable path shape:

```text
<circle-uuid>/<panoramas|thumbnails|voice>/<uploader-uuid>/<immutable-file>
```

The bucket is private. Approved members can read their circle's objects and can
insert only below their own uploader segment. There are intentionally no client
`UPDATE` or `DELETE` policies: uploads must not use overwrite/upsert, and future
deletion/finalization jobs should run in the trusted backend after rechecking
authorization.

## Daily 360 Moment MVP

`get_or_create_daily_capture_window(circle_id)` lazily creates one immutable
15-minute window per circle/local date. PostgreSQL derives the time from the
circle ID and local date, uses the owner's saved IANA time zone (or UTC as a
safe fallback), and always opens between 10:00 and 18:30 local time. A client
may request today's row, but cannot supply, insert, or update either bound.

The always-available side action uses `capture_kind = 'manual'`. The random
prompt uses `capture_kind = 'scheduled'` and is accepted only while PostgreSQL
`now()` is inside today's server-created bounds. A unique partial index permits
at most one scheduled contribution per uploader/window; manual contributions
do not consume that allowance.

Before calling `finalize_360_moment`, upload without upsert to these exact paths,
using one client-generated UUID for `<moment-id>`:

```text
<circle-id>/panoramas/<auth-user-id>/<moment-id>.jpg
<circle-id>/thumbnails/<auth-user-id>/<moment-id>.jpg
```

The security-definer finalizer derives the uploader from `auth.uid()`, rechecks
approved membership, requires those exact canonical paths to exist in the
private `family-media` bucket, validates reported panorama and thumbnail sizes
as 2:1, enforces the scheduled window, and inserts a `ready` row atomically.
Clients cannot insert or update `family_moments` directly. Approved members can
select ready moments in their circle, and the table is added idempotently to the
standard Supabase Realtime publication when that publication exists.

## Invite codes

Owners create invites only through `create_circle_invite`. The function generates
a 256-bit `ks1_...` code, stores its SHA-256 digest, and returns the raw code once.
`request_circle_join` accepts the raw code and hashes it inside the fixed-search-path
security-definer function. A stored digest therefore cannot be replayed as an
invite code. Invites last between five minutes and 30 days and allow between one
and 25 approvals. Clients cannot insert or mutate invite rows directly. Invite
submissions serialize per user/circle pair, and rescans and approvals lock an
existing join request before its invite so the two RPCs use the same concurrency
order.

## Local commands

With Docker and the Supabase CLI installed:

```sh
supabase start
supabase db reset
supabase test db supabase/tests/rls_membership.sql
supabase test db supabase/tests/360_moment_mvp.sql
```

## Assumptions and current limits

- Raw invite codes should be treated as secrets and kept out of analytics and
  application logs. Only the generated SHA-256 digest is persisted.
- Invite expiry and approval use database `now()`, never the device clock.
- IANA time-zone existence is not enforced by a `CHECK` constraint because the
  time-zone catalog cannot be referenced safely from an immutable check. The
  client and a later settings RPC should validate it.
- The Storage policy assumes a current Supabase Storage schema with
  `storage.foldername(text)` and the standard `storage.objects` table.
- PostgreSQL cannot inspect pixels inside an uploaded JPEG. The 2:1 width and
  height values are client-reported metadata; finalization verifies their
  arithmetic and that both exact Storage object rows exist. A later image
  processing worker should decode pixels, strip unsafe metadata, and generate a
  trusted thumbnail before a production launch.
- The current contract does not reserve uploads or clean up abandoned objects.
  Those require a trusted cleanup worker and quotas before production launch.
- Capsules, events, notifications, and AI tables remain future phases and must
  reuse the membership helper.
- The SQL suite is designed for `supabase test db`, but still requires a local
  Supabase stack to validate database-engine and Storage-version compatibility.

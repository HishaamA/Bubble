# Supabase foundation

This directory is the reproducible backend baseline for KinSphere. The first
migration creates profiles, private profile preferences, Family Circles,
approved/removed memberships, server-generated hashed expiring invites, join requests, atomic
membership workflow functions, and the private `family-media` Storage bucket.

## Authorization invariant

Only this state grants access to circle rows and Storage objects:

```sql
circle_members.user_id = current_app_user_id()
and circle_members.status = 'approved'
```

`current_app_user_id()` resolves only the verified Clerk
`auth.jwt()->>'sub'` through the private `app_identities` mapping. Clerk users
are not inserted into the managed `auth.users` table. Run
`bootstrap_current_user` after Clerk signs in and before loading family data.

An invite or join request never grants access. Pending and removed users fail
the same helper used by all circle policies. Membership decisions, removals,
irreversible invite revocation, and ownership transfer use `security definer`
functions with a fixed empty search path and explicit authorization checks.
The MVP permits one approved family membership per user. A partial unique index
and per-user transactional locks cover family creation and concurrent owner
approvals. Pending requests may remain in other families, but they cannot be
approved after the requester joins one family, and a joined user cannot submit
or refresh another join request. An existing database with duplicate approved
memberships must be reconciled explicitly before this migration can apply.

## Media paths

Client uploads use one immutable path shape:

```text
<circle-uuid>/<panoramas|thumbnails|voice|capsule-images|capsule-thumbnails>/<internal-user-uuid>/<immutable-file>
```

The bucket is private. Approved members can read their circle's objects and can
insert only below their own uploader segment. Uploads must not use
overwrite/upsert. Deletion is limited to failed, unreferenced uploads or exact
objects returned by the owner-only two-phase moment deletion RPC; a family
member can never remove another uploader's path.

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
<circle-id>/panoramas/<internal-user-id>/<moment-id>.jpg
<circle-id>/thumbnails/<internal-user-id>/<moment-id>.jpg
```

The security-definer finalizer derives the uploader from
`current_app_user_id()`, rechecks
approved membership, requires those exact canonical paths to exist in the
private `family-media` bucket, validates reported panorama and thumbnail sizes
as 2:1, enforces the scheduled window, and inserts a `ready` row atomically.
Clients cannot insert or update `family_moments` directly. Approved members can
select ready moments in their circle, and the table is added idempotently to the
standard Supabase Realtime publication when that publication exists.

An uploader removes a post with `begin_delete_own_family_moment`, then deletes
the exact returned panorama, thumbnail, and voice paths through Storage, and
calls `finish_delete_own_family_moment`. The first call changes the row to
`deleting` and creates an immutable, family-readable tombstone before any media
is touched. That tombstone is also published through Realtime, so online and
offline devices reliably evict their local cache. If cleanup is interrupted,
`list_pending_own_family_moment_deletions` lets the uploader resume it on the
next connection. It also lets the circle owner finish an already-tombstoned
cleanup if that uploader has since been removed from the family; this never
allows the owner to start deletion of someone else's ready post. Final metadata
deletion is rejected until every exact object is gone. Tombstones remain after
cleanup for future offline reconciliation.

Up to eight position-bound text or voice annotations are finalized atomically
with each panorama. Voice clips use the same private family-media boundary.
After sharing, only the original uploader can replace a ready moment's
annotation set through `replace_360_moment_annotations`. New or changed voice
clips use an immutable versioned path and the RPC returns superseded paths for
best-effort Storage cleanup:

```text
<circle-id>/voice/<internal-user-id>/<moment-id>-<annotation-id>-<32-lowercase-hex>.<ext>
```

Unchanged annotation IDs are updated in place so their family replies survive;
only omitted IDs and their targeted replies are deleted. The caller must still
be an approved member of the circle and the moment must still be ready.
Approved family members may then discuss a ready panorama through
`family_moment_comments`: a null annotation target comments on the whole image,
while a validated annotation ID replies to that embedded memory point. Comment
authors are derived server-side, direct table writes are revoked, and Realtime
publishes new comments without forcing clients to reload the panorama itself.

## Weekly and special-event Capsules

`get_or_create_weekly_capsule(circle_id)` uses the database clock and the
family owner's IANA time zone to create exactly one Monday-through-Sunday
Capsule for the approved circle. `create_special_capsule` creates a named
collection such as a birthday or wedding with a server-enforced future open
time. Both accept ordinary photos through a separate pipeline from 360
Moments; there is deliberately no 2:1 constraint.

The client re-encodes a selected photo and thumbnail as metadata-free JPEGs,
then uploads them without upsert to exact immutable paths:

```text
<circle-id>/capsule-images/<internal-user-id>/<item-id>.jpg
<circle-id>/capsule-thumbnails/<internal-user-id>/<item-id>.jpg
```

`finalize_capsule_photo` derives the uploader, rechecks membership and the
server open time, verifies both objects and their canonical paths, and then
increments the family-visible item count atomically. Before unlock, approved
members can see Capsule metadata and the total count but can read only their
own photo objects. After `opens_at <= now()`, every approved member can read
the family's contributions. Realtime publishes both collection and item
changes. The installed iPhone app renders the ordered photos as a private
1080×1920 H.264 recap at 30 fps, holding each image for six frames (0.2 s),
and opens the native share sheet for Save Video or AirDrop.

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

## Clerk authentication and event reminders

The client uses Clerk sessions with Supabase's native third-party auth support.
Activate Clerk's Supabase integration, then add the exact Clerk domain under
Supabase Authentication → Sign In / Providers → Third-party Auth. Supabase JS
receives `session.getToken()` through its `accessToken` callback; do not create
the deprecated Clerk Supabase JWT template or share a Supabase JWT secret.

Clerk third-party auth does not synchronize `auth.users`. The authenticated
bootstrap RPC maps the trusted string subject to a stable internal UUID and
creates the public profile, private email row, preferences, and durable tutorial
state. Browser-supplied email is unverified display metadata only; it must never
be used for authorization or outbound contact unless a trusted Clerk webhook or
verified JWT claim has supplied it. Legacy Supabase Auth users keep insert/delete
profile lifecycle triggers. See
`docs/decisions/0004-clerk-supabase-third-party-auth.md`.

`create_family_event` checks approved circle membership and uses the database
clock to create the event and, when requested, its reminder preference and
idempotent scheduled job in one transaction. Approved members load shared
events through RLS and receive Realtime refreshes. `set_event_reminder` lets
each approved family member opt in. A trusted scheduled Edge Function or
Supabase Cron invocation calls
`dispatch_due_event_reminders`; it writes the authorized in-app notification
before any generic APNs/FCM nudge is attempted.

## Local commands

With Docker and the Supabase CLI installed:

```sh
supabase start
supabase db reset
supabase test db supabase/tests/rls_membership.sql
supabase test db supabase/tests/360_moment_mvp.sql
supabase test db supabase/tests/replace_moment_annotations.sql
supabase test db supabase/tests/moment_comments.sql
supabase test db supabase/tests/events_notifications.sql
supabase test db supabase/tests/clerk_third_party_auth.sql
supabase test db supabase/tests/family_capsules.sql
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
- An approved uploader can delete their own exact, unreferenced failed-upload
  objects. There is no automated abandoned-upload cleanup, reservation, or
  quota yet; those require a trusted worker before production launch.
- Capsule, event, and notification tables reuse the approved-membership
  boundary. Scheduled-job dispatch remains restricted to the service role.
- Weekly and special Capsule unlocks are server authoritative. The local
  IndexedDB store is an offline preview/cache, not a cross-device permission
  boundary.
- The SQL suite is designed for `supabase test db`, but still requires a local
  Supabase stack to validate database-engine and Storage-version compatibility.
- Clerk account deletion is not inferred from sign-out. A trusted webhook or
  administrative retention workflow must delete the mapped profile when the
  product's account-deletion policy requires it.

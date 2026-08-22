# Supabase foundation

This directory is the reproducible backend baseline for Bubble. The first
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

## Family flight tracking

`family_flights` stores only an airline flight number, travel date, traveler
display name, and the normalized status returned by the server-side tracker.
It deliberately has no ticket-number field. A 13-digit ticket number cannot be
resolved by public flight-status services and is rejected before local or
server persistence. Approved circle members can read the family's flights and
refresh their shared status; only the creator or circle owner can remove one.
Direct table writes and authenticated snapshot RPC execution remain revoked.
The authenticated Edge Function performs the provider lookup first, then uses
its service role to persist only the normalized result after rechecking the
approved circle and stored flight identity. Client-supplied JSON never becomes
`status_snapshot`.

Live status is proxied through `supabase/functions/flight-status`. The function
uses AeroDataBox through RapidAPI over HTTPS and keeps the marketplace key
server-side. Clerk uses third-party RS256 session tokens, so the legacy Edge
gateway JWT check is disabled in `config.toml`; the handler authenticates that
token through PostgREST and requires an approved family membership before any
provider lookup. Configure and deploy it with:

```sh
supabase secrets set AERODATABOX_RAPIDAPI_KEY=your_server_only_key
supabase secrets set APP_ALLOWED_ORIGINS=https://your-production-origin.example
supabase functions deploy flight-status --no-verify-jwt
```

Copy `supabase/.env.demo.example` to the gitignored `supabase/.env.demo`, then
add a newly rotated AeroDataBox key. Run `pnpm supabase:functions:serve:demo`
to use it with the local Edge Function. Only run `pnpm
supabase:secrets:demo` when the local file contains the intended hosted secret
and allowed origins.

`AERODATABOX_RAPIDAPI_KEY` is a server-only secret. Never put it in a `VITE_`
variable, the web bundle, or a native APK. The proxy calls only the fixed HTTPS
`https://aerodatabox.p.rapidapi.com` host. Its normal lookup is the single-day
flight-status endpoint with `dateLocalRole=Departure` and `withLocation=true`.
The date entered in the app is always the scheduled departure date in the
origin airport's local calendar, so an overnight arrival on the next local day
does not make the lookup ambiguous;
the same provider's airport endpoint is used only when embedded route geometry
is incomplete. The key is sent only from the Edge Function. AeroDataBox's
RapidAPI Basic plan currently provides 600 units per month; a Tier-2 status
lookup costs two units, or roughly 300 lookups before cache savings. Future and
historical availability remains subject to the selected plan and provider data
coverage. Confirm current limits in the official [AeroDataBox pricing](https://aerodatabox.com/pricing/)
and [OpenAPI documentation](https://doc.aerodatabox.com/).

The Android WebView origin is `https://localhost`; iOS uses
`capacitor://localhost`. Both exact native origins are built into the function's
CORS allowlist. `APP_ALLOWED_ORIGINS` is only needed for additional hosted web
origins. A real Clerk session and approved family membership are required;
debug/test-auth preview builds intentionally cannot spend provider quota.

Use a modern Supabase publishable key in the APK. It is sent only as `apikey`;
the Clerk session token is the only Bearer credential. The function prefers the
hosted runtime's modern publishable/secret key variables and retains legacy
environment fallbacks for local Supabase compatibility.

The mobile client derives the default URL from `VITE_SUPABASE_URL`. A separately
hosted compatible proxy can instead be selected with the client-safe
`VITE_FLIGHT_TRACKER_ENDPOINT`; that URL is public, but provider credentials
must never be placed in any `VITE_` variable. The proxy requires a valid Clerk /
Supabase session and an approved Family Circle membership, constrains requests
to one normalized flight number and date, caches brief duplicate lookups, and
calls only fixed AeroDataBox HTTPS endpoints. Set `APP_ALLOWED_ORIGINS` to a
comma-separated production allowlist; Capacitor and local-development origins
are included by default.

AeroDataBox flight results must match the selected origin-local departure date.
Equivalent IATA/ICAO airline prefixes and leading-zero formats are normalized;
a different flight number is accepted only when the number-scoped lookup returns
an operating codeshare. When the provider returns more than one matching
departure on that day, the first request returns only sanitized route and time
choices and does not write a database row. The client sends the selected opaque
provider flight ID in a second request; the Edge Function repeats the fixed-host
provider lookup and verifies that the selection still belongs to the same flight
number and departure date before persisting its trusted snapshot. Client-supplied
status JSON is never accepted. Airport coordinates and IANA time zones are
normalized server-side. Live ADS-B position is optional: when it is unavailable
or stale, the client labels the airplane as an estimated or scheduled timeline
position rather than live GPS. Legacy saved snapshots with provider
`flightaware` remain valid, while all new provider responses use
`aerodatabox`. Durable database buckets permit twelve lookups per approved
member and thirty per family circle every five minutes; bounded in-memory
caching and request coalescing reduce duplicate provider calls within an Edge
isolate.

To preserve the free AeroDataBox allowance, each phone persists an automatic
refresh budget of at most two lookups per six hours. Nearby flights become
eligible after one hour and distant flights after one day; an explicit
`Refresh status` remains available. Mobile requests time out after twenty
seconds and every add, refresh, or delete sheet can be closed without trapping
the user. Ambiguous create retries reuse the same server row ID.

Each phone opts into its own departure and arrival alerts. The installed iPhone
or Android app uses Capacitor Local Notifications. Browser alerts are explicitly
best-effort and work only while the tab remains open. Local notifications are
rescheduled from the latest saved ETA whenever Bubble refreshes; they are not
airline push alerts and cannot learn about a new delay while the app is killed.

## Family Journal photo library

`family_journal_photos` is the immediate ordinary-photo source for Journal →
People. It is deliberately separate from Capsules and 360 moments: a photo is
visible as soon as it is added, while Capsule unlock rules remain unchanged.
The mobile client first re-encodes each selected image as a metadata-free JPEG,
saves the processed full image and thumbnail in account/family-scoped IndexedDB,
and then retries private family sharing in the background. Face portraits,
embeddings, detections, and recognition results never enter this table or
Storage; matching remains device-local.

The finalizer accepts only canonical UUID `.jpg` paths owned by the current
approved member, verifies JPEG Storage metadata and bounded full/thumbnail
sizes, and applies family/member/daily limits. Storage staging is limited to
twenty currently unfinalized Journal objects per member so a compromised client
cannot accumulate an unbounded private upload queue. Approved members can read
only finalized photos in their current circle; short-lived signed URLs are used
by the client.

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
supabase test db supabase/tests/family_journal_photos.sql
supabase test db supabase/tests/family_flights.sql
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
  objects. Journal photo staging and finalization have bounded quotas, but there
  is no automated abandoned-upload cleanup yet; that still requires a trusted
  worker before production launch.
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

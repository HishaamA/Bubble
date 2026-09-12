# Family Journal and Capsule fixes — 12 September 2026

This pass addresses the reported Journal overflow, deletion of one's own
Journal uploads, shared-family refresh failures, and uploader attribution on
released Capsules. Existing dirty/untracked work from previous requests was
preserved. No real photo was deleted and no GitHub push was performed. The
subsequent user-requested phone installation is recorded below.

## Changes

- Journal date editing uses readable paper/ink colors and constrains native
  date fields to their parent width in Plum, Forest and Midnight.
- Scrapbook cards use a grid rather than fragmenting across CSS columns.
  Captions, dates and uploader names wrap; portrait/landscape proportions stay
  intact.
- Owned Journal uploads have **Delete my photo**, an inline confirmation and
  safe cancel focus. Other people's uploads and Capsule copies do not expose
  this control. Changing photo/account clears the confirmation.
- Journal deletion is an authenticated, uploader-only server operation. It
  records family/uploader/photo-scoped tombstones; only those explicit markers
  prune offline caches. Missing rows or failed signed URLs are not deletion.
  Upload and durable-save operations are coalesced per photo and serialized
  with deletion. A realtime deletion hint during refresh queues another pass.
- Pending upload cancellation cannot resurrect through a late finalizer or
  suppress a different uploader's same-ID photo. Pending markers remain
  uploader-private; published deletion markers are visible to approved family
  members. New pending cancellations have a 1,000-per-24-hours cap; real photo
  deletion and retries are exempt.
- Original phone photos, separate Capsule contributions and saved downloads
  are not deleted. Unreferenced uploaded Journal objects are cleaned up using
  the existing uploader-only Storage policy, after metadata deletion succeeds.
- 360 family reads no longer depend on realtime readiness or the daily capture
  window. 360, plans and flights refresh on foreground/reconnect with stale
  request guards. Plans that already started today stay visible in Journal.
- Released Capsule strips and recap slides show the uploader's profile photo
  at top-right, with initials if absent/unavailable. Attribution is composited
  into browser and native saved videos. Optional avatar loading has a 5-second
  total deadline and a 2 MiB download cap, so an avatar cannot indefinitely
  block export. Each member's next authenticated bootstrap syncs their avatar.
- The combined recap includes all received family contributions in a stable
  chronological/ID order. Playback does not truncate. Export retains the
  existing native 150-photo safety limit and now reports an explicit error
  instead of silently omitting photos or saving an incomplete recap.

## Verified backend state and approved deployment

The linked project is **Bubble** (`hynmzfwfncswymhqlbhg`). Migration history was
read successfully. Before deployment, all existing migrations through
`20260911000200` were applied. A migration dry run with vault updates disabled
selected only:

`20260912000100_owned_journal_photo_deletion.sql`

Deployed policy definitions were inspected, without reading family content:

- Ready 360 moments, annotations, Journal photos, flights and events are scoped
  to approved members of the same circle.
- Capsules are visible to approved circle members. Capsule items become
  readable to all those members at the shared server `opens_at`; an uploader
  can read their own item beforehand.
- Profiles are readable by self/shared-circle members; updates are self-only.

After explicit user approval on 12 September 2026, the dry run was repeated and
the exact deletion migration was **applied successfully** to the linked Bubble
project with vault updates disabled. A fresh migration-history read confirms
`20260912000100` on both local and remote. No seed data, custom roles, vault
secrets or family/photo records were changed; no deletion was performed.

Post-deployment catalog checks passed: row security is enabled, authenticated
clients have guarded RPC access and read-only marker access, anonymous execution
and direct marker mutation are denied, the anti-resurrection trigger is enabled,
and deletion markers are published to realtime. The deployed marker policy
requires approved membership and either a published marker or its uploader.

The reusable check in `supabase/checks/owned_journal_photo_deletion.sql` passed
against the deployed database in one **read-only transaction**, ending in
rollback. It asserts the migration, tuple key, grants, trigger and realtime
registration, then executes anonymous and missing-identity rejection checks
using only null family/photo IDs. It sets no real user identity and reads no
family/photo contents. The missing-identity call returned the required
`authentication_required` denial.

## Validation

- Browser layout matrix: 320, 390 and 430px × all three themes (nine cases),
  using isolated fake photos. No horizontal page overflow, date-field escape
  or clipped long card captions; native date/year editing still saves.
- Deletion control and Timeline integration: 49 tests passed, including
  ownership gates, confirmation resets, cancellation, repeat clicks, failure,
  unmount and keyboard focus. The optional additional visual check of the new
  deletion control was unavailable when the browser connection disappeared.
- Uploader-scoped Journal library/service/store checks: 58 tests passed across
  seven suites, including concurrent upload/save/deletion and same-ID ownership.
- Capsule suite: 146 tests passed across 17 files, including avatar load limits,
  cleanup and all-contributor playback/export attribution.
- Final integrated suite: **1,229 tests passed across 141 files** (77.45 seconds).
  Expected jsdom canvas diagnostics were non-failing. No timeout or behavior
  assertion was weakened.
- TypeScript project build, full warning-denying lint gate, and Vite production
  build passed; 374 production modules transformed.
- SQL test files add 33 deletion-security assertions and seven avatar-sharing
  assertions. They were reviewed but **not executed**: this machine has no local
  Docker/PostgreSQL test runtime. The deployed read-only schema/denial smoke
  check above is not a substitute for successful-uploader and multi-account
  database tests.

## Remaining acceptance boundaries

- The migration is deployed and schema/unauthenticated guards are verified.
  Successful uploader deletion and family propagation still require a
  designated disposable test photo; no existing photo was used for testing.
- The new app build was installed in place and launched on Simreen’s iPhone
  at 14:01/14:02 Asia/Dubai; see [the installation record](./phone-installation-2026-09-12.md).
  Still test two approved family accounts on actual devices: upload/delete a
  designated test photo; publish/open a 360; add a
  plan and flight; release a test Capsule contributed to by both users and
  compare playback and saved-video attribution. No such live test was run here.
- Existing task definitions are shared; task completion/checkmarks remain
  per-device. A product-choice question was asked before changing that behavior.
- Existing 360 cold-device fetch still loads the newest 40 moments. No new
  historical pagination was introduced in this pass.
- Device clock skew/offline release, native video performance, network
  stress/capacity and physical iOS/Android widget flows were not proven by the
  client unit suite. This report does not claim a bug-free app.

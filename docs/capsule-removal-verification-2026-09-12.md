# Capsule and photo management update — 12 September 2026

## Delivered behavior

- Journal offers a management action for both direct uploads and released
  Capsule photos. An uploader can confirm deletion of their own source photo;
  another member's photo can be hidden on this device without changing the
  family's copy. Hidden items can be restored.
- Capsules expose creator-only confirmed deletion, plus reversible personal
  hiding for non-creators. The expandable **Manage my photos** panel allows
  uploaders to delete their own contributions even while a Capsule is sealed.
- Both special and weekly Capsules become past Capsules strictly more than
  72 hours after `opensAt`. Recently opened previous weeks remain visible in
  **Just opened** during those three days. Empty automatic weeks do not clutter
  history; empty authored special Capsules remain available in history.
- Every sealed cover uses the compact blurred-envelope artwork. The artwork
  is decorative, never injected into recaps. Other members' sealed photos are
  not fetched or mounted to create a visual blur.
- The status strip and Journal header share the same aligned background as
  the app in Plum, Forest and Midnight. No native identifiers were changed.

## Deletion boundaries and persistence

Migration `20260912000200_owned_capsule_deletion.sql` was applied to the linked
Bubble project after its dry run showed that single pending migration. It
adds uploader/creator-only operations, family-visible published deletion
receipts, private pending cancellation receipts, parent/photo locks, revival
guards, and deleted-parent media/reaction restrictions. No real family content
was deleted as part of deployment or testing.

Capsule deletion is a soft deletion: the server retains its inaccessible shell
and contained records, preserving weekly uniqueness so automatic creation
cannot bring the deleted week back. It is not a claim of immediate byte erasure
from all storage or previously downloaded videos. Existing signed URLs may
remain valid until their one-hour expiry. Deleting one photo source does not
delete separately uploaded copies or saved exports.

Confirmed receipts are persisted per account/family and applied before queued
uploads, after reconciliation, at store read/write boundaries, and in warm
Journal/widget views. Explicit creator/uploader IDs protect same-ID collisions;
published receipts also prune pre-upgrade caches that lack ownership metadata.
Private pending cancellation receipts never gain that legacy broad-match rule.
Week-wide suppression also requires a published receipt. Cancelling an offline
weekly draft removes only that compatible local identity, not another member's
canonical shared week or their contributions after reconnecting.

## Verification

- TypeScript application and tooling checks, repository lint, and production
  build passed. Production build transforms 382 modules.
- Dedicated deletion tests cover confirmation/cancel/double taps, errors,
  unmounts, account isolation, offline retention, canonical weekly IDs after
  upload, deletion receipts, stale writes, uploader/creator collisions, and
  pre-upgrade ownership metadata.
- Date partition tests cover exactly 72 hours and either side by one millisecond.
- Fake-data rendered checks: nine Capsule width/theme combinations at
  320/390/430px, including expanded confirmations, pass without horizontal
  overflow, blocked controls, nested buttons or external requests. Locked
  envelopes are 164–189px tall.
- Eighteen top-chrome size/theme checks passed, including keyboard-sized
  viewports. Scrolling causes zero pixel changes behind the opaque header.
- Deployed read-only smoke check passed for schema, privacy policies, grants,
  realtime feeds, revival guards, anonymous denial and missing-identity denial.
- The 48-case pgTAP ownership fixture is prepared but not executed: this machine
  has no local PostgreSQL/Docker runtime. No production fixture inserts or real
  photo deletions were used to substitute for that missing test environment.

Visual evidence: `/tmp/bubble-capsule-cards-qa.X54jG1/` and
`/tmp/bubble-app-chrome-qa.6085X9/`. Reusable, no-account fixtures are in
`scripts/qa/capsule-cards.html` and `scripts/qa/app-chrome.html`.

Full automated suite outcome and iPhone delivery evidence are recorded in the
phone installation report. Physical two-account deletion, Android runtime
acceptance and retained-data inspection still require hands-on verification.

# Journal navigation performance

## Cause and change

Journal already warmed route code and library/Capsule metadata, but its People
section started from empty state on every remount, reread IndexedDB and rewrote
the unchanged hydrated snapshot. Its rail, album covers and selected photo also
created separate Blob URLs that were revoked on every route exit. This caused
avoidable People/album loading flashes and repeated image loading on return.

- `peopleTimelineSession.ts` retains one account/family's private People metadata
  for the active member session. Reads coalesce, unchanged hydration is not saved
  again, and ordered edit/checkpoint persistence survives quick route remounts.
- The existing quiet-time route preloader prepares this local metadata after
  Journal code loads. It starts no network request or face scan, and ignores a
  lazy import that finishes after its shell/member has changed.
- `timelinePhotoPreviewCache.ts` reuses exact-Blob preview URLs within the same
  member namespace. Mounted images share reference-counted URLs; idle reuse is
  limited to 12 images, 24 MiB and 60 seconds. Account/family departure revokes
  the URLs through the existing member-cache lifecycle. No URL is persisted.
- Journal still unmounts normally. No hidden interactive page, route overlay,
  navigation delay or change to photo access/deletion permissions was introduced.
  All-photos default, widget focus, plans/flights and face matching remain intact.

## Verification

- Full regression suite: **1,378 tests in 153 files passed**.
  Log: `/private/tmp/bubble-journal-navigation-tests-20260912.log`.
- The final preloader module split passed its seven focused route tests.
- The final fixture/source audits passed seven checks across the interactive
  controls, authored copy and architecture suites.
- Application/tooling TypeScript checks, lint, production build and iOS sync
  passed. Production build: 384 modules. No dependency versions changed.
- Tests cover immediate warm/prewarmed state, coalesced reads, slow/failed saves,
  StrictMode hydration, stale account callbacks, Blob URL reuse, expiry, bounded
  idle memory and account/family cleanup.
- Chromium browser QA passed 20 alternating Moments/Capsule-to-Journal returns.
  All 20 first commits and next frames had three People, two albums and six
  unchanged image sources, with all six images decoded (`complete=true`,
  `naturalWidth=900`). Only three shared Blob URLs were allocated for the
  initially displayed photos; returns caused no new allocations or revocations.
  Plans/Photos, a profile round-trip, exact widget photo focus and later slider
  movement remained usable. No browser errors or outside requests were observed.
  Evidence: `/private/tmp/bubble-journal-navigation-qa.AT4M4x/results.json`.
- The isolated prewarmed first-ever visit had People/albums on its first commit,
  but initial photo decoding still followed mounting. A completely cold,
  un-prewarmed visit still hydrates local state. This is not a claim that cold
  data reads or first-ever image decoding have been eliminated.

The app change is shared by web, Android and iOS. Browser timings are not a
physical-iPhone benchmark, and installing on iPhone does not establish Android
device acceptance. No real family content was modified for testing.

Phone package/delivery evidence is recorded in `phone-installation-2026-09-12.md`.
The requested GitHub delivery includes earlier reviewed local app/refactor work;
the generated duplicate `ios/App/App/config 2.xml` is deliberately left untracked.
No backend deployment is part of this navigation fix.

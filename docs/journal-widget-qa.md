# Journal photo-widget regression checks

## Behavior

- Opening Journal normally selects **All photos**, including uploads with no
  enrolled or matched faces. Named scrapbook routes keep their person filter.
- The photo widget samples synced Journal uploads and authorized, unlocked
  capsule photos across the full archive. Locked, pending and local-only media
  are not published to the Home Screen.
- Photos rotate through a stable shuffled order hourly. iOS and Android refresh
  on their own schedules, so an exact on-the-hour visual change is not promised.
  Task pages stay parked when photos rotate.
- Every widget poster is paired with its own collection/photo IDs. New widget
  links and cached legacy photo-widget links open the ordinary Journal timeline
  at that photo, with All photos selected, rather than opening Photo memory.
- Focus is applied once per widget tap, including when photos arrive late.
  Manual timeline/person changes cancel pending restoration. A repeated tap
  creates a new selection request; switching away does not trap or reset users.
- A photo shared into weekly and special capsules occupies one timeline entry.
  Stable photo keys preserve its position if capsule membership changes.

## Isolated visual fixture

Open `/scripts/qa/journal-widget-screen.html` on a fresh local development
server. This entry is not imported into the production app. It uses the real
Journal page, timeline and primary tab bar, with three fabricated SVG photos.
It does not authenticate or read private photos and cannot write remote data.
Any timeline metadata uses the dedicated `qa-journal-widget:no-account` local
cache namespace.

The controls simulate a widget tap and delayed photo availability. With file
watching disabled, restart the development server after source changes rather
than relying on a reload of cached transforms.

## Checks performed on 11 September 2026

- At 402 × 874, Journal defaulted to All photos and showed the oldest of all
  three sample uploads. Document and viewport widths were both 402 px, with no
  horizontal overflow.
- Widget entry selected the latest sample at timeline position 3 of 3, inside
  Journal. Scrubbing back to the oldest photo worked. Tapping the same widget
  again restored its exact photo.
- Plans remained interactive after photo-widget entry. Returning to Photos did
  not reapply the dismissed widget selection. Primary navigation to Moments and
  back to Journal worked, with All photos selected on ordinary reopening.
- Hiding photos, tapping the widget and then loading photos selected the exact
  target after arrival. No separate loading screen or photo-viewer overlay was
  introduced.
- Automated coverage includes fresh/warm/repeated native entry, strict-mode
  startup, malformed routes, delayed photos, edited dates, duplicate memberships,
  direct-upload/capsule ID collisions, account and privacy changes, and hourly
  rotation.

## Verification and limits

- The initial targeted Journal/timeline run passed 45 tests. Photo selection,
  publishing and canonical timeline helpers passed 66 tests. Native-link parser
  and navigation tests passed 26 tests.
- A full JavaScript run passed 958 of 959 tests. Its sole failure was an obsolete
  expectation for the removed preview-only All-photos prop; that assertion was
  updated to the new universal default. Lint and TypeScript passed in that run.
- iOS paging, rotation and privacy harness: 30 scenarios passed. Shared widget
  model and extension type-checks passed for the iOS 15 extension deployment
  target using the installed SDK.
- Android: 17 pure JVM widget-model tests passed, and changed Android Java
  sources compiled against Android 36. Full Gradle verification was blocked by
  iCloud-generated duplicate resources, then local disk-space/file-read errors
  in an isolated retry.
- The final full check encountered iCloud dataless-file read cancellations and
  timeouts. These are workstation verification limits, not passing build results.
- Subsequent focused reruns passed **149 tests across 10 files**: 107 route,
  Journal, widget-publishing, selection and timeline-helper tests, plus 42
  PeopleTimeline/photo-viewer tests. These include the corrected universal-All
  assertion, the deferred-cache filter regression, and stable viewer-return
  keys. The final viewer-only rerun passed all 7 tests; scoped lint passed.
- A subsequent production build succeeded (338 modules), using a fresh
  temporary output folder to leave the existing app/device bundles untouched.
- Final lint of all changed TypeScript/TSX files passed. A separate final
  `pnpm typecheck` retry made no progress after printing `tsc -b` and was
  interrupted after several minutes; no final type-check success is claimed.
- No phone hardware test, installation or GitHub push was performed during the
  initial implementation checks above.

## Requested iPhone installation — 11 September 2026

- Rebuilt the production app and copied it into the iOS project.
- The signed App/Debug device build, including BubbleWidgetExtension, succeeded.
  Strict recursive code-signature verification passed; all 39 production entry
  and JavaScript/CSS chunk files matched the signed app bundle exactly.
- Installed in place on the connected iPhone 17 Pro with the existing bundle
  identifier. No uninstall or app-data reset was performed. Device tools
  confirmed the new installation and successfully launched Bubble at 23:17
  Asia/Dubai.
- Hands-on Home Screen widget refresh/navigation acceptance remains to be
  confirmed on the phone. A fresh full TypeScript run stalled on iCloud-only
  source reads and was stopped without compiler diagnostics; full tests were
  therefore not rerun during installation.
- GitHub publication is separate from installation and awaits confirmation of
  the repository destination; the commit identity is simreensiraj.

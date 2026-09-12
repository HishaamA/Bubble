# iPhone update — 12 September 2026

Follow-up installation requested after the two structural cleanup passes.
Those passes were local-only; this record covers the subsequent phone update.

## Build and package verification

- Fresh production web build succeeded: 365 modules transformed.
- Capacitor iOS sync succeeded with the existing plugin versions.
- Signed App/Debug physical-device build succeeded, including the embedded
  BubbleWidgetExtension target. Existing bundle IDs, signing team and App Group
  were retained.
- Recursive strict code-signature verification passed with the host certificate
  trust service available.
- SHA-256 comparison of all 53 web files in `dist` against the signed app's
  `public` directory found no mismatches.
- The app uses bundled production assets, not a local development-server URL.

## Installation

- Installed in place on Simreen's iPhone 17 Pro at 12:34 Asia/Dubai.
- Apple's device tool reported successful installation of
  `com.simerfamily.kinsphere`.
- Successfully launched that app at 12:36 Asia/Dubai.
- No uninstall, app-data reset, account change or photo deletion was performed.
- GitHub was not pushed as part of this installation.

## Verification limits

The preceding cleanup passed 1,128 automated tests, TypeScript checks, lint and
the production build; see [the cleanup report](./refactor-phase-two-verification.md).
This follow-up confirms packaging, installation and process launch, not every
physical-device interaction. Journal navigation, rapid tab switching, widget
taps, capture hardware and retained user data still need hands-on acceptance
on the phone. The displayed version remains 1.0 (1); package verification and
the successful install establish that this is the newly built copy.

## Second update — Journal, family sharing and Capsule attribution

User requested installation after the family Journal fixes and approved backend
deployment, and requested phone installation by default after future app changes.
That standing delivery preference is now recorded in the repository `AGENTS.md`.

- Fresh production web build succeeded: 374 modules transformed. Its bundle
  hashes match the previously verified source from the 1,229-test pass.
- A redundant TypeScript rerun stalled and was stopped; no app source changed
  since the preceding successful TypeScript/lint/full-test gates. This install
  does not claim a new completed TypeScript run.
- Capacitor iOS sync completed with the same three plugins. App identifier,
  native project, signing team and widget App Group remained unchanged.
- The first Xcode build stalled in SwiftPM's Git-status scan. It and its
  identified child were stopped. The successful retry supplied process-local
  Git overrides (`core.fsmonitor=false`, `core.trustctime=false`,
  `core.checkStat=minimal`), without changing repository Git configuration.
- The physical-device App/Debug build exited successfully using the existing
  derived-data directory and signing setup.
- All **53** files in fresh `dist` matched the signed app's `public` directory
  by SHA-256. The widget extension was present, and the embedded configuration
  had no development-server URL.
- Strict recursive code-signature verification passed. Main app and widget
  retained the expected identifiers and shared App Group.
- Installed in place on **Simreen’s iPhone 17 Pro at 14:01 Asia/Dubai**.
- Successfully launched `com.simerfamily.kinsphere` at **14:02 Asia/Dubai**.
- No uninstall, app-data reset, account change or photo deletion was performed.
  No GitHub push was performed.

The Journal deletion backend migration was already deployed and its read-only
safety smoke passed; see [the family Journal report](./family-journal-verification-2026-09-12.md).
This confirms delivery and launch, not successful deletion of a real photo or
two-family-account/device acceptance. Those interactions remain untested here.

## Third update — photo management, Capsule lifecycle and seamless chrome

See [the Capsule removal report](./capsule-removal-verification-2026-09-12.md)
for ownership boundaries, the deployed migration, read-only backend smoke,
visual checks and unexecuted database fixture limitations.

- Application and tooling TypeScript checks, lint and production build passed.
  The final build transforms 382 modules. A redundant incremental check was
  slow but eventually completed; the non-incremental retry also passed.
- Final full regression run: **1,341 passed / 1,343**, across 150 files.
  The two failures were 30-second timeouts in repository-wide source scans
  (`interactiveControls.test.ts` and `userFacingCopy.test.ts`), not assertion
  mismatches. Log: `/private/tmp/bubble-capsule-final-host-tests-20260912.log`.
  The copy scan separately passed in 4.9 seconds, but scan timing was
  inconsistent on this host; this is not a claim of an all-green full run.
  A final combined isolated scan rerun again reported a timeout and was
  stopped after remaining stalled; no further full-suite rerun was claimed.
  All 60 focused deletion/receipt/reconnect checks passed after the final
  offline-week safety fix, including the four new regression cases.
- The first final device-destination build timed out because the iPhone needed
  its passcode. The final generic iOS device build succeeded with the existing
  signing setup and process-local Git overrides.
- All **54** files in fresh `dist` matched the signed app's `public` directory
  by SHA-256; no mismatches were found. The embedded configuration uses
  production assets and has no development-server URL.
- Bundled `index.html` SHA-256:
  `39cb6dbb7bc96d7babd86d350f94dfbee508baeacccfcd60382f78d720ed9d59`.
- The widget extension is present. Strict recursive signature verification
  passed, retaining app ID `com.simerfamily.kinsphere`, widget ID
  `com.simerfamily.kinsphere.BubbleWidget`, team `WHLVT8Y56F` and App Group
  `group.com.simerfamily.kinsphere.widget`.
- Simreen's paired iPhone was rechecked; the friend's device was not used.
  At 15:48 Asia/Dubai it still required its passcode, but the subsequent
  in-place installation succeeded at **15:50 Asia/Dubai**.
- The newly installed app launched successfully at **15:51 Asia/Dubai**.
  Both operations were confirmed by Apple's device tool.

No uninstall, app-data reset, account change, real photo/Capsule deletion, or
GitHub push was performed during this update.

Installation and process launch do not establish physical-device acceptance
for real-photo deletion, two-family-account propagation, widget interaction,
Android behavior or retained-data inspection. Those remain hands-on checks;
no real family content was modified to test deletion.

## Fourth update — discreet controls and covered Capsule history

See [the presentation refinement report](./capsule-presentation-refinement-2026-09-12.md)
for behavior and verification. This update was installed and launched after the
user reconnected the phone and requested installation.

- Application and tooling TypeScript checks and lint passed. The full suite
  completed 1,360 checks: 1,359 passed, with the authored-copy audit finding a
  prohibited punctuation character in the new manual QA fixture. That fixture
  was corrected and both repository audits then passed (3 checks). This is not
  a claim of a second all-green full-suite run.
- All nine visual combinations passed: 320/390/430px in Plum, Forest and
  Midnight, including compact removal confirmations and old/recent/locked cards.
  No overflow, undersized targets, nested buttons, browser errors or external
  requests were found. Evidence:
  `/private/tmp/bubble-capsule-refinement-qa.2U2lrK/results.json`.
- The final production build transformed 382 modules; Capacitor iOS sync and
  the signed generic-iOS-device App/Debug build completed successfully. The
  process-local Git overrides above were used without changing Git settings.
- All **54** files in fresh `dist` matched the signed app's `public` directory
  by SHA-256, with no mismatches. Bundled `index.html` SHA-256:
  `92fb8843d697e30449581a5e98034ebd9d2bc9b8a2887b43c3488e7f8b1d9d14`.
- The package has no development-server URL and includes the widget extension.
  Strict recursive signature verification passed. Entitlements retain app ID
  `com.simerfamily.kinsphere`, widget ID
  `com.simerfamily.kinsphere.BubbleWidget`, team `WHLVT8Y56F` and App Group
  `group.com.simerfamily.kinsphere.widget`.
- Device discovery and a direct device-information check around **18:12
  Asia/Dubai** found Simreen's paired iPhone unavailable, with its connection
  tunnel unavailable. A subsequent device-list retry still found it unavailable.
  The friend's device was not substituted. Installation was deferred then.
- On the user's subsequent installation request, device discovery confirmed
  **Simreen's iPhone 17 Pro** was available and paired. All 54 bundled files and
  the recorded index hash were rechecked; the package was unchanged. Strict
  recursive signature verification passed again, with the widget included and
  no development-server URL.
- Installed in place at **22:56 Asia/Dubai**. Apple's device tool confirmed
  successful installation of `com.simerfamily.kinsphere`.
- Successfully launched that app at **22:57 Asia/Dubai**, confirmed by Apple's
  device tool. No other phone was targeted.
- Verified installed package source:
  `/private/tmp/bubble-smac-ios-device-derived/Build/Products/Debug-iphoneos/App.app`.

No uninstall, app-data reset, account change, actual family photo/Capsule
deletion, backend deployment or GitHub push was performed for this refinement.
Installation and process launch are confirmed; hands-on interaction, retained
content inspection and Android acceptance remain unverified.

## Fifth update — warm Journal navigation

See [the Journal navigation report](./journal-navigation-performance-2026-09-12.md).

- Full regression suite passed **1,378 tests across 153 files**. After the final
  preloader-module adjustment, its seven focused checks passed. Seven repository
  audits passed after the synthetic browser fixture was added; final application
  and tooling TypeScript checks and lint passed again after fixture completion.
- Real-browser QA passed 20 repeated returns to Journal, with People, albums
  and already-decoded photos present on the first commit and following frame.
  It also checked tabs, profile return, widget focus and slider use. Cold initial
  image decoding remains a separate operation; this is not an iPhone benchmark.
- Fresh production web build transformed 384 modules. iOS sync and signed
  generic-device App/Debug build passed with the existing signing setup.
- All **56** web files in fresh `dist` matched the signed app by SHA-256. Its
  `index.html` hash is
  `c26b76527eae7be19b1a17f43f89182c7d12cd4af8f47b293b99fa547d167dc2`.
- Strict recursive code-signature verification passed. App ID
  `com.simerfamily.kinsphere`, widget ID
  `com.simerfamily.kinsphere.BubbleWidget`, team `WHLVT8Y56F` and App Group
  `group.com.simerfamily.kinsphere.widget` were retained. The widget is embedded
  and there is no development-server URL.
- Device discovery confirmed **Simreen's iPhone 17 Pro** was available and
  paired. Installed the verified package in place at **23:21 Asia/Dubai**.
- The first launch attempt encountered a transient connection reset. Device
  discovery still showed the correct phone available; the next launch succeeded
  at **23:22 Asia/Dubai**, confirmed by Apple's device tool.
- No uninstall, app-data reset, real family-content mutation or backend
  deployment was performed. Hands-on iPhone interaction, retained-content
  inspection and physical Android acceptance remain unverified.

The user also requested a GitHub push. The repository's existing origin is
`HishaamA/simerfamily`; authenticated pushing account and commit author identity
were verified as `simreensiraj`. The separately reviewed pending app/refactor
changes are included with this fix, excluding the generated duplicate
`ios/App/App/config 2.xml` and ignored local credentials/build artifacts.

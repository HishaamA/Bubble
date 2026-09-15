# Widget controls rollback — 16 September 2026

## Scope

At the user's request, restored the version immediately before the right-side
widget control change on Android and iOS: bottom previous/next controls, visible
page counter, signature mark and original content spacing. The earlier themed
widget redesign, map-free flight tickets, retained tracked flights, Journal
person-upload fixes and other pending app work are preserved in this snapshot.

The side-control change was uncommitted, so this is a source-level rollback,
not a Git history rewrite. The iOS widget source matches its saved pre-change
baseline after normalizing line endings. Android renderer, footer layout and
navigation-pill styling were restored by reversing the side-control edits.

The deterministic, bounded native test-harness improvements are retained. They
do not change production app behavior. No new visual redesign was introduced.

## Verification

- 789 web tests across 61 widget, flight and Journal test files passed.
- TypeScript and production Vite builds passed; Capacitor Android/iOS sync passed.
- Generated SwiftPM paths were restored to forward slashes after Windows sync.
- Android JVM tests: 242 tests across 32 suites, no failures, errors or skips.
- Android debug app and instrumentation APK assemblies passed.
- Physical widget layout tests: 17 passed, 1 known pre-side-design failure.
  `longTaskAndPlanNamesFitAboveNavigationAtCompactHeight` reports vertically
  clipped subtitle text for a long task/plan at 320x220dp and font scale 1.0.
  This limitation is deliberately retained for the requested exact rollback;
  the test remains enabled and was not weakened.
- Synthetic restored flight and task widgets were visually inspected. Footer
  controls, page counters and the map-free flight design are present. These are
  detached native-host renders, not a claim of real launcher arrow-tap testing.
- All 69 packaged web files match `dist`; no embedded development `server.url`.
- App and test `ENABLE_TEST_AUTH_BYPASS` flags are false.
- Native iOS build/device verification remains unavailable on this Windows host.

## Installed Android package

- Device: OnePlus 8T / KB2001, serial `0a80470f`.
- App: `com.simerfamily.kinsphere`, Bubble, version 1.0 / code 1.
- App and instrumentation APKs installed in place with `adb install -r`
  (test APK additionally uses `-t`); both returned `Success`.
- Launch through `ForestLauncher` returned `Status: ok`; `MainActivity` opened
  and the app process was present afterward.
- Last update: `2026-09-16 00:48:55`.
- First install remains `2026-08-28 22:07:34`.
- Data directory remains `/data/user/0/com.simerfamily.kinsphere`.
- APK: `android/app/build/outputs/apk/debug/app-debug.apk`, 218,662,176 bytes.
- APK SHA-256:
  `3958a4c7d27f300d1870bf9f473a1d378e1da97ca9fb3d8b676c7a8de82a7a5b`.
- Unchanged signing-certificate SHA-256:
  `08cc75142c999fc19e42947bc248a091fea77acfd7af3bacaa5264ad8cf59ae2`.

No uninstall, app-data reset, user photo/task edits or backend deployment was
performed. Source and verification notes are committed to Bubble `origin/main`;
generated APKs, synthetic render output and local environment files are excluded.

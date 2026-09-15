# Minimal flight map and retained flight widgets — 15 September 2026

## Requested behavior

- Restored the original five-shape schematic map. Only the northeastern edge of
  its North America shape is adjusted so the JFK endpoint sits at its coast;
  there are no detailed coastlines, borders, or extra islands.
- Every flight still stored in the tracker is eligible for a widget page,
  including arrived, cancelled, old and distant-future flights. Removed the
  server-side date cutoff and the widget's active-only/24-hour/four-flight filters.
  The bounded deck supports the tracker's 100-flight collection plus 12 existing
  task/photo/recap cards. Synced removals and account clearing remain authoritative.
- Widget maps use the app's projected endpoints, quadratic route, marker and
  rotation, with identical 45-vertex land geometry. Cached positions say
  "Last reported"; estimates are explicitly not live GPS. Only timetable-derived
  estimates advance with time. Provider percentages are not overwritten.
- Arrived maps end at the destination; cancelled/unavailable maps do not invent
  a plane position. Retention does not fabricate a flight's status from the clock.
- Flight publication and removal no longer wait for unrelated photo thumbnails.
  Serialized writes, hidden-preview privacy and manual page selection are retained.
- Android's compact flight layout includes the map at normal 220–240dp heights
  with the existing 48dp navigation controls. Extremely short/narrow widgets retain
  route/status/open controls without squeezing an unreadable map into them.

This supersedes the active-only filter and detailed-map behavior documented on
14 September. No provider subscription, API-key, authentication or database-schema
changes were made. Widgets use cached authorized data, not extra paid API calls.

## Build and checks

- Web flight/widget suite: 267 tests passed, followed by three additional heading
  and timestamp regression cases; final focused publisher/flight run: 41 passed.
- Scoped lint, TypeScript build and Vite production build passed.
- Android JVM suite: 239 tests, no failures/errors.
- Production web assets synced to Android and iOS. Windows-generated SwiftPM
  dependency separators restored to portable forward slashes.
- Android debug app and instrumentation APK built offline with
  `-PenableTestAuthBypass=false`; generated flags verified false.
- All 69 packaged web files match `dist` byte-for-byte. Capacitor has no remote
  development-server URL.
- Signing certificate SHA-256:
  `08cc75142c999fc19e42947bc248a091fea77acfd7af3bacaa5264ad8cf59ae2`.
- APK SHA-256:
  `54b4756e6b6a509801091d76a8eb10304e823af4f2ff195ba08b41d54768467c`.
- APK: `android/app/build/outputs/apk/debug/app-debug.apk`.

## Connected Android delivery

- Target: connected OnePlus 8T / KB2001, serial `0a80470f`.
- Both `adb install -r` for Bubble and `adb install -r -t` for the test APK
  returned `Success`. Existing package ID and signing certificate retained.
  No uninstall, data clear, task edits or photo edits were performed.
- Physical-device instrumentation passed **9 tests**: eight JSON/retention/privacy
  contract cases and the map/layout test covering six widget sizes, including
  220, 240 and 300dp heights. Fixtures use isolated preferences and synthetic
  content, not the user's saved flights or gallery.
- The original app's capture directory contained 85 files before installation;
  hashes were kept only in the private tool session for comparison.
- The phone disconnected after successful installation and instrumentation,
  before app-launch, actual-flight publication and post-install capture-hash
  checks. Reconnection was requested. Do not treat these remaining checks as done.
- The isolated browser preview was visually checked in Forest: five quiet land
  shapes, one dotted route and one airplane; the ticket styling was not redesigned.

## iOS and remaining test limits

iOS widget parsing, retention and map rendering were updated to the same shared
contract. All 45 Swift/web land vertices match and Swift fixture coverage was
expanded. This Windows environment has no Swift compiler or Xcode, so the iOS
extension has not been compiled, installed or physically verified in this pass.
Android tests do not substitute for that verification.

No commit or push was performed for this change.

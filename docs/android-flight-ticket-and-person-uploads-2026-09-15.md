# Flight ticket widget and person uploads — 15 September 2026

## Changes

- Restyled native flight widgets as dark, theme-matched boarding passes: compact
  flight/traveler identity, restrained status pill, serif airport columns and a
  dotted plane divider. Normal compact Android sizes use an ETA/map split;
  taller widgets have a broader map below. Existing map geometry, flight
  retention, cached/estimated labels, navigation hitboxes and deep links remain.
- Added an explicit **Add scrapbook photos** action inside a person's scrapbook
  and management panel. The previous handler lost the selected person and always
  switched to All photos; the dedicated scrapbook route also lacked its picker.
- The library now returns the exact successfully saved photo IDs. Targeted imports
  apply explicit whole-photo membership for only the chosen person and only those
  successful rows, without waiting for face matching or labeling every detected
  face. Existing IDs can be reused without another association or storage copy.
- Membership completion survives tab navigation. Stale picker results, disposed
  accounts and changed account namespaces cannot attach/import into a new scope.
- Face-reference enrollment remains a separate, matching-only flow. Its source
  pictures are not silently saved or uploaded to scrapbooks. Ordinary scrapbook
  imports retain the existing family-photo sharing behavior.
- Partial failures and label-save problems are surfaced without asking users to
  re-upload photos already saved. Connected gallery originals are untouched.
  This change does not add content-based deduplication to explicit file imports.

## Verification

- Journal regression suite: **90 tests passed**, including no-face targeted
  imports, partial success, failures, reused IDs, chosen-person changes, tab
  unmount/remount, account disposal and old picker returns.
- Android JVM suite: **242 tests passed**; Android resource/Java compilation and
  debug instrumentation APK assembly passed.
- Full TypeScript project build, scoped strict lint and Vite production build passed.
- Browser visual QA with synthetic photos: scrapbook upload action readable in
  Plum, Forest and Midnight; manager separates scrapbook uploads from face views.
  Synthetic upload changes the count from four to five without leaving the person.
- Final APK built with `-PenableTestAuthBypass=false`, verified in generated flags.
  All **69** bundled web assets match `dist` byte-for-byte; no development-server URL.
- Signing certificate SHA-256:
  `08cc75142c999fc19e42947bc248a091fea77acfd7af3bacaa5264ad8cf59ae2`.
- APK SHA-256:
  `1ec947c15d10c555758e3e01e697ccd4b75e860ed67e4aec005a693520d9a54c`.
- APK: `android/app/build/outputs/apk/debug/app-debug.apk`,
  218,661,998 bytes, built at 01:56 Dubai time.

## Delivery limits

No Android device was detected throughout this change; reconnection was requested.
This APK **has not been installed**. No device data was cleared or changed.
The previous installed APK is documented in `android-installation-2026-09-15.md`;
its physical-device test result is not a visual verification of this newer design.

The new physical fixture methods are
`flightTicketsKeepTheDarkPaletteAndExportEveryThemeAtCompactAndTallSizes` and
`flightTicketsHandleLongNamesStatusesAndLargeSystemFonts` in
`BubbleWidgetLayoutInstrumentedTest`. They cover all three themes, 220/240/300dp
heights, long names/statuses and 1.4x font scaling. Run after reconnecting the
identified OnePlus 8T, using an in-place install and isolated synthetic fixtures.

iOS rendering was restyled and web assets synced. SwiftPM paths were restored to
portable forward slashes after Windows sync. Swift/Xcode and an iPhone are not
available here, so native iOS compilation and visual testing remain unverified.

No commit, push, backend deployment or real-photo test upload was performed.

## No-map follow-up

At the user's request, removed the map from Android and iOS flight widgets only.
The in-app flight map is unchanged. Widgets retain the themed ticket layout,
status, airport codes, ETA and update details; Android uses the full-width route
row at every size instead of reserving an empty map column. Legacy map payload
fields remain compatible, but the widget does not render a map bitmap or Canvas.

- Android JVM tests: **242 passed**, no failures or errors. Debug APK and updated
  no-map instrumentation fixtures compile successfully.
- Production web build and iOS asset sync completed; SwiftPM paths were repaired
  to portable forward slashes after Windows sync.
- All **69** APK web assets match the current production build; no dev-server URL.
- Test-auth bypass is false, and the signing certificate is unchanged.
- Updated APK SHA-256:
  `a993a4df7175ad8a05491bc249726f940ea86ffb80519770667884491e3ce722`.
- No connected Android was detected after the build, so this APK is **not
  installed** and the no-map physical layout tests have not run. iOS native
  compilation still requires Xcode. No existing device data was changed.

## Android delivery after reconnection

The user requested installation after reconnecting their OnePlus 8T (KB2001,
serial `0a80470f`). The no-map APK recorded above was reverified: matching SHA-256,
valid unchanged signing certificate, all 69 production assets matching, and no
development-server URL.

- `adb -s 0a80470f install -r .../app-debug.apk` returned **Success**.
- Launch through the existing `ForestLauncher` returned **Status: ok**, opening
  `MainActivity`; the app process was present afterward.
- Package reports `lastUpdateTime=2026-09-15 11:59:08`. Original
  `firstInstallTime=2026-08-28 22:07:34` and
  `dataDir=/data/user/0/com.simerfamily.kinsphere` are unchanged.
- This was an in-place update, with no uninstall, storage reset or user-content
  changes. Physical widget layout/instrumentation tests were not rerun during
  this install-only request. No commit, push or iOS delivery was performed.

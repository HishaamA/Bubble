# Widget side controls — 15 September 2026

Historical record: this design was reverted at the user's request on
16 September 2026. The previous bottom controls are restored; see
[the rollback verification](android-widget-rollback-2026-09-16.md).

## Requested change

Removed the entire bottom navigation bar, its Bubble mark and visible page
counter. Previous/next controls now sit in a slim, vertically centered capsule
at the trailing edge. Themes, widget content, privacy, navigation intents and
the map-free flight widget are retained.

Android uses a 36dp-wide visible capsule inside a 48x96dp touch area, two separate
48dp targets, 16dp arrow glyphs, a subtle divider and ripple feedback. A dedicated
52dp trailing inset prevents text/photos from overlapping the arrows. Bottom
padding is ordinary content padding again. Single-card widgets have neither the
controls nor the extra inset. The content inset follows RTL layout direction.

Narrow flight cards fall back to a compact route title; larger cards retain the
airport pair and status. Page context is available to accessibility without any
visible counter. The recovered vertical room also fixes the previously observed
long-task subtitle clipping case.

iOS has the equivalent trailing capsule, 44pt touch targets, no bottom bar or
counter, and responsive narrower content. Provider/intent/privacy logic is
preserved. Native iOS compilation and physical testing require Xcode and remain
unverified on this Windows host.

## Verification

- Fresh TypeScript project build, production Vite build and Android/iOS
  Capacitor sync succeeded. SwiftPM paths were repaired to forward slashes.
- Android JVM tests and both debug APK assemblies succeeded.
- All **18** physical `BubbleWidgetLayoutInstrumentedTest` cases passed on the
  connected OnePlus 8T, including no-map flights, all themes, large text, narrow
  layouts, privacy, page selection, resizing, right-control clearance and the
  formerly failing long-task case.
- The detached-host test harness no longer waits for global app idleness.
  Individual main-thread operations and tests have explicit timeouts.
- Synthetic flight, photo, task, narrow and large-font PNGs were exported to
  `android/build/reports/widget-side-controls` and visually inspected.
  These are detached native-host renders, not proof of real launcher arrow taps.
- `git diff --check` passed. Existing unrelated local work was preserved.

## Installed package

- Device: OnePlus 8T / KB2001, serial `0a80470f`.
- Both app and instrumentation APK installed in place with `adb install -r`
  (`-t` additionally for the test APK), returning **Success**.
- Launch through the existing `ForestLauncher` returned **Status: ok**, opened
  `MainActivity`, and the process was present afterward.
- Last update: `2026-09-15 22:44:56`.
- Original first install: `2026-08-28 22:07:34`, unchanged.
- Data directory: `/data/user/0/com.simerfamily.kinsphere`, unchanged.
- APK: `android/app/build/outputs/apk/debug/app-debug.apk`, 218,662,176 bytes.
- APK SHA-256:
  `72819dcb2dd4f227822ac6650e9e28442d52d1df56bd00c44b1c1d43bc33d849`.
- Signing certificate SHA-256:
  `08cc75142c999fc19e42947bc248a091fea77acfd7af3bacaa5264ad8cf59ae2`.
- All **69** packaged web files match `dist` by SHA-256; no embedded server URL.
  `ENABLE_TEST_AUTH_BYPASS=false`.

No uninstall, app-data reset, user-content changes, commit, push or backend
deployment occurred.

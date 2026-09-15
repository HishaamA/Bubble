# Widget visual redesign — 15 September 2026

## Scope

The user requested a substantially more polished design for widgets while
retaining their theme. The previous request to keep maps out of flight widgets
is preserved. The in-app flight map and Journal import work were not changed.

- Android: tonal gradients retain the original Plum, Forest and Midnight base
  colors, with cream editorial serif titles, restrained hairline borders and a
  faint four-ring Bubble signature.
- Flight cards: identity/status header, larger airport pair, quiet FROM/TO
  labels where space permits, a perforated rule and clearer arrival information.
  No map bitmap is generated or displayed.
- Photos/recaps: more image space, rounded fine framing, serif captions and a
  neutral readable scrim.
- Tasks/capture/empty cards: left-aligned type with a flexible content area and
  space-aware title/subtitle limits. Small cards do not reserve a redundant
  action badge at the expense of readable content.
- Navigation: a grouped, subtle control pill and quiet brand/counter footer.
  Existing 48dp Android touch targets, explicit card selection, routes, photo
  rotation, retention and privacy behavior remain unchanged.
- iOS: equivalent editorial presentation and four-ring signature; original
  provider, intents and privacy paths preserved. Small/medium/large layouts are
  supported. This Windows machine has no Xcode, so native iOS compilation and
  visual QA remain unverified.

## Verification

- 137 web widget tests passed across 10 files.
- 242 Android JVM tests passed with zero failures/errors.
- TypeScript project build, Vite production build and both Capacitor syncs passed.
  SwiftPM paths were restored to portable forward slashes after Windows sync.
- Final Android app and instrumentation APKs compiled successfully.
- All 69 APK web assets match the fresh production build. No development-server
  URL is embedded; ENABLE_TEST_AUTH_BYPASS is false.
- Signing certificate SHA-256 remains
  `08cc75142c999fc19e42947bc248a091fea77acfd7af3bacaa5264ad8cf59ae2`.
- APK SHA-256:
  `4f9f45272bde4fd3a98d36178a668500ba780b116410cb5c8a31cc4c9c498dbd`.
- APK: `android/app/build/outputs/apk/debug/app-debug.apk`.
- `git diff --check` passed. Existing unrelated uncommitted work was preserved.

## Device and visual testing limit

The known OnePlus 8T (KB2001, serial `0a80470f`) was present at the initial
check but disconnected during the build. The subsequent install command returned
`device not found`; no installation or app-data changes occurred. Reconnection
was requested. This redesigned APK is **not installed**.

Expanded isolated physical-device fixtures compile, but **have not run**.
Do not treat compilation or static sizing review as rendered screenshot QA.
The full `BubbleWidgetLayoutInstrumentedTest` suite includes:

- `savesRepresentativeCardsAtEveryThemeAndSize`
- `representativeCardsKeepVisibleTextInsideContentAtLargeSystemFonts`
- `singleCaptureAndPrivateFallbackFitAtLargeSystemFonts`
- `longTaskAndPlanNamesFitAboveNavigationAtCompactHeight`
- Existing no-map flight, theme, fill, footer, navigation and privacy tests.

They render only synthetic content into a detached AppWidgetHostView and export
PNGs under `cache/widget-layout-qa`. After reconnecting, run these tests, inspect
the resulting images, correct any clipping, and then confirm installation/launch
in place. Actual launcher arrow tapping remains a separate physical check.

No commit, push, backend deployment, user-content upload or storage reset was
performed.

## Installation after USB reconnection

The user requested installation again. ADB detected the same OnePlus 8T/KB2001
(`0a80470f`). Both the redesigned app APK above and its test APK installed
successfully with `install -r` (`-t` additionally for the instrumentation APK).
The APK hash, signing certificate, all 69 web assets and absence of a dev-server
URL were reverified before delivery.

The app subsequently launched through the existing `ForestLauncher` with
`Status: ok`, opening `MainActivity`; its process was present. Package state:

- `lastUpdateTime=2026-09-15 22:22:50`
- Original `firstInstallTime=2026-08-28 22:07:34` unchanged
- `dataDir=/data/user/0/com.simerfamily.kinsphere` unchanged

No uninstall or storage reset occurred. The redesigned APK **is now installed**.

### Newly observed physical-test issue

The real-device layout suite passed 13 individual tests, including all flight
no-map/theme/large-font tests, resizing, privacy and basic navigation/layout
checks. `longTaskAndPlanNamesFitAboveNavigationAtCompactHeight` failed at
320x220dp with normal font scale: `bubble_widget_subtitle` has vertically clipped
text when both the task title and plan name are long.

The next representative-image export test stopped reporting progress. The
diagnostic run was explicitly stopped using a force-stop of the test-host app,
then Bubble was relaunched successfully. The runner's resulting “Process
crashed” message reflects that deliberate termination, not a demonstrated
normal-use app crash. Four remaining suite cases were not completed.

Exported synthetic Forest flight and Plum long-task images were inspected.
The flight card shows both airport columns, ETA and controls with no map.
This is not a claim that the entire visual suite or real launcher taps passed.
No production code was changed during this install-only request; the long-text
clipping issue remains to be corrected.

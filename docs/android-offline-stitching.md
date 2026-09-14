# Android offline 360 assembly

This document covers **Advanced alignment** under Capture's **Other creation
options**, at `#/capture?workflow=advanced`. Standard Capture now uses the shared
on-phone iOS/Android compositor at 2K; see [phone panorama parity](phone-panorama-parity.md).
The native job recovery and stricter quality gates below apply to advanced jobs,
not standard shared blending.

The Android APK bundles DISK feature extraction and LightGlue learned matching
through ONNX Runtime CPU, followed by a native OpenCV reconstruction pipeline.
No source photos leave the phone during assembly, and no model download, worker
URL, USB connection, or API key is needed. Web/iOS retain their existing paths;
this native engine is Android-specific.

## Capture and recovery

- Standard capture starts with 34 main views. Actual saved-image intrinsics and
  camera poses are checked for coverage; narrow lenses or imperfect aiming can
  require extra fill dots. Coverage is checked again after accepting those photos.
- Turn around the **camera lens**, keeping it in one spot. Avoid walking around,
  switching lenses/zoom, nearby moving people, and very dark or textureless rooms.
  Extra dots repair missing coverage, not parallax or severe tracking drift.
- A dot is accepted only after its JPEG and recovery metadata have been saved.
  Camera-image delays retain earned hold progress; failed writes do not remove dots.
- Originals live in the app's private `files/panorama_captures/<UUID>` directory,
  scoped to the local profile. Saving/sharing does not remove them. Interrupted
  and completed sessions are listed on the capture screen after a restart.
- Assembly is visible foreground work. Navigating away does not cancel it.
  Explicit Stop cooperatively cancels; Retry starts from retained originals.
  A failed retry does not hide an earlier completed sphere. A 2K retry is offered
  for memory failure; the default output is 4096 × 2048.
- An interrupted **camera** session retains its photos but cannot safely resume
  its old AR coordinate system. Begin a new scan instead. Assembly recovery and
  capture-session continuation are different capabilities.

## Quality controls

Learned matches are geometrically verified, camera rotations are jointly refined,
exposures balanced, and wrapping seams blended. Difficult match graphs may receive
bounded classical SIFT recovery using real image evidence. The pipeline does not
invent missing walls or paint over alignment failure with generated content.
Coverage, connectedness, and reprojection error are checked before publishing.
Poorly aligned or incomplete captures fail with retained originals, not a rough
fallback image. These checks cannot guarantee a flawless handheld result: close
objects and movement can still defeat a rotation-based panorama.

## Build

Use Node/pnpm, JDK 21, Android SDK, NDK `27.0.12077973`, and CMake `3.22.1`.
From the repository root on Windows:

```powershell
.\scripts\setup-android-stitch.ps1
corepack pnpm install --frozen-lockfile
corepack pnpm exec tsc -b
corepack pnpm exec vite build --mode demo
corepack pnpm exec cap sync android
cd android
.\gradlew.bat --no-daemon :app:testDebugUnitTest :app:assembleDebug
```

The setup script verifies the pinned official OpenCV Android SDK archive and both
bundled model hashes. Models and attribution are under
`android/app/src/main/assets/stitch-models`; the SDK is ignored under `.native-deps`.
For a local sign-in-bypass test build, add `-PenableTestAuthBypass=true` to Gradle.
That option forces the local preview provider ahead of Clerk, even when an
existing real account is signed in. Signing out does not exit this build mode.
For account, family-sync, or widget-preview testing, omit it or explicitly use
`-PenableTestAuthBypass=false`; verify the generated debug `BuildConfig` contains
`ENABLE_TEST_AUTH_BYPASS = false` before installing. Local preview data remains
stored separately from signed-in family data.
Do not use the bypass option for a production release. Select the intended USB serial
and install `android/app/build/outputs/apk/debug/app-debug.apk` with `adb install -r`
to preserve app data. APK signing identity must remain unchanged.

## Verification

JVM tests cover capture hold rules, storage validation, and calibrated spherical
coverage planning (wrap, poles, roll, cancellation, frame budgets). Native geometry
tests and Android instrumentation run the actual compiled code and model runtime.
The opt-in `OfflinePanoramaInstrumentedTest#realOfflineStitchBenchmark` uses a
separately copied synthetic fixture, never the user's saved captures. Its local
report records model timings, graph/coverage errors, result size, and source retention.
`PanoramaRecoveryInstrumentedTest` checks damaged job metadata, orphaned work,
profile isolation, and preservation of prior completed output.
`PanoramaStitchServiceInstrumentedTest` copies the marked synthetic fixture to an
isolated owner-scoped session and exercises real foreground work, cancellation,
idempotent starts, durable reopening, and SHA-256 original-file preservation.

### Recorded OnePlus 8T validation (2026-09-09)

The installed APK passed 80 Android JVM tests, eight device service/storage tests,
and the actual 34-photo adaptive-model foreground-service reconstruction at 4K.
All 786 web tests passed after updating two integration fixtures to supply the
authentication context required by profile-scoped capture recovery.

The phone's 4096 × 2048 result aligned all 34 synthetic views with 73 validated
overlaps (four recovered by native SIFT), 100% measured coverage, no missing
regions, and median/p95 residuals of 1.05/2.38 output pixels. The result was
visually inspected and all source hashes remained unchanged. Reopening from
persisted state worked after the active worker was released; this is not a
claim that whole-process killing was simulated during that test.

End-to-end time was 352.27 seconds with the phone dozing under a partial wake
lock: feature extraction 122.33 s, adaptive matching 79.16 s, remaining native
assembly/overhead approximately 151 s. This is a measured background test, not
a promised capture time. Earlier full-depth matching took 140.81 s, but that
run used direct instrumentation under different scheduling/thermal conditions;
it is not a controlled overall speed comparison. Sampled process PSS reached
approximately 357 MiB plus 37 MiB swap; sampling is not a guaranteed peak.

Benchmark evidence is kept locally under ignored
`private-media/mobile-stitch-check/phone-adaptive-4k`. The installed APK SHA-256
was `72e7d295ed9145e45b374bd012b87ced3166f357795dd368e4d2c3a3f6f3294b`.
It was installed with `-r`; the original first-install timestamp and existing
WebView data remained. No user capture or app data was cleared.

Synthetic rotation-only reconstruction is a regression test, not evidence that
all real handheld scans look perfect. Final acceptance requires a fresh physical
capture and visual inspection in both the sphere viewer and headset.

### Capture-guidance follow-up (2026-09-09)

A regression test reproduced a full hold ring waiting indefinitely when aiming
just outside the strict capture zone but inside its hold-retention tolerance.
The guide now distinguishes these states: it asks the user to center the dot,
dims the retained progress ring, and keeps earned hold progress. Capture timing,
tracking, motion, and alignment requirements remain unchanged.

A bounded local diagnostic history (at most 120 samples, one every 500 ms) is
included when capture metadata is saved. It records alignment, hold, pose-speed,
camera-wait, and tracking states without video or network transmission, so a
persisting white-wall stall can be investigated from an actual device trace.

This follow-up build passed all 85 Android JVM tests and assembled successfully.
Its APK SHA-256 is
`d0e9dbfaf65769622a035d3c7d4884e38cd04428af895c59571ceda2cc985167`.
The follow-up APK was installed with `-r` on the reconnected OnePlus 8T at
22:55:42. All ten JPEG originals and their metadata in the user's latest
interrupted capture were verified SHA-256 identical before and after the update;
the first-install timestamp and WebView data size also remained unchanged.
Physical white-wall acceptance is still pending. The earlier reconstruction
benchmark above used the preceding APK.

### First completed handheld retest and coordinate-frame correction

The next phone retest completed all 44 requested photos (34 main views plus ten
measured gap-fill views). The original JPEGs and metadata are retained. This
proved capture completion, not a successful sphere: assembly rejected the scan
after 241.08 seconds, with only 18 validated overlaps and a largest connected
component of six frames. No misleading finished panorama was published.

Image inspection exposed a cross-time pose inconsistency. Frames 23 and 39 show
the same distinctive sink/appliances, with 335 calibrated SIFT inliers, but their
saved yaw values differ by 76.54 degrees. Their actual visual change is much
smaller. The original `coverageComplete` flag therefore cannot prove that this
scan physically covered a sphere. Recorded large positional changes are also
not enough to attribute the problem to user motion, because ARCore can change
its world coordinate system between frames.

The follow-up capture implementation uses one local session anchor, created at
the initial camera position. Every update reads both current camera and anchor
poses and saves `anchor.inverse * camera`; guide, hold, capture, and coverage all
share that reference. A paused reference preserves the dot and blocks capture;
a permanently stopped reference ends the scan with originals retained. It never
silently re-anchors midway. See the official
[ARCore world-coordinate guidance](https://developers.google.com/ar/reference/java/com/google/ar/core/Pose#world-coordinate-space)
and [anchor guidance](https://developers.google.com/ar/develop/anchors).

Five new JVM regressions verify reference invariance under common three-axis
world corrections, preservation of actual relative movement, and stationary
hold continuity. All 90 JVM tests passed. Physical stability through low-detail
tracking/relocalization still needs a new capture; old photos are not rewritten
or claimed repaired by this change.

Recovered background jobs now refresh while the capture page is visible and
stop at terminal states. Native bridge calls have bounded response deadlines;
timeouts explain that assembly may still be running rather than cancelling it.
Nine added web regressions cover terminal updates, visibility/profile cleanup,
timeouts, and late start acknowledgements with explicit cancellation.

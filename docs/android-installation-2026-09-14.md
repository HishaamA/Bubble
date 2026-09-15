# Android background gallery checking — 14 September 2026

## Scope

Improve gallery face-scan throughput and let the Android scan continue while the
user uses other apps. Preserve the existing account, enrollment, scan revision,
gallery references, and captured media. No Git push, auth bypass, backend change,
or photo upload is part of this delivery.

## Implementation

- Android 9+ uses a private `:galleryscan` foreground-service process, a locally
  packaged inference page, and a quiet progress notification with Pause.
- Human 3.3.6 / FaceRes 1024 and the existing model and scan revisions remain
  unchanged. Bundled TensorFlow 4.22.0 WASM is preferred; backend startup has a
  safe CPU fallback. Inference faults recreate the isolated engine instead of
  hot-switching a loaded model's TensorFlow backend.
- A native SQLite queue retains checkpoints while the UI is absent. Returning
  to Bubble imports bounded batches and acknowledges them only after the
  IndexedDB write commits. Existing valid scans are not submitted again.
- IndexedDB now stores face scans in individual rows instead of cloning and
  rewriting the entire descriptor library on every checkpoint. Existing data
  migrates atomically, without invalidating enrollment or scan results.
- Original gallery photos remain in MediaStore. Only temporary, bounded decoded
  pixels are used for inference; metadata and descriptors are persisted, not
  duplicate originals. Permission changes, disconnect, and account changes
  revoke the corresponding queue.
- iOS and older Android keep the foreground-scanning path. This change does not
  promise unrestricted iOS background execution.

## Build and automated verification

- TypeScript check, production Vite build and Android Capacitor sync passed.
- Journal/gallery/coordinator regression suite: 28 files, 410 tests passed.
- Final focused shared pipeline and isolated engine suite: 65 tests passed.
- Scoped lint and whitespace checks passed.
- Native `testDebugUnitTest`: 213 tests, no failures, errors, or skips.
- Build command: `gradlew.bat --offline --no-daemon :app:testDebugUnitTest
  :app:assembleDebug :app:assembleDebugAndroidTest -PenableTestAuthBypass=false`.
- Generated `BuildConfig.ENABLE_TEST_AUTH_BYPASS` is false. Capacitor config
  contains no development-server URL.
- Packaged web assets were compared byte-for-byte against `dist`: 69 matched,
  including the isolated scanner entry and all three local WASM binaries.
- Fresh desktop WASM/WebGL runs on the bundled fictional four-person fixture
  returned four 1024-component descriptors, with FaceRes similarity 1.0 between
  corresponding results. This is a compatibility check, not an accuracy claim
  for the user's photos or a phone performance measurement.

## Physical device verification

Target: connected OnePlus 8T / KB2001, Android 14; device serial omitted.
Application: `com.simerfamily.kinsphere`.
Updates use `adb install -r`; no uninstall or app-data clear.

Existing signing certificate SHA-256:
`08cc75142c999fc19e42947bc248a091fea77acfd7af3bacaa5264ad8cf59ae2`.
Original installation time: `2026-08-28 22:07:34`.
Photo and notification permissions were already granted before the update.

The first physical instrumentation run found a row-returning SQLite PRAGMA
incorrectly passed to `execSQL`. This was corrected to use a consumed query
cursor. The synthetic engine test also initially treated a blocked optional
asset request as an inference failure; it now mirrors the production deny-only
behavior and still requires a valid completed result within its deadline.

All 85 pre-existing panorama capture files had identical SHA-256 hashes after
the first in-place update. Hashes/filenames and family-photo data are not copied
into this report.

Final APK SHA-256:
`8f4f810a114de1a6b0335f1fbb6e0808090c0d46f6a70156c5c720161c639a55`.
The installed `/data/app/.../base.apk` hash matches this build exactly; its
signing certificate remains unchanged. In-place update completed at
`2026-09-14 10:43:27`. Original install time and photo/notification permission
grants remain unchanged. Resolved `.MidnightLauncher` launched MainActivity
successfully (`Status: ok`, 497 ms).

The corrected on-device gallery instrumentation suite passed **12/12** tests
in 1.989 seconds. The detached, packaged model completed the generated gray
1600×1200 image in **1,651 ms**, including cold initialization. This proves the
packaged engine works without an Activity, but is not a per-family-photo timing
or a foreground-service endurance test. Store tests use a separate synthetic
test database; no real photos or production queue are used by instrumentation.

A debug-only, `android.permission.DUMP`-protected aggregate status receiver lets
ADB read status/counts/heartbeat without opening photos, returning identifiers
or vectors, changing the queue, or using instrumentation that would stop the
app. It is absent from release builds. After launch its queue is idle; the user
has been asked to open Journal and switch to another app once checking starts.
Real-library progress outside Bubble and notification Pause remain unverified.

## Operating limits

Background checking needs visible notifications. Pause is user-controlled.
Force-stop, reboot, permission revocation, operating-system termination, or the
bounded service-session limit can interrupt execution; saved progress remains
and the user can resume from Bubble. There is no automatic boot restart.
Android places time limits on foreground-service work; the service stops safely
before its own 345-minute session ceiling. Charging is recommended for a large
first scan. A shorter physical test cannot establish all-night reliability,
thermal behavior, or every manufacturer's battery-management policy.

References: [Android foreground-service timeouts](https://developer.android.com/develop/background-work/services/fgs/timeout),
[Android partial photo access](https://developer.android.com/about/versions/14/changes/partial-photo-video-access).

## Follow-up: completed scans but too few scrapbook matches

The user's completed library was inspected through a read-only debug WebView
query. Matching runs inside the phone; only anonymous aggregate counts leave
the WebView. No photos, embeddings, names, photo keys, or account keys are
exported. The diagnostic lives in `scripts/gallery-match-diagnostics.mjs` and
is not a production build entry.

Baseline for the gallery-containing account: 4,716 saved scan rows, of which
4,708 are phone-gallery rows; 65 manual labels and 135 dismissals. There are
1,817 detected faces across 901 photos, 12 automatic face assignments and two
Family photos. These are matching-engine counts, not a ground-truth assessment
of who actually appears in those images. A completed scan is not evidence that
every recognizable person was found.

Confirmed defects in learning from existing user decisions:

- Automatic matching required agreement with the original enrollment even
  after the user explicitly confirmed another face/age/appearance.
- Only the latest eight supplemental face confirmations were consulted. One
  profile had 47 explicit confirmations; earlier examples were not available
  as matching references even though their manual labels remained saved.

The Family selector itself already uses any two distinct family members.
Synthetic mounted-view tests verify gallery imports update open scrapbooks and
Family without remounting, and appending 4,699 gallery scans retains previously
uploaded/capsule photos, manual tags, enrollments, and dismissals.

No blanket threshold reduction or full-library rescan is planned for this
correction. A known missed Family photo has been requested from the user to
test the remaining detection/matching problem against an explicit example.
The correction was installed in place at `2026-09-14 11:58:45` and MainActivity
launched successfully. Its APK SHA-256 is
`d0c191dc4cf421630074b72867a7308a9241a2b0573ce0d730d7092e9cc4eb9a`.
All 69 packaged web assets match `dist`; the certificate and original install
time are unchanged. Auth bypass remains disabled.

Post-install read-only recomputation on the phone preserved all 4,716 scan rows,
65 manual assignments, and 135 dismissals. Automatic assignments increased
**12 → 27**, distributed **7 / 3 / 17** across the three enrolled profiles.
The profile with 47 face confirmations now contributes all 47 appearances
instead of only eight. The Family count **remains two**: this specific undercount
is not resolved. The phone disconnected after that aggregate query; a final
capture-file rehash/installed-package rehash could not run on this follow-up.
The failed rehash attempt is a disconnected-device result, not evidence of
deleted files. Earlier in-place-update verification found all 85 captures intact.

Validation for the recognition correction: broader 29-file / 414-test suite
passed, followed by 85 focused matching/learning/propagation tests after the
final provenance-dedup fix. Typecheck, lint, Vite, Capacitor sync, and Android
assemble passed. The detector and scan revision are unchanged; no full rescan
or photo copying was initiated.

The aggregate query also measured 13,518 ms for a cold automatic+review matching
calculation on the large phone state. A bounded immutable-descriptor cache
optimization is being prepared separately; it must not be represented as
installed or physically benchmarked until a subsequent delivery is recorded.

### Final matching-speed delivery

The descriptor-validation and pair-score cache improvement was installed in
place at `2026-09-14 13:29:57`, after the phone reconnected. The installed base
APK and local build both have SHA-256
`408cf19a9b6e6b5dffa53d808e8a72cb63b8b4bfa05fabb403929ea9fce25cb7`.
All 69 web assets match `dist`; signing identity is unchanged, auth bypass is
disabled, and the packaged configuration has no development server URL.
MainActivity launched successfully. Original installation time remains
`2026-08-28 22:07:34`. All 85 original capture files were rehashed after the
update and match the saved pre-update hashes exactly.

On the same phone state, cold matching took 4,808 ms in the pre-install
read-only benchmark and 5,669 ms in the post-install verification, compared
with the previous 13,518 ms. These timings measure the matching calculation,
not whole-app startup or photo detection throughput. Both runs retained the
same 27 automatic assignments, 151 review candidates and two Family photos.
The post-install check also retained all 4,716 scan rows, 65 manual labels and
135 dismissals. No full rescan, photo duplication, data clear or uninstall was
performed.

Final focused validation passed: five test files / 89 tests, plus typecheck,
lint, diff-check, Vite build, Capacitor sync and Android assemble. The internal
cache preserves scores and rounding; public descriptor validation remains
unchanged. Family under-recognition still needs a known missed photo with
user-supplied identities to establish and test the remaining failure.

## Flight map alignment and active flight widgets

The airport positions were already geographic, but the decorative land shapes
were not drawn in the same coordinate system. Replaced only that land geometry
with simplified, public-domain Natural Earth coastlines and a shared projection.
No ticket styles, provider requests, route wrapping, or live/estimated semantics
changed. Source attribution is in `flightLandCoordinates.ts`.

Existing widgets now include up to four tracked, nonterminal flights alongside
tasks/photos/recaps. Departures within 24 hours and ongoing journeys are eligible;
arrival/cancellation removes them. Native flight pages show airport codes,
traveler/flight number, destination-local ETA, last-update information and a
clearly estimated elapsed-time progress indicator where space permits. Taps
open the Flights tab once, without replaying the navigation when changing tabs.
Cached flight cards expire at the earlier of arrival plus two hours and the
provider snapshot's 24-hour freshness boundary. Native validity is additionally
bounded to 36 hours; only explicit full-privacy flight cards may survive midnight.
No provider key, raw live coordinates, or ticket number is sent to widgets.

The publisher receives account/family-scoped cache changes and authenticated
family-row updates even when another member tab is open. It does not poll paid
flight providers in the background. Native widgets can advance the labelled
estimate from saved timetable values, but fresh status/ETA requires an updated
app/family snapshot. OS widget refresh scheduling is best effort. Hidden previews
omit travel metadata; old-account reads and stale deletion responses are ignored.

Validation:

- 21 focused web test files / 277 tests passed, including flight presentation,
  projection, storage, widget selection, privacy, publication and navigation.
  The publisher integration suite separately passed all 12 tests.
- All 226 Android JVM tests passed. Five synthetic on-device instrumentation
  tests passed: real JSON contract/privacy plus RemoteViews layout at five sizes.
  The 320 x 300 layout screenshot was inspected; no real photos or flight rows
  were inserted or changed for testing.
- Visual browser QA inspected the real ticket at 390px in Plum/Forest/Midnight
  and 320px in Midnight, with no horizontal overflow and aligned JFK/DXB markers.
- Typecheck, lint, production Vite build, Android assembly, and Capacitor sync
  for both platforms passed. Windows-generated SwiftPM path separators were
  restored to forward slashes. Swift/Xcode is unavailable here: the expanded
  57-scenario Swift fixture and iOS native build remain unexecuted.

Installed in place on the connected OnePlus 8T at `2026-09-14 20:57:00`.
Installed and built APK SHA-256:
`37580ee5ae039a77e11b3499061e5275fc3e66831ce42b2724b29b122616fd51`.
All 69 packaged web assets match `dist`, the signing certificate is unchanged,
auth bypass remains false, and no development-server URL is configured.
ForestLauncher resolved to MainActivity and launched successfully. Original
installation time is still `2026-08-28 22:07:34`; all 85 capture files have
identical before/after hashes. No uninstall, data clear, backend deployment,
commit or push was performed for these changes.

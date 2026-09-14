# Phone-only panorama assembly

The standard `#/capture` route uses `composeGuidedPanorama` on both Android and
iOS at 2048×1024. The iOS native controller in this repository captures calibrated
photos; it does not contain a separate native stitcher. This comparison is against
repository source, not a verified binary extracted from an installed iPhone.

## What changed

- Standard capture no longer requires a computer, AI service, model health check,
  or installed stitching weights. Keep Capture open while assembly runs. Leaving
  or stopping aborts the shared operation without removing native originals.
- Android converts the detached camera YUV buffer to a bitmap, rotates/resizes,
  then encodes **one** final JPEG. It no longer encodes and decodes an intermediate
  JPEG. Explicit SDR color spaces are respected; unsupported HDR is rejected.
- Missing optional camera color metadata falls back to the existing unknown-SDR
  path. ARCore 1.54 inherits Android's `Image.getDataSpace()` without initializing
  the framework's image-valid flag; on Android 13+ that getter can throw "Image
  is already closed" for a valid ARCore frame. Previously this reset the hold on
  every image attempt. Only this optional getter is guarded; unreadable planes,
  actual closed images and explicitly unsupported color formats still fail.
- Intrinsics scale from the full camera image, subtract the crop origin, then
  rotate/resize with the output. A non-full-frame camera crop no longer silently
  changes the principal point.
- Android samples fresh, synchronized image/pose/calibration candidates during
  the steady hold and retains the sharpest recent one, following iOS's approach.
  Zero sharpness is valid: a textureless wall must not become a sharpness deadlock.
- Source session IDs are retained on saved Moments so reopening Capture does not
  automatically rebuild an already-saved native source set. Existing native jobs
  and finished results still resume through their original pipeline.

The rendering math is intentionally shared: calibrated projection, overlap-based
exposure adjustment, an optical-center winner and narrow color-compatible seam
blending. Android and iOS already export compatible coordinate conventions;
flipping an axis or changing yaw signs was not warranted by the source audit.

## Plain walls and ceilings on Android

The camera used to stop updating the guide whenever either ARCore tracking or its
anchor paused. A saved OnePlus attempt showed 18 accepted photos, followed by
insufficient-feature and paused-anchor states. That froze the projected dots.

The Android guide now uses a calibrated game rotation vector for short visual
tracking interruptions. The calibration includes the device-to-camera axes, and
sensor history is matched to `Frame.getAndroidCameraTimestamp()` only when the
camera declares the REALTIME clock. `Frame.getTimestamp()` is not assumed to be
on the sensor clock. Real images and intrinsics still come from ARCore; a dot is
only completed after its JPEG and recovery manifest are durable.

The image/pose pairing comes from the current `Frame.acquireCameraImage()` call,
not raw timestamp equality. A previous 1 ms equality check appeared to pass while
tracking was PAUSED, but rejected 158 of 166 acquired images once TRACKING began
on the OnePlus 8T. The image/AR-frame difference reached 4.781 ms; the image/Android
exposure offset remained 31.347 ms. ARCore refines its pose clock during tracking.

Capture now learns the image/Android exposure offset from three coherent pairs
instead of comparing the image clock with the refined AR clock. No absolute
device offset is hardcoded. Startup clock settling, duplicates, stale REALTIME
exposures, and discontinuities still fail closed; calibration restarts when
needed. A previously trusted, still-fresh best-frame candidate remains eligible
even if the newest image is unavailable or still warming up. Frame metadata and
bounded local diagnostics retain all three timestamps and rejection reasons.
The hold ring stays below complete until the separate durable-save acknowledgement.

Gyro capture requires fresh orientation, recent quiet linear-acceleration data,
the existing angular hold checks, and calibration no older than 30 seconds.
Recovery guidance lasts up to 90 seconds, but cannot capture expired estimates.
Low light, excessive motion and sensor discontinuities are not silently accepted.
Successful visual recovery must stabilize and agree with the estimated direction;
a replacement anchor is mapped into the existing sphere, not a new target grid.

Gyro-assisted frames explicitly record `inertialEstimated` and
`translationAvailable: false`. The lens must still stay approximately in one spot:
an orientation sensor cannot measure translation or remove parallax. The native
advanced assembler excludes these frozen positions from its translation metric,
while keeping its image-alignment quality checks.

Reference: [ARCore frame clocks and sensor pose](https://developers.google.com/ar/reference/java/com/google/ar/core/Frame)
and [Android sensor timestamps](https://developer.android.com/reference/android/hardware/SensorEvent#timestamp).

The first 2026-09-11 camera check ran only while visual tracking was PAUSED. Its
passing result did not validate the TRACKING-time clock refinement above.

Reverification after the clock correction: 162 native JVM tests and 10 targeted
device tests passed. The strict live test required TRACKING and used production's
120 ms image-attempt interval. It accepted all 51 acquired TRACKING images and
matched 386 exposure-time motion samples across both states. Two initial PAUSED
images warmed up the clock; no TRACKING images were rejected. The live test also
copied a real image, closed its ARCore buffer, scored the detached pixels, encoded
and decoded the upright JPEG, and deleted its temporary cache file.

The installed production APK matched the rebuilt artifact's SHA-256
`1ec5baed2d285ced9f71c4acbebc05156daf9e0caf97ab043374e1b6b0afa847`.
All 82 pre-existing capture files retained their original hashes. These checks
cover the real camera-to-JPEG path and modeled hold-to-candidate handoff, not a
complete physical 34-dot scan or the assembled panorama's visual quality.

## Existing captures and honest limits

An actual retained 44-frame Android capture was rendered with the shared iOS
compositor in the local browser at 2K. Assembly completed in 25.43 seconds on the
development computer, but the output still had severe geometric patchwork. That
capture records older raw ARCore poses rather than the newer shared capture-anchor
coordinates. This is evidence that seam blending alone does not repair its
alignment, not evidence of fresh-capture quality or a phone speed benchmark.

The standard compositor does not estimate new camera alignment. Tracking drift,
moving around the room instead of rotating near the lens, moving subjects, and
missing coverage can still produce seams. Old raw-pose and failed advanced sets
require explicit selection to rebuild, with a warning. Their originals remain
available. A fresh physical-device scan is required to assess the camera changes.

## Other creation options

- `#/capture?workflow=advanced`: Android's stricter native feature-matching
  assembler, or the existing computer-enhanced path on other platforms. Failure
  does not silently fall back to standard blending or weaken quality gates.
- `#/capture?workflow=ai`: the optional free model on the user's computer. It
  invents unseen content; its retained drafts/results are separate from scans.
- A finished panorama can still be imported without capturing new frames.

The developer-only `scripts/compositor-check.html` page runs the real shared
compositor against a selected local capture folder. Its file picker uses local
browser files; it does not upload them, modify originals, or create a Moment.

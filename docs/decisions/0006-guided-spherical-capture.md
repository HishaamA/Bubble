# 0006 — Add guided native spherical capture

Status: accepted
Date: 2026-08-27
Owners: KinSphere product and client engineering

## Context

ADR 0002 limited the first prototype to importing a finished panorama or
wrapping one horizontal phone sweep. Product direction now explicitly requires
KinSphere to guide the user through photographing the whole surrounding sphere,
including the ceiling and floor, and to make the result available as a Moment.

A WebView file input cannot synchronize full-resolution camera frames with
device pose or provide a dependable installed-app capture experience. The
feature therefore changes the native boundary while preserving the existing
Capacitor app, private media path, and Moments contribution flow.

## Decision

- Keep React responsible for the daily-window rules, caption/share flow,
  progress after native capture, and browser fallback.
- Add an app-local Capacitor plugin named `PanoramaCapture`. It presents a
  full-screen native guide and returns temporary local frame URLs with explicit
  target and measured orientation metadata.
- On iOS, use ARKit tracking and `ARFrame.capturedImage`. On Android, use
  ARCore's display-oriented camera pose, CPU camera image, and image intrinsics
  from the same `Frame`. This keeps the two native capture contracts equivalent
  and avoids mixing CameraX shutter timing with an independent motion sensor.
- Place overlapping targets in several horizontal rings plus zenith and nadir.
  Capture automatically only when a target is aligned, tracking is usable, and
  the phone remains steady for the configured hold interval.
- Assemble a metadata-free 2:1 derivative on-device. The first bounded
  compositor uses captured pose, perspective-to-sphere projection, exposure
  normalization, overlap feathering, and coverage rejection. Native OpenCV
  feature refinement, seam finding, and multiband blending remain the
  production-quality replacement behind the same bridge contract.
- Pass only progress, metadata, temporary URLs, and the final derivative across
  boundaries. Do not stream live camera frames through the Capacitor bridge.
- Store source frames only in a session-specific application cache directory.
  Remove partial frames on cancellation/failure and discard successful source
  frames after the derivative has been encoded.
- In an ordinary browser, offer an interactive guide preview and finished-360
  import. Never label the preview or a single file picker as native 360 capture.

## Consequences

- Guided capture requires an installed iOS or Android build. The LAN-hosted web
  app can demonstrate the interaction but cannot invoke the native plugin.
- Both native implementations track rotation and translation. Users should
  still rotate around one point because translating the camera changes which
  surfaces are visible and can create parallax in any single-view panorama.
- Pose-only composition is materially better than stretching an uncaptured
  horizontal band, but difficult interiors can still show seams. OpenCV-based
  feature alignment and repeated physical-device tuning are required before a
  production photography claim.
- The change supersedes only ADR 0002's statement that multi-frame capture and
  stitching are out of scope. Daily-window, authorization, derivative privacy,
  and upload decisions remain unchanged.

## Verification

- Unit tests cover spherical projection, 360-degree seam wrapping, guide-target
  projection, bridge-to-draft integration, cleanup, and the existing
  capture-to-Moments path.
- Web visual QA verifies the manual capture entry and interactive guide preview
  without console errors.
- Release readiness additionally requires physical iPhone and Android runs that
  complete every target, produce a draggable 2:1 panorama, clean temporary
  frames, share it to a second family member, and reopen it in Cardboard mode.

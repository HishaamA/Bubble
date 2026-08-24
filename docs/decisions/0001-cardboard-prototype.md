# 0001 — Add a Cardboard panorama mode

Status: accepted
Date: 2026-08-26
Owners: product and engineering

## Context

The implementation handoff originally deferred VR. Product has now explicitly
requested a phone-in-Google-Cardboard experience that follows device motion while
keeping the existing touch and flat-view panorama paths.

## Decision

Bubble will include a bounded Cardboard prototype for the existing two-scene
memory flow. It duplicates the monoscopic 360 panorama into two side-by-side eye
views, attempts fullscreen and landscape presentation, and uses the phone's
orientation sensors after a user gesture. It does not claim WebXR stereoscopy,
positional tracking, depth reconstruction, or compatibility with standalone VR
headsets.

The normal panorama remains the primary route. Motion is optional, permission
denial is recoverable, the flat accessible view remains available outside
Cardboard mode, and all viewer dependencies stay bundled locally.

## Consequences

- Cardboard mode renders two panorama canvases and therefore has a higher GPU and
  battery cost than the normal viewer.
- iOS and Android permission, orientation, thermal, focus, and teardown behavior
  require physical-device testing.
- A future production-grade stereoscopic or WebXR viewer requires a separate
  product and architecture decision.

## Verification

- Unit tests cover synchronized scenes, motion startup, exit, and cleanup.
- Physical iPhone and Android checks cover accepted and denied motion permission,
  landscape rotation, fullscreen fallback, Cardboard readability, and returning
  to the standard viewer without duplicate sensor listeners.

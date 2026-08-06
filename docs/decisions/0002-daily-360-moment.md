# 0002 — Separate daily 360 Moments from Capsules

## Status

Accepted for the MVP prototype. The capture limitation is superseded by
[ADR 0006](./0006-guided-spherical-capture.md); the daily-window and secure
sharing decisions remain active.

## Context

Capsules are recipient- and server-time-locked collections intended to open in
the future. They are not a camera or contribution entry point. The product also
needs a lightweight shared ritual: once per day, the family receives one short,
unexpected window in which each member may share one 360 panorama. A manual
upload shortcut must remain available outside that window.

An ordinary single phone-camera frame does not create a complete stitched
spherical image. Many phones can, however, stitch a wide horizontal sweep in
their native Pano or Panorama mode. That capture can become a useful MVP 360°
scene if the entire sweep is retained and normalized to the viewer's 2:1 input
contract, while the product stays clear that uncaptured sky and ground were not
invented.

## Decision

- Put 360 capture/import on Memories as a right-edge action, not under Capsules.
- Offer separate phone-camera and photo-library affordances. Guide phone users
  to landscape orientation and the native Pano or Panorama mode before making a
  slow horizontal sweep.
- Accept either an approximately 2:1 equirectangular image or a sufficiently
  wide native phone panorama. Reject ordinary single frames rather than
  presenting them as 360° captures.
- Normalize a wide phone panorama to an exact 2:1 derivative. Preserve the full
  horizontal sweep and extend only its own top and bottom edge pixels into the
  uncaptured spherical poles. AI completion, multi-frame web stitching, and
  claims of a fully captured sphere remain out of scope.
- Keep the daily mode and manual mode distinct. PostgreSQL creates the daily
  15-minute circle window and enforces it with server time. Manual contributions
  do not consume the daily allowance.
- Re-encode viewer and thumbnail JPEG derivatives before remote upload so the
  selected original and its metadata remain on-device.
- Use private immutable Storage paths, an authorization-checking finalization
  RPC, RLS-protected ready rows, and Realtime/refetch delivery to approved circle
  members.
- Keep an IndexedDB fallback so the interaction can be tested without a backend;
  local-only success copy must not claim another phone received the image.

## Consequences

- True cross-device delivery depends on authentication, approved circle
  membership, Supabase configuration, and the migration being applied.
- Abandoned immutable Storage objects need a later quota and cleanup worker.
- PostgreSQL verifies reported dimensions and object existence but cannot decode
  JPEG pixels; a trusted media worker remains a production hardening step.

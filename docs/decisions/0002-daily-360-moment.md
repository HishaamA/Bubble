# 0002 — Separate daily 360 Moments from Capsules

## Status

Accepted for the MVP prototype.

## Context

Capsules are recipient- and server-time-locked collections intended to open in
the future. They are not a camera or contribution entry point. The product also
needs a lightweight shared ritual: once per day, the family receives one short,
unexpected window in which each member may share one 360 panorama. A manual
upload shortcut must remain available outside that window.

An ordinary phone camera does not create a complete stitched equirectangular
360 image. Pretending otherwise would produce content the panorama viewer cannot
render correctly.

## Decision

- Put 360 capture/import on Memories as a right-edge action, not under Capsules.
- Accept existing image files and request the environment camera/library picker,
  then validate an approximately 2:1 equirectangular shape.
- Explain that true content comes from a 360 camera or an already exported
  panorama; custom capture/stitching remains out of scope.
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

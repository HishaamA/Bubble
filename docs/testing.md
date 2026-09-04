# Bubble testing and release gates

## Testing principle

Bubble handles private family data, time-gated content, resumable media, native sensors, and privileged background work. A UI-only happy path is insufficient. Tests must prove the permission boundary, recovery behavior, device behavior, and negative cases described below.

## Baseline pull-request gate

Every change must pass:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Changes to database behavior must additionally rebuild a clean local Supabase instance and run the database/RLS suite. Native changes must build the affected platform. A failing required check blocks merge; do not waive it with manual database edits or an admin shortcut.

After Docker Desktop and Deno are installed, the complete disposable backend
gate is one command:

```bash
pnpm test:supabase:local
```

It rebuilds every migration, runs the database/RLS/auth pgTAP suite, exercises
the Edge Function runtime boundary, and discards the stack it created. See
[`supabase/README.md`](../supabase/README.md#disposable-local-integration-tests)
for prerequisites and safe reuse/debugging options.

## Automated test layers

### Unit tests

Cover deterministic client logic, including:

- environment validation and error normalization
- IANA time-zone and quiet-hour calculations
- upload state transitions, retry classification, and reconciliation decisions
- media dimension, pixel-count, byte-size, and ratio validation
- deterministic daily 360 window states and exact 2:1 derivative crop sizing
- weekly Capsule window calculations, special-event opening validation, and
  deterministic 0.2-second-per-photo recap plans
- ordinary Capsule image acceptance, metadata-free derivative sizing, and
  rejection of non-image or oversized input
- cache bounds and protection of pending-upload files
- hotspot coordinate bounds and scene mapping
- reduced-motion and flat-viewer selection logic

### Component and integration tests

Cover behavior at module boundaries:

- route guards, session restore, error boundary, and offline/error UI
- viewer adapter mount/change/start/stop/resize/destroy lifecycle
- no duplicated listeners or orientation subscriptions after remount
- thumbnail-first feed behavior and authorized full-media loading
- contribution, reaction, weekly/special Capsule, Journal event, and Family
  Thread review flows
- Capsule tab and legacy route behavior, ordinary-photo contribution,
  server-locked recap controls, and downloadable recap generation
- manual and scheduled 360 selection, preview, caption, local persistence, and
  capture-to-Memories routing
- accessible names, focus order, keyboard behavior, and external hotspot list

### Database, RLS, and Storage tests

Use distinct users and circles. Test both allowed and denied `select`, `insert`, `update`, and `delete` operations. At minimum prove:

- unrelated circles cannot access one another's rows or Storage objects
- pending, rejected, expired, revoked, and removed membership states grant no content access
- removal revokes access immediately
- reveal rules cannot be bypassed through a direct API request
- server time controls invite expiry, round close, event reminders, and weekly
  or special Capsule opening
- approved members may read their own Capsule contributions before opening;
  other members cannot read the rows or Storage objects until opening, and an
  unrelated circle never gains access
- one weekly Capsule exists per circle/week, special Capsules require a future
  opening time, and finalization rejects late, malformed, noncanonical, or
  cross-user contribution paths
- ownership transfer and last-owner constraints preserve a valid circle
- uniqueness rules prevent duplicate membership, round contribution, reaction,
  weekly Capsule, and idempotency records
- scheduled 360 finalization uses server time, canonical uploader paths, and a
  one-contribution-per-member/window constraint; manual uploads remain separate
- a two-session invite rescan versus owner-approval race completes without a
  deadlock and produces one valid final membership/request state

### Edge Function and job tests

Verify:

- invite codes are hashed, expire, and can be revoked
- scheduled dispatchers are safe to run more than once
- upload reservation/finalization reconciles retries without duplicate media or contributions
- deletion removes authorization first and cleanup jobs can retry safely
- in-app notification records are written before generic push attempts
- push payloads contain no captions, family text, media URLs, audio, or invite secrets
- notification taps re-check the current user's authorization
- Family Thread re-reads sources server-side, sends approved text only, returns source IDs, avoids private normal-log content, and supports manual fallback

## Media privacy gate

For representative images at minimum, verify that:

1. The selected original path never appears in an upload request.
2. Output dimensions are within limits and retain approximate 2:1 geometry.
3. Viewer and thumbnail outputs are fresh encodes.
4. EXIF and GPS metadata are absent from both outputs.
5. Interrupted TUS uploads resume from the correct offset.
6. A non-member cannot fetch the object even with a known path.
7. Revocation clears or makes inaccessible any affected local cached copy.

### Capsule photo and recap gate

For representative regular photos, additionally verify that:

1. Capsule upload accepts portrait, landscape, square, and supported HEIC/JPEG
   inputs without requiring 2:1 geometry, while rejecting video and invalid
   image files.
2. Uploaded image and thumbnail objects are fresh metadata-free derivatives;
   the selected original and its path never leave the device.
3. Before server unlock, another approved member cannot query the item row,
   sign its Storage path, or infer more than the safe Capsule metadata and total
   count.
4. After unlock, both phones receive the same ordered photo set.
5. The recap plan uses six frames per photo at 30 fps, so duration is exactly
   `photo count × 0.2 seconds`.
6. The installed app can render and save/share the recap, while an unsupported
   browser reports an explicit fallback instead of claiming success.

## Upload recovery scenarios

Exercise every queue state and transition. Required interruption points include before upload, during upload, after object transfer but before finalization, and after finalization but before the local ready state is saved. Repeat after:

- process restart
- sign-out and sign-in
- foreground/background transition
- network loss and return
- manual retry

Each scenario must converge without a duplicate Storage object, media row, contribution, notification, or job side effect.

## Panorama and native device matrix

Run the current supported Android and iOS targets on physical devices. Verify:

Use the detailed [physical-device acceptance checklist](physical-device-testing.md)
for the required device record, case-by-case pass criteria, and sanitized
evidence. The summary below remains the minimum scope, not a substitute for
that signed-off checklist.

- touch drag and zoom
- orientation permission accepted and denied
- start/stop behavior when entering, leaving, backgrounding, and reopening the viewer
- flat 2D fallback
- bundled Pannellum operation with network access disabled
- voice recording and playback in both device directions
- stable chair hotspot pitch/yaw
- doorway target scene and target yaw
- Cardboard split view, synchronized eyes, fullscreen fallback, landscape rotation,
  thermal stability, and clean exit on both supported phones
- 360 photo-library/camera handoff, ordinary-photo rejection, derivative
  encoding, and the new memory opening in both normal and Cardboard viewers
- guided capture camera permission accepted and denied; complete the standard
  rings, zenith, and nadir; verify auto-capture requires alignment and a steady
  hold, output is exact 2:1, cancellation removes partial frames, successful
  composition removes source frames, and rotating around one point avoids
  obvious parallax tears
- event reminders while the installed app is backgrounded and normally
  terminated, plus permission-denied, Android inexact-alarm, reboot, and cancel
  cases; verify Journal owns the controls and browser copy never promises
  closed-tab delivery
- weekly and special Capsule ordinary-photo contribution on both phones;
  confirm server-time unlock, cross-member reveal, 0.2-second-per-photo recap
  playback, and native save/share behavior
- Low-Data Mode behavior and bounded preloading

## Accessibility and resilience gate

Test the complete core flow with:

- VoiceOver and TalkBack
- large text / dynamic type
- reduced motion
- motion permission denied
- keyboard or switch-style focus navigation where supported
- weak, intermittent, and absent connectivity
- expired session, permission denial, and membership revocation while content is open

Every panorama action must have an accessible non-motion route. Loading, empty, offline, retryable failure, permanent failure, permission-denied, and access-revoked states must be announced and visually distinct.

## Phase evidence

When closing a roadmap phase, record:

- commit or build identifier
- automated commands and results
- Supabase migration/reset result when applicable
- device models, OS versions, and app build
- accounts/circles used as anonymized test roles
- failed-path scenarios exercised
- screenshots or logs that contain no private family content
- remaining known issues and their scope decision

## Final two-phone acceptance run

Repeat the full flow enough times to reveal lifecycle and retry defects:

1. Register, sign in, reset a password, create a circle, and approve a second user.
2. Confirm invalid membership states and an unrelated account remain denied.
3. Complete a Day Relay across two time zones and quiet-hour settings.
4. Upload a sanitized panorama from Phone A and open it privately on Phone B.
5. Use touch, optional motion, zoom, flat fallback, the chair voice message, and doorway scene.
6. Interrupt an upload, restart, resume, and confirm there are no duplicates.
7. Add ordinary photos from both phones to a weekly Capsule and a named special
   Capsule, wait for server unlock, render the 0.2-second-per-photo recap, and
   save/share it. Create a family event and reminder from Journal.
8. Create a text-only, source-linked Family Thread draft and explicitly approve or discard it.
9. Verify generic push behavior, authorization re-check, membership removal, deletion, and cache cleanup.
10. Complete the accessibility and weak-connectivity passes without a crash or manual backend repair.

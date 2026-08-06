# KinSphere delivery roadmap

## How to use this roadmap

Complete the phases in order. A phase is done only after its gate passes with recorded evidence. A green web demo does not satisfy a physical-device, RLS, offline, or native gate.

## Phase 0 — Repository foundation

Build the repository contract: README, environment template, architecture invariants, decision records, formatting, linting, type checking, tests, CI, and a reproducible lockfile.

**Gate:** A clean checkout installs, lints, type-checks, tests, and builds with documented commands.

## Phase 1 — App shell and native projects

- Scaffold React, TypeScript, and Vite.
- Add Capacitor Android and iOS projects.
- Add routing, environment validation, the Supabase client, and an error boundary.
- Bundle a pinned Pannellum build under app assets.

**Gate:** The app installs on a physical Android phone and iPhone, connects to a development Supabase project, and loads Pannellum without a runtime CDN.

## Phase 2 — Local panorama proof

- Build one `PanoramaViewer` adapter with mount, scene change, orientation start/stop, resize, and destroy operations.
- Bundle two 2:1 panorama fixtures.
- Add touch, zoom, optional motion, flat fallback, one chair voice hotspot, and one doorway link.
- Add the explicitly approved bounded Cardboard split-view prototype described in
  ADR 0001, without claiming WebXR stereoscopy or positional tracking.

**Gate:** Both phones complete the chair-and-doorway flow offline. Closing and reopening the viewer leaves no duplicate listeners or orientation sensors.

## Phase 3 — Supabase foundation

- Add versioned migrations, seed data, indexes, foreign keys, uniqueness constraints, and server-owned state fields.
- Enable RLS on every private table and create one private family-media bucket.
- Add positive and negative RLS/database tests, especially cross-circle denial.

**Gate:** A fresh local Supabase instance rebuilds entirely from the repository, and unrelated users cannot read or mutate another circle's rows or objects.

## Phase 4 — Accounts and Family Circles

- Add registration, sign-in/out, password reset, session restoration, and profile settings.
- Add circle creation and active-circle selection.
- Add hashed expiring invites, pending joins, approval/rejection, removal, and ownership transfer.

**Gate:** Two real accounts join one circle only after approval. Expired, revoked, pending, rejected, removed, and unrelated users fail direct access tests.

## Phase 5 — Secure media pipeline

- Add the app-local guided spherical-capture bridge, native target/steady-state
  camera sessions, pose-tagged temporary frames, and on-device spherical
  composition.
- Validate JPEG format, dimensions, pixel count, byte size, and approximate 2:1 ratio.
- Re-encode on-device to a viewer image up to 4096 x 2048 and a thumbnail; remove metadata.
- Reserve immutable media paths, upload with TUS, verify, and mark ready.
- Download authorized media into app-private storage before viewing.

**Gate:** Both physical platforms complete all guide targets and clean their
temporary frames; Phone A uploads only metadata-free derivatives, Phone B opens
them privately, an interrupted transfer resumes, and a non-member cannot fetch
them.

## Phase 6 — Persistent queue and cache

- Persist upload jobs and processed local file paths.
- Begin with one active upload and the full documented state machine.
- Resume on app launch, sign-in, foreground, network return, or manual retry after server reconciliation.
- Add a size-bounded thumbnail/recent-panorama cache that protects pending-upload files.

**Gate:** A contribution prepared offline survives an app restart and reaches ready state without duplicate media or contribution records.

## Phase 7 — Day Relay and family feed

- Freeze approved participants when a round starts.
- Calculate prompt times from IANA time zones and quiet hours.
- Add manual start and an idempotent scheduled dispatcher; a missed participant cannot block the relay.
- Enforce reveal-after-contribution-or-close in RLS/SQL.
- Add the composer, captions, voice notes, thumbnail-first feed, reactions, and Realtime/refresh behavior.
- Add one server-authoritative daily 360 Moment window per circle, plus the
  explicitly separate manual panorama upload action. Accepted family moments
  appear in Memories through the same private media and Realtime path.

**Gate:** Two members in different time zones complete a round and exchange one
360 Moment. Direct API tests cannot bypass reveal/window rules, and the feed
loads thumbnails before full panoramas.

## Phase 8 — Voice, Echo Pins, and linked scene

- Reuse one recording/upload/player path and duration limit across product surfaces.
- Require a text alternative for accessible audio use.
- Persist hotspot pitch/yaw and support preview, edit, move, delete, and an accessible external list.
- Persist the doorway target panorama and target yaw; preload only that next scene when data settings permit.

**Gate:** Audio works Android-to-iPhone and iPhone-to-Android, the chair pin remains attached to the intended object, and the doorway opens the correct second view.

## Phase 9 — One Capsule and one Event Room

- Capsule: title, recipients, server opening time, selected panorama/voice/text items, locked state, and deletion.
- Event: title, description, event time zone, countdown, one reminder, prompt, shared collection, and voice/text guestbook.
- Reuse existing contribution, media, notification, audio, and permission layers.

**Gate:** Device-clock changes cannot open a capsule, non-recipients remain denied, event times display locally, and multiple authorized members contribute to an Event Room.

## Phase 10 — Family Thread AI

- Allow only approved captions and explicitly approved text alternatives as sources.
- Re-read authorized sources server-side and send text only.
- Return a short draft with source IDs and require edit, approve, discard, or manual replacement.
- Keep provider credentials and private source text out of the client and normal logs.

**Gate:** Each draft sentence is reviewable against selected source text, nothing publishes automatically, and the user can finish manually during provider failure.

## Phase 11 — Notifications, privacy, accessibility, and release

- Write in-app notifications before sending generic FCM/APNs nudges.
- Add contribution, circle, capsule, and account deletion with authorization-first revocation and retryable cleanup.
- Complete loading, empty, offline, denied, revoked, and retry states.
- Verify large text, TalkBack, VoiceOver, reduced motion, motion denial, flat mode, and weak connectivity.
- Run all automated and repeated two-phone end-to-end checks.

**Gate:** The final acceptance suite passes without manual database repair, hidden admin shortcuts, private push content, crashes, or stale authorization.

## Deferred until the core is stable

- Selfie bubble
- Tradition prompt library
- Voice transcription and translation after explicit review
- Elder Mode
- Event Room-to-capsule conversion

## Explicitly out of scope

Live 360 video, standalone-headset/WebXR VR, positional tracking, 3D
reconstruction, tours beyond two scenes, Same Moment
prompts, public social features, rankings, streaks, direct messaging,
hidden-message games, advanced virtual tours, face identification, emotion
detection, image-understanding AI, Privacy Lens, Capture Coach, and automatic
publishing.

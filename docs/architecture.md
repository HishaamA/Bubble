# KinSphere architecture

## Authority and change control

[`KinSphere_Implementation_Handoff.docx`](../KinSphere_Implementation_Handoff.docx) is the source of truth for the first build. This document translates its locked rules into implementation boundaries. A conflicting change requires an explicit product decision recorded in [`docs/decisions/`](./decisions/README.md); ordinary refactoring cannot weaken an invariant.

## System boundaries

### Client

The Capacitor app owns interaction, local media processing, the persistent upload queue, recent-media caching, and the isolated panorama adapter. It authenticates as the current user with the public Supabase URL and publishable key. It never receives a secret key, service-role key, or provider credential.

### Supabase

Supabase is the backend of record for identity, circle membership, content, reveal state, notifications, schedules, and deletion work. Postgres constraints and RLS enforce authorization even when requests bypass the UI. Private Storage objects are addressed through immutable paths and are accessible only after current authorization is checked.

### External transports and providers

FCM and APNs carry generic nudges only. Delivery is best-effort, and the in-app notification row is authoritative. The Family Thread provider receives only text re-read and approved by a server function; it receives no images or raw audio.

## Dependency direction

```text
app shell -> features -> services/lib
                  \-> viewer facade -> bundled Pannellum

authenticated client -> Supabase RLS / Storage policies
scheduled or privileged work -> Edge Functions -> Postgres / providers
```

- Feature code may compose viewer events, but `src/viewer/` cannot import auth, circle, round, capsule, event, or Supabase business logic.
- Client services may use the authenticated Supabase client. Privileged workflows belong in SQL functions or Edge Functions.
- UI visibility is never evidence of authorization. The database and Storage policies decide access.

## Non-negotiable invariants

### Security and membership

- **SEC-01 — Private by default:** Enable RLS on every private table and deny access unless an explicit policy grants it.
- **SEC-02 — Circle isolation:** A user from one circle cannot read or mutate another circle's rows or media.
- **SEC-03 — Membership state:** Pending, rejected, expired, revoked, and removed users remain outside content policies.
- **SEC-04 — Immediate revocation:** Membership removal blocks new server access immediately. Cleanup may be asynchronous, but authorization is not.
- **SEC-05 — Client credentials:** Only the Supabase publishable key may be client-visible. Secret/service-role, AI, cron, FCM, and APNs credentials are server-only.

### Media and panorama viewer

- **MEDIA-01 — Original stays local:** Never upload, cache remotely, or log the user's selected original panorama.
- **MEDIA-02 — Fresh derivatives:** Validate JPEG type, byte size, dimensions, pixel count, and approximate 2:1 geometry; then re-encode a viewer image no larger than 4096 x 2048 plus a thumbnail. Upload only these fresh outputs.
- **MEDIA-03 — Metadata removal:** Sanitized outputs must contain no EXIF/GPS metadata before they enter the upload queue.
- **MEDIA-04 — Private retrieval:** Download protected media with the authenticated client into app-private storage before giving a local source to Pannellum.
- **VIEWER-01 — Adapter isolation:** The viewer accepts local scene data and emits events. It owns rendering, touch, zoom, orientation start/stop, resize, scene changes, and teardown only.
- **VIEWER-02 — Offline dependency:** Bundle and pin Pannellum in the app. Do not load viewer code from a CDN.
- **VIEWER-03 — Bounded tour:** The core flow supports one voice Echo Pin and one doorway to exactly one second panorama, with a flat fallback.

### Time, jobs, and reliability

- **TIME-01 — Server clock:** Invite expiry, round closing, prompt dispatch, event reminders, and capsule opening use database/server time, never the device clock as authority.
- **OPS-01 — Idempotent effects:** Scheduled jobs, upload finalization, notifications, deletion work, and provider calls use unique idempotency keys or equivalent database guarantees.
- **UPLOAD-01 — Persistent queue:** Persist upload state and processed local paths. Supported states are queued, uploading, finalizing, ready, retryable failure, permanent failure, and cancelled.
- **UPLOAD-02 — Reconcile first:** On launch, sign-in, foreground, network return, or manual retry, compare local and server state before transmitting again.
- **UPLOAD-03 — No false background promise:** KinSphere promises resume when reopened; it does not promise uninterrupted transfer after the operating system kills it.
- **CACHE-01 — Bounded private cache:** Cache thumbnails and recently opened panoramas under a size limit. Never evict files required by pending uploads, and clear inaccessible content after authorization changes.

### Product truth and AI

- **NOTIFY-01 — In-app source of truth:** Write the in-app notification first. Push contains no family text, media URL, caption, audio, invite secret, or other private content; opening it re-checks authorization.
- **AI-01 — Approved text only:** Re-read selected approved captions or explicitly approved text alternatives server-side. Never send an image or raw audio to the AI provider.
- **AI-02 — Traceable draft:** Store source IDs with the draft so every sentence can be reviewed against selected source text.
- **AI-03 — Human publication:** A draft can be edited, approved, discarded, or replaced manually. It is never published automatically, and AI failure never blocks the manual path.

### Accessibility and degraded operation

- **A11Y-01 — Equivalent controls:** Core actions remain available with device motion denied, via the flat viewer and an accessible hotspot list outside the panorama.
- **A11Y-02 — Platform support:** Support large text, VoiceOver, TalkBack, reduced motion, clear focus/labels, and non-color-only state communication.
- **OFFLINE-01 — Explicit states:** Loading, empty, offline, retry, permission-denied, and access-revoked states must be distinguishable and recoverable where possible.

## Minimum backend domains

- **Identity:** `profiles`, `device_tokens`
- **Family:** `circles`, `circle_members`, `circle_invites`, `join_requests`
- **Rounds:** `rounds`, `round_participants`, `contributions`, `reactions`
- **Media:** `media`, `voice_notes`, `hotspots`, `upload_jobs`
- **Capsules:** `capsules`, `capsule_recipients`, `capsule_items`
- **Events:** `events`, `event_guestbook_entries`
- **AI and operations:** `family_threads`, `family_thread_sources`, `notifications`, `scheduled_jobs`, `deletion_jobs`

Required database guarantees include one membership per user/circle, one contribution per user/round, one reaction per user/contribution, one recipient row per user/capsule, bounded hotspot coordinates, and unique job idempotency keys.

## Primary data flows

### Panorama contribution

1. The client validates the selected JPEG and approximate 2:1 geometry.
2. The client creates metadata-free viewer and thumbnail derivatives.
3. The client persists a queue job and immutable destination paths before transfer.
4. TUS uploads one job at a time to private Storage.
5. Finalization verifies the objects and atomically marks media ready.
6. An authorized viewer downloads a protected object into app-private storage.
7. The isolated viewer receives only the local scene URL and hotspot configuration.

### Membership change

1. A server-side operation changes membership state.
2. RLS and Storage authorization stop permitting access immediately.
3. Retryable deletion/cleanup jobs remove server objects and local cache entries as appropriate.

### Family Thread

1. A user selects approved captions or manually approved text alternatives.
2. A server function re-reads those sources under the user's current authorization.
3. Only the text is sent to the configured provider.
4. A draft and source IDs return for review.
5. The user edits and approves, discards, or completes the work manually.

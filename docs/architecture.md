# Bubble architecture

## Authority and change control

The legacy-named [`KinSphere_Implementation_Handoff.docx`](../KinSphere_Implementation_Handoff.docx) is the source of truth for the first build. This document translates its locked rules into implementation boundaries. A conflicting change requires an explicit product decision recorded in [`docs/decisions/`](./decisions/README.md); ordinary refactoring cannot weaken an invariant.

## System boundaries

### Client

The Capacitor app owns interaction, local media processing, Capsule recap
rendering, the persistent upload queue, recent-media caching, and the isolated
panorama adapter. It authenticates as the current user with the public Supabase
URL and publishable key. It never receives a secret key, service-role key, or
provider credential.

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

The [codebase guide](./codebase-guide.md) maps these boundaries to current
modules. Feature controllers own asynchronous workflows; controlled components
own presentation; pure selectors/reconciliation own derived data. Runtime import
guards run with the normal test suite for viewer/service isolation and selected
pure modules. Fully erased `import type`/`export type` contracts do not create
runtime dependencies; inline type specifiers can retain a module load under
the current compiler settings.

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
- **CAPSULE-01 — Separate still-image path:** Capsule accepts ordinary still
  photos, not panoramas. Re-encode image and thumbnail derivatives without
  metadata, do not apply the 2:1 panorama rule, and keep selected originals on
  the device.
- **CAPSULE-02 — Server-authoritative reveal:** Create one weekly Capsule per
  circle and allow named special-event Capsules. Before `opens_at`, an uploader
  may read their own items but other members may read only safe Capsule metadata
  and the total count. Postgres RLS and Storage policies enforce the reveal.
- **CAPSULE-03 — Deterministic recap:** An opened Capsule recap shows each
  ordered photo for 0.2 seconds. The client may render a downloadable video
  natively or through a feature-detected browser fallback; it does not upload a
  recap as a 360 Moment.

### Time, jobs, and reliability

- **TIME-01 — Server clock:** Invite expiry, round closing, prompt dispatch, event reminders, and capsule opening use database/server time, never the device clock as authority.
- **OPS-01 — Idempotent effects:** Scheduled jobs, upload finalization, notifications, deletion work, and provider calls use unique idempotency keys or equivalent database guarantees.
- **UPLOAD-01 — Persistent queue:** Persist upload state and processed local paths. Supported states are queued, uploading, finalizing, ready, retryable failure, permanent failure, and cancelled.
- **UPLOAD-02 — Reconcile first:** On launch, sign-in, foreground, network return, or manual retry, compare local and server state before transmitting again.
- **UPLOAD-03 — No false background promise:** Bubble promises resume when reopened; it does not promise uninterrupted transfer after the operating system kills it.
- **CACHE-01 — Bounded private cache:** Cache thumbnails and recently opened panoramas under a size limit. Never evict files required by pending uploads, and clear inaccessible content after authorization changes.

### Product truth and AI

- **NOTIFY-01 — In-app source of truth:** Write the in-app notification first. Push contains no family text, media URL, caption, audio, invite secret, or other private content; opening it re-checks authorization.
- **EVENT-01 — Journal owns plans:** Family event creation, RSVP, upcoming
  plans, and reminder controls live in Journal. There is no separate Events tab;
  legacy event routes redirect to Journal.
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
- **Capsules:** `family_capsules`, `family_capsule_items`
- **Events:** `events`, `event_guestbook_entries`, `event_reminders`
- **AI and operations:** `family_threads`, `family_thread_sources`, `notifications`, `scheduled_jobs`, `deletion_jobs`

Required database guarantees include one membership per user/circle, one
contribution per user/round, one reaction per user/contribution, one weekly
Capsule per circle/week, canonical Capsule item paths, server-time Capsule
reveal, bounded hotspot coordinates, and unique job idempotency keys.

## Primary data flows

### Panorama contribution

1. The client either receives pose-tagged frames from the installed native
   guided-capture plugin or validates an imported JPEG and approximate 2:1
   geometry.
2. The client creates metadata-free viewer and thumbnail derivatives. Guided
   frames are projected onto a complete 2:1 sphere and removed after encoding.
3. The client persists a queue job and immutable destination paths before transfer.
4. TUS uploads one job at a time to private Storage.
5. Finalization verifies the objects and atomically marks media ready.
6. An authorized viewer downloads a protected object into app-private storage.
7. The isolated viewer receives only the local scene URL and hotspot configuration.

### Membership change

1. A server-side operation changes membership state.
2. RLS and Storage authorization stop permitting access immediately.
3. Retryable deletion/cleanup jobs remove server objects and local cache entries as appropriate.

### Capsule contribution and recap

1. The client accepts an ordinary still image and freshly encodes metadata-free
   image and thumbnail derivatives without a panorama aspect-ratio requirement.
2. The authenticated client uploads immutable, uploader-scoped private Storage
   objects and finalizes one `family_capsule_items` row before `opens_at`.
3. Before opening, RLS exposes an item only to its uploader; approved members
   may see the Capsule metadata and total count.
4. After the database clock reaches `opens_at`, approved circle members can
   retrieve the ordered photos.
5. The client renders the recap at six frames per photo at 30 fps (0.2 seconds
   per photo) and offers the resulting video through the supported save/share
   path.

### Journal family plans

1. Journal loads approved-circle events and renders the featured and upcoming
   plan widgets before its memory calendar.
2. A member creates an event or opts into a reminder from Journal.
3. The installed app schedules the device reminder while the server-backed
   reminder remains the durable cross-device preference.

### Home Screen widget

1. The authenticated app selects an automatic daily card from already-authorized
   events, Capsules and Journal photos: due soon, newly opened recap, another
   item today, contribution prompt, Journal memory, then the private empty state.
   It also builds a bounded browsing deck: up to four unfinished tasks or plans today,
   two Capsules unlocked today, six real photos from the synced Journal library
   and opened Capsule archive, and a contribution/empty card when applicable and
   space remains. The stable shuffled photo order advances hourly so older
   uploads can resurface. Still-locked Capsule media never enters this deck.
2. A member must explicitly enable **Widget previews** before task names or
   family photos can leave the app surface. The server-confirmed preference is
   mirrored only into that account-and-family's local partition.
3. The version-1 snapshot retains its original card and automatic schedule, with
   an additive optional `pages` array of at most 12 cards. Each page has a stable
   `id` (at most 120 characters), a `group` (`tasks`, `photos`, `recap`, or
   `capture`), and the existing card fields. Pages inherit the parent snapshot's
   local-day expiry and must match its theme and privacy. Images stay outside
   the JSON: the bridge accepts the legacy `thumbnailBase64` plus an optional
   `pageThumbnails` map from page ID to resized image data, with at most eight
   media pages. Android stores snapshots and images in app-private files; iOS
   uses the App Group
   `group.com.simerfamily.kinsphere.widget` shared with WidgetKit.
4. The publisher debounces changes, caches resized thumbnails within the current
   account/family scope, and skips unchanged native publications. Signed-storage
   token rotation does not invalidate an otherwise unchanged image, while its
   origin, path, and image transformations remain part of the cache identity.
   Privacy changes and account/family changes clear that cache.
5. Native widgets validate every field, page, and local route; render the selected
   Plum, Forest, or Midnight card; and fail to generic copy without media after
   preview opt-out, sign-out, invalid data, or local-day rollover. Media filenames
   are native-generated, never page IDs or caller-supplied paths. Removing private
   content also clears saved page selections.
6. Taps use an allowlisted app deep link. Photo taps select the exact stable ID
   in Journal's normal All timeline; they do not open a second photo page.
   Hydration must not reapply consumed focus after the member starts browsing.
   Recap acknowledgement occurs only
   after the signed-in app re-fetches the requested, unlocked family Capsule
   and actually opens its recap.

#### Browsing and keeping a card visible

- **iOS:** The original `BubbleWidget` kind remains the automatic widget. On
  iOS 17 and later, previous/next App Intent buttons browse eligible cards
  without launching the app. Once chosen, a page remains selected across
  same-day snapshot updates by stable page ID, until it disappears, expires, or
  previews are disabled. Selection is stored per widget kind, not per placed
  instance. Before manual selection, the original automatic schedule still
  applies. Separate **Bubble Tasks**, **Bubble Photos**, and **Bubble Recap**
  widgets filter the same deck; an empty category shows its own generic prompt,
  never another category's private content.
- **iOS swipe setup:** All four widgets use the small Home Screen size. Add the
  desired category widgets, then drag one onto another to make an iOS widget
  stack. In **Edit Stack**, disable **Smart Rotate** and **Widget Suggestions**
  to keep the category the user swipes to. This is the supported swipe mechanism
  on iOS, including iOS 15/16 where the in-widget paging buttons are unavailable.
  WidgetKit controls the outer rounded-square shape and does not expose a custom
  swipe gesture for Bubble to replace the system stack. See Apple's
  [widget and stack instructions](https://support.apple.com/en-ie/118610).
- **Android:** A native `StackView` supports direct vertical swiping through the
  deck inside the 2x2 widget. Bubble never automatically advances or explicitly
  resets its displayed child; stable page IDs, unchanged-publication suppression,
  and quiet same-day timer refreshes help retain the current card. The launcher
  owns the swipe position, so persistence is best-effort across changed decks,
  launcher restarts, resizing, or removing and re-adding the widget. There is no
  cross-device or app-managed Android page-selection setting.

The layouts fill their available widget area with bounded text, full-bleed media,
and subtle doodles. A recap is a poster/play affordance, not an inline autoplaying
video; tapping opens the recap in the app. Photo reactions are also performed in
the authenticated in-app photo destination, not directly on the Home Screen.

Widget extensions never hold Supabase or Clerk credentials and do not perform
background family fetches. Native timelines can expire or redraw a stored
same-day card, but a newly unlocked recap is published after the authenticated
app next opens or resumes.

### Family Thread

1. A user selects approved captions or manually approved text alternatives.
2. A server function re-reads those sources under the user's current authorization.
3. Only the text is sent to the configured provider.
4. A draft and source IDs return for review.
5. The user edits and approves, discards, or completes the work manually.

# KinSphere

KinSphere is a private family app for sharing immersive memories. A family member imports an existing equirectangular panorama, adds a caption or voice note, and shares a sanitized derivative with an approved Family Circle. Other members can explore the panorama, hear a voice Echo Pin, and follow one doorway into a second scene.

> [!IMPORTANT]
> [`KinSphere_Implementation_Handoff.docx`](./KinSphere_Implementation_Handoff.docx) is the source of truth for the first build. Implement its phases in order, and do not add optional features until the two-phone core flow is stable.

## Core proof

The first end-to-end proof is intentionally narrow:

1. Phone A imports a panorama and processes it entirely on-device.
2. Only newly encoded, metadata-free viewer and thumbnail files are uploaded.
3. Phone B opens the private panorama as an approved circle member.
4. Touch, zoom, optional device motion, and a flat fallback all work.
5. A chair hotspot plays a voice message.
6. A doorway hotspot opens exactly one second panorama.
7. A daily surprise 360 Moment is server-time locked, while a separate manual
   upload remains available from Memories.
8. A validated, metadata-free 2:1 derivative can be shared privately with an
   approved Family Circle and appears as a new Memories bubble.
9. The persistent right-edge **Upload 360 now** action is available from every
   primary tab; Capsules is first and Memories is second in the bottom bar.

The current web preview also keeps accepted uploads in IndexedDB so the full
capture-to-viewer interaction works without backend credentials. Cross-device
delivery requires configured Supabase credentials, signed-in approved circle
members, and the included `360_moment_mvp` migration.

Profile includes the MVP Family Sync setup: email sign-in/sign-up, circle
creation, private one-use invite codes, join requests, owner approval, and
sign-out. With no client-safe Supabase credentials it clearly stays in
local-only mode.

## Locked stack

- React, TypeScript, and Vite
- Capacitor for Android and iOS
- A pinned Pannellum build bundled with the app; no runtime CDN
- Supabase Auth, Postgres, Row Level Security, private Storage, Realtime, Edge Functions, and Cron
- TUS resumable uploads
- FCM and APNs as generic push transports; in-app notifications remain authoritative

## Architecture rules

These rules are release constraints, not implementation suggestions:

- All family data and media are private by default. RLS is the permission boundary.
- The Supabase service-role key and provider credentials never enter the client bundle.
- The selected original panorama never leaves the device.
- The panorama viewer receives local scene data and emits viewer events; it owns no product or backend policy.
- Pending uploads survive app restarts and reconcile with server state before retrying.
- Invite expiry, round closure, reminders, and capsule opening use server time.
- Scheduled jobs and external side effects are idempotent.
- Family Thread sends approved text only and always requires source review and human publication approval.
- Removing a member revokes server access immediately; local and Storage cleanup may complete asynchronously.

See [`docs/architecture.md`](./docs/architecture.md) for the complete boundary and invariant list.

## Repository shape

```text
src/
  app/          routing, providers, shell, and error handling
  features/     auth, circles, rounds, feed, capsules, events, and Family Thread
  services/     media processing, uploads, queue, cache, and push
  viewer/       isolated Pannellum adapter and viewer UI
  lib/          Supabase client, dates, validation, and errors
supabase/
  migrations/   schema, indexes, constraints, RLS, and SQL functions
  functions/    server-side workflows and integrations
  tests/        database and RLS tests
docs/           architecture, decisions, roadmap, test gates, and AI-use log
```

## Development prerequisites

### Web and shared development

- Git
- Node.js 22 LTS or newer and pnpm through Corepack
- A development Supabase project
- Supabase CLI and Docker for local database and RLS work

### Native development

- macOS with Xcode 26 or newer; Capacitor's generated iOS project uses Swift Package Manager
- Android Studio, Android SDK, and JDK 17 for Android
- One physical iPhone and one physical Android phone for phase and release gates
- FCM and APNs credentials only when push-notification work begins

Simulators are useful during implementation, but they do not replace the required two-device acceptance runs.

The current Codex host has Node 22, but it does not yet have full Xcode, Android
Studio, or Docker. Web builds can run here now. Native compilation and local
Supabase integration tests require those tools before their corresponding gates
can pass. Android builds must use Android Studio's bundled JDK rather than the
host JDK 26, which is newer than the generated Gradle wrapper supports.

## Local setup

```bash
corepack enable
pnpm install
cp .env.example .env.local
pnpm dev
```

Fill only the client-safe values in `.env.local`. Keep service-role, AI-provider,
push-provider, and cron secrets in the Supabase development environment; never
prefix them with `VITE_`.

The expected client variables are documented in [`.env.example`](./.env.example). Native platform setup and Supabase initialization are added in their corresponding roadmap phases.

The 360 Moment button imports an existing 2:1 equirectangular image. Ordinary
phone cameras do not produce a complete stitched 360 image; use a 360 camera or
an exported panorama. The app re-encodes viewer and thumbnail derivatives before
the secure Supabase upload path.

## Quality checks

Before merging a feature, run the checks exposed by the project:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Database-affecting work must also rebuild a clean local Supabase instance and pass the RLS/database suite. Native, viewer, upload, media, notification, and accessibility work must pass the relevant physical-device gates in [`docs/testing.md`](./docs/testing.md).

## Delivery sequence

Work is gated, not merely grouped. A phase is complete only when its acceptance check passes; otherwise the next phase stays out of scope. Follow [`docs/roadmap.md`](./docs/roadmap.md).

## Security reporting

Do not commit credentials, production identifiers, original family media, downloaded private media, recordings, or database dumps. If a secret is exposed, revoke it before removing it from history.

# KinSphere

KinSphere is a private family app for sharing immersive memories. A family
member can follow a native dot guide to capture the surrounding sphere or
import an existing equirectangular panorama, add a caption, and share a
sanitized derivative with an approved Family Circle. Other members can explore
the panorama, hear a voice Echo Pin, and follow one doorway into a second scene.

> [!IMPORTANT]
> [`KinSphere_Implementation_Handoff.docx`](./KinSphere_Implementation_Handoff.docx) is the source of truth for the first build. Implement its phases in order, and do not add optional features until the two-phone core flow is stable.

## Core proof

The first end-to-end proof is intentionally narrow:

1. Phone A captures pose-tagged overlapping views with the native guide, or
   imports a finished panorama, and processes the result entirely on-device.
2. Only newly encoded, metadata-free viewer and thumbnail files are uploaded.
3. Phone B opens the private panorama as an approved circle member.
4. Touch, zoom, optional device motion, and a flat fallback all work.
5. A chair hotspot plays a voice message.
6. A doorway hotspot opens exactly one second panorama.
7. A daily surprise 360 Moment is server-time locked, while a separate manual
   upload remains available from Memories.
8. A validated, metadata-free 2:1 derivative can be shared privately with an
   approved Family Circle and appears as a new Memories bubble.
9. **Upload 360 now** remains a Moments-only action. The separate Capsule tab
   accepts ordinary photos, opens one family recap each week, and supports
   named occasion Capsules without sending those images through the panorama
   pipeline.

The current web preview also keeps accepted uploads in IndexedDB so the full
capture-to-viewer interaction works without backend credentials. Cross-device
delivery requires configured Supabase credentials, signed-in approved circle
members, and the included `360_moment_mvp` migration.

Capsule contributions use the same account-scoped offline approach when the
backend is unavailable. With the family Capsule migration applied, ordinary
photos sync privately across approved family accounts, stay hidden from other
members until the server-timed unlock, and can be exported as a rapid
0.2-second-per-photo recap. iOS uses a native H.264 renderer and share sheet;
compatible browsers use a feature-detected MediaRecorder fallback.

Profile includes persistent Family Sync backed by Clerk identity and Supabase:
circle creation, private one-use invite codes, join requests, owner approval,
and sign-out. With no client-safe Supabase credentials, development can use an
explicit account-scoped local preview; production does not treat that preview
as cross-device delivery.

## Locked stack

- React, TypeScript, and Vite
- Capacitor for Android and iOS
- A pinned Pannellum build bundled with the app; no runtime CDN
- Clerk sessions with Supabase native third-party auth, Postgres, Row Level Security, private Storage, Realtime, Edge Functions, and Cron
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

The current Codex host has Node 22 and Xcode 26.6. The iOS project is verified
against both the iOS Simulator and generic arm64 iPhone targets. Installing it
on a physical iPhone still requires selecting an Apple Development team in
Xcode. Android Studio and Docker are not installed, so Android compilation and
local Supabase integration tests still require those tools. Android builds must
use Android Studio's bundled JDK rather than the host JDK 26, which is newer
than the generated Gradle wrapper supports.

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

Clerk must be enabled as a native third-party auth provider in Supabase. Follow
[`docs/decisions/0004-clerk-supabase-third-party-auth.md`](./docs/decisions/0004-clerk-supabase-third-party-auth.md); do not use Clerk's deprecated Supabase
JWT template.

The 360 Moment screen launches native guided capture only from an installed
Capacitor build. Its ring, ceiling, and floor targets capture automatically when
the phone is aligned and steady. The LAN/web build provides the same interactive
guide as a preview and can still import an existing 2:1 panorama, but it does not
claim access to the native capture plugin. The app re-encodes viewer and
thumbnail derivatives before the secure Supabase upload path.

After installing native prerequisites, synchronize and open a device project:

```bash
pnpm cap:sync
npx cap open ios
# or
npx cap open android
```

Camera and motion quality must be verified on physical phones; simulators and
the Vite preview cannot satisfy the guided-capture acceptance gate.

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

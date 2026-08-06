# Architecture decision records

Use this directory for decisions that change an implementation boundary, dependency, privacy posture, or acceptance gate. The implementation handoff remains authoritative unless a product owner explicitly approves a change.

## Locked decisions

The following decisions are already fixed for the first build and are described in [`docs/architecture.md`](../architecture.md):

- React + TypeScript + Vite with Capacitor for Android and iOS
- Supabase as the backend and RLS as the authorization boundary
- Pannellum pinned and bundled locally behind an isolated adapter
- on-device panorama validation, resize, re-encoding, thumbnailing, and metadata removal
- TUS uploads with a persistent, reconciling queue
- server time for expiring and scheduled behavior
- idempotent jobs and external side effects
- in-app notifications as truth, with generic FCM/APNs nudges
- approved-text-only Family Thread with source traceability and human publication approval
- exactly two linked panorama scenes in the core build
- monochrome, content-first UI with gradients limited to Memories bubble depth
- guided native multi-frame spherical capture behind an app-local Capacitor
  plugin, with an explicit browser preview/import fallback

## ADR format

Create records as `NNNN-short-title.md` with this structure:

```markdown
# NNNN — Decision title

Status: proposed | accepted | superseded
Date: YYYY-MM-DD
Owners: names or roles

## Context
What decision is needed and which constraints apply?

## Decision
What will the project do?

## Consequences
What becomes easier, harder, required, or intentionally unsupported?

## Verification
Which automated or device gate proves the decision is implemented?
```

An accepted ADR must identify any affected architecture invariant and roadmap/test gate. Never use an ADR to silently reduce privacy or authorization guarantees.

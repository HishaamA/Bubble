# Structural cleanup verification — 12 September 2026

This records the first pass. See [second-pass verification](./refactor-phase-two-verification.md)
for the subsequent plans, flights, Journal display, capture and preference cleanup.

This pass separates existing responsibilities without intentionally changing
the product UI, storage format, native contracts or database authorization.
Earlier uncommitted product fixes were preserved. Changes are local; no commit,
GitHub push or phone installation was performed as part of this refactor.

## Scope

- Journal: pure selection/album rules and controlled people/form components;
  hydration, navigation, scanning and uploads still have one lifecycle owner.
- Capsules: pure reconciliation, synchronization stages, cards, image resource
  lifetime, presentation rules and the cohesive recap playback/export sheet.
- Family settings: explicitly typed workflow controller, with presentation left
  in the panel and account/request/action guards preserved together.
- Widgets: scoped data loading, pure event projection and cancellable native
  publication; the publisher now only connects those owners and refresh timing.
- Maintenance: a codebase guide, runtime dependency tests, explicit integration
  coverage for extracted controls and button semantics in the manual QA harness.

| Entry component | Before this pass | After |
| --- | ---: | ---: |
| `PeopleTimeline.tsx` | 2,145 lines | 1,832 lines |
| `CapsulesPage.tsx` | 1,678 lines | 749 lines |
| `FamilySyncPanel.tsx` | 820 lines | 448 lines |
| `WidgetSnapshotPublisher.tsx` | 313 lines | 56 lines |

Line counts measure responsibility moved out of entry components, not total code
deleted. Explicit contracts, focused modules and tests add lines elsewhere.

## Final checks

- Full Vitest suite: **1,069 tests passed across 125 files**.
- TypeScript project build (`tsc -b`): passed.
- Repository Oxlint gate with warnings denied and unused-disable reporting:
  passed.
- Vite production build: passed, 351 modules transformed.
- Capsule-focused checks: 86 tests across 10 files passed, including locked
  card media, Blob URL lifetime, offline merging and ended-session checkpoints.
- Widget checks: 48 tests across three files passed, including opt-out,
  late-account data, stalled account reads, repeated parent renders and late
  subscription teardown.
- Architecture guard and guard-self tests: 55 passed; transitive runtime edges,
  erased versus inline type imports, barrels, cycles and implicit JSX covered.
- Independent review found no introduced Capsule regressions; 21 extracted
  function bodies matched the original after AST normalization. Widget review
  caught and corrected unstable empty-snapshot identity during account changes.

The first full integration run exposed missing test-coverage mappings for moved
controls and missing button types in an existing manual harness. Both were
corrected. A test-only filesystem scan also timed out while iCloud hydrated
source; the subsequent complete run passed without increasing timeouts.
Expected jsdom canvas-not-implemented diagnostics remained non-failing.

## What these checks do not establish

This is not a production load test or a security audit. Native code and SQL
were not changed in this pass, and no new physical iOS/Android or live database
test was performed. The existing native changes in the working tree belong to
earlier work, not this refactor.

Journal orchestration, plans, flights, capture and native controllers still have
large sections. Their next cohesive seams and required regressions are recorded
in [the codebase guide](./codebase-guide.md#remaining-cleanup-in-a-safe-order).
Backend capacity and very large media-library performance require separate
measurements; structural cleanup alone cannot prove scalability.

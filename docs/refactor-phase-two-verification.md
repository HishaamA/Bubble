# Structural cleanup, second pass — 12 September 2026

This continues the [first cleanup pass](./refactor-verification.md). It is a
behavior-preserving extraction, not a product redesign or a database migration.
Existing working-tree changes were retained. A verified local archive of the
affected source folders and maintenance files was created before editing.
No commit, GitHub push or phone installation is included in this pass.

## Responsibility changes

| Entry component | Before this pass | After | Extracted responsibility |
| --- | ---: | ---: | --- |
| `JournalEventsSection.tsx` | 1,618 lines | 1,224 lines | Controlled plan card/week picker, shared types and plan selection/formatting |
| `FlightTrackerSection.tsx` | 1,467 lines | 896 lines | Controlled ticket/lookup form, artwork and presentation calculations |
| `PeopleTimeline.tsx` | 1,832 lines | 1,621 lines | Controlled photo frame/scrubber, date/tag controls and scan-status display |
| `Capture360Page.tsx` | 1,101 lines | 906 lines | Controlled capture entry/draft editor, shared icon and submission types |
| `ProfilePreferences.tsx` | 226 lines | 109 lines | Per-switch optimistic state, serialized latest-intent save queue and privacy guards |

Line counts describe smaller entry components, not code deletion. Explicit
props, named modules and focused tests add code elsewhere. All new files must
be included with the modified entry components when committing this work.

The codebase guide now maps each responsibility to its owner. Import-boundary
checks also cover `planViewModel` and `flightPresentation`, and extracted
interactive controls retain direct tests or an explicit integration-test mapping.

## Preserved contracts

- Plans: shared-over-local ID precedence, mount-day cutoff, completion
  tombstones, explicitly empty task/progress overrides, reminder/save guards,
  add-sheet focus and modal ownership.
- Flights: account scope, request versions, abort handling, lookup/refresh/delete
  locks, alert persistence, form IDs/refs and portal lifecycle. Airport-local
  formatting, date-line wrapping and live-versus-estimated map semantics remain
  unchanged.
- Journal: the All default and one-shot exact widget-photo selection remain in
  the same parent. Manual scrubbing still consumes the focus request; later
  hydration cannot replay it. Concrete photo-frame refs, local face-analysis
  ownership, checkpoints, date edits and manual tags are retained.
- Capture: native-session tokens, picker inputs, temporary-file/object-URL
  cleanup, cancellation, review state, draft save queue and sharing guards remain
  together. Public submission types are re-exported from the original module for
  caller compatibility.
- Preferences: account/family keyed rows, latest intent during same-tick taps,
  serialized writes, rollback and fail-closed widget privacy are retained.
  Finishing writes remain bound to the original account after unmount.

## Review and regression coverage

Independent read-only reviews compared the extractions directly with the
pre-edit archive. No introduced behavior regression was found:

- Plans: 22 critical mutation/storage functions matched the checkpoint; the
  extracted selectors and callback wiring were reviewed separately.
- Journal: state, refs, selectors, lifecycle effects and handlers before render
  setup matched the checkpoint; concrete DOM targets and control callbacks were
  checked separately.
- Capture: all 60 non-render controller statements matched, apart from moving
  explanatory presentation copy; icon/copy helpers retained their bodies.
- Preferences: the extracted state/effect/queue block was byte-identical.
- Flights: coordinator effects, handlers and guards matched; equivalent error
  types and a named existing cancellation-latch callback were checked separately.

This pass adds 59 tests: 20 plan selection/control cases, 16 flight presentation
cases, 10 Journal presentation cases, 11 capture presentation cases and two
preference race cases. Existing component/service/lifecycle assertions remain.

## Validation

- TypeScript project build: passed.
- Repository Oxlint gate with warnings denied and unused-disable reporting:
  passed.
- Vite production build: passed, 365 modules transformed.
- Git tracked-change whitespace check: passed.
- Full-suite rerun: **1,128 tests passed across 132 files**, including all four
  architecture boundary cases (58.76 seconds).

The initial full run passed 1,124 tests; four architecture cases could not run
because their source-inventory setup exceeded its existing timeout in the
cloud-backed folder. Those checks subsequently passed in a focused run. The
timeout was not raised and no behavior assertions were weakened. Three new test
queries used an unsupported type option; it was removed, retaining the default
exact accessible-name matching. Expected jsdom canvas diagnostics are non-failing.

## Limits and next work

This is not proof of zero bugs, production-scale performance or backend capacity.
No native implementation, SQL, storage format, credential, family record or photo
data was changed by this pass. No new physical iOS/Android, live camera or live
database test was performed; native changes already in the working tree belong
to earlier work.

Large asynchronous controllers remain deliberately intact where their locks,
cancellation and cleanup form one workflow. The next safe seams and necessary
regression coverage are recorded in the
[codebase guide](./codebase-guide.md#remaining-cleanup-in-a-safe-order). Split
those workflows only with lifecycle characterization and relevant device tests;
do not replace them with an opaque context object merely to shorten files.

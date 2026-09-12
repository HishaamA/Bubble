# Working in Bubble's codebase

Start here when making a change. [Architecture](./architecture.md) defines the
privacy and ownership rules; this guide explains where the current code lives.
It describes an incremental refactor, not a claim that every screen has already
been decomposed or that backend capacity has been load-tested.

See the [first-pass verification](./refactor-verification.md) and
[second-pass verification](./refactor-phase-two-verification.md) for scope,
measured component changes, final checks and explicit limitations.

## Find the right owner

| Change | Start here | Keep out of this layer |
| --- | --- | --- |
| Navigation, auth gates, tab lifetime | `src/app/`, `src/app/routes/` | Media processing and feature-specific fetches |
| Journal photo selection and people albums | `src/features/journal/people/peopleTimelineSelectors.ts` | React effects, storage reads, network calls |
| Journal people rail and enrollment forms | `PeopleTimelinePeople.tsx`, `PeopleTimelinePersonForm.tsx` in that folder | Owning scans, hydration, uploads or route state |
| Journal photo frame, scrubber, date/tags and scan controls | `PeopleTimelineViewer.tsx`, `PeopleTimelinePhotoDetails.tsx`, `PeopleTimelineScanStatus.tsx` | Reapplying widget focus or starting background analysis independently |
| Journal scan/upload/navigation coordination | `src/features/journal/people/PeopleTimeline.tsx` | Duplicating the lifecycle in child components |
| Plan cards, checklist controls and week picker | `src/features/events/PlanCard.tsx`, `PlanWeekPicker.tsx` | Independent save/reminder locks or duplicate checklist state |
| Plan merging, task selection and calendar labels | `src/features/events/planViewModel.ts` | Network access, persistence or UI state |
| Plan creation, completion and reminders | `src/features/events/JournalEventsSection.tsx` | Moving guards away from their mutations |
| Flight ticket, lookup form and map artwork | `src/features/flights/FlightTicket.tsx`, `FlightLookupSheet.tsx`, `FlightArtwork.tsx` | Owning network requests, modal lifecycle or alert persistence |
| Flight formatting and route geometry | `src/features/flights/flightPresentation.ts` | Fetching provider data or mutating snapshots |
| Flight lookup, refresh, deletion and alerts | `src/features/flights/FlightTrackerSection.tsx` | Competing request versions, action locks or account scopes |
| Capture entry and draft editor | `src/features/capture/CaptureStartPanel.tsx`, `CaptureDraftEditor.tsx` | Starting capture on mount, owning Blob URLs or saving drafts |
| Capture session, files and durable drafts | `src/features/capture/Capture360Page.tsx`, `captureTypes.ts` | Splitting session guards from native completion and cleanup |
| Capsule local/server merging | `src/features/capsules/capsuleReconciliation.ts` | Fetches, persistence and presentation |
| Capsule refresh and queued upload sequence | `src/features/capsules/capsuleSynchronization.ts` | Rendering, focus and export UI |
| Capsule card layout and eligibility display | `src/features/capsules/CapsuleCard.tsx`, `capsuleViewModel.ts` | Reimplementing server reveal or merge rules |
| Capsule playback, export and focus | `src/features/capsules/recap/CapsuleRecapSheet.tsx` | Splitting its timers and cleanup among competing owners |
| Capsule image loading and object URLs | `src/features/capsules/CapsulePhotoImage.tsx` | Creating URLs for locked content or leaking them on unmount |
| Family settings layout | `src/features/profile/family-sync/FamilySyncPanel.tsx` | Request tokens or direct server writes |
| Family create/join/invite workflows | `useFamilySyncController.ts` in that folder | Styling and independent copies of membership state |
| Family response validation and persistence | `familySyncAdapter.ts`, `src/services/persistence/` | Trusting UI visibility as authorization |
| Preference switch display and save queue | `src/features/profile/ProfilePreferences.tsx`, `usePreferenceChoice.ts` | Parallel writes for the same switch or leaking a prior account's choice |
| Widget data refresh/subscriptions | `src/features/widgets/useWidgetFamilyData.ts` | Thumbnail decoding and native writes |
| Widget task merging and card choice | `widgetEventProjection.ts`, `widgetSnapshot.ts`, `journalWidgetPhotos.ts` | Fetching or mutating records while selecting a card |
| Widget thumbnail lifetime/native publication | `useNativeWidgetPublication.ts`, `nativeBubbleWidget.ts` | Owning the Journal or planner UI |
| Widget tap destination | `WidgetDeepLinkHandler.tsx`, `widgetDeepLink.ts`, Journal routes | A second photo viewer or unconditional route replay |
| Native widget rendering/interaction | `ios/App/BubbleWidgetExtension/`, Android `widget/` package | Clerk credentials or direct family-service fetching |
| Panorama rendering | `src/viewer/` | Family, auth or backend knowledge |
| App appearance | `src/theme/`, feature-owned CSS | Theme-specific copies of feature logic |
| Authorization and shared data rules | `supabase/migrations/`, `supabase/functions/` | Relaxing RLS to work around a client bug |

Paths in a row without a full prefix are siblings of the preceding full path.
Feature-owned service modules remain beside their feature; `src/services/`
contains cross-feature boundaries. Do not move everything into a global
`utils/` folder just to shorten component files.

## The four kinds of module

1. **Presentation** receives explicit, typed values and callbacks. It renders
   controls and accessibility labels. A component may own its tightly coupled
   UI lifecycle, such as an image object URL or recap focus/teardown.
2. **Controllers/hooks** own one workflow's state, effects and cancellation.
   Keep request versions, action latches and cleanup with the work they protect.
3. **Pure domain functions** receive data and return data. Pass the clock,
   local overrides and authorized records as inputs. They neither fetch nor
   persist and can be tested without mounting a screen.
4. **Adapters/services/stores** own I/O, untrusted input validation and platform
   differences. Prefer the existing injectable adapter or store contract over
   adding a new generic data-access framework.

A useful extraction gives a responsibility one owner and a testable contract.
It need not reduce the total number of lines: explicit props and tests add code.
Avoid a large opaque context object, a new global event bus, or several hooks
that each synchronize copies of the same state.

## Follow the state, not just the file names

### Journal

`JournalPage` supplies authorized library/archive data and the requested widget
photo. `PeopleTimeline` owns hydration, local face analysis, uploads, date
corrections and selection. Pure selectors derive the people index, album
covers/counts, review previews and ordered timeline. Controlled children render
the people rail, add/manage-person forms, photo frame/scrubber, date/tag controls
and scan status. The parent still owns every scan, hydration, save and selection
effect. Pass frame and image refs through to the original DOM elements: widget
scroll positioning and focus restoration depend on those targets.

All is the initial photo filter. A widget focus request selects the exact
stable photo ID in the normal timeline once; manual browsing must win over
later hydration. Do not add a child effect that re-applies that request on
every incoming photo refresh. Face descriptors stay device-local.

### Plans and flights

`JournalEventsSection` owns local/shared plans, completion tombstones, reminder
registration and the add-plan sheet. `PlanCard` and `PlanWeekPicker` render
controlled values and send commands back to that owner. `planViewModel` retains
shared-over-local ID precedence, the original mount-day cutoff and explicitly
empty task/progress overrides. Do not replace those empty overrides with demo
defaults or give each card its own persistence queue.

`FlightTrackerSection` owns account-scoped lookup, refresh, deletion, alerts and
the modal portal/lifecycle. `FlightLookupSheet` receives the same input/form refs
and IDs; `FlightTicket` receives the same guarded callbacks. `flightPresentation`
derives airport-local labels and date-line-wrapped routes. Live versus estimated
position remains a provider-quality decision, not a new inference in the view.

### Capture

`CaptureStartPanel` renders daily/manual entry choices. `CaptureDraftEditor`
renders the controlled caption and preview. Neither component starts a session,
saves data or creates/revokes object URLs. `Capture360Page` retains native-session
tokens, picker callbacks, temporary-file cleanup, review state, durable saves and
sharing guards. The caption and guided-capture refs still reach their original
elements for focus restoration.

`captureTypes` owns the submission contract. The page re-exports its existing
public types so callers need not change imports as part of this refactor.

### Capsules

The page invokes the session cache; the cache controls warm snapshots,
single-flight refresh and whether a session is still current. Synchronization
loads durable local drafts, reconciles family rows, retries eligible pending
uploads and persists the result. Reconciliation preserves local Blob bytes
while the server owns shared IDs, metadata, visible counts and signed URLs.

A local weekly draft can acquire a server UUID. Merge by week until that
happens, and update photo ownership references together. Never replace a local
queue with a remote response wholesale or treat device-clock unlock as backend
permission. `CapsuleCard` renders reveal/contribution states using the shared
presentation rules in `capsuleViewModel`. `CapsulePhotoImage` owns image loading
and object-URL cleanup. `CapsuleRecapSheet` retains one owner for its playback
timers, focus trap, export lock, native staging, cancellation and cleanup.

### Family settings

The panel renders the controller's snapshot, status, membership fields and
invitation actions. The controller privately owns three different guards:

- **Scope epoch:** rejects work from a previous account/family.
- **Request version:** rejects a superseded read within that scope.
- **Action latch:** prevents duplicate submissions before React has rerendered.

These guards are not interchangeable. Keep the injected adapter and copy/share
functions testable. Do not optimistically replace an invite code before the
server confirms rotation, or retain protected state after access is rejected.

`ProfilePreferences` owns the scoped initial read and switch layout. Each row's
`usePreferenceChoice` owns its optimistic value, latest-intent ref, serialized
save queue and rollback. Keep rows keyed by preference field, account and family.
A finishing save may complete after unmount for its original account; it must
never update the new account's UI or widget privacy. Same-tick repeated taps must
be coalesced through the ref, not a stale rendered value.

### Widgets

`WidgetSnapshotPublisher` connects the following owners:

```text
useWidgetFamilyData → projectWidgetEvents → selectBubbleWidgetTimeline
                                                ↓
                                  useNativeWidgetPublication
                                                ↓
                                       nativeBubbleWidget
```

Data loading coalesces Journal reads separately from plans. Local preference
and checklist changes project immediately without waiting for network work.
Selection is read-only; the native publication hook owns debounce, thumbnail
cache, abort signals and write versions. The bridge also serializes native
operations. Account changes clear prior media; unchanged payloads must not
reset the user's chosen widget page. Even the empty account-switch snapshot
must have stable identity across unrelated renders.

Widget photos use the authorized Journal library plus opened, synced Capsule
photos. Stable IDs survive signed-URL renewal. The shuffled photo order advances
hourly; tapping a photo focuses the ordinary Journal timeline, not a separate
page. Never materialize photos when previews are disabled.

## Changing a workflow safely

1. Read the nearest component, domain module, service/store and tests.
2. Identify the existing state owner and write a failing characterization test
   for the case that could be lost: stale response, rapid click, pending upload,
   account change, locked media or navigation after hydration.
3. Extract one cohesive responsibility with an explicit contract. Preserve
   markup, data formats, storage keys, subscription order and native contracts
   unless the task explicitly changes them.
4. Run its pure tests and its original component/service integration tests.
   Testing only a newly extracted helper misses wiring and lifecycle mistakes.
5. Run `pnpm check` before merging. Native and database changes additionally
   require the checks in [testing.md](./testing.md).

Architecture tests run with the normal suite. They check runtime import
boundaries, including transitive imports and re-exports, while allowing erased
`import type` and `export type` contracts. Under `verbatimModuleSyntax`, inline
`import { type T }` can still emit a runtime load; use `import type` at these
boundaries. The guards do not prove business correctness, database scalability,
rendering performance or absence of all side effects. Do not bypass them with
an unchecked barrel or dynamic import; move the responsibility instead.

## Remaining cleanup, in a safe order

| Area | Next useful seam | Regression protection needed |
| --- | --- | --- |
| Journal timeline | Scan/upload orchestration, then scoped hydration/navigation | Abort, checkpoint persistence, late data, exact widget focus, manual browsing |
| Capsule page | Contribution processing versus session/navigation coordination | Durable staged photos, cancellation, retries, account changes and recap routing |
| Plans (`JournalEventsSection`) | Cohesive add-sheet workflow, then account-scoped reminder/service coordination; cards/week picker are separated | Rapid submissions, edit/delete, local overrides, offline reminders |
| Flights (`FlightTrackerSection`) | Cohesive lookup/refresh/alert workflow; ticket, sheet and formatting are separated | Stale results, same-flight requests, rate limits, cancellation and timezone handling |
| Capture and panorama composition | Capture lifecycle versus geometry/media processing; entry/editor views are separated | Physical-device capture, bounded memory, temporary files, cancellation and image geometry |
| Native capture/viewer implementations | Platform-specific rendering and lifecycle boundaries | iOS and Android device tests, orientation, teardown and file confinement |

The preference queue/display separation is complete. Keep its rapid-tap,
rollback, late-account-response and fail-closed widget-privacy tests when making
future changes; another abstraction is not needed just to make that file smaller.

Keep these as separately tested changes. The current cleanup improves ownership
and readability; it does not yet eliminate the large timeline, plan, flight or
native capture controllers. Loading very large photo libraries and production
backend capacity require measurements beyond this structural refactor.

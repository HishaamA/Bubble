# Bubble code quality conventions

These conventions apply to first-party web, native, Edge Function, and database
code. Generated Capacitor files and vendored dependencies follow their upstream
projects and should not be reformatted merely to match this guide.

## Names describe roles

- Use `camelCase` for values and functions, `PascalCase` for components and
  types, and uppercase snake case only for true process-wide constants.
- Name a value for the role it plays: `flightSnapshot`, `requestBody`, or
  `presentationWindow` is clearer than `object`, `data`, or `item`.
- Include units when a number could be misread, such as `durationMs`,
  `widthPixels`, or `freshnessSeconds`.
- Keep established domain language consistent across the bridge. A Moment,
  Capsule, Family Circle, panorama, or staged artifact should not acquire a
  second name in a lower layer.

Short mathematical names are acceptable only inside a tightly scoped formula
whose conventional meaning is unambiguous. Public APIs and multi-step routines
must use descriptive names.

## Comments explain contracts and reasons

- Every exported function, class, component, and native bridge method has a
  concise comment describing its contract.
- Add a comment before a non-obvious block when its order, fallback, lock,
  bound, or security check matters. Explain why the block exists rather than
  restating each line.
- Document intentional sequential work. Media decoding, storage reconciliation,
  and provider throttling sometimes stay serial to bound memory or preserve
  ordering.
- Keep comments current when behavior changes. Remove comments that merely
  narrate syntax, obsolete implementation history, or an abandoned plan.

Tests should read as executable behavior specifications. Test names normally
provide their documentation; add a comment only when the setup models a subtle
race, platform limitation, or security boundary.

## Control flow stays bounded

- Return early for invalid input and terminal states instead of nesting the
  main path.
- Every retry, poll, cache, collection, and long-running loop has an explicit
  bound, deadline, or ownership rule.
- Avoid duplicate sources of truth. Derived state should be computed or owned
  by one abstraction rather than synchronized through parallel effects.
- Keep cleanup idempotent. Cancellation, sign-out, interruption, and teardown
  may be requested more than once.
- Do not swallow operational failures unless the work is explicitly best
  effort; explain that choice beside the catch.

## Boundaries validate untrusted data

- Validate Capacitor calls, URLs, file paths, environment values, provider
  responses, and database results before use.
- Resolve local paths and prove they remain inside the expected app-owned root
  before reading or deleting them.
- Keep user-facing errors useful but free of provider internals, credentials,
  private identifiers, and family content.
- Never weaken Row Level Security or native file confinement because the UI
  already hides an action.

## Required checks

Run the repository gate before merging:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Native and database changes also require the platform-specific checks in
[`testing.md`](./testing.md). A passing static suite does not replace physical
camera, Cardboard, accessibility, two-phone privacy, or server-time testing.

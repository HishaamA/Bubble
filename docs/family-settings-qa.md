# Family and settings regression checks

## Isolated visual fixture

With the development server running, open
`/scripts/qa/family-screen.html`. This entry is not imported into the production
app. It uses fabricated members and codes, never authenticates an account, and
does not write to the backend or clipboard. It uses the real family panel,
appearance selector, and signed-out preference layout. Theme choices affect
only the browser's local appearance setting.

The controls cover two or 25 members, owner/member roles, 550 ms responses,
failed code rotation, all three themes, and standard/150%/200% text. On a server
with file watching disabled, restart the server after changing styles; a page
reload alone can reuse Vite's old transform cache.

## Checks performed on 11 September 2026

- Browser layout at 320 px and 402 px, including 200% text: no horizontal
  content overflow after the fixes. Names, badges, code actions, appearance
  choices, and preferences reflow instead of shrinking or clipping.
- 25 fabricated family members render; the current person and owner are marked.
  Broken portraits fall back to initials. Non-owners have no rotation control.
- Successful rotation displays the returned new code. A failed response leaves
  the old code available and shows an actionable error. No live family code
  was rotated during testing.
- The simulated native status-bar background stays fixed while content scrolls.
- The real app preview completed nine successive primary-tab changes. A plan
  with a long title and date/time values kept every input inside its 320 px
  dialog; closing the unsaved form and returning to Moments remained usable.
- Automated regressions cover rapid repeated taps, slow responses, initial-load
  retry, auth changes/unmounts, stale family snapshots, denied access, repeated
  widget entry/Back/Close, Strict Mode cold launch, and preference privacy during
  account changes. Run `pnpm check` for lint, types, tests and the production build.

### Final verification result

- `pnpm check`: lint, TypeScript, all 926 tests in 116 files, and production build
  passed. Earlier attempts hit iCloud file-read timeouts; the final complete run
  passed after requesting local availability of the project files.
- Android `testDebugUnitTest`: all 50 native tests passed, including 14 widget
  tests. No Android phone was connected for hands-on validation.
- iOS native widget paging/privacy harness: all 15 scenarios passed.
- iPhone device build and strict code-signature verification passed. The bundled
  entry and profile code matched the tested production files exactly. Installed
  in place on the connected iPhone; automatic launch was blocked by its lock
  screen, so hands-on confirmation remains with the user.

## Limits

The browser fixture is not a substitute for device accessibility testing or
frame-time measurement on iOS and Android. Local SQL assertions in
`supabase/tests/family_share_code_safety.sql` were added but not executed because
this workstation has no running local PostgreSQL/Docker environment. They must
run against the disposable local test database, never against a live family.
No production database migration was required for these UI/service fixes.

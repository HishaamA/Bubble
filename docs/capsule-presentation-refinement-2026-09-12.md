# Capsule presentation refinement — 12 September 2026

## Behavior

- An ongoing weekly Capsule has no delete or hide control. Members can still
  expand the subtle photo-management link and remove their own contributions.
- Other Capsules use a small top-right cross. It opens an explicit confirmation;
  it does not delete immediately or open a recap. Creator-only deletion and
  reversible personal hiding for other members remain unchanged.
- Journal photo removal and expanded own-photo rows use the same discreet cross,
  with a 44px touch target, accessible action name and confirmation.
- Gathering envelopes use smaller obscured decorative frames, restrained paper
  layers and a plain lock status rather than a large button-like label.
- Weekly and special recaps show photo previews only from unlock through exactly
  96 hours later. Older cards use a closed keepsake envelope with no photo images
  mounted. Tapping the envelope or play control opens the authorized recap.
  Closing it returns to the covered card.
- The four-day preview window is measured from the family unlock instant, not
  from a later video export or rerender. The separate three-day Past Capsules
  grouping remains unchanged. Neither rule changes stored photos or access.

## Scope and verification

No backend migration, family content deletion, account changes or GitHub push
were part of this refinement. Cross-platform application code is shared, but
physical Android acceptance is not established by an iPhone installation.

Regression tests cover the ongoing-week protection, discreet confirmation and
cancel, four-day boundaries, no automatic old-photo mounting, recap navigation,
photo ownership and deletion persistence. Visual checks use isolated fake-data
fixtures, not a real family account. Final test, layout and phone-delivery
results are recorded in `phone-installation-2026-09-12.md`.

The full suite ran 1,360 checks: 1,359 passed, with only a prohibited punctuation
character in the new manual QA fixture failing the authored-copy audit. That
fixture was corrected; both repository audits then passed (3 checks). Application
and tooling TypeScript checks and lint passed. The focused page/Journal sweep
passed 99 checks, card/view-model 24, removal controls 30, and deletion persistence
43. These overlapping focused counts are not additional to the full-suite total.

Final visual QA passed all nine combinations of 320/390/430px widths and Plum,
Forest and Midnight themes. Checks found no horizontal or control/text overflow,
undersized targets, nested buttons, browser errors or outside requests. The run
verified sealed older cards, the exact 96-hour boundary, the protected ongoing
weekly Capsule, and both Capsule and own-photo confirmation/cancel flows.
Evidence: `/private/tmp/bubble-capsule-refinement-qa.2U2lrK/results.json`.

The final production build, iOS sync, signed native build and package verification
passed. Phone delivery was initially blocked by an unavailable device. After the
user reconnected it, the same verified package was installed in place on
Simreen's iPhone at 22:56 Asia/Dubai and launched successfully at 22:57. See the
fourth update in the installation record for delivery evidence and test limits.

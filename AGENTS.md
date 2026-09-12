# Bubble working preferences

## Default phone delivery

The user requested on 12 September 2026 that app changes be installed on their
phone by default after each completed change.

- After verifying a user-requested app change, build fresh production assets,
  sync the native iOS project, and install the signed app in place on the
  connected device identified as **Simreen’s iPhone**. Re-check the available
  device list every time; do not substitute a friend's or another device.
- Preserve the existing app identifier, signing setup, App Group, accounts and
  local data. Never uninstall the app or reset app data to deliver an update.
- Verify the signed package contains the newly built web assets, includes the
  widget extension, and is not pointed at a local development server. Confirm
  successful installation and launch before saying the phone was updated.
- If the phone is unavailable, locked, untrusted, or a build/signing check
  fails, report the specific blocker. Do not claim an install happened.
- If SwiftPM stalls in a Git-status scan, use the process-local Git overrides
  documented in the installation record; do not change global Git settings.
- This default applies to app changes, not documentation-only work. Preserve
  cross-platform behavior; an iPhone installation does not prove Android QA.
- Installation does not authorize a GitHub push or an unrelated backend
  deployment. Follow the user's separate direction for those actions.

Record installation evidence and remaining physical-device test limits in
`docs/phone-installation-2026-09-12.md` or a dated successor.

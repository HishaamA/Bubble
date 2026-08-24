# 0005 — Schedule event reminders with the native operating system

Status: accepted
Date: 2026-08-27
Owners: product and engineering

## Context

Family-event reminders must still appear when Bubble is backgrounded or its
UI process is no longer running. A JavaScript timer in a browser tab cannot make
that guarantee, and a local notification is not a substitute for the server-side
in-app notification record or future generic push system described in the core
architecture.

## Decision

The installed Capacitor app schedules a private, one-time local notification
with `@capacitor/local-notifications` for one hour before an event. The event's
stable database ID and current Clerk subject produce an account-scoped signed
32-bit notification ID. The lock-screen copy is generic and contains no event
title or family text.

Scheduling happens only after the user taps “Remind me.” Bubble requests the
normal notification permission at that point, schedules with
`allowWhileIdle: true`, and requests an exact Android alarm with a non-mandatory
inexact fallback. Persisted reminder selections are reconciled with the native
pending-notification list on launch and when the web view becomes visible again;
that restore path never opens a permission or settings prompt. Turning a reminder
off cancels both pending and already-delivered notifications.

On the web, Bubble may use the browser Notification API and an in-memory
timer while the tab remains open. The UI explicitly says that closing the tab or
browser cancels that behavior. Bubble never claims closed-browser delivery.

## Native configuration

- Android 13+ asks for notification display permission through the plugin.
- Android 12+ declares `SCHEDULE_EXACT_ALARM`. If exact alarms are disabled, the
  plugin reports a warning and Bubble keeps an inexact alarm rather than
  failing the reminder.
- Android uses a monochrome drawable for the status-bar icon. The plugin's merged
  manifest supplies its boot receiver, `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`, and
  notification permission declarations so scheduled alarms can be restored by
  the operating system after a normal reboot.
- iOS asks for local-notification authorization through the system; no Info.plist
  usage-description key is required. Scheduled notifications set an explicit
  default sound, while the Capacitor presentation options cover foreground
  badge, sound, banner, and notification-list presentation.

## Consequences

- A normally backgrounded or terminated installed app does not need its
  JavaScript runtime alive for the operating system to deliver the local alert.
- Delivery still depends on user permissions and platform policy. Android force
  stop, OEM battery restrictions, Focus modes, disabled exact alarms, or manual
  notification disablement may delay or suppress an alert.
- `allowWhileIdle` is subject to Android's per-app Doze limits and must not be
  treated as an unrestricted alarm channel.
- A remote push service is still required for server-triggered reminders,
  cross-device schedule changes while a device never reopens the app, and
  delivery telemetry.

## Verification

- Unit tests cover stable bounded IDs, permission denial, exact-alarm fallback,
  one-hour scheduling, idle allowance, explicit sound, reconciliation, and
  pending/delivered cancellation.
- Web tests verify that permission is requested only after a user action and that
  fallback copy states the open-tab limitation.
- Before release, install a synced native build on physical Android and iPhone
  devices. Schedule a near-future test event, background and normally terminate
  the app, and verify delivery. Repeat with permission denied, exact alarms
  disabled, reboot (Android), Focus/Do Not Disturb, and reminder cancellation.

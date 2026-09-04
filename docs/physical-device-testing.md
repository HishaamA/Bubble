# Physical-device acceptance checklist

This runbook covers behavior that browser tests and simulators cannot prove:
camera and microphone permissions, AR-guided capture, orientation and motion,
the iOS Metal and Android Cardboard renderers, lifecycle interruptions, low
light, and private synchronization between two signed-in phones.

Run it against the exact commit proposed for release. A previous test run is
not evidence for a newer commit, even when the UI looks unchanged.

## Release gate

- Test one ARKit-capable iPhone on iOS 15 or later and one ARCore-capable
  Android phone on Android 7 or later.
- Use a real Cardboard-compatible headset with a readable QR profile.
- Use two distinct Clerk accounts in one test family: `OWNER-A` on Phone A and
  `MEMBER-B` on Phone B. Keep `OUTSIDER-C` outside that family for denial tests.
- Use only synthetic or consented test media. Evidence must not contain real
  family photos, email addresses, invite codes, session tokens, or precise
  locations.
- Record `PASS`, `FAIL`, `BLOCKED`, or `N/A` for every applicable case. `N/A`
  needs a reason. A case may be marked `PASS` only when its required evidence
  is attached.
- Any crash, frozen camera, stuck spinner, silent permission failure, distorted
  panorama, duplicated upload, cross-family disclosure, or failure to restore
  orientation blocks release.

## Run record

Create one copy of this block per device and keep it with the release evidence.

| Field | Required value |
| --- | --- |
| Run ID | Date plus short label, for example `2026-09-06-ios-release` |
| Commit | Full Git commit SHA |
| Build | App version, build number/version code, and Debug/Release/TestFlight/APK source |
| Tester | Name or team handle |
| Device | Manufacturer, model, and hardware identifier when available |
| OS | Exact iOS/Android version and security patch on Android |
| Native support | ARKit or ARCore support; Google Play Services for AR version on Android |
| Headset | Cardboard make/model and QR profile used |
| Accounts | Anonymous roles only: `OWNER-A`, `MEMBER-B`, `OUTSIDER-C` |
| Family | Anonymous test-family label; never record the invite code |
| Network | Wi-Fi/cellular, normal/weak/offline, and backend environment |
| Light | Normal indoor or low light; record lux if a meter is available |
| Permission start state | Camera, microphone, motion, notifications, and photo-library state |
| Evidence root | Folder or test-run URL containing sanitized screenshots, recordings, and logs |
| Result | Overall `PASS`, `FAIL`, or `BLOCKED` |
| Issues | Issue links/IDs and the affected case IDs, or `None` |

For each case, add a row to the run's result sheet:

| Case ID | Device | Result | Observed value | Evidence path/URL + timestamp | Issue |
| --- | --- | --- | --- | --- | --- |
| Example: CAP-05 | iPhone 15, iOS 18.6 | PASS | 34/34; 2048 x 1024 | `ios/CAP-05.mov` 00:12-01:48; `ios.log` 14:03:21-14:05:02 | None |

`Observed value` is mandatory. Record counts, dimensions, duration, permission
state, or delivery latency instead of writing only "works." Native logs should
cover the same wall-clock interval as the recording and contain no uncaught
exception, fatal renderer error, or repeated lifecycle callback.

## Test setup

1. Install a clean build on both phones; do not reuse data from a different
   commit. Keep a second run with an in-place upgrade when release migration is
   in scope.
2. Prepare a safe room with textured walls, straight vertical lines, nearby and
   distant objects, a bright window, and a clear point about which the tester
   can rotate. Repeat the low-light cases after dark or in a dim room.
3. Start a sanitized screen recording and platform log capture before each
   lifecycle case. Use Xcode's device console for iOS and filtered `adb logcat`
   for Android.
4. Sign in `OWNER-A` and create the test family. Sign in `MEMBER-B` on the other
   phone, join with the temporary invite, and approve it from Phone A. Do not
   retain the invite in screenshots or logs.
5. Have a known-good 2:1 equirectangular test image available for viewer/VR
   comparison. Its left/right seam should contain a recognizable marker and it
   should have obvious zenith and nadir markers.

## Authentication and two-phone privacy

| ID | Platform | Action | Pass condition | Required evidence |
| --- | --- | --- | --- | --- |
| AUTH-01 | iOS + Android | On a clean install, sign in once with email code on one phone and Google on the other. Cancel Google once, then retry. Background and reopen during one email-code attempt. | Cancellation returns to an interactive sign-in sheet; the callback returns to Bubble rather than a browser dead end; one session is created per phone; reopening does not reveal another account or bypass verification. | Recording from sign-in through Moments; final anonymous role shown; log interval containing the native callback with tokens and email redacted. |
| AUTH-02 | iOS + Android | Force-close and reopen while signed in, then sign out and sign in as a different test account on the same phone. | Session restoration finishes without an auth loop; after sign-out, the prior account's local moments, drafts, profile, and family state never flash or remain accessible. | Cold-launch recording before and after account switch; screenshots of the empty/new-account state; role-to-device mapping. |
| FAMILY-01 | Two phones | Create a family as `OWNER-A`; submit and approve `MEMBER-B`; refresh/relaunch both phones. | Both phones show the same family membership exactly once and remain connected after relaunch. No duplicate pending request or membership appears. | Side-by-side sanitized screenshots, approval recording, and timestamps for submit/approve/visible. |
| FAMILY-02 | Two phones + outsider | Share one completed 360 moment from Phone A. Observe Phone B without manually repairing backend data. Attempt the same family data from `OUTSIDER-C`. | Phone B receives one viewable moment with matching caption/annotations; Phone A does not create a duplicate; the outsider cannot list, open, sign, or infer the media object. | A/B recordings with moment ID suffix and delivery latency; sanitized request/log evidence of the outsider denial; object count before/after. |
| FAMILY-03 | Two phones | Start viewing the shared moment on Phone B, then remove `MEMBER-B` from Phone A and refresh/relaunch Phone B. | Access is revoked without exposing the panorama from network or stale family state; cached content is cleared or made inaccessible; rejoining requires the normal approval flow. | Removal timestamp, Phone B recording, denied request status, and post-relaunch screenshot. |

## Camera, capture, and microphone

The standard guide contains 34 targets. Bubble's shared compositor is requested
at 2048 pixels wide, so a successful standard result should be an exact 2:1
image (normally `2048 x 1024`) unless the release intentionally changes that
contract.

| ID | Platform | Action | Pass condition | Required evidence |
| --- | --- | --- | --- | --- |
| CAP-01 | iOS + Android | Reset camera permission. Start **Upload a 360 photo now** -> **Start guided 360 capture** and allow access. Repeat with permission already granted. | The prompt appears only when required; both paths reach the live guide; no blank/black surface, duplicate guide, or stuck busy state appears. | Recording of both launches; permission-state screenshot; native log interval. |
| CAP-02 | iOS + Android | Reset permission, deny camera access, retry, then grant it in system Settings and return. Include Android's permanent-denial state when available. | Denial returns to an interactive capture page with clear recovery copy; no frame is saved; granting access allows a new guide without reinstalling or restarting the phone. | Denial and recovery recording; before/after permission state; no-frame observation. |
| CAP-03 | iOS + Android | Rapidly tap the guided-capture action, then cancel once before any frame and once after at least three frames. Start a third capture immediately. | Only one native guide opens; each cancellation returns once, clears the busy state and partial private session, and the next capture starts normally with `0/34`. | Recording including counters; logs showing one session at a time and cancellation; cache/session count before and after when available. |
| CAP-04 | iOS + Android | Align a dot while moving, stop just outside alignment, then center and hold steady. Repeat with a brief tremor. | Movement/out-of-alignment never accepts a frame; the progress ring advances only while aligned and steady; one centered hold accepts exactly one target and moves on without demanding the vanished starting dot. | Close-up recording of guide and counter; observed hold time; logs for accepted target indices showing no duplicate. |
| CAP-05 | iOS + Android | Complete all middle rings, zenith, and nadir while rotating around one fixed point. Review and save/share the result. | Counter reaches `34/34`; composition completes without missing-coverage error; output is exact 2:1; drag can inspect the full sphere; straight lines, seam, zenith, and nadir are not stretched into unusable shapes; source frames are discarded after the derivative is accepted. | Entire capture or representative clips, final dimensions, four viewer screenshots (front/seam/zenith/nadir), composition duration, and cleanup evidence/log. |
| CAP-06 | iOS + Android | Interrupt before the first frame using lock/unlock, app switch, Control Center/notification shade, and an incoming call or system permission sheet. | The session resumes with valid tracking or exits with a clear retry path; no frozen camera, stale reticle, or hanging bridge call remains. | One recording per interruption class plus lifecycle log timestamps. |
| CAP-07 | iOS + Android | Repeat the interruptions after at least three accepted frames; then start and finish a clean retake. | Bubble never combines frames across a changed tracking origin. It either resumes with preserved alignment or explicitly requires a clean retake, removes the partial session, and permits that retake immediately. | Recording showing pre-interruption count, resulting message, clean restart, and successful next frame; logs for cleanup/result code. |
| CAP-08 | iOS + Android | Rotate the phone, toggle system rotation lock, resize through any native prompt, and return from background during capture and review. | Native capture remains a correctly laid-out portrait guide; controls, reticle, arrows, progress, and review actions stay inside safe areas. Review and Moments restore the app's normal orientation rules. | Portrait/landscape screenshots at each boundary and final restored state; no layout-warning/crash logs. |
| CAP-09 | iOS + Android | Capture in low light, facing both a plain dark surface and a detailed dim surface. Repeat one target with camera motion. | Guidance remains readable on bright and dark content; poor tracking asks for more light/detail or slower motion instead of silently taking a bad frame; recovery happens after pointing at detail; no crash or endless hold occurs. | Screen recording including recovery copy; room/light description or lux; final low-light panorama screenshots and capture times. |
| CAP-10 | iOS + Android | Translate roughly an arm's length after capture begins, then return to the original pivot and continue. | Bubble warns or prevents unsafe progress rather than silently accepting large translation; returning to the pivot restores capture. The final image does not contain a catastrophic parallax tear. | Recording of translation/recovery; observed guidance text; seam comparison image. |
| MIC-01 | iOS + Android | From panorama review, deny microphone once, then allow it and record/play a voice note. Background once during recording. | Denial preserves the draft; allowed recording plays once with correct duration; backgrounding stops capture and releases the microphone indicator; retry works without duplicate audio or an active mic. | Recording, permission states, duration, microphone-indicator state, and lifecycle logs. |

## Panorama viewer, motion, and Cardboard

Run the viewer cases with both the known-good panorama and a panorama produced
by `CAP-05`. This separates a renderer problem from a stitching problem.

| ID | Platform | Action | Pass condition | Required evidence |
| --- | --- | --- | --- | --- |
| VIEW-01 | iOS + Android | Open a shared panorama in the normal viewer. Drag through the seam, pinch in/out, inspect zenith/nadir, background/reopen, and exit/re-enter three times. | Projection remains spherical and undistorted for a correct 2:1 source; touch and zoom remain smooth; state is usable after resume; no duplicate motion/listener response or black texture appears. | Recording with source filename/dimensions; front/seam/zenith/nadir screenshots; three-cycle log interval. |
| MOTION-01 | iOS + Android | Allow motion where prompted and move yaw, pitch, and roll slowly, then quickly. Hold still for ten seconds. | View follows the correct direction without a 90/180-degree jump, reversed axis, uncontrolled drift, or continued movement while the phone is still. Touch remains available. | Recording with a second camera showing phone movement and screen; note prompt/result and observed drift. |
| MOTION-02 | iOS + Android | Deny or disable motion and reopen the panorama/VR flow. Test a device or setting where motion is unavailable if possible. | Bubble explains the limitation and preserves synchronized drag/flat viewing; denial never traps the user or repeatedly prompts in one session. | Denial recording, fallback copy screenshot, and successful drag evidence. |
| VR-01 | iOS + Android | From Moments choose **Set up Cardboard VR**, select a memory, rotate at the prompt, press **Go**, then exit. Repeat using **Use split view anyway** before rotating. | Setup advances on real rotation; override remains reachable; viewer enters landscape/fullscreen; exit returns to the same memory and restores prior orientation/system bars. | Full setup/exit recording for each route and orientation screenshots before/during/after. |
| VR-02 | iOS | Open the native Cardboard renderer with the known-good panorama. Inspect through the headset while turning 360 degrees and looking up/down. | The Metal renderer presents two synchronized calibrated eyes, continuous seam wrapping, correct head direction, and no blank eye, severe distortion, double vision after QR calibration, shader error, or retained screen. | Through-lens photos for both eyes, external movement recording, source dimensions, and Xcode console interval. |
| VR-03 | Android | Repeat `VR-02` in the native Google Cardboard activity. Use the system Back control and the viewer back control. | Both eyes remain synchronized and calibrated; either exit path releases the renderer and returns to the same memory with portrait UI/system bars restored. No GL/renderer fatal error appears. | Through-lens photos, exit recordings, source dimensions, and filtered logcat interval. |
| VR-04 | iOS + Android | With no saved viewer profile, accept **Scan headset QR**; deny and then grant camera access where the OS asks; scan an invalid/unreadable code and then the headset's real code. Reopen VR. | Cancel/denial leaves a usable standard profile or retry path; valid scan updates calibration and persists across reopen; optical alignment improves or remains correct and the app does not hang on the scanner. | QR flow recording with the code itself obscured, before/after through-lens image, and persisted-reopen evidence. |
| VR-05 | iOS + Android | While VR is active, background/foreground, lock/unlock, receive an interruption, and repeat enter/exit five times. | Rendering and head tracking pause off-screen and resume once; exit remains responsive; no duplicated sensor response, orientation leak, staged-file leak, black eye, or crash occurs. | Recording, five-cycle count, lifecycle logs, and staged-cache observation when available. |
| VR-06 | iOS + Android | Run VR continuously for 15 minutes while slowly turning and changing scenes when available. Observe battery/thermal warnings and frame stability. | No crash, runaway brightness/idle timeout, progressively increasing lag, memory warning, or unusable thermal state occurs. Any OS thermal warning is recorded and triaged. | 15-minute start/end timestamps, screen/through-lens clips at start/middle/end, battery delta, thermal state/warning, and native logs. |

## Final two-phone acceptance path

After every individual case passes, perform this uninterrupted release run:

1. Clean-install the same commit on both phones and complete `AUTH-01` and
   `FAMILY-01`.
2. On Phone A, finish a standard guided capture in normal indoor light, add a
   short text note and voice note, and share it.
3. Without refreshing database data manually, wait for exactly one moment on
   Phone B. Record delivery latency.
4. On Phone B, inspect the normal viewer with touch and motion, then complete
   Cardboard entry, head tracking, background/resume, and exit.
5. Remove Phone B's member from Phone A while the memory is open and verify
   `FAMILY-03`.
6. Sign out both phones and confirm no private image or account content appears
   during the next cold launch.

The release passes only when both device run records are `PASS`, all applicable
case rows contain the required artifacts, and every failure has been fixed and
rerun on the same commit. A note that a feature "was tested before" is not a
substitute for commit-specific evidence.

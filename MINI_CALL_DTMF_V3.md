# Mini call screening — native keypad detection repair

## Problem described by live diagnostics

The controller correctly detects the screening call and the native keypad toggle, but reports `keypadDigitCount=0`. A previous `lastDigitAttempt=1 via native pointer` only proved that Electron dispatched a mouse event, **not** that Google Voice generated an in-call DTMF tone. Google Voice's web call controls work when operated directly.

## Changes

- Fixes a sidebar scoping error: previously every digit under `gv-call-sidebar` was rejected, even if it was part of the **active** `gv-in-call` component. It now excludes only the separate idle dialer and unrelated recipient picker.
- Searches new native digit controls inside the call panel, Google Voice's Angular overlays, accessible open shadow roots, and accessible **same-origin** iframe DOM. Cross-origin frames are not inspected.
- If both `Open keypad` and `Hide keypad` controls are visible, it does not blindly activate Hide. It scans for real digit buttons first, then prefers an explicit Open toggle if necessary.
- Maps same-origin iframe-local mouse coordinates into the main Voice viewport before dispatching the native pointer event.
- Does not transition to `active`, close the screening hold, or claim that DTMF worked just because a pointer event was sent. Google's UI/call state must actually advance.
- On a failed digit lookup, the native pad remains open and the controller returns an error; its diagnostics now include safe keypad-scope metadata, counts, and the last **unconfirmed** attempt.
- Preserves all existing themes and the user's previous CSS changes, GIF picker, mini controller and always-on-top behavior.

## Test procedure

1. Completely exit the prior Voice Desktop process **including the tray icon**, then extract and run the project with `pnpm install` and `pnpm start` in Windows Command Prompt.
2. Place a real incoming Google Voice call with call screening enabled.
3. Click Answer and then click the floating **1** button once. It should open Google's keypad if needed and click its visible native digit 1 without bringing the main window forward. Repeat with 2 on a separate test call.
4. If the shortcut reports it could not find the digit, **open the keypad in Google Voice**, confirm you can click 1 manually, and click **Copy diagnostics** *while the native keypad is still visible*. Send that output and, if possible, a screenshot of only the keypad/call controls (hide personal details).

Automated tests exercise simulated DOM layouts and therefore **do not prove live DTMF signaling**. No undocumented Google Voice API or remote sending endpoint is used.

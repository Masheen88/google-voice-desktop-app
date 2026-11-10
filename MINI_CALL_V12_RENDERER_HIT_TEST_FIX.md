# v12 — painted-window DTMF hit-test fallback

## Issue seen in live v11 report
- First attempt: `onscreen-translucent`, window painted successfully.
- Verified `gv-dtmf-input > gv-dialpad > ... > button` corresponding to 1.
- `dtmf.hitMismatch` reported a keypad section rather than the digit. The handler threw before clicking.
- A later attempt with the normal Voice window open dispatched a Chromium pointer click (not itself confirmation of DTMF).

## Change
The native in-call keypad discovery and the working End Call path are preserved. In painted-window mode only, the renderer waits up to 700ms for the keypad to become hit-testable after animation. If a different element still captures the hit-test, it activates ONLY the previously verified live Google Voice DTMF button using its DOM click handler. It never clicks the overlapping element or the separate ordinary dialer. Tests cover both digits and verify direct mode fails safely on obstructions.

This is a candidate fix, not a guarantee of Google Voice DTMF delivery: the web app may require a trusted user gesture or foreground focus. A click being dispatched is not confirmation of call screening acceptance. Diagnostics expose `lastHitTest`, `paintedNativeClickFallbacks`, and `inputTransport` to distinguish what happened.

## Test
Completely exit Voice Desktop (including tray). Run `pnpm install` then `pnpm start`; confirm mini controller says `v12`. Hide the main window, answer an incoming call, press 1 once, and copy diagnostics before opening Google Voice. If it still fails, report both main-process and mini diagnostics. If it works, the call should move beyond Google's screening prompt without opening the full Voice window.

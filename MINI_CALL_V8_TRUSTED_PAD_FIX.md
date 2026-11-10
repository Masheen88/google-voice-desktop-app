# Voice Desktop — native in-call DTMF routing v8

## Why the previous version couldn't send 1

The live v7 diagnostic reported an actual native in-call keypad with 12 visible buttons, plus a successfully captured manual click at:

`gv-dialpad > section[0] > div[1] > div[0] > div[0] > button[0]`

However, `nativeGrid1=false` / `verifiedKeypad1=false` showed that the previous full-grid validator rejected the real keypad before clicking its native button. The manual key path was saved but still subjected to restrictive verification. The working Google Voice UI itself did not fail.

## v8 changes

1. **Trusted-click route first.** Reuse a previously manually confirmed 1/2 button through its tag-and-child-index path within an active `gv-dialpad`. This works even if the button has no readable digit label. A contradictory explicit label still invalidates a stale route.
2. **Scoped native dialpad.** Find the actual `gv-dialpad` within `gv-in-call`; reject the ordinary `gv-make-call-panel` even if it is nested inside `gv-in-call`. Confirm a live answered call before sending DTMF.
3. **Direct native key recognition.** If a real 12-button in-call pad has a uniquely identified 1/2 button, select it directly without requiring all twelve controls to have readable labels or appear in DOM telephone order.
4. **Conservative 2 fallback.** When 1 is identified but 2 has no label, find its immediate neighbor only if the three key cells share the same native row and each cell contains exactly one button. Geometry can serve as a separate fallback if a true four-row, three-column grid is visible.
5. **Trusted pointer input.** Once the correct native button is identified, prefer Chromium's native pointer dispatch to the precise key location, with a DOM `.click()` fallback only if native input is unavailable. No private Google Voice API, fabricated audio tones, or automatic redial.
6. **Diagnostics v8.** Shows `controllerBuild=2026-11-09-v8-learned-pad`, `learnedRouteResolved1/2`, native grid discovery paths, and the recognized single-digit key indices. It never copies caller names or phone numbers.
7. **Hang Up unchanged.** Preserves the working verified End Call behavior from v7, as well as the always-on-top popup, GIF picker, and theme rules.

## Windows installation

Exit Voice Desktop completely, including the tray icon, then extract the ZIP to a clean folder and run:

```cmd
pnpm install
pnpm start
```

Verify the floating controller shows **v8** beside Diagnostics. The app will automatically load the previously learned 1 key from its own preferences; you do **not** have to train it again unless Google changes the native keypad layout.

For a screened call: answer, then select **1 — Accept** from the floating controller. If it cannot activate the key, the native Google Voice keypad remains available. Copy Diagnostics while the call is active to inspect `learnedRouteResolved1`, `nativeGrid1`, `lastDigitAttempt`, and the recent timeline.

To build the Windows installer using the existing project script:

```cmd
pnpm run build:windows:offline
```

## Testing and limitations

Tests exercise the real preload action logic using simulated Google Voice DOM trees, including the exact nested manual-click route reported by the user, a 12-button native keypad with unreadable labels, incorrect/stale learned routes, idle-dialer rejection, and both End Call paths. Automated tests cannot prove that Google Voice transmits DTMF during a live authenticated call. A dispatched click is not confirmation of acceptance by the telephone network.

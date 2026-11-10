# Voice Desktop mini call controller — v7 native in-call grid and Hang Up verification

## What the live v6 diagnostic proved

- During call screening, Google Voice mounted a visible `section.dialpad-container` within `gv-in-call`.
- That component contained **12 visible native buttons** but Google Voice only exposed the `1` label clearly enough for the old digit detector. The shortcut wrongly rejected the entire real keypad.
- The normal `gv-make-call-panel` has a separate dialpad and must never be used for screening.
- The floating Hang Up button needed two clicks on a live call and left the mini window visible.

## v7 implementation

1. **Native 12-button grid recognition:** When an active `gv-in-call` contains a visible `section.dialpad-container` with exactly 12 buttons, check any readable labels against conventional telephone order (`1 2 3 / 4 5 6 / 7 8 9 / * 0 #`). Missing labels are allowed; contradictory labels cause rejection. If no labels are exposed, validate the three-column grid geometry. This avoids accidentally selecting unrelated numeric text.
2. **Real native in-call button click:** Select button index 0 for screening `1`, index 1 for `2`, then call that actual button's `.click()` so Google Voice's own Angular handler can process it. This differs from the earlier keyboard-event and incidental numeric-leaf approaches. No undocumented network endpoints or synthetic DTMF audio are used.
3. **Trusted manual-key capture:** The manual-click observer can identify a 1/2 click by its position in the confirmed native grid even if Google gives the button no readable number.
4. **Verified Hang Up:** After requesting Hang Up, the controller waits for the original native call controls to disappear. If they remain, it clicks the current End Call control **once more**, on the same call surface, and checks again. Once the controls are stably absent, it clears the screening hold and publishes the idle state so the mini window closes.
5. **Diagnostics v7:** The report now shows `controllerBuild=2026-11-09-v7-native-grid`, `nativeGrid1`, `nativeGrid2`, `verified12Grid`, `lastHangupAttempt`, and action traces including the selected native grid button. The footer says `v7` to help identify stale installs.

## How to run on Windows 11 (CMD)

Close the installed Voice Desktop application **including the tray process**, then extract the source ZIP to a new folder and run:

```cmd
pnpm install
pnpm start
```

For the Windows installer, use the existing build command:

```cmd
pnpm run build:windows:offline
```

On a screened incoming call, click Answer and then **1 — Accept call** in the floating controller. If it still fails, open Google's native in-call keypad and verify that 1 works there. Copy the **v7 diagnostics** while the call is active, preferably after a single failed controller attempt. In the output, check `nativeGrid1=true`, `dtmf.selected: mode=native-12-key-grid`, and `dtmf.nativeButton`. For End Call, check `lastHangupAttempt`.

## Verification and limitations

58 automated tests pass, including new regression fixtures for the 12-button grid with incomplete labels, rejecting the idle dialer and conflicting key labels, trusted click capture, first-click Hang Up, and an automatic second-click Hang Up when the original native controls persist.

**Actual Google Voice DTMF and real call termination cannot be verified by the tests alone.** A programmatic click of a Google Voice button is not proof that the remote telephone network accepted its tone. If Google Voice's code requires trusted pointer input rather than the native button click handler, the diagnostics will show the attempted route and a subsequent update can add a narrowly scoped trusted-input fallback.

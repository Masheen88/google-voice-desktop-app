# Voice Desktop v10 — floating call input while Google Voice is in the tray

## What your v9 report established

- The actual in-call 12-key Google Voice keypad is found (`nativeGrid1=true`, `nativeGrid2=true`).
- When the main app is visible, the controller can activate the native keypad.
- The last v9 diagnostics were copied after the main window was opened, so they did not reliably preserve the earlier hidden-window action.
- Sending keyboard events or invoking `.click()` in a background renderer does **not** prove an in-call DTMF tone was transmitted. No private Google Voice calling API is used.

## v10 change: temporary offscreen rendering (Windows)

When a mini-controller 1/2 action occurs while the Google Voice window is hidden or minimized:

1. The Electron **main process** records the window's original location, visibility and minimized state.
2. It temporarily places the **existing authenticated call window** to the left of every connected monitor, removes its taskbar entry, and makes it visible without focusing it. The call is **not transferred** to another window or session.
3. After Chromium has time to paint the in-call keypad, the trusted Voice preload identifies the actual in-call `gv-dialpad` button and sends a native pointer click through Chromium. The existing native-keypad verification is unchanged.
4. The main process allows the event to settle, then restores the exact former window bounds and tray/minimized state. Cleanup runs even if the action fails.
5. The floating controller stays always on top; the main call window never intentionally comes to the foreground.

This is an attempt to make the same pointer-input path that worked with the main app visible usable while it is hidden from the desktop. Some Windows compositor configurations may clamp or not render offscreen windows; v10 detects a clamped window and refuses an unsafe click. **Live DTMF delivery still requires a real call test.**

## Improved diagnostics

The controller displays **v10**. Its copied diagnostic includes:

- `controllerBuild=2026-11-09-v10-render-assist`
- `lastDeliveryMode=offscreen-rendered` or `direct`
- `mainWindowAtLastDigit` (including an error description if IPC couldn't read the state)
- `inputTransport` and `lastDigitAttempt`
- A new **Main-process window delivery timeline** that survives Google Voice DOM changes and captures whether the window was parked and restored

No caller names, numbers, message bodies or URLs are collected in the added main-process timeline.

## How to test

1. Fully exit the old app including its tray instance. Optionally run `taskkill /F /IM "Voice Desktop.exe"` in Windows CMD, but only if the installed copy is still running.
2. Extract this complete ZIP into a new project folder.
3. Run `pnpm install` then `pnpm start`.
4. Confirm **v10** appears in the mini controller.
5. With the main window **hidden in the tray**, answer an incoming call and press 1 in the floating controller.
6. If the screening prompt does not advance, manually answer using the Google Voice keypad and copy v10 diagnostics. Include the complete **Main-process window delivery timeline** at the end of the report.

### Limits

This fix has automated coverage for window transitions, cleanup after errors, clipboard reporting integration and existing in-call keypad selection, but no simulated or automated test can prove that Google's live service received DTMF. If v10 still fails while the hidden window was temporarily rendered, the next step is to evaluate Windows' offscreen-compositor behavior in the live session rather than changing DOM selectors again.

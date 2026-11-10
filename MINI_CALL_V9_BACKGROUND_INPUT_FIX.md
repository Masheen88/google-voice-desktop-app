# Voice Desktop mini-call background input fix — v9

## Why v8 worked only with the main Voice window visible

The call controller correctly identified the genuine twelve-key in-call `gv-dialpad`, but it invoked the selected native button through Chromium `Input.dispatchMouseEvent`. Chromium can accept those mouse commands while a `BrowserWindow` is hidden or minimized without delivering a click through the window's painted surface. Successful debugger dispatch does **not** confirm that Google Voice sent a DTMF tone.

## v9 implementation

- `src/main.js` exposes a sender-validated `mini-call-input-context` IPC method returning only window visibility/minimization/focus flags.
- When the Google Voice window is hidden or minimized, the sandboxed Google Voice preload invokes the real, already verified in-call button's `click()` handler directly in its own renderer. It never targets the ordinary dialer, arbitrary numeric content, or an undocumented Voice API.
- When the main Voice window is visible, the existing Chromium native-pointer path remains unchanged. A window that becomes hidden between checks safely falls back to the DOM click path.
- The mini controller remains always-on-top. The background path does not unhide or focus the main Voice window.
- Diagnostics report `controllerBuild=2026-11-09-v9-background-dom`, `mainWindowAtLastDigit`, and `inputTransport` alongside the original keypad and action traces.
- The working verified Hang Up behavior from v7/v8 is unchanged.

## Tests and limitations

Unit tests cover hidden/minimized 1/2 actions, visible-window compatibility, ordinary-dialer exclusion, and IPC sender verification. They cannot establish whether Google Voice's live WebRTC call transmits the DTMF tone. A synthetic DOM click may still be ignored if Google requires a trusted real pointer event to send DTMF in the current version; in that case, a different strategy or an actively rendered Voice surface will be necessary. Do not assume a successful click dispatch means the call was accepted.

## Manual validation

1. Fully exit the old application, including its tray instance. Run `pnpm install` and `pnpm start` from the extracted project.
2. Confirm the controller footer displays **v9**.
3. Hide or minimize the Google Voice main window. On a test incoming call, press **Answer**, then **1** in the floating controller.
4. If the spoken screening prompt doesn't stop, use the native Google Voice keypad to accept and then collect v9 diagnostics. Check `mainWindowAtLastDigit` and `inputTransport` to confirm which branch was attempted.

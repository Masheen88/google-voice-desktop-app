# Mini call controls — November 2026 update

This update is based on the last distributed Voice Desktop ZIP with GIF picker and mini controller.

## Changes

- Keep **End** enabled during active/screening/outgoing calls even when Google's label is absent in the last state snapshot.
- Route live actions to Google Voice's page-side preload, which re-discovers controls at click time.
- Identify Google Material icon-only buttons (`call_end`, `dialpad`, `mic`, etc.) and numeric keys labelled `2ABC` or `one`.
- Avoid immediately toggling the native keypad a second time after choosing a screening digit.
- Provide an **Open Voice** control and a **Keypad** fallback if Google Voice does not expose a recognizable in-call keypad.
- Add **Copy diagnostics** to the mini controller for an anonymized summary of phase, recognized controls, call-panel tags, and Material icon names (not caller names, message contents, phone numbers, or credentials).
- Preserve the user's DarkPlus selector for the disabled Google Voice dialer call button, as well as prior theme and GIF picker changes.

## Testing on Windows 11

1. Run `pnpm install`, then `pnpm start`.
2. Have someone call your Google Voice number, answer using the mini controller, and press **1** during Google's screening prompt.
3. Test **2** on a separate incoming call, then test **End** on an active/outgoing call.
4. If a mini button cannot activate the equivalent native button, click **Copy diagnostics** while the call is open and paste that summary in your next report. Use **Open Voice** to hang up with Google's native control in the meantime.
5. For a Windows installer, use `pnpm run build:windows:offline`.

**Important:** Automated tests validate mock DOM/layout behavior only. They do not complete authenticated Google Voice calls, confirm actual DTMF signaling, or verify that calls ended. A successful programmatic click is not independent confirmation that Google Voice processed a key. Google may change its DOM again.

## About the console warnings

The attached console output included a storage-access permission warning, Electron's generic content-security-policy warning, and a Chromium `powerPreference` warning. None explicitly identifies a mini-controller click failure. If a live call still fails, use **Copy diagnostics**; a sanitized call-controls report is much more specific than those unrelated page stack traces.

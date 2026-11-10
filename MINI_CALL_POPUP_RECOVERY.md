# Mini Call popup recovery — November 2026

This release builds on the native DTMF call-controller update. It addresses a regression where the floating controller sometimes did not appear even when Google Voice had an incoming or active call.

## Detection changes

- Keeps strict Answer/Decline and End Call detection, but adds a bounded fallback for **visible Google Voice-specific call elements** (`gv-in-call`, `gv-incoming-call`, etc.). This fallback recognizes an incoming call when its Answer button uses alternate wording, and recognizes an active call when the End button temporarily disappears during a Google UI transition.
- Does not treat the normal standalone dialer or the Calls tab as a live call. A live Google Voice call component must also expose call-specific controls.
- Every three seconds, republishes the latest non-idle call snapshot. This gives the main process an opportunity to reopen an accidentally hidden controller after navigation or transient UI changes.
- Protects periodic detection against unexpected DOM errors and logs a rate-limited, metadata-free `Mini call detector warning` to the main-process console.
- Preserves the always-on-top Electron window, native keypad DTMF path, existing CSS theme fixes, GIF picker, and all other previously included project features.

## Running and verifying

1. Close **Voice Desktop completely**, including its Windows tray process, before starting the updated build. Otherwise you may still be running the previous preload.
2. From the project folder in Windows Command Prompt: `pnpm install` and then `pnpm start`.
3. Check **File > Settings > Floating mini call controller** is enabled.
4. Use the menu **File > Mini call controller** to open a manual controller preview if needed. If preview works but incoming calls do not, this distinguishes call detection from window creation.
5. Make a test incoming call and confirm the mini controller opens while Google Voice rings, remains visible after Answer, and stays above other windows.

The 1 / 2 shortcuts still use the previous native keypad implementation. No change to the DTMF signaling behavior is claimed in this popup-specific recovery.

## Testing limits

The suite checks the actual preload functions against simulated live-call DOM structures and verifies the main-process show pathway. It does not prove compatibility with Google's current authenticated live-call UI. Use the controller's **Copy diagnostics** action, or copy any main-process `Mini call detector warning` if the issue persists.

# Voice Desktop v11 — background call keypad and diagnostic history

The v10 report ended with `lastDeliveryMode=unknown` despite a native pointer dispatch. The last renderer-only snapshot could not show what happened to the window when the **earlier failed click** was attempted. V11 records each 1/2 action in the Electron main process and includes that summary **first** in Copy diagnostics.

On Windows, hidden/minimized windows can be culled by the compositor even when moved completely offscreen and shown. V11 tests an alternative: during one digit action it briefly shows the **same** authenticated Google Voice window at approximately 4% opacity on a real display, uses Google's existing in-call keypad, then restores the original hidden/minimized state. It does not focus Google Voice or open another session. This can briefly tint or intercept desktop clicks and remains experimental. There is no supported Google Voice DTMF API for Electron, and a dispatched click is **not** proof that the call accepted the digit.

Existing native End Call logic is unchanged. The main controller remains always-on-top while open. GIF picker, themes and other existing features are retained.

## Validation

1. Fully exit Voice Desktop including the tray copy, then start the freshly extracted v11 folder with `pnpm install` and `pnpm start`.
2. Answer a screened call with the main Voice window hidden and press 1 **once**.
3. Copy diagnostics before opening the main Voice app, preferably while the call is active.
4. Report should start with `Voice Desktop main-process call delivery v11`, including `request=1 ... mode=onscreen-translucent` if the special transport ran. If it says `mode=direct`, the main window was already regarded as visible when the action began. The renderer section says `diagnostics v11`.
5. If unsuccessful, use Google's native keypad as the reliable fallback. No automatic second digit is sent, avoiding accidental double-DTMF.

Automated tests check window transitions and diagnostics code paths but cannot validate actual DTMF delivery or Windows compositor behavior during a real call.

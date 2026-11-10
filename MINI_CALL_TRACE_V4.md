# Mini call controller — detailed native-keypad trace (v4)

## What the November 9 diagnostics indicate

The previous output reported `phase=screening`, `postAnswer=true`, `hangupAvailable=true`, but `keypadAvailable=false`, `keypadToggle=none` and `lastDigitAttempt=1: no active call keypad toggle`. **That attempt was stopped before a key click was sent.** The Electron keyboard / pointer transport cannot send an actual DTMF response unless we locate Google's real in-call digit control.

## Changes

- The controller looks for the native keypad toggle on **multiple live call surfaces**, including sibling `gv-in-call` and `gv-in-call-status` elements, instead of relying on the first remembered panel.
- During a real post-answer call, if a keypad toggle disappears briefly, the action waits up to 1.6 seconds for it to reappear. It never guesses at the separate idle dialer.
- Removed the old 480 ms automatic **Hide keypad** click after a digit dispatch. This preserves the live native keypad and avoids racing an in-progress Google Voice DTMF interaction.
- Added a **bounded chronological trace** for action starts, detected call phase changes, keypad discovery, attempts to open it, discovered digit elements, native pointer / DOM dispatch, errors, and UI state following a digit.
- **Detailed selector paths** now identify call widgets, keypad toggle locations, whether controls are hidden or disabled, recognized 0/1/2 keys, and why candidate numeric leaves were excluded.
- The diagnostics include frame accessibility counts without copying frame URLs. Private caller names, phone numbers, conversation text, arbitrary attribute values and contact IDs are not captured.
- Main-process forwarding allows a longer wait for Angular keypad transitions, and the clipboard response includes the expanded diagnostics.
- All previous features and theme modifications remain included. The floating window remains always on top.

## Live verification steps

1. Fully close Voice Desktop **including its tray process**, then start this updated version (`pnpm install` and `pnpm start`).
2. Call your Google Voice number with screening enabled. Click **Answer** in the floating controller.
3. When the recorded screening prompt requests the option, click **1** once. You may see Google's native keypad display; it is intentionally not forced closed while signaling is unconfirmed.
4. **Before ending the call**, click **Diagnostics** on the floating controller and send the full copied output. It should begin `Voice Desktop mini call diagnostics v4` and contain **Control paths** and **Recent call-control timeline** sections.
5. If the mini controller still cannot send 1, manually open Google's keypad and click 1, then copy diagnostics **again while the keypad is still open**. The trace may show the native keypad element path from that manual action.

Never include a screenshot containing private contact data unless you want it reviewed. Diagnostics are metadata-oriented, but review any shared logs before posting them.

## Limitations

A dispatched click does **not** prove that Google Voice sent a DTMF tone or accepted screening. There is no documented Google Voice web API for this integration, and the actual browser UI may change. Unit tests are mocked DOM interactions and cannot establish successful live call signaling. The `iframeCount` by itself does not prove the keypad is in an iframe.

## Tests

`node --test tests/*.test.cjs`

The suite includes regressions for call surfaces located in different Angular components, detailed diagnostics not exposing user text, and a missing-toggle trace. There are 48 passing tests as of this update.

# Voice Desktop: in-call screening digits (diagnostics-driven fix)

## Why the previous shortcuts appeared to work without changing the call

The prior mini controller used Chromium `Input.dispatchKeyEvent` to send `1` or `2`. Successfully delivering a key event **does not mean Google Voice accepted a DTMF tone**. The report from a live screened call confirmed `phase=screening`, `postAnswer=true`, `keypadAvailable=true`, and `keypadDigitCount=4`, so call detection worked but keypad discovery was too restrictive.

## What changed

- The two screening shortcuts **no longer take the keyboard-only path**. They target Google's **actual in-call keypad** so its existing UI handlers can generate DTMF.
- If the native keypad is closed, the controller opens it in the authenticated Google Voice page, locates the requested digit, activates it, and then attempts to hide the keypad after a short delay **only if the same live call surface still offers Hide keypad**. It never navigates Google Voice to another page or brings the full window forward.
- If the keypad is already open, it uses it as-is. Google Voice can present **both Open keypad and Hide keypad** concurrently, so the latter now takes precedence.
- A live keypad with **four discoverable digits** can be used when it is verified as the active call keypad; the old minimum of five discoverable digits no longer blocks this case. Sidebar/idle dialer controls remain excluded.
- The controller tries a trusted Chromium **mouse** click at the verified digit's location (not a keyboard key event). If the debugger is occupied or exact coordinates are unavailable, it falls back to clicking the verified DOM key.
- Copy diagnostics now includes `keypadDigits`, `keypadToggle`, `candidateTags`, and `lastDigitAttempt`, without including any caller or contact data.
- The mini controller retains its Google Voice-inspired UI and **always-on-top** Electron window behavior. GIF picker, CSS themes, updater and other features are unchanged.

## Run / verify

From Windows Command Prompt inside the extracted project directory:

```cmd
pnpm install
pnpm start
```

Run the automated checks:

```cmd
pnpm run test:mini-call
pnpm run test:gif
```

For an incoming screened call, first click **Answer**, then select **1 / Accept call** or **2 / Voicemail** in the mini controller. If the call fails to respond, open the *native* Google Voice keypad (without ending the call), click **Diagnostics** in the mini controller, and share that output. The additional keypad metadata will help determine whether the buttons are in a separate overlay or an inaccessible frame.

## Limits and safety

- The test suite covers DOM/keypad behavior with mock call surfaces, and no live Google Voice authenticated call could be made in this environment. **This update is not yet confirmed to transmit real DTMF in a live call.** Successful pointer dispatch or DOM click is not proof of a completed screening action.
- Google Voice does not provide a supported public desktop DTMF API. The selectors may need updates as Google changes its markup.
- No private Google Voice APIs are called; the project acts only on Google Voice's own call controls, and only after detecting a live answered call.

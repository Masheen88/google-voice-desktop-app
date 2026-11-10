# Mini Call Controller — Native Keyboard DTMF Update

This update is based on the previous `voice-desktop-call-controls-fixed.zip` project. It keeps the GIF picker, themes, update checker, and other existing Voice Desktop features.

## Changes

- The **1 — Accept** and **2 — Voicemail** controls **first attempt trusted Chromium keyboard input** using Electron's webContents debugger/Chrome DevTools `Input.dispatchKeyEvent` API. This avoids opening the full Google Voice keypad during the normal shortcut path.
- Before sending a digit, the Google Voice preload verifies a live call or a bounded post-answer screening session and focuses the call area instead of a message editor.
- If Chrome debugging is already in use or keyboard injection fails, the controller **falls back to Google Voice's own call keypad**. The keypad selector has also been expanded for nested spans, Material-style controls, and custom elements.
- The floating window now has a compact Google Voice-inspired design (light and system dark variations), rounded call buttons, a green answer key, a red hangup key, and minimal footer diagnostics.
- The mini window **always stays on top while displayed** using Electron's native always-on-top window flag. The previous optional always-on-top checkbox has been removed to avoid contradictory behavior. Its last saved value is ignored.
- The two screening buttons are locked during an in-flight request to avoid sending duplicate keys.

## How to run

From the project root on Windows:

```cmd
pnpm install
pnpm start
```

Run the regression tests:

```cmd
pnpm run test:mini-call
pnpm run test:gif
```

Build the Windows installer:

```cmd
pnpm run build:windows:offline
```

## Live-call validation required

The tests validate event dispatch, stage guards, and the keyboard fallback, but **cannot verify that Google's web UI accepted DTMF**. Google Voice does not provide a public supported desktop DTMF automation API. After clicking Answer during a screened incoming call, press **1** or **2** in the mini controller and check whether Google Voice responds. If it does not, use **Keypad** to operate the native UI and click **Diagnostics** to copy anonymized control metadata for investigation.

**Privacy:** No phone number or caller name is copied by Diagnostics. The update does not record audio, inspect messages, or call any private Google service endpoints. The Chromium debugging session is temporary and detached immediately after sending the key.

**Limitations:** Always-on-top on Windows generally works over ordinary desktop apps; it does not override secure Windows desktops (e.g., UAC prompts) and cannot cover all exclusive full-screen scenarios. Linux Wayland does not support Electron always-on-top.

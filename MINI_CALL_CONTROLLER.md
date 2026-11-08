# Voice Desktop — Floating Mini Call Controller

The mini controller is an optional, draggable, **always-on-top** local Electron window. It appears when the authenticated `voice.google.com` page exposes a live incoming or outgoing call, even if the main Voice Desktop window is minimized to the tray. It closes automatically when the call ends (after a short DOM transition grace period). After the first Answer click, it keeps the screening controls visible even if the call UI briefly disappears.

## Features

- Incoming: **Answer** and **Decline** using Google Voice's existing call controls.
- Connected calls: quick **1** / **2** keys, **Mute / Unmute**, **End**, and a shortcut to the native **Keypad**.
- Screening: **1 = accept** and **2 = send to voicemail**, but only when Google Voice's screen-calls feature is active and the call has reached the keypad stage. First press **Answer** if the phone is still ringing. The mini window stays visible during the spoken prompt, including when the native call controls temporarily vanish.
- Outgoing calls: the quick keys send plain **DTMF 1** and **DTMF 2**; they do **not** control voicemail for outgoing calls.
- Hides the main dialpad after a quick key if the mini controller had to open it; preserves an already-open dialpad.
- Open main Voice Desktop window from the mini controller. Drag the small header to move it between monitors; the position is saved.
- Close button hides it for the **remainder of the current call**. Another new call shows it automatically.

## Settings and testing

1. Open **File → Settings → Floating mini call controller**.
2. Enable **Automatically show on calls** and **Always on top** (both enabled by default).
3. Click **Preview mini call controller** to see the layout. Preview controls are disabled and **never send digits or place calls**.
4. For a live call, **File → Mini call controller** or **Ctrl+Shift+M** (when Voice Desktop is focused) can manually reopen the mini panel. The tray menu provides another entry.
5. Use the controller's **Open Google Voice** button to fall back to Google's original call UI at any time.

## How the shortcuts work

The app does *not* use a Google Voice calling API. `src/preload.js` watches only the rendered call UI and clicks Google's currently available call controls. For digits, it finds Google's **in-call** keypad, opens it if necessary, selects the real digit control, and closes the keypad only if it opened it. It refuses to press the idle dialer's digits and won't send digits before answering an incoming call.

Google documents screening behavior as press 1 to accept / press 2 for voicemail: https://support.google.com/voice/answer/9262934

**Important limitations:** Google Voice is a third-party website, and its DOM/layout can change. The detectors are tested against representative UI structures, not an authenticated Google account. The app reports an error if it cannot find a compatible in-call keypad; use Google's full keypad instead. Sending a DOM click confirms only that the native button was activated, **not** that the remote network received a DTMF tone or completed a call. Linked-phone calls that take place on a different device are not controllable from this desktop window.

## Developer notes

- `src/main.js` owns the controller window, state and action IPC. All IPC handlers check their sender.
- `src/mini-call-preload.js` exposes only `ready`, `action`, `onState` and `onFeedback` to the local renderer.
- `src/pages/mini-call.*` implements the window's local interface (no network requests).
- `src/preload.js` detects visible call controls with a throttled MutationObserver and conservative UI heuristics. It never exposes Node APIs to Google Voice.
- Unreliable DOM transitions are debounced before the controller is dismissed.
- `tests/miniCall.test.cjs` exercises the **actual** preload logic with a mock DOM for incoming, outgoing, screening, DTMF, and guard cases.

Run tests from the project folder:

```cmd
pnpm run test:mini-call
pnpm run test:gif
```

Build for Windows using the existing workflow:

```cmd
pnpm install
pnpm start
pnpm run build:windows:offline
```

> Note: the Windows build command also runs the project's existing version bump step.

## Answer-to-screening transition fix

Google Voice sometimes removes the initial Answer and Hang Up controls while it plays the
spoken screening prompt. Earlier versions treated that short gap as an ended call and hid the
mini window after two seconds. The preload now starts a **75-second post-answer screening hold**
when the verified Answer control is clicked (from the mini controller **or** Google Voice itself).
During this period the mini window remains visible and its 1 / 2 shortcuts can be attempted.
The actual digit is still sent **only through a native in-call keypad**—never through the idle
dialer or an undocumented API. If Google has not exposed the keypad, the controller reports an
error instead of silently claiming that the key was sent. Pressing 1 changes to a shorter
15-second connecting hold, while pressing 2 or explicitly ending the call clears the hold.
A canceled call with no detectable end controls could leave the panel visible until the hold
expires; the **×** button hides it at once.

**Live call verification is still required.** If your version of Google Voice does not expose
an in-call keypad to the Electron renderer, use **Open Google Voice** to send the key and share
a screenshot of the web call controls for a selector adjustment.

## Native keypad detection (2026 follow-up)

- The 1 and 2 quick keys operate Google's actual **in-call** keypad. They do not generate
  DTMF audio or call internal Google Voice APIs.
- The detector now accepts accessible digits and common numeric-attribute keypad buttons,
  and waits for lazy rendering of the keypad for up to ~2.1 seconds.
- If Google's call keypad is placed in an Angular overlay, only newly revealed digits after
  the real call's Keypad button is clicked may be considered. An existing sidebar dialer
  is explicitly excluded to avoid placing an unintended call.
- If Voice changes its private DOM and the digit cannot be found, the keypad stays open and
  a clear error is shown. Use the **Keypad** button in the mini controller to bring the
  Google Voice window forward and enter the digit directly.
- A live authenticated Google Voice call is needed to verify compatibility against Google's
  current web UI; the automated tests use DOM fixtures and cannot prove actual DTMF delivery.

### Theme contrast

DarkPlus, Dracula, and Solar theme sources now explicitly style `span.title` and
`span.gb_2d.gb_Bd` for readable headers/status. Cerulean and Minty have light palettes,
so those were left unchanged to avoid overriding their darker text contrast.

Also corrected dark-on-dark message input text in Dracula and Solar.

## Call-control troubleshooting (native UI)

Google Voice frequently changes Angular/Material markup. In the mini call widget, **Copy diagnostics**
copies only detected generic call-control names, call-panel tag names and controller phase to the
clipboard (never caller identity, phone numbers, conversation content or Google credentials).
If **1**, **2**, or **End** fails, paste this diagnostics output when reporting the problem.
The mini widget uses Google Voice's native UI and cannot guarantee that Google accepted a DTMF digit
or ended the call merely because a button click was dispatched. Open the main Google Voice window
to finish the call if the widget cannot locate the appropriate native control.

The *Answer* transition may temporarily unmount the native call panel; the screening window remains
visible through this short transition. As of this update the mini widget does not immediately close
Google Voice's keypad after a digit, avoiding accidental second clicks during call transitions.

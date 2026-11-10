# Voice Desktop — Native call-screening keypad repair (v5)

## What the real diagnostics established

The v4 report showed `keypadDigits=0,1`, `keypadDigitCount=4`, and
`lastDigitAttempt=1: native pointer dispatched (unconfirmed)`. A manual
press of Google's own in-call **1** key successfully accepted the call.
That establishes that the application was finding unrelated numeric nodes,
not reliably hitting Google's actual DTMF control.

## Behavior changes

- A digit is no longer eligible merely because visible text says `0` or `1`.
  The picker searches for related keys **inside an active call keypad**,
  requires credible numeric key labels (including `data-digit` and accessibility
  labels), and verifies `1` and `2` belong to the keypad group. That avoids
  clicking a digit preview or a separate idle dialer.
- When the keypad is collapsed, the mini controller can open it, then wait for
  native controls. If those controls still cannot be identified it **does not
  claim DTMF was delivered**. It leaves the keypad open for manual use.
- **Passive native-key learning:** When you manually press Google's working
  in-call **1** or **2** key while screening, Voice Desktop records only the
  native control's structural DOM route (tag names and child indexes) and saves
  it in the app's existing preferences. **No caller names, phone numbers,
  message contents, URLs, or arbitrary DOM attributes are stored.** The route
  is revalidated against a current in-call surface before later use. It can
  stop working if Google substantially restructures the keypad, in which case
  pressing the native key again refreshes the saved route.
- A short message on the mini controller confirms that a manual key press
  was learned. The report now starts with `diagnostics v5` and shows
  `verifiedKeypad1`, `verifiedKeypad2`, `learnedNativeDigits`,
  `learnedNativeRoute1/2`, the path for a manually clicked key, and the
  existing trace of discovery/open/selection attempts.
- The redesigned floating controller continues to be an always-on-top Electron
  window. Existing GIFs, themes, DarkPlus changes, settings, notifications,
  and update mechanisms are preserved.

## How to use / test

1. Close Voice Desktop completely, including its **system tray** instance.
2. Extract the new project and run `pnpm install` followed by `pnpm start`.
3. Answer an incoming screened call from the floating mini controller.
4. Try **1** once. If a warning says the native number controls are unverified,
   use **Google Voice's own in-call keypad** to press **1**. The floating
   controller should briefly report **“Google Voice native 1 key learned…”**.
5. On the next screened call, the controller can reuse the recorded native
   element path. It will still fail safely if that element is no longer valid.
6. To train **2**, do the same during another screened call that you intend to
   send to voicemail, using Google's native **2** key once.
7. Copy **Diagnostics** during the call if either shortcut still fails. The
   report includes a structural path and action timeline without caller details.

## Technical limitations

This is an Electron enhancement to the existing Google Voice page, not a
Google Voice public DTMF API. Google can change the DOM and break saved routes.
A successfully dispatched native pointer or DOM click does not prove the
telephone network received the tone. The automated tests use simulated
Google Voice controls, not a real authenticated call, so **live DTMF delivery
has not been verified**.

## Validation

Run `node --test tests/*.test.cjs` from the project root. The suite includes
regressions for partial `0/1` candidates, manual key learning, saved call
state, native keypad markup, accessibility labels, the GIF feature and more.

# Voice Desktop — v13 compact call controller and shared state

This version is built from the working **v12 background DTMF** source. The native
Google Voice `1` / `2` activation and End Call transport are retained.

## Changes

- Compact Google Voice–style floating controller, with small header, contact,
  state and timer, and simpler rounded call actions.
- The `1` and `2` screening shortcuts appear **only while screening**.
- The controller uses three heights for ringing, screening and active/outgoing;
  it remains always on top while visible.
- The top-right minus button hides the controller without ending the call.
- **File > Show/Hide mini call controller** (`Ctrl+Shift+M` on Windows/Linux),
  the **system-tray right-click menu**, and a new compact **Mini call** button
  in the Google Voice window all toggle the same Electron window.
- The tray shows a non-sensitive call phase indicator while a call is live.
- Minimize/hide state is synchronized across the three controls; manually hidden
  mini controllers stay hidden for the rest of that call until reopened.
- Incoming, screening, connected and idle states use the existing native Google
  Voice DOM observer. A native `1` press (from the widget or Google Voice itself)
  switches out of the screening-only UI; mute and native hang-up changes also
  propagate through the observer.
- A four-second transition grace and two-second idle debounce avoid closing the
  popup during Angular's temporary post-Answer DOM unmount. The older 75-second
  screening hold no longer masks a call whose native surface has disappeared.
- Existing GIF picker, settings, tray notifications, themes, updater and v12 DTMF
  path are preserved.

## Run and test on Windows 11

1. Fully close the previous Voice Desktop process, including the tray icon.
2. Extract this ZIP into a fresh directory.
3. Run `pnpm install` followed by `pnpm start`.
4. Confirm the mini controller footer reads **v13**.
5. Test incoming Answer → 1, Hide → Show from tray, Show/Hide from the main
   Google Voice button, manually mute/unmute, End Call, and an outgoing call.

Automated tests cover DOM detection, native keypad selection, call-control
transports, and v13 menu/launcher synchronization. **Live DTMF delivery remains
unverified in this environment**; the v12 transport was reported working by the
user, so this update leaves it intact.

## Notes

- The main Google Voice page is still the source of truth for live call UI.
- Hiding the mini controller does **not** mute, disconnect or stop a call.
- The mini controller's elapsed display is a local clock, not a network-verified
  billing timer.
- The embedded page controls may need adapting if Google changes its markup.

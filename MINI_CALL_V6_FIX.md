# Voice Desktop Mini Call — v6 native keypad isolation and diagnostics

## Findings from user diagnostics

The reports provided after v5 still say `diagnostics v4`, which strongly suggests an older source build or an existing system-tray process is running. The first report was captured at phase=idle and contained `gv-make-call-panel > gv-dialpad` keys: those are **ordinary dialer** controls, not evidence of real in-call DTMF. The second report is screening mode but doesn't establish which number button actually transmits DTMF.

## Changes

- Explicit **v6** marker in the mini controller footer and `diagnostics v6` + `controllerBuild` in clipboard output.
- Exclude `gv-make-call-panel` digits before considering any `gv-in-call` ancestors; an outer `gv-in-call` tag alone never makes an ordinary dialing panel a DTMF keypad.
- Prefer real BUTTON controls within native keypad components; don't press arbitrary numeric preview spans.
- Observe trusted user clicks during screening before Google changes the DOM and learn stable keypad-component-relative routes.
- Persistent native-route storage remains restricted to key 1/2, allowlisted `gv-*` root tags and child indices.
- Include `manualKeyCapture`, `dialpadComponents` and `dialpad: kind=...` diagnostics without copying phone numbers, contacts, messages or URLs.
- Check hit targets before sending Chromium native pointer events, rather than reporting a likely wrong click as success.

## Installation / testing on Windows

1. Completely quit Voice Desktop from the tray. In a Windows CMD, if necessary, close the old packaged app using `taskkill /F /IM "Voice Desktop.exe"`. Do not kill all Electron processes, as that would close unrelated apps.
2. Extract this ZIP to a **new folder**, open that folder in VS Code, and use `pnpm install` followed by `pnpm start`.
3. Confirm **v6** appears beside **Diagnostics** in the mini controller. If you still see `diagnostics v4` or `v5`, an older app is running.
4. On the first screened call, press **Answer**, then open Google's native in-call keypad and press **1** manually. The controller should report `manualKeyCapture=1: learned ...`. This is a live-call test, not something automated tests can confirm.
5. On a subsequent screened call, try the controller's **1** button. Copy v6 diagnostics if it fails. The trace indicates whether the native click target was truly in the in-call pad or in the ordinary make-call dialer.

**No guarantee of live DTMF**: Google Voice does not offer an official Electron call-control integration. These changes improve targeting and diagnostics, but live audio screening acceptance has not been verified here.

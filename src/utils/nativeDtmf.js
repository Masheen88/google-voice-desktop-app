'use strict';

// Legacy experimental keyboard transport, retained for reference and its unit tests.
// The live mini controller no longer calls this helper: dispatching a key does not
// establish that Google Voice generated an in-call DTMF tone.

/**
 * Deliver an in-call digit to the Google Voice Chromium renderer as native input.
 * Unlike webContents.sendInputEvent(), CDP input doesn't require us to activate
 * the full Google Voice window and take focus away from the mini controller.
 * This does NOT call Google's private APIs. It only attempts a trusted keystroke.
 */
async function sendNativeVoiceDigit(webContents, digit) {
  if (!['1', '2'].includes(digit)) {
    return { ok: false, message: 'Only the screening shortcuts 1 and 2 are supported.' };
  }
  if (!webContents || webContents.isDestroyed?.()) {
    return { ok: false, message: 'Google Voice is not available.' };
  }
  const client = webContents.debugger;
  if (!client || client.isAttached()) {
    return { ok: false, message: 'Chrome debugging is already in use.' };
  }
  let attached = false;
  try {
    client.attach('1.3');
    attached = true;
    const keyCode = digit.charCodeAt(0);
    const event = {
      key: digit, code: `Digit${digit}`, windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode, modifiers: 0,
    };
    // Send keyDown once, then release it. Never issue an extra char event that could
    // result in duplicate DTMF or insert a character in an unrelated input field.
    await client.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', text: digit, unmodifiedText: digit, ...event,
    });
    await client.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...event });
    return { ok: true, message: `Sent keyboard digit ${digit} to Google Voice.` };
  } catch (error) {
    return { ok: false, message: `Native key dispatch unavailable: ${String(error?.message || error).slice(0, 130)}` };
  } finally {
    if (attached && client.isAttached()) {
      try { client.detach(); } catch { /* Page may have navigated during an active call. */ }
    }
  }
}

module.exports = { sendNativeVoiceDigit };

'use strict';

// These tests exercise the real keyboard transport. They cannot prove Google Voice's
// current keyboard handler accepts the digit during an authenticated screening call.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sendNativeVoiceDigit } = require('../src/utils/nativeDtmf');

function fakeWebContents({ alreadyAttached = false, failOn } = {}) {
  let attached = alreadyAttached;
  const events = [];
  const debuggerClient = {
    isAttached: () => attached,
    attach: (protocol) => { assert.equal(protocol, '1.3'); attached = true; events.push(['attach']); },
    detach: () => { attached = false; events.push(['detach']); },
    sendCommand: async (name, payload) => {
      events.push([name, payload]);
      if (payload.type === failOn) throw new Error('simulated CDP failure');
      return {};
    },
  };
  return { contents: { isDestroyed: () => false, debugger: debuggerClient }, events };
}

test('sends exactly one native Chromium keyDown and keyUp for screening digit 1', async () => {
  const fake = fakeWebContents();
  const result = await sendNativeVoiceDigit(fake.contents, '1');
  assert.equal(result.ok, true);
  assert.deepEqual(fake.events.map(item => item[0]), [
    'attach', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent', 'detach',
  ]);
  assert.equal(fake.events[1][1].type, 'keyDown');
  assert.equal(fake.events[1][1].text, '1');
  assert.equal(fake.events[1][1].code, 'Digit1');
  assert.equal(fake.events[2][1].type, 'keyUp');
  assert.equal(fake.events[2][1].key, '1');
});

test('sends screening digit 2 without bringing the main window forward', async () => {
  const fake = fakeWebContents();
  const result = await sendNativeVoiceDigit(fake.contents, '2');
  assert.equal(result.ok, true);
  assert.equal(fake.events[1][1].key, '2');
});

test('refuses unsupported digits or disconnected webContents', async () => {
  assert.equal((await sendNativeVoiceDigit(fakeWebContents().contents, '9')).ok, false);
  assert.equal((await sendNativeVoiceDigit(null, '1')).ok, false);
});

test('never interrupts an existing debugger session', async () => {
  const fake = fakeWebContents({ alreadyAttached: true });
  assert.equal((await sendNativeVoiceDigit(fake.contents, '1')).ok, false);
  assert.deepEqual(fake.events, []);
});

test('detaches debugger after a failed keypress to preserve normal Google Voice behavior', async () => {
  const fake = fakeWebContents({ failOn: 'keyDown' });
  assert.equal((await sendNativeVoiceDigit(fake.contents, '1')).ok, false);
  assert.equal(fake.events.at(-1)[0], 'detach');
});

test('mini-call window is unconditionally always-on-top, with no on/off preference', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  assert.match(main, /alwaysOnTop:\s*true/);
  assert.match(main, /setAlwaysOnTop\(true, 'floating'\)/);
  assert.doesNotMatch(main, /miniCallWindow\.setAlwaysOnTop\(top\)/);
});

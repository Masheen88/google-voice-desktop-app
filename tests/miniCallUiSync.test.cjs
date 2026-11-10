// Regression checks for the native window/Google Voice launcher boundary.
// These tests don't require a Google account or live phone call.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');

// The three control surfaces must call the same native toggle logic.
test('File menu, tray, and in-app launcher all toggle the same mini controller', () => {
  const main = src('main.js');
  const preload = src('preload.js');
  assert.match(main, /function toggleMiniCallController\(\)/);
  assert.match(main, /label: "Show mini call controller"/);
  assert.match(main, /id: "mini-call-toggle"/);
  assert.match(main, /ipcMain\.on\('mini-call-toggle-from-voice'/);
  assert.match(main, /isMainWindowSender\(event\) \|\| !isGoogleVoiceUrl\(event\.sender\.getURL\(\)\)/);
  assert.match(preload, /ipcRenderer\.send\('mini-call-toggle-from-voice'\)/);
  assert.match(preload, /mini-call-visibility/);
  assert.match(preload, /voice-desktop-mini-toggle/);
});

test('Minimizing the controller does not end or reset the active call', () => {
  const main = src('main.js');
  const hide = main.slice(main.indexOf('function hideMiniCallController()'), main.indexOf('async function toggleMiniCallController()'));
  assert.match(hide, /miniCallWindow\.hide\(\)/);
  assert.doesNotMatch(hide, /miniCallSetState\(/);
  assert.doesNotMatch(hide, /win\.hide\(/);
  assert.match(main, /setAlwaysOnTop\(true, 'floating'\)/);
});

test('UI is smaller and shows screening keys only while screening', () => {
  const main = src('main.js');
  const html = src('pages/mini-call.html');
  const js = src('pages/mini-call.js');
  assert.match(main, /if \(miniCallState\.phase === 'screening'\) return 274/);
  assert.match(html, /id="screening-section"[^>]*hidden/);
  assert.match(js, /\$\('screening-section'\)\.hidden = !isScreenedIncoming/);
  assert.match(js, /\$\('call-state'\)\.textContent/);
  assert.match(js, /\$\('mute'\)\.classList\.toggle\('is-muted'/);
});

test('State transitions are sourced from the Google Voice observer', () => {
  const preload = src('preload.js');
  const main = src('main.js');
  assert.match(preload, /miniCallSetPostAnswerHold\('active', snapshot, root\)/);
  assert.match(preload, /miniCallSetPostAnswerHold\('active', miniCallLastSnapshot, callPanel\)/);
  assert.match(preload, /if \(Date\.now\(\) - miniCallPostAnswerMissingSince >= 4000\) return \{ phase: 'idle' \}/);
  assert.match(main, /const changed = JSON\.stringify\(previous\) !== JSON\.stringify\(nextState\)/);
  assert.match(main, /if \(changed\) \{\s*miniCallResizeForPhase\(\);\s*miniCallSendState\(\)/);
});

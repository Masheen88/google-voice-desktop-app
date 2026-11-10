// Unit-level integration tests run the ACTUAL sandboxed preload detector against a mock DOM.
// They do not place live calls or depend on undocumented Google Voice endpoints.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8');

// The real preload schedules post-action diagnostic sampling. Unit tests must
// clean up those outstanding callbacks or the Node test runner stays alive after
// all assertions have passed (a v8 test-harness issue, not an application hang).
const outstandingTestTimers = new Set();
test.afterEach(() => {
  for (const timer of outstandingTestTimers) clearTimeout(timer);
  outstandingTestTimers.clear();
});
function testTimeout(callback, duration, ...args) {
  const timer = setTimeout(() => {
    outstandingTestTimers.delete(timer);
    callback(...args);
  }, duration);
  outstandingTestTimers.add(timer);
  return timer;
}
function clearTestTimeout(timer) {
  outstandingTestTimers.delete(timer);
  clearTimeout(timer);
}

class Node {
  constructor(name, attrs = {}, text = '', children = []) {
    this.tagName = name.toUpperCase();
    this.nodeType = 1;
    this.attrs = attrs;
    this.textContent = text;
    this.children = children;
    this.parentElement = null;
    this.isConnected = true;
    this.disabled = false;
    this.visible = true;
    this.clicks = 0;
    this.onClick = null;
    for (const child of children) child.parentElement = this;
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  get className() { return this.attrs.class || ''; }
  get innerText() { return this.textContent + ' ' + this.children.map((item) => item.innerText).join(' '); }
  getClientRects() { return this.visible ? [{}] : []; }
  getBoundingClientRect() { return { height: 240, width: 340 }; }
  matches(selector) {
    if (selector === '*') return true;
    if (selector === 'iframe') return this.tagName === 'IFRAME';
    // Correctly match comma-separated native Angular component selectors.
    // Earlier mocks returned false for gv-dialpad because they intercepted
    // selector strings containing gv-in-call-keypad before checking the tag.
    const selected = selector.split(',').map((item) => item.trim());
    if (selected.includes('gv-dialpad') && this.tagName === 'GV-DIALPAD') return true;
    if (selected.includes('gv-keypad') && this.tagName === 'GV-KEYPAD') return true;
    if (selected.includes('section.dialpad-container') && this.tagName === 'SECTION' &&
        this.className.includes('dialpad-container')) return true;
    // Real native in-call dialpad from the user's v6 diagnostic trace.
    if (selector.includes('section.dialpad-container') || selector.includes('gv-in-call-keypad') || selector.includes('gv-in-call-dialpad')) {
      return (this.tagName === 'SECTION' && this.className.includes('dialpad-container')) ||
        this.tagName === 'GV-IN-CALL-KEYPAD' || this.tagName === 'GV-IN-CALL-DIALPAD';
    }
    if (selector.includes('button') && (this.tagName === 'BUTTON' || this.attrs.role === 'button')) return true;
    if (selector.split(',').map((s) => s.trim()).includes('gv-in-call') && this.tagName === 'GV-IN-CALL') return true;
    if (selector.includes('gv-in-call-status') && this.tagName === 'GV-IN-CALL-STATUS') return true;
    if (selector.includes('gv-call-panel') && this.tagName === 'GV-CALL-PANEL') return true;
    if (selector.includes('gv-call-sidebar') && this.tagName === 'GV-CALL-SIDEBAR') return true;
    if (selector.includes('gv-make-call-panel') && (this.tagName === 'GV-MAKE-CALL-PANEL' || this.tagName === 'GV-MAKE-CALL-PANEL-NG2')) return true;
    if (selector.includes('gv-recipient-picker') && this.tagName === 'GV-RECIPIENT-PICKER') return true;
    if (selector === '[hidden], [inert], [aria-hidden="true"]') return false;
    // Support the additional accessible keypad controls introduced by the fix.
    if (selector.includes('[data-digit]') && (this.attrs['data-digit'] || this.attrs['data-key'])) return true;
    if (selector.includes('[class*="digit-button" i]') && this.className.includes('digit-button')) return true;
    if (selector.includes('[class*="keypad" i]') && this.className.includes('keypad')) return true;
    if (selector.includes('[class*="dialpad" i]') && this.className.includes('dialpad')) return true;
    if (selector.includes('gv-keypad') && this.tagName === 'GV-KEYPAD') return true;
    if (selector.includes('gv-dialpad') && this.tagName === 'GV-DIALPAD') return true;
    if (selector.includes('gv-call-panel') && selector.includes('[role="dialog"]')) {
      return this.attrs.role === 'dialog' || this.tagName.startsWith('GV-CALL') || this.tagName === 'GV-IN-CALL';
    }
    return false;
  }
  closest(selector) {
    for (let p = this; p; p = p.parentElement) if (p.matches(selector)) return p;
    return null;
  }
  querySelectorAll(selector) {
    const results = [];
    const visit = (node) => {
      for (const child of node.children) {
        if ((selector === 'button, [role="button"]' && child.tagName === 'BUTTON') ||
            child.matches(selector)) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }
  querySelector(selector) {
    const visit = (node) => {
      for (const child of node.children) {
        if (selector.includes('mat-icon') && child.tagName === 'MAT-ICON') return child;
        const inside = visit(child);
        if (inside) return inside;
      }
      return null;
    };
    return visit(this);
  }
  click() { this.clicks++; this.onClick?.(); }
}
const button = (label) => new Node('button', { 'aria-label': label }, label);

function loadPreload(root, origin = 'https://voice.google.com', options = {}) {
  const messages = [];
  const documentListeners = new Map();
  const document = {
    readyState: 'loading', documentElement: root,
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    addEventListener: (name, callback) => documentListeners.set(name, callback),
    elementFromPoint: options.elementFromPoint || (() => null),
  };
  const window = {
    location: { origin },
    innerHeight: 900,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    addEventListener: () => {},
  };
  const ipcRenderer = {
    send: (...args) => messages.push(args),
    on: () => {},
    // Simulate Electron's visibility gate without requiring a Windows desktop.
    invoke: async (channel) => channel === 'mini-call-input-context'
      ? options.inputContext || '' : '',
  };
  const sandbox = {
    require: (id) => {
      assert.equal(id, 'electron');
      return { ipcRenderer, webFrame: { executeJavaScript: async () => {} } };
    },
    console, window, document,
    setTimeout: testTimeout, clearTimeout: clearTestTimeout, setInterval: () => {},
    MutationObserver: class { observe() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\n;globalThis.testExports = { miniCallReadSnapshot, miniCallPerformAction, miniCallInstallObserver, miniCallControlDiagnostics, miniCallPrepareKeyboardTone, miniCallVerifiedActionKeys, miniCallDigitCandidates, miniCallInLiveKeypad, miniCallSurface, miniCallNativeDigitEvent, miniCallIsIdleDialerDigit, setDeliveryModeForTest: (mode) => { miniCallLastDeliveryMode = mode; } };', sandbox);
  return { detector: sandbox.testExports, messages, documentListeners, document };
}

function callPanel(...buttons) {
  return new Node('div', { role: 'dialog' }, 'Google Voice call', buttons);
}

// A message list, normal dialer, or web login must not cause a fake call popup.
test('ignores idle page and ordinary call history', () => {
  const root = new Node('body', {}, '', [new Node('div', {}, 'Recent calls', [button('Call'), button('Delete')])]);
  assert.equal(loadPreload(root).detector.miniCallReadSnapshot().phase, 'idle');
});

test('recognizes incoming call and native answer / decline buttons', () => {
  const root = new Node('body', {}, '', [callPanel(button('Answer call'), button('Decline call'))]);
  const state = loadPreload(root).detector.miniCallReadSnapshot();
  assert.equal(state.phase, 'incoming');
  assert.equal(state.canAnswer, true);
  assert.equal(state.canDecline, true);
  assert.equal(state.canKeypad, false);
});

test('does not treat an unrelated answer button as a call', () => {
  const root = new Node('body', {}, '', [new Node('div', {}, 'Quiz', [button('Answer')])]);
  assert.equal(loadPreload(root).detector.miniCallReadSnapshot().phase, 'idle');
});

test('recognizes outgoing calls when dialing is visible', () => {
  const root = new Node('body', {}, '', [new Node('gv-call-panel', {}, 'Calling…', [button('End call'), button('Keypad'), button('Mute')])]);
  const state = loadPreload(root).detector.miniCallReadSnapshot();
  assert.equal(state.phase, 'outgoing');
  assert.equal(state.canHangup, true);
  assert.equal(state.canMute, true);
  assert.equal(state.canKeypad, true);
});

test('recognizes call screening with a keypad', () => {
  const root = new Node('body', {}, '', [new Node('gv-call-panel', {}, 'Press 1 to accept, press 2 for voicemail', [button('End call'), button('Keypad')])]);
  assert.equal(loadPreload(root).detector.miniCallReadSnapshot().phase, 'screening');
});

test('uses Google Voice actual keypad digit 1 and leaves the native pad open', async () => {
  const one = button('1');
  const two = button('2');
  const digits = [one, two, ...'34567890'.split('').map(button)];
  for (const digit of digits) digit.visible = false;
  const keypad = button('Keypad');
  keypad.onClick = () => { for (const digit of digits) digit.visible = !digit.visible; };
  const root = new Node('body', {}, '', [new Node('gv-call-panel', {}, 'Press 1 to accept', [button('End call'), keypad, ...digits])]);
  const app = loadPreload(root);
  const outcome = await app.detector.miniCallPerformAction('tone-1');
  assert.equal(outcome.ok, true);
  assert.equal(one.clicks, 1);
  assert.equal(two.clicks, 0);
  assert.equal(keypad.clicks, 1); // Avoid a second click during Google's call transition.
  assert.equal(one.visible, true);
});

test('uses 2 for voicemail via native keypad', async () => {
  const digits = '1234567890'.split('').map(button);
  const keypad = button('Dial pad');
  const root = new Node('body', {}, '', [new Node('gv-call-panel', {}, 'Press 2 for voicemail', [button('End call'), keypad, ...digits])]);
  const app = loadPreload(root);
  const outcome = await app.detector.miniCallPerformAction('tone-2');
  assert.equal(outcome.ok, true);
  assert.equal(digits[1].clicks, 1);
  assert.equal(keypad.clicks, 0); // Keep the native keypad open if it was already open.
});

test('does not send screening DTMF while incoming call is unanswered', async () => {
  const root = new Node('body', {}, '', [callPanel(button('Answer'), button('Decline'), button('Keypad'))]);
  await assert.rejects(loadPreload(root).detector.miniCallPerformAction('tone-1'), /Click Answer first/);
});

test('does not send a digit if the in-call keypad cannot be found', async () => {
  const keypad = button('Keypad');
  const root = new Node('body', {}, '', [new Node('gv-call-panel', {}, '', [button('End call'), keypad])]);
  await assert.rejects(loadPreload(root).detector.miniCallPerformAction('tone-2'), /not verified as Google Voice/);
});

test('never detects call controls outside the Google Voice origin', () => {
  const root = new Node('body', {}, '', [callPanel(button('Answer call'), button('Decline call'))]);
  assert.equal(loadPreload(root, 'https://accounts.google.com').detector.miniCallReadSnapshot().phase, 'idle');
});

// Regression: answering can unmount BOTH native Answer and Hang Up while the spoken
// screening prompt plays. It must NOT be interpreted as a disconnected call.
test('keeps screening controller alive when Answer removes all native call buttons', async () => {
  const answer = button('Answer call');
  const panel = callPanel(answer, button('Decline call'));
  const root = new Node('body', {}, '', [panel]);
  const app = loadPreload(root);
  assert.equal(app.detector.miniCallReadSnapshot().phase, 'incoming');

  // Simulate Google Voice replacing its call UI immediately after Answer.
  answer.onClick = () => { panel.children = []; };
  const result = await app.detector.miniCallPerformAction('answer');
  assert.equal(result.ok, true);
  assert.equal(answer.clicks, 1);
  const screening = app.detector.miniCallReadSnapshot();
  assert.equal(screening.phase, 'screening');
  assert.equal(screening.awaitingScreening, true);
  assert.equal(screening.canAnswer, false);
  assert.equal(screening.canKeypad, false);
});

test('quick 1 works after Answer even when Google replaces the whole call surface', async () => {
  const answer = button('Answer call');
  const ringingPanel = callPanel(answer, button('Decline call'));
  const root = new Node('body', {}, '', [ringingPanel]);
  const app = loadPreload(root);
  await app.detector.miniCallPerformAction('answer');

  // Google's new screening UI contains a real in-call keypad but no Hang Up button.
  const keys = '1234567890'.split('').map(button);
  const newPanel = new Node('gv-call-panel', {}, 'Call screening', [button('Keypad'), ...keys]);
  root.children = [newPanel];
  newPanel.parentElement = root;
  ringingPanel.isConnected = false;
  const before = app.detector.miniCallReadSnapshot();
  assert.equal(before.phase, 'screening');
  assert.equal(before.canKeypad, true);

  const sent = await app.detector.miniCallPerformAction('tone-1');
  assert.equal(sent.ok, true);
  assert.equal(keys[0].clicks, 1);
  // v13 keeps the controller in sync with the actual native 1 press by leaving
  // screening after selecting the in-call key (remote audio remains unverified).
  assert.equal(app.detector.miniCallReadSnapshot().phase, 'active');
});

test('quick 2 clears the screening hold after sending native voicemail digit', async () => {
  const answer = button('Answer call');
  const panel = callPanel(answer, button('Decline call'));
  const root = new Node('body', {}, '', [panel]);
  const app = loadPreload(root);
  await app.detector.miniCallPerformAction('answer');
  const keys = '1234567890'.split('').map(button);
  panel.children = [button('Keypad'), ...keys];
  for (const child of panel.children) child.parentElement = panel;

  const result = await app.detector.miniCallPerformAction('tone-2');
  assert.equal(result.ok, true);
  assert.equal(keys[1].clicks, 1);
  panel.children = [];
  // Do not clear the screening hold until Google Voice actually ends the call.
  assert.equal(app.detector.miniCallReadSnapshot().phase, 'screening');
});

test('post-answer hold never sends digits on the unrelated idle dialer', async () => {
  const answer = button('Answer');
  const panel = callPanel(answer, button('Decline'));
  const root = new Node('body', {}, '', [panel]);
  const app = loadPreload(root);
  await app.detector.miniCallPerformAction('answer');
  panel.children = [];

  // The unrelated dialer contains all ten keys but is not a call surface.
  const dialerKeys = '1234567890'.split('').map(button);
  const idleDialer = new Node('div', {}, 'New call', [button('Keypad'), ...dialerKeys]);
  root.children.push(idleDialer);
  idleDialer.parentElement = root;
  await assert.rejects(app.detector.miniCallPerformAction('tone-1'), /Could not locate Google Voice’s active call panel/);
  assert.equal(dialerKeys[0].clicks, 0);
});


test('native Google Voice Answer click also keeps the mini controller open', () => {
  const answer = button('Answer call');
  const panel = callPanel(answer, button('Decline call'));
  const root = new Node('body', {}, '', [panel]);
  const app = loadPreload(root);
  app.detector.miniCallInstallObserver();
  assert.equal(app.detector.miniCallReadSnapshot().phase, 'incoming');
  app.documentListeners.get('click')({ target: answer });
  panel.children = [];
  assert.equal(app.detector.miniCallReadSnapshot().phase, 'screening');
});

// 2026 regression: Google Voice may render its call keypad as custom elements carrying
// numeric data attributes rather than native <button> labels.
test('clicks native non-button keypad digit using data-digit', async () => {
  const keys = '1234567890'.split('').map((digit) => new Node('div', { 'data-digit': digit }, ''));
  const panel = new Node('gv-call-panel', {}, 'Call connected', [button('End call'), ...keys]);
  const app = loadPreload(new Node('body', {}, '', [panel]));
  console.log('DEBUG',app.detector.miniCallDigitCandidates(panel).map(x=>x.getAttribute('data-digit')), app.detector.miniCallVerifiedActionKeys(panel,'1')?.length, app.detector.miniCallInLiveKeypad(keys[0]));
  const sent = await app.detector.miniCallPerformAction('tone-1');
  assert.equal(sent.ok, true);
  assert.equal(keys[0].clicks, 1);
  assert.equal(keys[1].clicks, 0);
});

test('finds keypad digits rendered in a detached portal after native toggle', async () => {
  const keypad = button('Show dialpad');
  const nativeDigits = '1234567890'.split('').map((d) => new Node('div', { 'data-key': d }, ''));
  const panel = new Node('gv-call-panel', {}, 'Call connected', [button('End call'), keypad]);
  const root = new Node('body', {}, '', [panel]);
  const unrelatedKeys = '1234567890'.split('').map(button);
  const sidebar = new Node('gv-call-sidebar', {}, '', unrelatedKeys);
  root.children.push(sidebar);
  sidebar.parentElement = root;
  keypad.onClick = () => {
    // The new digits are appended OUTSIDE the in-call panel, as with an overlay.
    const portal = new Node('div', { role: 'dialog', class: 'keypad-panel' }, 'In-call keypad', nativeDigits);
    root.children.push(portal);
    portal.parentElement = root;
  };
  const app = loadPreload(root);
  const result = await app.detector.miniCallPerformAction('tone-2');
  assert.equal(result.ok, true);
  assert.equal(nativeDigits[1].clicks, 1);
  assert.equal(unrelatedKeys[1].clicks, 0);
});

test('after keypad failure the native pad stays open for manual entry', async () => {
  const toggle = button('Keypad');
  const app = loadPreload(new Node('body', {}, '', [new Node('gv-call-panel', {}, 'Call connected', [button('End call'), toggle])]));
  await assert.rejects(app.detector.miniCallPerformAction('tone-1'), /not verified as Google Voice/);
  assert.equal(toggle.clicks, 1); // Do NOT toggle it closed after a failed lookup.
});

// Regression: Google Voice can expose call controls ONLY as Material icon glyph names
// rather than text or aria-label. The previous detector disabled Hang Up in that case.
test('detects and activates icon-only Hang Up and keypad controls', async () => {
  const end = new Node('button', {}, '', [new Node('mat-icon', {}, 'call_end')]);
  const pad = new Node('button', {}, '', [new Node('mat-icon', {}, 'dialpad')]);
  const panel = new Node('gv-call-panel', {}, 'On a call', [end, pad]);
  // A native End Call click removes the call controls when the call disconnects.
  end.onClick = () => { panel.children = []; };
  const app = loadPreload(new Node('body', {}, '', [panel]));
  const state = app.detector.miniCallReadSnapshot();
  assert.equal(state.canHangup, true);
  assert.equal(state.canKeypad, true);
  assert.equal((await app.detector.miniCallPerformAction('hangup')).ok, true);
  assert.equal(end.clicks, 1);
});

test('accepts keypad buttons with number/letter labels and spoken digit names', async () => {
  const digits = ['1', '2ABC', '3DEF', '4GHI', '5JKL', '6MNO', '7PQRS', '8TUV', '9WXYZ', 'zero']
    .map(button);
  const panel = new Node('gv-call-panel', {}, 'Connected', [button('End call'), ...digits]);
  const app = loadPreload(new Node('body', {}, '', [panel]));
  const answer = await app.detector.miniCallPerformAction('tone-2');
  assert.equal(answer.ok, true);
  assert.equal(digits[1].clicks, 1);
});

test('copied diagnostics contain generic actions but no caller names or numbers', () => {
  const panel = new Node('gv-call-panel', {}, 'Jane Contact 555-555-5555',
    [button('End call'), button('Keypad'), button('Jane Contact 555-555-5555')]);
  const app = loadPreload(new Node('body', {}, '', [panel]));
  const report = app.detector.miniCallControlDiagnostics();
  assert.match(report, /hangupAvailable=true/);
  assert.match(report, /End call/);
  assert.doesNotMatch(report, /Jane|555/);
});

// The keyboard route must not open Google's dialpad or act on the incoming call
// before the user has answered. The Electron main process supplies trusted input.
test('prepares native keyboard digits on an active call without opening the keypad', () => {
  const toggle = button('Keypad');
  const panel = new Node('gv-call-panel', {}, 'Connected', [button('End call'), toggle]);
  const app = loadPreload(new Node('body', {}, '', [panel]));
  assert.equal(app.detector.miniCallPrepareKeyboardTone().ok, true);
  assert.equal(toggle.clicks, 0);
});

test('refuses native keyboard digits before the original Answer action', () => {
  const panel = callPanel(button('Answer call'), button('Decline call'));
  const app = loadPreload(new Node('body', {}, '', [panel]));
  assert.throws(() => app.detector.miniCallPrepareKeyboardTone(), /Answer the incoming/);
});

test('allows native keyboard digits during the verified post-answer screening hold', async () => {
  const answer = button('Answer call');
  const panel = callPanel(answer, button('Decline call'));
  const root = new Node('body', {}, '', [panel]);
  const app = loadPreload(root);
  await app.detector.miniCallPerformAction('answer');
  panel.children = []; // Angular temporarily unmounts the call surface.
  assert.equal(app.detector.miniCallPrepareKeyboardTone().ok, true);
});

// Regression from live diagnostics: only four digits were discoverable on Google's
// current call UI. A verified freshly opened keypad does not require 5+ digits.
test('sends a screening 1 using a verified newly opened partial keypad', async () => {
  const toggle = button('Open keypad');
  const keys = ['0', '1', '2', '3'].map((digit) => button(`Digit ${digit}`));
  for (const key of keys) key.visible = false;
  const panel = new Node('gv-in-call', {}, 'Screening call', [button('End call'), toggle, ...keys]);
  toggle.onClick = () => {
    toggle.attrs['aria-label'] = 'Hide keypad';
    for (const key of keys) key.visible = true;
  };
  const app = loadPreload(new Node('body', {}, '', [panel]));
  assert.equal(app.detector.miniCallReadSnapshot().phase, 'screening');
  const result = await app.detector.miniCallPerformAction('tone-1');
  assert.equal(result.ok, true);
  assert.equal(toggle.clicks, 1);
  assert.equal(keys[1].clicks, 1);
  assert.equal(keys[2].clicks, 0);
});

test('sends a screening 2 when only four native keys are identifiable', async () => {
  const keys = ['0', '1', '2', '3'].map((digit) => button(`Key ${digit}`));
  const toggle = button('Hide keypad');
  const panel = new Node('gv-in-call', {}, 'Screening call', [button('End call'), toggle, ...keys]);
  const app = loadPreload(new Node('body', {}, '', [panel]));
  const result = await app.detector.miniCallPerformAction('tone-2');
  assert.equal(result.ok, true);
  assert.equal(keys[2].clicks, 1);
});

test('diagnostics describe recognized keypad digits without caller details', () => {
  const panel = new Node('gv-in-call', {}, 'Jenny Doe +1 (222) 333-4444',
    [button('End call'), button('Hide keypad'), button('Digit 1'), button('Digit 2')]);
  const report = loadPreload(new Node('body', {}, '', [panel])).detector.miniCallControlDiagnostics();
  assert.match(report, /keypadDigits=1,2/);
  assert.match(report, /keypadToggle=Hide keypad/);
  assert.doesNotMatch(report, /Jenny|222|333|4444/);
});

test('mini-call tone IPC avoids the unreliable keyboard-only DTMF route', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const tones = mainSource.slice(mainSource.indexOf("ipcMain.handle('mini-call-action'"), mainSource.indexOf("ipcMain.on('mini-call-action-result'"));
  assert.doesNotMatch(tones, /sendNativeVoiceDigit|dispatchKeyEvent/);
  assert.match(tones, /miniCallForwardAction\(action\)/);
  assert.match(tones, /mini-call-native-key-click/);
});

test('when both keypad toggles are visible, chooses the already open native keypad', async () => {
  const open = button('Open keypad');
  const hide = button('Hide keypad');
  const digits = ['0','1','2','3'].map((digit) => button(`Digit ${digit}`));
  const panel = new Node('gv-in-call', {}, 'Screening call',
    [button('End call'), open, hide, ...digits]);
  const app = loadPreload(new Node('body', {}, '', [panel]));
  const result = await app.detector.miniCallPerformAction('tone-1');
  assert.equal(result.ok, true);
  assert.equal(open.clicks, 0);
  assert.equal(digits[1].clicks, 1);
  assert.match(app.detector.miniCallControlDiagnostics(), /lastDigitAttempt=1: Google Voice DOM click dispatched \(unconfirmed\)/);
});

test('uses 1 from an already open keypad portal without clicking Hide keypad', async () => {
  const hide = button('Hide keypad');
  const panel = new Node('gv-in-call', {}, 'Screening call', [button('End call'), hide]);
  const keys = ['0','1','2','3'].map((digit) => button(`Digit ${digit}`));
  const portal = new Node('div', { role: 'dialog', class: 'keypad-panel' }, 'Keypad', keys);
  const app = loadPreload(new Node('body', {}, '', [panel, portal]));
  const result = await app.detector.miniCallPerformAction('tone-1');
  assert.equal(result.ok, true);
  assert.equal(hide.clicks, 0);
  assert.equal(keys[1].clicks, 1);
});

// Regression: Google Voice can render its in-call widget inside gv-call-sidebar.
// The old blanket sidebar exclusion rejected every one of its DTMF keys.
test('accepts live call keypad nested under the sidebar without selecting the idle dialer', async () => {
  const callKey = button('Digit 1');
  const callKey2 = button('Digit 2');
  const idleKey = button('Digit 1');
  const live = new Node('gv-in-call', {}, 'Screening call', [button('End call'), button('Hide keypad'), callKey, callKey2]);
  const root = new Node('body', {}, '', [
    new Node('gv-call-sidebar', {}, '', [
      new Node('gv-make-call-panel-ng2', {}, 'New call', [idleKey]),
      live,
    ]),
  ]);
  const app = loadPreload(root);
  const sent = await app.detector.miniCallPerformAction('tone-1');
  assert.equal(sent.ok, true);
  assert.equal(callKey.clicks, 1);
  assert.equal(idleKey.clicks, 0);
});

test('does not claim success when the keypad opens without revealing any digits', async () => {
  const open = button('Open keypad');
  const hide = button('Hide keypad');
  const panel = new Node('gv-in-call', {}, 'Screening call', [button('End call'), open, hide]);
  const app = loadPreload(new Node('body', {}, '', [panel]));
  await assert.rejects(app.detector.miniCallPerformAction('tone-1'), /not verified as Google Voice/);
  assert.equal(open.clicks, 0); // Hide is present, so the pad is already open.
  assert.equal(hide.clicks, 0);
  assert.match(app.detector.miniCallControlDiagnostics(), /lastDigitAttempt=1: rejected unverified numeric controls/);
});

test('finds a newly revealed digit inside an accessible same-origin iframe', async () => {
  const key1 = button('Digit 1');
  const key2 = button('Digit 2');
  key1.visible = false;
  key2.visible = false;
  const iframeRoot = new Node('div', { class: 'keypad-panel' }, '', [key1, key2]);
  const frame = new Node('iframe');
  frame.contentDocument = {
    nodeType: 9,
    querySelectorAll: (selector) => iframeRoot.querySelectorAll(selector),
  };
  frame.contentWindow = { location: { origin: 'https://voice.google.com' } };
  const keypad = button('Open keypad');
  keypad.onClick = () => { key1.visible = true; key2.visible = true; };
  const panel = new Node('gv-in-call', {}, 'Screening', [button('End call'), keypad]);
  const app = loadPreload(new Node('body', {}, '', [panel, frame]));
  const result = await app.detector.miniCallPerformAction('tone-1');
  assert.equal(result.ok, true);
  assert.equal(keypad.clicks, 1);
  assert.equal(key1.clicks, 1);
  assert.equal(key2.clicks, 0);
});

// Regression: live call control widgets can be siblings, not descendants of one call panel.
test('finds screening keypad toggle in sibling call-status component', async () => {
  const one = button('1');
  const two = button('2');
  const keys = [one, two, ...'34567890'.split('').map(button)];
  keys.forEach((key) => { key.visible = false; });
  const open = button('Open keypad');
  open.onClick = () => { keys.forEach((key) => { key.visible = true; }); };
  const call = new Node('gv-in-call', {}, '', [button('End call'), button('Mute call')]);
  const status = new Node('gv-in-call-status', {}, '', [open, ...keys]);
  const root = new Node('body', {}, '', [call, status]);
  const app = loadPreload(root);
  const response = await app.detector.miniCallPerformAction('tone-1');
  assert.equal(response.ok, true);
  assert.equal(open.clicks, 1);
  assert.equal(one.clicks, 1);
  assert.equal(two.clicks, 0);
  const diagnostics = app.detector.miniCallControlDiagnostics();
  assert.match(diagnostics, /action\.start: tone-1/);
  assert.match(diagnostics, /dtmf\.toggle/);
  assert.match(diagnostics, /dtmf\.target/);
  assert.match(diagnostics, /Recent call-control timeline/);
});

test('diagnostics show technical DOM ancestry but never caller text or phone-number attributes', async () => {
  const person = 'PRIVATE-CALLER-NEVER-COPY';
  const name = new Node('span', { id: person, title: person }, person);
  const call = new Node('gv-in-call', { class: 'gv-call-live' }, '', [name, button('End call'), button('Mute call')]);
  const root = new Node('body', {}, '', [call]);
  const app = loadPreload(root);
  const text = app.detector.miniCallControlDiagnostics();
  assert.match(text, /Control paths \(structural metadata only\)/);
  assert.match(text, /gv-in-call/);
  assert.doesNotMatch(text, /PRIVATE-CALLER/);
  assert.match(text, /frameAccess=none/);
});

test('failed digit lookup is preserved in diagnostics even when live controls disappear', async () => {
  const panel = new Node('gv-in-call', {}, '', [button('End call'), button('Mute call')]);
  const root = new Node('body', {}, '', [panel]);
  const app = loadPreload(root);
  await assert.rejects(app.detector.miniCallPerformAction('tone-2'), /not available yet/);
  const text = app.detector.miniCallControlDiagnostics();
  assert.match(text, /dtmf\.waitToggle/);
  assert.match(text, /dtmf\.failure/);
  assert.match(text, /no active call keypad toggle/);
});

// The user's live v4 diagnostics saw only incidental 0/1 leaves. The former
// detector would send an unconfirmed click to one of those instead of DTMF.
test('rejects isolated 0 and 1 when the real in-call 2 key is missing', async () => {
  const zero = button('0');
  const one = button('1');
  const panel = new Node('gv-in-call', {}, 'Screening call', [button('End call'), button('Hide keypad'), zero, one]);
  const app = loadPreload(new Node('body', {}, '', [panel]));
  await assert.rejects(app.detector.miniCallPerformAction('tone-1'), /not verified as Google Voice/);
  assert.equal(one.clicks, 0);
  assert.equal(zero.clicks, 0);
  const diagnostic = app.detector.miniCallControlDiagnostics();
  assert.match(diagnostic, /verifiedKeypad1=false/);
  assert.match(diagnostic, /lastDigitAttempt=1: rejected unverified numeric controls/);
});

// A real manual click teaches the exact live in-call key path; unlike 0/1
// numeric leaves, this route is grounded in a working user interaction.
test('learns native 1 route from a trusted manual keypad click and reuses it', async () => {
  const answer = button('Answer call');
  const panel = new Node('gv-in-call', {}, 'Incoming call', [answer, button('Decline call')]);
  const app = loadPreload(new Node('body', {}, '', [panel]));
  await app.detector.miniCallPerformAction('answer');
  const zero = button('0');
  const one = button('1');
  panel.children = [button('End call'), button('Hide keypad'), new Node('gv-keypad', {}, '', [zero, one])];
  for (const child of panel.children) child.parentElement = panel;
  app.detector.miniCallNativeDigitEvent({ isTrusted: true, composedPath: () => [one, panel.children[2], panel], target: one });
  assert.equal(app.messages.some(([name, data]) => name === 'mini-call-learned-native-digit' && data.digit === '1'), true);
  const outcome = await app.detector.miniCallPerformAction('tone-1');
  assert.equal(outcome.ok, true);
  assert.equal(one.clicks, 1);
  assert.equal(zero.clicks, 0);
  assert.match(app.detector.miniCallControlDiagnostics(), /learnedNativeDigits=1/);
});

// A strong regression fixture based on the user's real v4 diagnostics: the ordinary
// dialer lives under gv-in-call > gv-make-call-panel > gv-dialpad while idle.
test('excludes ordinary gv-make-call-panel keys even when nested under gv-in-call', () => {
  const one = button('1');
  const two = button('2');
  const standardDialer = new Node('gv-make-call-panel', {}, '', [new Node('gv-dialpad', {}, '', [one, two])]);
  const callHost = new Node('gv-in-call', {}, '', [standardDialer]);
  const app = loadPreload(new Node('body', {}, '', [callHost]));
  assert.equal(app.detector.miniCallIsIdleDialerDigit(one), true);
  assert.equal(app.detector.miniCallDigitCandidates(callHost).includes(one), false);
  assert.equal(app.detector.miniCallReadSnapshot().phase, 'idle');
});

test('v8 diagnostics identify running build and distinguish native from ordinary dialpads', () => {
  const root = new Node('body', {}, '', [new Node('gv-call-panel', {}, 'Call connected', [button('End call'), button('Keypad')])]);
  const report = loadPreload(root).detector.miniCallControlDiagnostics();
  assert.match(report, /mini call diagnostics v12/);
  assert.match(report, /controllerBuild=2026-11-09-v12-paint-hit-fallback/);
  assert.match(report, /manualKeyCapture=none/);
  assert.match(report, /dialpadComponents=/);
});

// Live v6 report: section.dialpad-container inside gv-in-call had exactly 12
// native buttons, but Google exposed a readable digit for only "1". Target the
// verified grid's FIRST and SECOND buttons instead of unrelated numeric leaves.
// This fixture mirrors the observed user path exactly:
// gv-dialpad>section[0]>div[1]>div[0]>div[0]>button[0] for the trusted 1 key.
function liveVoiceGrid(firstLabel = '1') {
  const keys = Array.from({ length: 12 }, (_, index) => button(index === 0 ? firstLabel : ''));
  const rows = Array.from({ length: 4 }, (_, row) => new Node('div', {}, '',
    Array.from({ length: 3 }, (_, col) => new Node('div', {}, '', [keys[row * 3 + col]]))));
  const grid = new Node('gv-dialpad', {}, '', [new Node('section', {}, '', [
    new Node('div', {}, ''), new Node('div', {}, '', rows),
  ])]);
  const section = new Node('section', { class: 'dialpad-container' }, '', [grid]);
  return { keys, grid, section };
}

test('v8 uses verified 1 under gv-dialpad and its adjacent 2 button without requiring every key labelled', async () => {
  const { keys, section } = liveVoiceGrid('1');
  const active = new Node('gv-in-call', {}, 'Screening call', [button('End call'), button('Hide keypad'), section]);
  const app = loadPreload(new Node('body', {}, '', [active]));
  assert.equal(app.detector.miniCallReadSnapshot().phase, 'screening');
  const one = await app.detector.miniCallPerformAction('tone-1');
  const two = await app.detector.miniCallPerformAction('tone-2');
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.equal(keys[0].clicks, 1);
  assert.equal(keys[1].clicks, 1);
  assert.equal(keys[2].clicks, 0);
  const report = app.detector.miniCallControlDiagnostics();
  assert.match(report, /nativeGrid1=true/);
  assert.match(report, /nativeGrid2=true/);
  assert.match(report, /native-explicit-label/);
  assert.match(report, /native-sibling-of-confirmed-one/);
});

test('v7 does not use a 12-button ordinary make-call dialpad as screening input', async () => {
  const keys = Array.from({length: 12}, (_, index) => button(index === 0 ? '1' : ''));
  const ordinary = new Node('gv-make-call-panel', {}, '', [new Node('section', { class: 'dialpad-container' }, '', keys)]);
  const active = new Node('gv-in-call', {}, 'Screening call', [button('End call'), button('Hide keypad'), ordinary]);
  const app = loadPreload(new Node('body', {}, '', [active]));
  assert.match(app.detector.miniCallControlDiagnostics(), /nativeGrid1=false/);
  await assert.rejects(app.detector.miniCallPerformAction('tone-1'), /not verified as Google Voice/);
  assert.equal(keys[0].clicks, 0);
});

test('v7 rejects a 12-button pad whose recognized labels contradict telephone order', async () => {
  const keys = Array.from({length: 12}, (_, index) => button(index === 0 ? '7' : ''));
  const active = new Node('gv-in-call', {}, 'Screening call', [button('End call'), button('Hide keypad'),
    new Node('section', { class: 'dialpad-container' }, '', keys)]);
  const app = loadPreload(new Node('body', {}, '', [active]));
  assert.match(app.detector.miniCallControlDiagnostics(), /nativeGrid1=false/);
  await assert.rejects(app.detector.miniCallPerformAction('tone-1'), /not verified as Google Voice/);
  assert.equal(keys[0].clicks, 0);
});

test('v8 learns a manual 1 from gv-dialpad and reuses that exact route for later screening', async () => {
  const answer = button('Answer call');
  const active = new Node('gv-in-call', {}, 'Incoming call', [answer, button('Decline call')]);
  const app = loadPreload(new Node('body', {}, '', [active]));
  await app.detector.miniCallPerformAction('answer');
  const { keys, section } = liveVoiceGrid('1');
  active.children = [button('End call'), button('Hide keypad'), section];
  for (const node of active.children) node.parentElement = active;
  const target = keys[0];
  app.detector.miniCallNativeDigitEvent({ isTrusted: true,
    composedPath: () => [target, target.parentElement, target.parentElement.parentElement, section, active], target });
  assert.equal(app.messages.some(([event, hint]) => event === 'mini-call-learned-native-digit' && hint.digit === '1'), true);
  const report = app.detector.miniCallControlDiagnostics();
  assert.match(report, /manualKeyCapture=1: learned gv-dialpad depth=5/);
  assert.match(report, /learnedRouteResolved1=true/);
  const one = await app.detector.miniCallPerformAction('tone-1');
  assert.equal(one.ok, true);
  assert.equal(keys[0].clicks, 1);
  assert.match(app.detector.miniCallControlDiagnostics(), /mode=learned-native-route/);
});

test('v8 reuses manually captured real 1 when its accessible label disappears', async () => {
  const active = new Node('gv-in-call', {}, 'Incoming call', [button('Answer call'), button('Decline call')]);
  const app = loadPreload(new Node('body', {}, '', [active]));
  await app.detector.miniCallPerformAction('answer');
  const { keys, section } = liveVoiceGrid('1');
  active.children = [button('End call'), button('Hide keypad'), section];
  for (const node of active.children) node.parentElement = active;
  app.detector.miniCallNativeDigitEvent({ isTrusted: true,
    composedPath: () => [keys[0], section, active], target: keys[0] });
  // Angular re-renders can expose the same working button without digit text.
  keys[0].attrs['aria-label'] = '';
  keys[0].textContent = '';
  assert.match(app.detector.miniCallControlDiagnostics(), /nativeGrid1=false/);
  assert.match(app.detector.miniCallControlDiagnostics(), /learnedRouteResolved1=true/);
  const outcome = await app.detector.miniCallPerformAction('tone-1');
  assert.equal(outcome.ok, true);
  assert.equal(keys[0].clicks, 1);
});

test('v8 rejects stale trusted routes when a button now identifies a different digit', async () => {
  const active = new Node('gv-in-call', {}, 'Incoming call', [button('Answer call'), button('Decline call')]);
  const app = loadPreload(new Node('body', {}, '', [active]));
  await app.detector.miniCallPerformAction('answer');
  const { keys, section } = liveVoiceGrid('1');
  active.children = [button('End call'), button('Hide keypad'), section];
  for (const node of active.children) node.parentElement = active;
  app.detector.miniCallNativeDigitEvent({ isTrusted: true,
    composedPath: () => [keys[0], section, active], target: keys[0] });
  // A label contradiction prevents an old route from sending the wrong DTMF.
  keys[0].attrs['aria-label'] = '7';
  keys[0].textContent = '7';
  assert.match(app.detector.miniCallControlDiagnostics(), /learnedRouteResolved1=false/);
  await assert.rejects(app.detector.miniCallPerformAction('tone-1'), /not verified as Google Voice/);
  assert.equal(keys[0].clicks, 0);
});

test('v8 never reuses a learned gv-dialpad route in the ordinary make-call dialer', async () => {
  const answer = button('Answer call');
  const active = new Node('gv-in-call', {}, 'Incoming call', [answer, button('Decline call')]);
  const app = loadPreload(new Node('body', {}, '', [active]));
  await app.detector.miniCallPerformAction('answer');
  const { keys, section } = liveVoiceGrid('1');
  active.children = [button('End call'), button('Hide keypad'), section];
  for (const node of active.children) node.parentElement = active;
  app.detector.miniCallNativeDigitEvent({ isTrusted: true,
    composedPath: () => [keys[0], section, active], target: keys[0] });
  const ordinary = new Node('gv-make-call-panel', {}, '', [section]);
  active.children = [button('End call'), button('Hide keypad'), ordinary];
  for (const node of active.children) node.parentElement = active;
  const report = app.detector.miniCallControlDiagnostics();
  assert.match(report, /learnedRouteResolved1=false/);
  assert.match(report, /nativeGrid1=false/);
  await assert.rejects(app.detector.miniCallPerformAction('tone-1'), /not verified as Google Voice/);
  assert.equal(keys[0].clicks, 0);
});

test('v7 retries End Call automatically once if the first click only closes keypad', async () => {
  const end = button('End call');
  const panel = new Node('gv-in-call', {}, 'Screening call', [end, button('Hide keypad')]);
  const app = loadPreload(new Node('body', {}, '', [panel]));
  end.onClick = () => { if (end.clicks === 2) panel.children = []; };
  const result = await app.detector.miniCallPerformAction('hangup');
  assert.equal(result.ok, true);
  assert.equal(end.clicks, 2);
  assert.match(app.detector.miniCallControlDiagnostics(), /lastHangupAttempt=call controls disappeared after retry/);
});

test('v7 only needs one End Call click when native Google Voice disconnects immediately', async () => {
  const end = button('End call');
  const panel = new Node('gv-in-call', {}, 'Screening call', [end]);
  end.onClick = () => { panel.children = []; };
  const app = loadPreload(new Node('body', {}, '', [panel]));
  const result = await app.detector.miniCallPerformAction('hangup');
  assert.equal(result.ok, true);
  assert.equal(end.clicks, 1);
});

// Regression for the user's v8 report: the verified native 12-button in-call
// keypad exists even when the main Google Voice window is minimized to tray.
// Chromium's pointer compositor isn't painted there, so invoke the in-page
// Angular button handler instead of accepting a no-op CDP mouse dispatch.
test('v9 hidden main window clicks exactly one verified in-call 1 without showing the window', async () => {
  const { keys, section } = liveVoiceGrid('1');
  const active = new Node('gv-in-call', {}, 'Screening call', [button('End call'), button('Hide keypad'), section]);
  const context = { interactive: false, visible: false, minimized: true, focused: false };
  const app = loadPreload(new Node('body', {}, '', [active]), 'https://voice.google.com', { inputContext: context });
  const result = await app.detector.miniCallPerformAction('tone-1');
  assert.equal(result.ok, true);
  assert.equal(keys[0].clicks, 1);
  assert.equal(keys[1].clicks, 0);
  assert.match(result.message, /background DOM click dispatched/);
  assert.match(app.detector.miniCallControlDiagnostics(), /mainWindowAtLastDigit=visible=false minimized=true focused=false/);
  assert.match(app.detector.miniCallControlDiagnostics(), /inputTransport=background DOM click/);
});

test('v9 hidden main window selects native 2 and never ordinary outgoing keypad', async () => {
  const { keys, section } = liveVoiceGrid('1');
  const ordinaryKeys = Array.from({ length: 12 }, (_, index) => button(index === 0 ? '1' : ''));
  const ordinary = new Node('gv-make-call-panel', {}, '', [new Node('gv-dialpad', {}, '', ordinaryKeys)]);
  const active = new Node('gv-in-call', {}, 'Screening call', [button('End call'), button('Hide keypad'), section, ordinary]);
  const context = { interactive: false, visible: false, minimized: false, focused: false };
  const app = loadPreload(new Node('body', {}, '', [active]), 'https://voice.google.com', { inputContext: context });
  const result = await app.detector.miniCallPerformAction('tone-2');
  assert.equal(result.ok, true);
  assert.equal(keys[1].clicks, 1);
  assert.equal(keys[0].clicks, 0);
  assert.equal(ordinaryKeys.reduce((acc, node) => acc + node.clicks, 0), 0);
});

test('v9 maintains original on-screen digit behavior when main Google Voice is visible', async () => {
  const { keys, section } = liveVoiceGrid('1');
  const active = new Node('gv-in-call', {}, 'Screening call', [button('End call'), button('Hide keypad'), section]);
  const context = { interactive: true, visible: true, minimized: false, focused: false };
  const app = loadPreload(new Node('body', {}, '', [active]), 'https://voice.google.com', { inputContext: context });
  const result = await app.detector.miniCallPerformAction('tone-1');
  assert.equal(result.ok, true);
  assert.equal(keys[0].clicks, 1);
  assert.match(app.detector.miniCallControlDiagnostics(), /mainWindowAtLastDigit=visible=true minimized=false focused=false/);
});

test('v9 Electron main exposes input visibility only to the authenticated Voice preload', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('mini-call-input-context'/);
  assert.match(main, /isMainWindowSender\(event\).*isGoogleVoiceUrl/);
  assert.match(main, /reason: 'background-window'/);
  assert.match(main, /backgroundThrottling: false/);
});

// Live v11 regression: a painted, tray-hidden Google Voice window located the
// real native 1 button but elementFromPoint saw a surrounding section instead.
// The v12 fallback must click exactly the verified button, never the section.
test('v12 painted background hit-test obstruction activates exactly the verified native 1', async () => {
  const { keys, section } = liveVoiceGrid('1');
  const active = new Node('gv-in-call', {}, 'Screening call', [button('End call'), button('Hide keypad'), section]);
  const app = loadPreload(new Node('body', {}, '', [active]), 'https://voice.google.com', {
    inputContext: { interactive: true, visible: true, minimized: false, focused: false },
    elementFromPoint: () => section,
  });
  keys[0].ownerDocument = app.document;
  keys[0].getBoundingClientRect = () => ({ x: 20, y: 30, width: 60, height: 55 });
  app.detector.setDeliveryModeForTest('onscreen-translucent');
  const result = await app.detector.miniCallPerformAction('tone-1');
  assert.equal(result.ok, true);
  assert.equal(keys[0].clicks, 1);
  assert.equal(keys[1].clicks, 0);
  const report = app.detector.miniCallControlDiagnostics();
  assert.match(report, /lastHitTest=blocked-by-section/);
  assert.match(report, /paintedNativeClickFallbacks=1/);
  assert.match(report, /inputTransport=painted native in-page click/);
});

test('v12 painted fallback targets native 2 and never an ordinary dialer', async () => {
  const { keys, section } = liveVoiceGrid('1');
  const ordinaryKeys = Array.from({ length: 12 }, (_, index) => button(index === 0 ? '1' : ''));
  const ordinary = new Node('gv-make-call-panel', {}, '', [new Node('gv-dialpad', {}, '', ordinaryKeys)]);
  const active = new Node('gv-in-call', {}, 'Screening call', [button('End call'), button('Hide keypad'), section, ordinary]);
  const app = loadPreload(new Node('body', {}, '', [active]), 'https://voice.google.com', {
    inputContext: { interactive: true, visible: true, minimized: false, focused: false },
    elementFromPoint: () => section,
  });
  keys[1].ownerDocument = app.document;
  keys[1].getBoundingClientRect = () => ({ x: 85, y: 30, width: 60, height: 55 });
  app.detector.setDeliveryModeForTest('onscreen-translucent');
  const result = await app.detector.miniCallPerformAction('tone-2');
  assert.equal(result.ok, true);
  assert.equal(keys[1].clicks, 1);
  assert.equal(keys[0].clicks, 0);
  assert.equal(ordinaryKeys.reduce((total, b) => total + b.clicks, 0), 0);
});

test('v12 direct visible-window hit-test obstruction never clicks another element', async () => {
  const { keys, section } = liveVoiceGrid('1');
  const active = new Node('gv-in-call', {}, 'Screening call', [button('End call'), button('Hide keypad'), section]);
  const app = loadPreload(new Node('body', {}, '', [active]), 'https://voice.google.com', {
    inputContext: { interactive: true, visible: true, minimized: false, focused: false },
    elementFromPoint: () => section,
  });
  keys[0].ownerDocument = app.document;
  keys[0].getBoundingClientRect = () => ({ x: 20, y: 30, width: 60, height: 55 });
  app.detector.setDeliveryModeForTest('direct');
  await assert.rejects(app.detector.miniCallPerformAction('tone-1'), /obscures Google Voice/);
  assert.equal(keys[0].clicks, 0);
  assert.equal(keys[1].clicks, 0);
});

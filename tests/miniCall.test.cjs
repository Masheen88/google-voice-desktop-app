// Unit-level integration tests run the ACTUAL sandboxed preload detector against a mock DOM.
// They do not place live calls or depend on undocumented Google Voice endpoints.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8');

class Node {
  constructor(name, attrs = {}, text = '', children = []) {
    this.tagName = name.toUpperCase();
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
    if (selector === 'button, [role="button"]') return this.tagName === 'BUTTON' || this.attrs.role === 'button';
    if (selector === '[hidden], [inert], [aria-hidden="true"]') return false;
    // Support the additional accessible keypad controls introduced by the fix.
    if (selector.includes('[data-digit]') && (this.attrs['data-digit'] || this.attrs['data-key'])) return true;
    if (selector.includes('[class*="digit-button" i]') && this.className.includes('digit-button')) return true;
    if (selector.includes('gv-call-panel') && selector.includes('[role="dialog"]')) {
      return this.attrs.role === 'dialog' || this.tagName.startsWith('GV-CALL');
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

function loadPreload(root, origin = 'https://voice.google.com') {
  const messages = [];
  const documentListeners = new Map();
  const document = {
    readyState: 'loading', documentElement: root,
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    addEventListener: (name, callback) => documentListeners.set(name, callback),
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
    invoke: async () => '',
  };
  const sandbox = {
    require: (id) => {
      assert.equal(id, 'electron');
      return { ipcRenderer, webFrame: { executeJavaScript: async () => {} } };
    },
    console, window, document,
    setTimeout, clearTimeout, setInterval: () => {},
    MutationObserver: class { observe() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(source + '\n;globalThis.testExports = { miniCallReadSnapshot, miniCallPerformAction, miniCallInstallObserver, miniCallControlDiagnostics };', sandbox);
  return { detector: sandbox.testExports, messages, documentListeners };
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
  await assert.rejects(loadPreload(root).detector.miniCallPerformAction('tone-2'), /Could not identify the in-call 2 key/);
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
  assert.equal(app.detector.miniCallReadSnapshot().phase, 'idle');
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
    const portal = new Node('div', { role: 'dialog' }, 'In-call keypad', nativeDigits);
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
  await assert.rejects(app.detector.miniCallPerformAction('tone-1'), /native keypad is open/);
  assert.equal(toggle.clicks, 1); // Do NOT toggle it closed after a failed lookup.
});

// Regression: Google Voice can expose call controls ONLY as Material icon glyph names
// rather than text or aria-label. The previous detector disabled Hang Up in that case.
test('detects and activates icon-only Hang Up and keypad controls', async () => {
  const end = new Node('button', {}, '', [new Node('mat-icon', {}, 'call_end')]);
  const pad = new Node('button', {}, '', [new Node('mat-icon', {}, 'dialpad')]);
  const panel = new Node('gv-call-panel', {}, 'On a call', [end, pad]);
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

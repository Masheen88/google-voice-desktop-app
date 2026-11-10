'use strict';

// Unit tests for the real main-process background call transport.
// These verify window state management, not Google's live DTMF acknowledgement.
const test = require('node:test');
const assert = require('node:assert/strict');
const { findOffscreenBounds, findPaintedBounds, withRenderedCallWindow } = require('../src/utils/renderedCallWindow');

function mockVoiceWindow({ visible = false, minimized = false, focused = false, maximized = false } = {}) {
  const events = [];
  let state = { visible, minimized, focused, maximized, opacity: 1,
    bounds: { x: 100, y: 150, width: 1200, height: 900 }, skipTaskbar: false };
  const send = (action, value) => events.push([action, value]);
  const win = {
    isDestroyed: () => false,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isFocused: () => state.focused,
    isMaximized: () => state.maximized,
    getOpacity: () => state.opacity,
    getBounds: () => ({ ...state.bounds }),
    setBounds(bounds) { send('setBounds', bounds); state.bounds = { ...bounds }; },
    setOpacity(value) { send('setOpacity', value); state.opacity = value; },
    setSkipTaskbar(value) { send('setSkipTaskbar', value); state.skipTaskbar = value; },
    showInactive() { send('showInactive'); state.visible = true; state.minimized = false; },
    restore() { send('restore'); state.minimized = false; state.visible = true; },
    minimize() { send('minimize'); state.minimized = true; state.visible = false; },
    hide() { send('hide'); state.visible = false; },
    unmaximize() { send('unmaximize'); state.maximized = false; },
    maximize() { send('maximize'); state.maximized = true; state.visible = true; },
  };
  return { win, events, getState: () => state };
}

const displays = [
  { bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
  { bounds: { x: 0, y: 0, width: 2560, height: 1440 } },
];
const instant = async () => {};

test('chooses an offscreen location left of every monitor', () => {
  const bounds = findOffscreenBounds({ x: 200, y: 250, width: 1200, height: 900 }, displays);
  assert.ok(bounds.x + bounds.width < -1920);
  assert.equal(bounds.width, 1200);
});

test('hidden tray window is rendered translucent on screen without focus then returned to tray', async () => {
  const mock = mockVoiceWindow();
  const parking = [];
  const result = await withRenderedCallWindow({ window: mock.win, displays,
    platform: 'win32', wait: instant,
    onParkingChanged: (state) => parking.push(state),
    action: async ({ mode, parked }) => {
      assert.equal(mode, 'onscreen-translucent');
      assert.equal(parked, true);
      assert.equal(mock.getState().visible, true);
      assert.equal(mock.getState().minimized, false);
      assert.equal(mock.getState().focused, false);
      assert.ok(mock.getState().bounds.x >= -1920);
      assert.equal(mock.getState().opacity, 0.04);
      assert.equal(mock.getState().skipTaskbar, true);
      return { ok: true };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(parking, [true, false]);
  assert.equal(mock.getState().visible, false);
  assert.deepEqual(mock.getState().bounds, { x: 100, y: 150, width: 1200, height: 900 });
  assert.equal(mock.getState().skipTaskbar, false);
  assert.equal(mock.getState().opacity, 1);
  assert.ok(mock.events.some(([name]) => name === 'showInactive'));
});

test('minimized window is restored translucently on screen then minimized again', async () => {
  const mock = mockVoiceWindow({ visible: false, minimized: true });
  await withRenderedCallWindow({ window: mock.win, displays, platform: 'win32', wait: instant,
    action: async () => ({ ok: true }),
  });
  assert.equal(mock.getState().minimized, true);
  assert.equal(mock.getState().visible, false);
  assert.equal(mock.getState().opacity, 1);
  assert.equal(mock.events.filter(([name]) => name === 'restore').length, 1);
  const opacityEvents = mock.events.filter(([name]) => name === 'setOpacity');
  assert.equal(opacityEvents[0][1], 0);
  assert.equal(opacityEvents.at(-1)[1], 1);
});

test('visible Voice window is never moved, hidden, or refocused', async () => {
  const mock = mockVoiceWindow({ visible: true, focused: false });
  await withRenderedCallWindow({ window: mock.win, displays, platform: 'win32', wait: instant,
    action: async ({ mode }) => { assert.equal(mode, 'direct'); return { ok: true }; },
  });
  assert.deepEqual(mock.events, []);
});

test('always restores the transparent window if a DTMF action throws', async () => {
  const mock = mockVoiceWindow();
  await assert.rejects(withRenderedCallWindow({ window: mock.win, displays,
    platform: 'win32', wait: instant,
    action: async () => { throw new Error('native pointer failed'); },
  }), /native pointer failed/);
  assert.equal(mock.getState().visible, false);
  assert.equal(mock.getState().skipTaskbar, false);
});

test('fails closed if operating system repositions temporary Voice window completely off-screen', async () => {
  const mock = mockVoiceWindow();
  const originalSetBounds = mock.win.setBounds;
  mock.win.setBounds = function (bounds) {
    originalSetBounds.call(mock.win, bounds.x === 100 && bounds.y === 150 ? { ...bounds, x: -4000 } : bounds);
  };
  let invoked = false;
  await assert.rejects(withRenderedCallWindow({ window: mock.win, displays,
    platform: 'win32', wait: instant,
    action: async () => { invoked = true; return { ok: true }; },
  }), /could not place the transparent Voice window/);
  assert.equal(invoked, false);
  assert.equal(mock.getState().visible, false);
  assert.equal(mock.getState().skipTaskbar, false);
});

test('does not park Voice on platforms where showInactive cannot be guaranteed', async () => {
  const mock = mockVoiceWindow();
  await withRenderedCallWindow({ window: mock.win, displays, platform: 'linux', wait: instant,
    action: async ({ mode }) => { assert.equal(mode, 'direct'); return { ok: true }; },
  });
  assert.deepEqual(mock.events, []);
});


test('Electron routes both screening digits through the window-render transport', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8');
  assert.match(source, /action === 'tone-1' \|\| action === 'tone-2'/);
  assert.match(source, /withRenderedCallWindow\(\{/);
  assert.match(source, /Main-process window delivery timeline/);
  assert.match(renderer, /mini call diagnostics v12/);
  assert.match(renderer, /lastDeliveryMode=/);
});


test('painted bounds preserve dimensions but constrain hidden Voice window to a real display', () => {
  const target = findPaintedBounds({ x: -12000, y: 400, width: 1200, height: 900 }, displays);
  assert.equal(target.width, 1200);
  assert.equal(target.height, 900);
  assert.equal(target.x, -1920);
});

test('main process prepends transport history before long renderer DOM diagnostics', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/main.js'), 'utf8');
  assert.match(source, /mainReport \+ result\.diagnostics/);
  assert.match(source, /Recent 1\/2 attempts/);
  assert.match(source, /miniCallDeliveryAttempts/);
  assert.match(source, /mode=\$\{item\.transport\}/);
});

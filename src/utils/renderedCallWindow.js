'use strict';

// v11: Voice needs a painted in-call keypad to deliver DTMF. A fully offscreen
// window may be culled by the Windows compositor, even though Electron reports
// it as visible. Briefly show the SAME authenticated window at low opacity on a
// real display; never create a second Google Voice session or use private APIs.
// This is experimental and does not guarantee that the remote call receives DTMF.
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function findOffscreenBounds(bounds, displays) {
  // Retained for backwards compatibility with v10 diagnostics/tests and tooling.
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
    throw new Error('Voice window bounds are unavailable.');
  }
  const valid = Array.isArray(displays) ? displays.filter((item) =>
    Number.isFinite(item?.bounds?.x) && Number.isFinite(item.bounds.width)) : [];
  if (!valid.length) throw new Error('Cannot determine where to park the Voice window.');
  return { x: Math.min(...valid.map((item) => item.bounds.x)) - bounds.width - 160,
    y: bounds.y, width: bounds.width, height: bounds.height };
}

function findPaintedBounds(bounds, displays) {
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
    throw new Error('Voice window bounds are unavailable.');
  }
  const valid = Array.isArray(displays) ? displays.map((item) => item?.workArea || item?.bounds)
    .filter((area) => area && [area.x, area.y, area.width, area.height].every(Number.isFinite)) : [];
  if (!valid.length) throw new Error('Cannot determine a display for the Voice window.');

  // Preserve the existing dimensions: resizing may cause Google's Angular
  // call sidebar to switch layouts and invalidate a previously verified key.
  const width = Math.max(320, Math.trunc(bounds.width));
  const height = Math.max(240, Math.trunc(bounds.height));
  const overlap = (area) => Math.max(0, Math.min(bounds.x + width, area.x + area.width) - Math.max(bounds.x, area.x)) *
    Math.max(0, Math.min(bounds.y + height, area.y + area.height) - Math.max(bounds.y, area.y));
  const area = [...valid].sort((a, b) => overlap(b) - overlap(a))[0];
  const x = Math.max(area.x, Math.min(Math.trunc(bounds.x), area.x + Math.max(0, area.width - width)));
  const y = Math.max(area.y, Math.min(Math.trunc(bounds.y), area.y + Math.max(0, area.height - height)));
  return { x, y, width, height };
}

function intersectsDisplay(bounds, displays) {
  return (Array.isArray(displays) ? displays : []).some((display) => {
    const area = display?.workArea || display?.bounds;
    return !!area && Math.min(bounds.x + bounds.width, area.x + area.width) > Math.max(bounds.x, area.x) + 100 &&
      Math.min(bounds.y + bounds.height, area.y + area.height) > Math.max(bounds.y, area.y) + 100;
  });
}

/**
 * Run a screening-digit request against a painted Chromium window on Windows.
 * Its 4% opacity makes it nearly invisible but may briefly tint or intercept
 * desktop input. The mini controller remains always on top; no focus is taken.
 * It restores the original window state in finally, even after an error.
 */
async function withRenderedCallWindow({ window, displays, platform = process.platform,
  action, wait = delay, trace = () => {}, onParkingChanged = () => {} }) {
  if (!window || window.isDestroyed?.()) throw new Error('Google Voice window is closed.');
  if (typeof action !== 'function') throw new TypeError('Call action must be a function.');
  const previous = {
    visible: Boolean(window.isVisible()), minimized: Boolean(window.isMinimized()),
    focused: Boolean(window.isFocused?.()), maximized: Boolean(window.isMaximized?.()),
    opacity: typeof window.getOpacity === 'function' ? window.getOpacity() : 1,
    bounds: { ...window.getBounds() },
  };
  trace('initial', `visible=${previous.visible} minimized=${previous.minimized} focused=${previous.focused}`);
  if (platform !== 'win32' || (previous.visible && !previous.minimized)) {
    trace('direct', platform === 'win32' ? 'already-visible' : 'other-platform');
    return action({ mode: 'direct', parked: false });
  }
  if (typeof window.setOpacity !== 'function') {
    throw new Error('Transparent background call input is unavailable on this system.');
  }

  const target = findPaintedBounds(previous.bounds, displays);
  let started = false;
  let skipTaskbar = false;
  onParkingChanged(true);
  try {
    // Make all changes while the window is still hidden; avoid flashing the
    // full Google Voice page during the minimized -> restored transition.
    if (previous.maximized) window.unmaximize();
    window.setOpacity(0);
    if (previous.minimized) window.restore();
    window.setBounds(target);
    window.setSkipTaskbar(true);
    skipTaskbar = true;
    window.setOpacity(0.04);
    window.showInactive();
    started = true;
    await wait(500);
    if (!window.isVisible() || window.isMinimized()) {
      throw new Error('Voice did not become compositor-visible for in-call keypad input.');
    }
    if (!intersectsDisplay(window.getBounds(), displays)) {
      throw new Error('Windows could not place the transparent Voice window on a display.');
    }
    trace('painted', 'onscreen-translucent');
    const result = await action({ mode: 'onscreen-translucent', parked: true });
    // Allow the native click handler an opportunity to enqueue DTMF before hiding.
    await wait(850);
    trace('action-result', result?.ok ? 'dispatched-unconfirmed' : 'failed');
    return result;
  } finally {
    try {
      if (!window.isDestroyed?.()) {
        // Restore visibility and geometry before removing the reduced opacity.
        // Minimized state is restored while the window remains transparent.
        window.setOpacity(0);
        if (previous.minimized) window.minimize();
        else window.hide();
        window.setBounds(previous.bounds);
        if (previous.maximized && !previous.minimized) {
          window.maximize();
          if (!previous.visible) window.hide();
        }
        window.setOpacity(previous.opacity);
        if (skipTaskbar) window.setSkipTaskbar(false);
        trace('restored', previous.minimized ? 'minimized' : 'tray-hidden');
      }
    } finally {
      onParkingChanged(false);
      if (!started) trace('aborted', 'renderer-not-ready');
    }
  }
}

module.exports = { findOffscreenBounds, findPaintedBounds, intersectsDisplay, withRenderedCallWindow };

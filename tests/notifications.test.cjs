const { test } = require('node:test');
const assert = require('node:assert/strict');
const { attachAuth } = require('../src/auth');

function guest() {
  const wc = {
    session: {
      webRequest: { onBeforeSendHeaders(filter, listener) { wc.handler = filter === null ? null : listener; } },
      setPermissionCheckHandler(handler) { wc.checkHandler = handler; },
      setPermissionRequestHandler(handler) { wc.requestHandler = handler; }
    },
    on(event, listener) { wc.login = listener; },
    removeListener() { wc.removed = true; },
    isDestroyed() { return false; }
  };
  return wc;
}

test('embedded webview is denied native notifications on check and request', () => {
  const wc = guest();
  const detach = attachAuth(wc, { serverUrl: 'http://localhost:4096', basicAuth: false }, () => {});
  assert.equal(wc.checkHandler(null, 'notifications', 'http://localhost:4096'), false);
  let requested;
  wc.requestHandler(null, 'notifications', (granted) => { requested = granted; });
  assert.equal(requested, false);
  detach();
});

test('non-notification permissions keep Electron defaults', () => {
  const wc = guest();
  const detach = attachAuth(wc, { serverUrl: 'http://localhost:4096', basicAuth: false }, () => {});
  for (const permission of ['clipboard-sanitized-write', 'fullscreen', 'media', 'geolocation', 'openExternal']) {
    assert.equal(wc.checkHandler(null, permission, 'http://localhost:4096'), true);
    let granted;
    wc.requestHandler(null, permission, (value) => { granted = value; });
    assert.equal(granted, true);
  }
  assert.equal(wc.checkHandler(null, 'deprecated-sync-clipboard-read', 'http://localhost:4096'), false);
  detach();
});

test('detaching removes both permission handlers', () => {
  const wc = guest();
  const detach = attachAuth(wc, { serverUrl: 'http://localhost:4096', basicAuth: false }, () => {});
  assert.equal(typeof wc.checkHandler, 'function');
  assert.equal(typeof wc.requestHandler, 'function');
  detach();
  assert.equal(wc.checkHandler, null);
  assert.equal(wc.requestHandler, null);
  assert.equal(wc.removed, true);
});

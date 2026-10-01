const { test } = require('node:test');
const assert = require('node:assert/strict');
const { attachAuth } = require('../src/auth');

function guest() {
  const wc = {
    session: { webRequest: { onBeforeSendHeaders(filter, listener) { wc.handler = filter === null ? null : listener; } } },
    on(event, listener) { wc.login = listener; },
    removeListener() { wc.removed = true; },
    isDestroyed() { return false; }
  };
  return wc;
}
test('cold HTTP, assets and API use scoped Basic Auth, foreign redirects do not', () => {
  const wc = guest();
  const detach = attachAuth(wc, { serverUrl: 'https://example.com/oc', basicAuth: true, username: 'user', password: 'test' }, () => {});
  for (const url of ['https://example.com/oc/', 'https://example.com/oc/assets/main.js', 'https://example.com/oc/global/health']) {
    wc.handler({ url, requestHeaders: { authorization: 'stale' } }, (result) => {
      assert.equal(result.requestHeaders.Authorization, 'Basic dXNlcjp0ZXN0');
      assert.equal(result.requestHeaders.authorization, undefined);
    });
  }
  for (const url of ['https://example.com/sibling', 'https://evil.example/']) {
    wc.handler({ url, requestHeaders: { Authorization: 'stale' } }, (result) => assert.equal(result.requestHeaders.Authorization, undefined));
  }
  detach(); assert.equal(wc.handler, null); assert.equal(wc.removed, true);
});
test('no auth injects no credentials and rejected auth is not retried indefinitely', () => {
  const wc = guest();
  const reports = [];
  attachAuth(wc, { serverUrl: 'http://localhost:4096', basicAuth: false }, (msg) => reports.push(msg));
  wc.handler({ url: 'http://localhost:4096/', requestHeaders: {} }, (result) => assert.deepEqual(result.requestHeaders, {}));
  let args;
  wc.login({ preventDefault() {} }, { url: 'http://localhost:4096/' }, { isProxy: false }, (...values) => args = values);
  assert.deepEqual(args, []); assert.equal(reports.length, 1);
});

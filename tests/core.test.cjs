const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serverUrl, authHeaders, inServerScope, partitionKey, loadSettings, sessionUrl, readerUrl, sessionIdFromUrl } = require('../src/core');

test('HTTP/HTTPS with reverse-proxy paths, never credentials or unsupported schemes', () => {
  assert.equal(serverUrl('https://example.com/tools/opencode/'), 'https://example.com/tools/opencode');
  for (const bad of ['file:///tmp/a', 'javascript:alert(1)', 'http://user:secret@example.com', 'http://example.com/?token=x']) {
    assert.throws(() => serverUrl(bad));
  }
});
test('no auth by default, optional UTF-8 Basic Auth', () => {
  assert.deepEqual(authHeaders({}), {});
  assert.deepEqual(authHeaders({ basicAuth: true, username: 'opencode', password: 'test' }), { Authorization: 'Basic b3BlbmNvZGU6dGVzdA==' });
  assert.throws(() => authHeaders({ basicAuth: true, username: 'u:v', password: 'test' }));
});
test('auth stays in exact server origin and path, not redirects or proxy siblings', () => {
  const base = 'https://example.com/oc';
  assert.equal(inServerScope('https://example.com/oc/assets/a.js', base), true);
  for (const url of ['https://evil.example/oc', 'http://example.com/oc', 'https://example.com/oc-other', 'https://example.com/private']) {
    assert.equal(inServerScope(url, base), false);
  }
});
test('partitions distinguish same-named vaults, servers and auth modes', () => {
  const s = { serverUrl: 'http://localhost:4096' };
  const a = partitionKey('/a/vault', s);
  assert.notEqual(a, partitionKey('/b/vault', s));
  assert.notEqual(a, partitionKey('/a/vault', { ...s, serverUrl: 'https://example.com' }));
  assert.notEqual(a, partitionKey('/a/vault', { ...s, basicAuth: true }));
  assert.equal(a, partitionKey('/a/vault', s));
});
test('settings accept known public fields only, have no private-machine defaults', () => {
  const a = loadSettings({ secretPath: 'private', directory: '/project/a' });
  const b = loadSettings({ directory: '/project/b' });
  assert.equal(a.secretPath, undefined);
  assert.equal(a.basicAuth, false);
  assert.equal(a.directory, '/project/a'); assert.equal(b.directory, '/project/b');
  assert.equal(a.tuiLauncher, '');
  assert.equal(loadSettings({ tuiLauncher: 'C:/OpenCode/start.cmd' }).tuiLauncher, 'C:/OpenCode/start.cmd');
});
test('session route includes the encoded server, including custom subpaths', () => {
  const base = 'https://example.com/oc';
  const result = sessionUrl(base, 'ses_test');
  assert.ok(result.startsWith(base + '/server/'));
  assert.ok(result.endsWith('/session/ses_test'));
});
test('reader defaults to the original local address and accepts a custom base', () => {
  assert.equal(loadSettings({}).readerBase, 'http://127.0.0.1:18924');
  assert.equal(readerUrl(loadSettings({}).readerBase, 'ses_test123'), 'http://127.0.0.1:18924/read/ses_test123');
  assert.equal(readerUrl('https://reader.example/custom/', 'ses_test123'), 'https://reader.example/custom/read/ses_test123');
  assert.throws(() => readerUrl('http://localhost:18924', '../wrong'));
  assert.throws(() => readerUrl('http://user:secret@localhost:18924', 'ses_test123'));
});
test('current session comes from the page path, never draft IDs or query text', () => {
  assert.equal(sessionIdFromUrl('http://localhost:4096/server/serverId/session/ses_current123'), 'ses_current123');
  assert.equal(sessionIdFromUrl('http://localhost:4096/new-session?session=ses_old123'), '');
  assert.equal(sessionIdFromUrl('about:blank'), '');
});
test('project memory is enabled per vault without inventing an initial project', () => {
  assert.equal(loadSettings({}).rememberProjects, true);
  assert.deepEqual(loadSettings({}).projectMemory, {});
  assert.equal(loadSettings({ rememberProjects: false }).rememberProjects, false);
});

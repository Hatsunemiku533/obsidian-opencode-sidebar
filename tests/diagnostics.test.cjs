const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { DiagnosticLog, errorSummary, scrub, navigationSummary, classifySnapshot, attachNetworkDiagnostics } = require('../src/diagnostics');
const { safeErrorSummary } = require('../src/error-summary');
const { pageSnapshot, installPageDiagnostics } = require('../src/page-diagnostics');

test('logs survive a new instance, redact credentials, and never include raw bodies or URLs', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-diagnostics-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const secret = 'private-secret-123'; const basic = Buffer.from('user:' + secret).toString('base64');
  const log = new DiagnosticLog('/test/vault', () => [secret, basic], { directory });
  log.write('first', { password: secret, body: 'private conversation', url: 'http://user:' + secret + '@example.com/?token=hidden', info: 'Basic ' + basic, error: errorSummary(new TypeError('arbitrary private conversation ' + secret)) });
  const next = new DiagnosticLog('/test/vault', () => [secret, basic], { directory });
  next.write('second');
  const text = next.copy();
  for (const forbidden of [secret, basic, 'private conversation', 'example.com', 'token=hidden']) assert.equal(text.includes(forbidden), false);
  assert(text.includes('first')); assert(text.includes('second')); assert(text.includes('TypeError'));
});
test('logs rotate, remain bounded, and fall back to memory when disk fails', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-log-rotate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = new DiagnosticLog('/test/vault', () => [], { directory, limit: 400 });
  for (let n = 0; n < 12; n++) log.write('snapshot', { number: n });
  assert(fs.existsSync(log.file + '.1')); assert(fs.statSync(log.file).size <= 400);
  const blocker = path.join(directory, 'not-a-directory'); fs.writeFileSync(blocker, 'test');
  const broken = new DiagnosticLog('/test/vault', () => [], { directory: blocker });
  broken.write('memory-record'); assert(broken.diskError); assert(broken.copy().includes('memory-record'));
});
test('a mid-session rotation failure still copies new memory-only records beside old disk history', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-log-contention-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = new DiagnosticLog('/test/vault', () => [], { directory, limit: 200 });
  log.write('persisted-before');
  fs.writeFileSync(log.file + '.rotation.lock', 'other window');
  log.write('memory-only', { info: 'x'.repeat(180) });
  assert(log.diskError); assert(log.copy().includes('persisted-before')); assert(log.copy().includes('memory-only'));
  fs.unlinkSync(log.file + '.rotation.lock');
  log.write('recovered');
  assert.equal(log.diskError, null); assert(log.copy().includes('memory-only'));
});
test('technical error categories and script line numbers survive without message content', () => {
  const error = new Error('Settings context must be used within a context provider; private content');
  error.stack = 'Error: private content\n at http://user:secret@localhost:4096/assets/index-abc.js:1503:8165';
  const summary = errorSummary(error);
  assert.equal(summary.kind, 'context-provider'); assert.equal(summary.context, 'Settings');
  assert.deepEqual(summary.frames, [{ file: 'index-abc.js', line: 1503, column: 8165 }]);
  assert.equal(JSON.stringify(summary).includes('private content'), false);
  assert.equal(JSON.stringify(summary).includes('secret'), false);
  assert.equal(scrub(summary).context, 'Settings');
  assert.equal(safeErrorSummary({ kind: 'content-security-policy', name: 'Error', text: 'private' }).kind, 'content-security-policy');
});
test('navigation records credential presence and route without recording the URL/session/query', () => {
  const result = navigationSummary('http://user:secret@localhost:4096/session/ses_private?token=hidden', 'http://localhost:4096');
  assert.equal(result.credentialsPresent, true); assert.equal(result.route, 'session');
  const text = JSON.stringify(result); assert(!text.includes('secret')); assert(!text.includes('ses_private')); assert(!text.includes('hidden'));
});
test('snapshot separates API health from empty DOM, resource faults, auth and renderer failure', () => {
  assert.equal(classifySnapshot({ health: { ok: true }, page: { ready: false } }).category, 'blank-page');
  assert.equal(classifySnapshot({ health: { ok: true }, documentStatus: 401 }).category, 'authentication');
  assert.equal(classifySnapshot({ documentStatus: 404 }).category, 'document-http');
  assert.equal(classifySnapshot({ navigation: { credentialsPresent: true } }).category, 'credential-url');
  assert.equal(classifySnapshot({ rendererGone: true }).category, 'renderer');
  assert.equal(classifySnapshot({ health: { ok: false } }).category, 'server-connection');
  assert.equal(classifySnapshot({ health: { ok: true }, resources: [{ resource: 'script', status: 404 }] }).category, 'static-resources');
  assert.equal(classifySnapshot({ page: { errorPage: true } }).category, 'frontend');
  assert.equal(classifySnapshot({ page: { ready: true, runtimeError: { kind: 'fetch-failed' } } }).category, 'ready-with-recent-error');
});
test('page probe never treats a quoted error in a reply as an application error', () => {
  const dom = new JSDOM('<div id="root"><div data-component="markdown"><h1>出了点问题</h1><button>重启</button><p>private conversation</p></div></div>');
  const snapshot = pageSnapshot(dom.window);
  assert.equal(snapshot.errorPage, false); assert.equal(snapshot.ready, true);
  assert(!JSON.stringify(snapshot).includes('private conversation'));
  dom.window.document.body.innerHTML = '<div id="root"><section><div><h1>出了点问题</h1><pre>Language context must be used within a context provider</pre></div><button>重启</button></section></div>';
  const actual = pageSnapshot(dom.window);
  assert.equal(actual.errorPage, true); assert.equal(actual.pageError.context, 'Language');
  dom.window.close();
});
test('runtime hooks install once, debounce repeats and exclude ResizeObserver noise', () => {
  const dom = new JSDOM('<div id="root"></div>');
  const records = []; dom.window.console.warn = (...args) => records.push(args);
  installPageDiagnostics(dom.window); installPageDiagnostics(dom.window);
  const error = new Error('Settings context must be used within a context provider');
  for (let n = 0; n < 3; n++) dom.window.dispatchEvent(new dom.window.ErrorEvent('error', { error }));
  dom.window.dispatchEvent(new dom.window.ErrorEvent('error', { message: 'ResizeObserver loop limit exceeded' }));
  assert.equal(records.length, 1); assert.equal(pageSnapshot(dom.window).runtimeError.context, 'Settings');
  dom.window.__ocSidebarLastErrorAt = Date.now() - 61000;
  assert.equal(pageSnapshot(dom.window).runtimeError, undefined);
  dom.window.close();
});
test('network hooks capture only technical resource failures in scope and detach independently', () => {
  const callbacks = {}; const records = [];
  const wc = { isDestroyed: () => false, session: { webRequest: {
    onCompleted(filter, callback) { callbacks.completed = filter === null ? null : callback; },
    onErrorOccurred(filter, callback) { callbacks.failed = filter === null ? null : callback; }
  } } };
  const detach = attachNetworkDiagnostics(wc, { serverUrl: 'https://example.com/oc' }, (event, record) => records.push({ event, record }));
  callbacks.completed({ url: 'https://example.com/oc/assets/index-abc.js?token=private', resourceType: 'script', statusCode: 404 });
  callbacks.failed({ url: 'https://example.com/oc/assets/style.css', resourceType: 'stylesheet', error: 'net::ERR_CONNECTION_REFUSED' });
  callbacks.completed({ url: 'https://elsewhere.example/private', resourceType: 'script', statusCode: 404 });
  callbacks.failed({ url: 'https://example.com/oc/', resourceType: 'mainFrame', error: 'net::ERR_ABORTED' });
  assert.equal(records.length, 2); assert.equal(records[0].record.asset, 'index-abc.js');
  assert(!JSON.stringify(records).includes('token=private'));
  detach(); assert.equal(callbacks.completed, null); assert.equal(callbacks.failed, null);
});

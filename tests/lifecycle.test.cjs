const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function setup(overrides = {}) {
  const dom = new JSDOM('<div id="embed"></div>');
  const opened = [];
  const notices = [];
  class Base {}
  class Notice { constructor(message) { notices.push(message); } }
  const mod = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8') + '\nmodule.exports.ViewForTest = SidebarView;';
  const context = {
    module: mod, document: dom.window.document, window: { open: (...args) => opened.push(args) }, DIAGNOSTIC_SCRIPT: '', PROJECT_SCRIPT: '', Buffer, URL, process, setTimeout, clearTimeout, setInterval, clearInterval,
    require(name) {
      if (name in overrides) return overrides[name];
      if (name === 'obsidian') return { Plugin: Base, ItemView: Base, Notice, Setting: Base, PluginSettingTab: Base, SuggestModal: Base, Modal: Base, Menu: Base };
      return name.startsWith('.') ? require(path.join(__dirname, '../src', name)) : require(name);
    }
  };
  vm.runInNewContext(source, context);
  const plugin = { settings: { serverUrl: 'http://localhost:4096', basicAuth: false, mathFixes: false }, vaultPath: '/a/vault' };
  const view = new mod.exports.ViewForTest({}, plugin);
  view.contentEl = { empty() {} };
  view.embedEl = dom.window.document.getElementById('embed');
  view.setStatus = (kind, message) => { view.status = { kind, message }; };
  return { dom, view, opened, notices, PluginClass: mod.exports };
}

test('partition, src and listeners are set before webview is attached; 401 uses frame event', () => {
  const { dom, view } = setup();
  const append = view.embedEl.appendChild.bind(view.embedEl);
  view.embedEl.appendChild = node => {
    assert.match(node.getAttribute('partition'), /^opencode-sidebar-/);
    assert.equal(node.getAttribute('src'), 'about:blank');
    assert.equal(node.isConnected, false);
    return append(node);
  };
  view.createEmbed();
  const frame = new dom.window.Event('did-frame-navigate');
  frame.isMainFrame = true; frame.httpResponseCode = 401;
  view.webview.dispatchEvent(frame);
  assert.equal(view.mainStatus, 401); assert.equal(view.status.kind, 'err');
  view.onClose(); dom.window.close();
});
test('rejected async inspection from an old view cannot change a replacement status', async () => {
  const { dom, view } = setup();
  let reject;
  const old = { executeJavaScript: () => new Promise((resolve, failure) => reject = failure) };
  view.webview = old;
  const pending = view.probeReady(old);
  view.webview = { remove() {} }; view.status = { kind: 'ok', message: 'new connection' };
  reject(Error('disposed')); await pending;
  assert.equal(view.status.message, 'new connection');
  view.onClose(); dom.window.close();
});
test('reader button opens the live session, including after native UI switches it', async () => {
  const { dom, view, opened } = setup();
  view.plugin.settings.readerBase = 'http://127.0.0.1:18924';
  let current = 'http://localhost:4096/server/test/session/ses_first123';
  view.webview = { getURL: () => current, remove() {} };
  await view.openRead();
  current = 'http://localhost:4096/server/test/session/ses_second456';
  await view.openRead();
  assert.equal(opened[0][0], 'http://127.0.0.1:18924/read/ses_first123');
  assert.equal(opened[1][0], 'http://127.0.0.1:18924/read/ses_second456');
  assert.equal(opened[1][1], '_blank');
  view.onClose(); dom.window.close();
});
test('a stale view probe cannot cancel the replacement view poll timer', async () => {
  const { dom, view } = setup();
  view.webview = { remove() {} };
  let fired = false;
  view.readyTimer = setTimeout(() => { fired = true; }, 10);
  await view.probeReady({});
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(fired, true);
  view.onClose(); dom.window.close();
});
test('page inspection timeout is bounded and identified by a diagnostic code', async () => {
  const { dom, view } = setup();
  await assert.rejects(view.inspectPage({ executeJavaScript: () => new Promise(() => {}) }, 5), (error) => error.code === 'ERR_DIAGNOSTIC_TIMEOUT');
  view.onClose(); dom.window.close();
});
test('a disposed remote hook cannot prevent the webview from being cleaned up', () => {
  const { dom, view } = setup();
  let removed = false;
  view.webview = { remove() { removed = true; } };
  view.detachNetwork = () => { throw Error('Remote object already destroyed.'); };
  view.detachAuth = () => {};
  view.disposeEmbed();
  assert.equal(removed, true); assert.equal(view.detachNetwork, null); assert.equal(view.webview, null);
  view.onClose(); dom.window.close();
});
test('TUI action uses the configured local launcher, not a shell-supplied web URL', () => {
  const launches = [];
  const { dom, view, PluginClass } = setup({
    'node:fs': { existsSync: file => file.endsWith('start.cmd'), statSync: () => ({ isFile: () => true }) },
    'node:child_process': { spawn: (...args) => { launches.push(args); return { on() {}, unref() {} }; } }
  });
  const launcher = 'C:\\tools\\start.cmd';
  view.plugin.settings.tuiLauncher = launcher;
  view.plugin.settings.serverUrl = 'https://example.test';
  PluginClass.prototype.launchTUI.call(view.plugin);
  assert.equal(launches.length, 1);
  assert.equal(launches[0][0], 'cmd.exe');
  assert.equal(launches[0][1][3], `start "" "${launcher}"`);
  assert.equal(launches[0][2].cwd, 'C:\\tools');
  assert.equal(launches[0][2].windowsVerbatimArguments, true);
  dom.window.close();
});
test('TUI reports the launcher exit instead of treating process creation as a successful connection', () => {
  const handlers = {};
  const { dom, view, notices, PluginClass } = setup({
    'node:fs': { existsSync: () => true, statSync: () => ({ isFile: () => true }) },
    'node:child_process': { spawn: () => ({ on(event, callback) { handlers[event] = callback; }, unref() {} }) }
  });
  view.plugin.settings.tuiLauncher = 'C:\\tools\\start.cmd';
  PluginClass.prototype.launchTUI.call(view.plugin);
  assert.equal(notices.length, 0);
  handlers.exit(1, null);
  assert.match(notices[0], /失败/);
  notices.length = 0;
  PluginClass.prototype.launchTUI.call(view.plugin);
  handlers.exit(0, null);
  assert.match(notices[0], /启动脚本已打开/);
  notices.length = 0;
  PluginClass.prototype.launchTUI.call(view.plugin);
  handlers.error(Error('spawn failed')); handlers.exit(1, null);
  assert.equal(notices.length, 1);
  dom.window.close();
});
test('real Windows TUI launch executes a batch file with Unicode and spaces in its path', { skip: process.platform !== 'win32' }, async () => {
  const folder = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'oc-tui-test-'));
  const dir = path.join(folder, '中文 空格'); fs.mkdirSync(dir);
  const launcher = path.join(dir, 'start.cmd');
  const marker = path.join(dir, 'opened.marker');
  fs.writeFileSync(launcher, '@echo off\r\n> "%~dp0opened.marker" echo launched\r\nexit 0\r\n');
  const { dom, view, notices, PluginClass } = setup();
  try {
    view.plugin.settings.tuiLauncher = launcher;
    PluginClass.prototype.launchTUI.call(view.plugin);
    for (let n = 0; n < 100 && (!fs.existsSync(marker) || !notices.length); n++) await new Promise(resolve => setTimeout(resolve, 100));
    assert(fs.existsSync(marker), 'The real start command must actually run the batch file');
    assert.match(fs.readFileSync(marker, 'utf8'), /launched/);
    assert.match(notices[0], /启动脚本已打开/);
  } finally { dom.window.close(); fs.rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});
test('the toolbar follows native session navigation but ignores a stale title response', async () => {
  const responses = [];
  const { dom, view } = setup({ './api': { apiGet: () => new Promise(resolve => responses.push(resolve)) } });
  const current = { remove() {} };
  view.webview = current;
  view.sessionButton = { textContent: '选择会话' };
  const first = view.updateSessionTitle(current, 'http://localhost:4096/server/test/session/ses_first123');
  const second = view.updateSessionTitle(current, 'http://localhost:4096/server/test/session/ses_second456');
  responses[1]({ title: '最新会话' }); await second;
  responses[0]({ title: '旧会话' }); await first;
  assert.equal(view.sessionButton.textContent, '最新会话');
  view.updateSessionTitle(current, 'http://localhost:4096/');
  assert.equal(view.sessionButton.textContent, '选择会话');
  view.onClose(); dom.window.close();
});
test('old project capture cannot overwrite a replacement view or a disabled memory setting', async () => {
  const { dom, view } = setup();
  const { partitionKey } = require('../src/core');
  const id = partitionKey(view.plugin.vaultPath, view.plugin.settings);
  const memory = { identity: id, scope: 'local', projects: [{ worktree: '/selected' }], selectedDirectory: '/selected' };
  let resolve; let saves = 0;
  view.plugin.settings.rememberProjects = true; view.plugin.saveSettings = async () => { saves++; };
  view.projectIdentity = id; view.projectMonitorReady = true;
  const current = { executeJavaScript: () => new Promise(done => { resolve = done; }), remove() {} };
  view.webview = current;
  const first = view.captureProjects(current);
  view.webview = { remove() {} }; resolve(memory); await first;
  assert.equal(saves, 0);
  view.webview = current;
  const second = view.captureProjects(current);
  view.plugin.settings.rememberProjects = false; resolve(memory); await second;
  assert.equal(saves, 0);
  await view.onClose(); dom.window.close();
});
test('closing flushes the latest project choice and unchanged polling does not repeatedly save', async () => {
  const { dom, view } = setup();
  const { partitionKey } = require('../src/core');
  view.plugin.settings.rememberProjects = true;
  view.projectIdentity = partitionKey(view.plugin.vaultPath, view.plugin.settings); view.projectMonitorReady = true;
  let selected = '/first'; let saves = 0;
  view.plugin.saveSettings = async () => { saves++; };
  view.webview = { remove() {}, executeJavaScript: async () => ({ identity: view.projectIdentity, scope: 'local', projects: [{ worktree: selected }], selectedDirectory: selected }) };
  await view.captureProjects(); await view.captureProjects(); assert.equal(saves, 1);
  selected = '/last';
  await view.onClose();
  assert.equal(view.plugin.settings.projectMemory.selectedDirectory, '/last'); assert.equal(saves, 2); assert.equal(view.webview, null);
  dom.window.close();
});
test('remembered directories register a guest page script without an Obsidian-blocked preload', async () => {
  const { dom, view } = setup();
  const { partitionKey } = require('../src/core');
  const id = partitionKey(view.plugin.vaultPath, view.plugin.settings);
  view.plugin.settings.rememberProjects = true;
  view.plugin.settings.projectMemory = { identity: id, scope: 'local', projects: [{ worktree: '/selected', password: 'not-copied' }], selectedDirectory: '/selected' };
  view.createEmbed();
  const first = view.webview.getAttribute('partition');
  assert.equal(view.webview.getAttribute('preload'), null);
  assert(view.projectSource.includes('OpenCodeProjects.restoreProjects(window,'));
  assert(!view.projectSource.includes('not-copied'));
  const calls = [];
  const debuggerApi = { isAttached: () => debuggerApi.attached, attach() { debuggerApi.attached = true; }, detach() { debuggerApi.attached = false; }, async sendCommand(method, params) { calls.push({ method, params }); return { identifier: 'test-script' }; } };
  await view.installProjectRestore({ debugger: debuggerApi }, view.projectSource);
  assert.equal(calls[0].method, 'Page.enable');
  assert.equal(calls[1].method, 'Page.addScriptToEvaluateOnNewDocument');
  assert.equal(calls[1].params.source, view.projectSource);
  await view.detachProjects(); view.detachProjects = null;
  assert.equal(calls[2].method, 'Page.removeScriptToEvaluateOnNewDocument');
  assert.equal(debuggerApi.attached, false);
  view.createEmbed();
  assert.notEqual(view.webview.getAttribute('partition'), first);
  assert(!first.startsWith('persist:'));
  await view.onClose(); dom.window.close();
});
test('pending or failed restoration cannot overwrite saved projects with empty startup state', async () => {
  const { dom, view } = setup();
  let captures = 0;
  view.webview = { remove() {}, executeJavaScript() { captures++; } };
  view.plugin.settings.rememberProjects = true; view.projectMonitorReady = true;
  view.projectRestorePending = true;
  await view.captureProjects();
  view.projectRestorePending = false; view.projectRestoreFailed = true;
  await view.captureProjects();
  assert.equal(captures, 0);
  await view.onClose(); dom.window.close();
});
test('guest navigation waits for document-start registration after Obsidian has stripped preload', async () => {
  let registered;
  const debuggerApi = { isAttached: () => debuggerApi.attached, attach() { debuggerApi.attached = true; }, detach() { debuggerApi.attached = false; },
    sendCommand(method) { return method === 'Page.addScriptToEvaluateOnNewDocument' ? new Promise(resolve => { registered = resolve; }) : Promise.resolve({}); } };
  const { dom, view } = setup({
    electron: { remote: { webContents: { fromId: () => ({ debugger: debuggerApi }) } } },
    './auth': { attachAuth: () => () => {} },
    './diagnostics': { ...require('../src/diagnostics'), attachNetworkDiagnostics: () => () => {} }
  });
  const id = require('../src/core').partitionKey(view.plugin.vaultPath, view.plugin.settings);
  view.plugin.settings.rememberProjects = true;
  view.plugin.settings.projectMemory = { identity: id, scope: 'local', projects: [{ worktree: '/selected' }], selectedDirectory: '/selected' };
  view.createEmbed(); view.webview.getWebContentsId = () => 1;
  view.webview.removeAttribute('preload');
  view.webview.dispatchEvent(new dom.window.Event('did-attach'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.webview.getAttribute('src'), 'about:blank');
  assert.equal(typeof registered, 'function');
  registered({ identifier: 'native-startup' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.webview.getAttribute('src'), 'http://localhost:4096/');
  await view.onClose(); dom.window.close();
});
test('failed startup restoration is checked, warns and preserves the saved directory', async () => {
  const { dom, view } = setup();
  const id = require('../src/core').partitionKey(view.plugin.vaultPath, view.plugin.settings);
  view.plugin.settings.rememberProjects = true;
  view.plugin.settings.projectMemory = { identity: id, scope: 'local', projects: [{ worktree: '/saved' }], selectedDirectory: '/saved' };
  view.createEmbed();
  view.webview.getURL = () => 'http://localhost:4096/';
  view.webview.executeJavaScript = async () => false;
  view.sessionButton = {};
  view.inspectPage = async () => ({ ready: true });
  view.webview.dispatchEvent(new dom.window.Event('dom-ready'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.projectRestorePending, false);
  assert.equal(view.projectRestoreFailed, true);
  assert.equal(view.projectMonitorReady, false);
  assert.equal(view.status.kind, 'warn');
  assert.equal(view.plugin.settings.projectMemory.selectedDirectory, '/saved');
  await view.onClose(); dom.window.close();
});
test('a failed project save remains eligible for retry without a new directory selection', async () => {
  const { dom, view } = setup();
  const { partitionKey } = require('../src/core');
  view.plugin.settings.rememberProjects = true;
  view.projectIdentity = partitionKey(view.plugin.vaultPath, view.plugin.settings); view.projectMonitorReady = true;
  let saves = 0;
  view.plugin.saveSettings = async () => ++saves > 1;
  view.webview = { remove() {}, executeJavaScript: async () => ({ identity: view.projectIdentity, scope: 'local', projects: [{ worktree: '/retry' }], selectedDirectory: '/retry' }) };
  await view.captureProjects(); await view.captureProjects(); assert.equal(saves, 2);
  await view.captureProjects(); assert.equal(saves, 2);
  await view.onClose(); dom.window.close();
});
test('unrelated settings from an older window preserve the latest persisted project memory', async () => {
  const { dom, view, PluginClass } = setup();
  const { loadSettings, partitionKey } = require('../src/core');
  const folder = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'oc-project-save-test-'));
  const plugin = view.plugin;
  const id = partitionKey(plugin.vaultPath, plugin.settings);
  const old = { identity: id, scope: 'local', projects: [{ worktree: '/old' }], selectedDirectory: '/old' };
  const latest = { ...old, projects: [{ worktree: '/latest' }], selectedDirectory: '/latest' };
  plugin.settings = loadSettings({ ...plugin.settings, projectMemory: old });
  plugin.manifest = { id: 'opencode-sidebar', dir: folder };
  let data = { vaults: { [plugin.vaultPath]: loadSettings({ ...plugin.settings, projectMemory: latest }) } };
  plugin.loadData = async () => data;
  plugin.saveData = async value => { data = value; };
  try {
    assert(await PluginClass.prototype.saveSettings.call(plugin));
    assert.equal(data.vaults[plugin.vaultPath].projectMemory.selectedDirectory, '/latest');
    assert(await PluginClass.prototype.saveSettings.call(plugin, true));
    assert.equal(data.vaults[plugin.vaultPath].projectMemory.selectedDirectory, '/old');
  } finally { fs.rmSync(folder, { recursive: true }); await view.onClose(); dom.window.close(); }
});

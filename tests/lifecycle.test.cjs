const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function setup() {
  const dom = new JSDOM('<div id="embed"></div>');
  class Base {}
  const mod = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8') + '\nmodule.exports.ViewForTest = SidebarView;';
  const context = {
    module: mod, document: dom.window.document, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    require(name) {
      if (name === 'obsidian') return { Plugin: Base, ItemView: Base, Notice: Base, Setting: Base, PluginSettingTab: Base, SuggestModal: Base, Modal: Base, Menu: Base };
      return name.startsWith('.') ? require(path.join(__dirname, '../src', name)) : require(name);
    }
  };
  vm.runInNewContext(source, context);
  const plugin = { settings: { serverUrl: 'http://localhost:4096', basicAuth: false, mathFixes: false }, vaultPath: '/a/vault' };
  const view = new mod.exports.ViewForTest({}, plugin);
  view.contentEl = { empty() {} };
  view.embedEl = dom.window.document.getElementById('embed');
  view.setStatus = (kind, message) => { view.status = { kind, message }; };
  return { dom, view };
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

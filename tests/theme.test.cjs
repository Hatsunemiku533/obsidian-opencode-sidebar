const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { applyAppearance, COLOR_STYLE_ID, TYPE_STYLE_ID, FONTS, FONT_SIZES } = require('../src/theme');
const { loadSettings } = require('../src/core');

function page() {
  const dom = new JSDOM('<style id="oc-theme">:root{--v2-text-text-base:#123456}</style><style id="oc-sidebar-claude-theme">old</style><div id="root"><textarea>unsent draft</textarea><pre><code>original code</code></pre></div>');
  dom.window.document.documentElement.dataset.colorScheme = 'light';
  return dom;
}

test('appearance settings are per vault and migrate the old Claude toggle', () => {
  const defaults = loadSettings();
  assert.equal(defaults.themeOverlay, true);
  assert.equal(defaults.fontFamily, 'clear');
  assert.equal(defaults.fontSize, 14);
  assert.equal(loadSettings({ claudeTheme: false }).themeOverlay, false);
  assert.equal(loadSettings({ claudeTheme: false, themeOverlay: true }).themeOverlay, true);
  assert.equal('claudeTheme' in defaults, false);
});
test('unknown fonts and sizes fall back instead of injecting arbitrary CSS', () => {
  assert.equal(loadSettings({ fontFamily: 'book', fontSize: 16 }).fontFamily, 'book');
  assert.equal(loadSettings({ fontFamily: 'book', fontSize: 16 }).fontSize, 16);
  assert.equal(loadSettings({ fontFamily: 'x;}body{display:none', fontSize: 40 }).fontFamily, 'clear');
  assert.equal(loadSettings({ fontSize: 40 }).fontSize, 14);
  assert.equal(loadSettings({ fontSize: '16' }).fontSize, 14);
});
test('three readable fonts and five sizes, none lighter than regular', () => {
  assert.deepEqual(Object.keys(FONTS), ['clear', 'soft', 'book']);
  assert.deepEqual([...FONT_SIZES], [13, 14, 15, 16, 17]);
  for (const font of Object.values(FONTS)) {
    assert(font.weight >= 400, font.label);
    assert(font.strong >= 600, font.label);
  }
});
test('applying is idempotent, replaces the old overlay and leaves page content alone', () => {
  const dom = page(); const doc = dom.window.document;
  const root = doc.getElementById('root'); const before = root.innerHTML;
  applyAppearance(doc, { theme: true, font: 'soft', size: 15 });
  applyAppearance(doc, { theme: true, font: 'soft', size: 15 });
  assert.equal(doc.querySelectorAll('#' + COLOR_STYLE_ID).length, 1);
  assert.equal(doc.querySelectorAll('#' + TYPE_STYLE_ID).length, 1);
  assert.equal(doc.getElementById('oc-sidebar-claude-theme'), null);
  assert.equal(doc.getElementById('oc-theme').textContent, ':root{--v2-text-text-base:#123456}');
  assert.equal(root.innerHTML, before);
  assert.equal(doc.documentElement.dataset.colorScheme, 'light');
  dom.window.close();
});
test('disabling the theme removes colors but keeps the font and bold fixes', () => {
  const dom = page(); const doc = dom.window.document;
  applyAppearance(doc, { theme: true, font: 'book', size: 16 });
  applyAppearance(doc, { theme: false, font: 'book', size: 16 });
  assert.equal(doc.getElementById(COLOR_STYLE_ID), null);
  const type = doc.getElementById(TYPE_STYLE_ID).textContent;
  assert.match(type, /Noto Serif SC/);
  assert.match(type, /--oc-font-size:\s*16px/);
  assert.match(type, /--oc-strong-weight:\s*700/);
  dom.window.close();
});
test('switching font replaces the previous font instead of stacking', () => {
  const dom = page(); const doc = dom.window.document;
  applyAppearance(doc, { theme: true, font: 'book', size: 16 });
  applyAppearance(doc, { theme: true, font: 'clear', size: 13 });
  const type = doc.getElementById(TYPE_STYLE_ID).textContent;
  assert.doesNotMatch(type, /Noto Serif SC/);
  assert.match(type, /Microsoft YaHei UI/);
  assert.match(type, /--oc-font-size:\s*13px/);
  dom.window.close();
});
test('invalid runtime input uses defaults', () => {
  const dom = page(); const doc = dom.window.document;
  applyAppearance(doc, { theme: true, font: '}body{', size: 99 });
  const type = doc.getElementById(TYPE_STYLE_ID).textContent;
  assert.doesNotMatch(type, /\}body\{/);
  assert.match(type, /--oc-font-size:\s*14px/);
  dom.window.close();
});
test('colors only change the light scheme; dark mode keeps native colors', () => {
  const dom = page(); const doc = dom.window.document;
  applyAppearance(doc, { theme: true, font: 'clear', size: 14 });
  const color = doc.getElementById(COLOR_STYLE_ID).textContent;
  const colorBlock = color.split('/* shape and motion */')[0];
  assert.match(colorBlock, /^html:not\(\[data-color-scheme="dark"\]\)/);
  assert.match(colorBlock, /#3f6684/);
  assert.doesNotMatch(colorBlock, /#C4623F|#F4F1EA|#EFE8DC/i);
  dom.window.close();
});

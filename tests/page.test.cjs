const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { installPageFixes } = require('../src/page');
const { selectionToMarkdown } = require('../src/copy');
const katex = require('katex');

test('dollar blocks are not reparsed as inline math; plain source copies once', () => {
  const dom = new JSDOM('<div data-component="markdown"><p>Text $x^2$.</p><p>$$\\mu_w(x)=[1-w(x)]\\mu_a(x)+w(x)\\mu_b(x).$$</p><pre>$not_math$</pre></div><textarea>$draft$</textarea>');
  const win = dom.window; win.katex = katex;
  installPageFixes(win);
  const root = win.document.querySelector('[data-component="markdown"]');
  assert.equal(root.querySelectorAll('.katex').length, 2);
  assert.equal(root.querySelectorAll('.katex-display').length, 1);
  assert.equal(root.querySelector('pre').textContent, '$not_math$');
  const range = win.document.createRange(); range.selectNodeContents(root);
  win.getSelection().addRange(range);
  const text = selectionToMarkdown(win.getSelection());
  assert.equal((text.match(/\\mu_w/g) || []).length, 1);
  assert.ok(text.includes('$$\n\\mu_w'));
  assert.ok(!text.includes('$\\mu_w(x)=[1-w(x)]$'));
  win.close();
});

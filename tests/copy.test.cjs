const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const katex = require('katex');
const { selectionToMarkdown, installCopyFix } = require('../src/copy');

function page(body) {
  const dom = new JSDOM('<body><div class="oc-sidebar-markdown">' + body + '</div></body>');
  const { document } = dom.window;
  const selection = dom.window.getSelection();
  function select(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  select(document.querySelector('.oc-sidebar-markdown'));
  return { dom, document, selection, select };
}

test('inline math becomes one TeX source, without visual/MathML duplication', () => {
  const p = page('<p>Before ' + katex.renderToString('x^2') + ' after.</p>');
  assert.equal(selectionToMarkdown(p.selection), 'Before $x^2$ after.');
});
test('block formulas use double dollars and retain paragraph breaks', () => {
  const p = page('<p>First</p>' + katex.renderToString('u(x)=(1-w)u_a+w u_b', { displayMode: true }) + '<p>Last</p>');
  assert.equal(selectionToMarkdown(p.selection), 'First\n\n$$\nu(x)=(1-w)u_a+w u_b\n$$\n\nLast');
});
test('a selection entirely inside visual math recovers original TeX', () => {
  const p = page(katex.renderToString('\\mu_w(x)'));
  p.select(p.document.querySelector('.katex-html'));
  assert.equal(selectionToMarkdown(p.selection), '$\\mu_w(x)$');
});
test('a partial math endpoint does not duplicate or truncate the formula', () => {
  const p = page('<p>A ' + katex.renderToString('x^2') + ' B</p>');
  const range = p.document.createRange();
  range.setStart(p.document.querySelector('.katex-html .mord').firstChild, 0);
  range.setEnd(p.document.querySelector('p').lastChild, 2);
  p.selection.removeAllRanges(); p.selection.addRange(range);
  assert.equal(selectionToMarkdown(p.selection), '$x^2$ B');
});
test('multiline text, code, lists and links remain Markdown', () => {
  const p = page('<h2>Title</h2><p>A<br>B <code>x &lt; y</code></p><ul><li>One</li><li>Two</li></ul><p><a href="https://example.com">Link</a></p>');
  assert.equal(selectionToMarkdown(p.selection), '## Title\n\nA\nB `x < y`\n\n- One\n- Two\n\n[Link](https://example.com)');
});
test('copy clears rich HTML and ignores inputs and editor selections', () => {
  const p = page('<p>' + katex.renderToString('x') + '</p><textarea>draft</textarea>');
  installCopyFix(p.dom.window);
  const data = new Map([['text/html', '<span>old</span>']]);
  const event = new p.dom.window.Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { clearData: () => data.clear(), setData: (k, v) => data.set(k, v) } });
  p.document.querySelector('p').dispatchEvent(event);
  assert.equal(data.get('text/plain'), '$x$\n\ndraft');
  assert.equal(data.has('text/html'), false);
  const edit = new p.dom.window.Event('copy', { bubbles: true, cancelable: true });
  p.document.querySelector('textarea').dispatchEvent(edit);
  assert.equal(edit.defaultPrevented, false);
});

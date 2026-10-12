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
test('native display math retains TeX after the sanitizer unwraps MathML annotations', () => {
  const p = page('<p>First</p>' + katex.renderToString('\\boldsymbol q(t)=\n[u_1,\\ldots,u_N]^T.', { displayMode: true }) + '<p>Last</p>');
  // The live OpenCode sanitizer removes these tags but retains their children.
  for (const node of p.document.querySelectorAll('semantics,annotation')) node.replaceWith(...node.childNodes);
  assert.equal(selectionToMarkdown(p.selection), 'First\n\n$$\n\\boldsymbol q(t)=\n[u_1,\\ldots,u_N]^T.\n$$\n\nLast');
});
test('copying inside a sanitized display formula clears HTML and emits one complete formula', () => {
  const p = page(katex.renderToString('\\boldsymbol q(t)=[u_1,\\ldots,u_N]^T.', { displayMode: true }));
  for (const node of p.document.querySelectorAll('semantics,annotation')) node.replaceWith(...node.childNodes);
  p.select(p.document.querySelector('.katex-html'));
  installCopyFix(p.dom.window);
  const data = new Map([['text/html', '<span>old</span>']]);
  const event = new p.dom.window.Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { clearData: () => data.clear(), setData: (k, v) => data.set(k, v) } });
  p.document.querySelector('.katex-html').dispatchEvent(event);
  assert.equal(data.get('text/plain'), '$$\n\\boldsymbol q(t)=[u_1,\\ldots,u_N]^T.\n$$');
  assert.equal(data.has('text/html'), false);
  assert.equal(event.defaultPrevented, true);
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
test('tables preserve header, separator, rows and surrounding paragraphs', () => {
  const p = page('<p>In order:</p><table><thead><tr><th>Output</th><th>Meaning</th></tr></thead><tbody><tr><td><code>Counting objects: 100% (15/15), done.</code></td><td>Counted objects.</td></tr><tr><td>Compressing</td><td>Compressed.</td></tr></tbody></table><p>Next:</p>');
  assert.equal(selectionToMarkdown(p.selection), 'In order:\n\n| Output | Meaning |\n| --- | --- |\n| `Counting objects: 100% (15/15), done.` | Counted objects. |\n| Compressing | Compressed. |\n\nNext:');
});
test('table cells retain inline formatting and math, escape pipes and flatten line breaks', () => {
  const p = page('<table><thead><tr><th style="text-align:left">Expression</th><th align="right">Notes</th></tr></thead><tbody><tr><td><code>a | b</code> ' + katex.renderToString('x^2') + '</td><td><strong>First</strong><br><a href="https://example.com">Second</a></td></tr><tr><td>Empty neighbor</td><td></td></tr></tbody></table>');
  assert.equal(selectionToMarkdown(p.selection), '| Expression | Notes |\n| :--- | ---: |\n| `a \\| b` $x^2$ | **First**<br>[Second](https://example.com) |\n| Empty neighbor |  |');
});
test('a selection spanning body cells remains a table without adding unselected row text', () => {
  const p = page('<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>Alpha</td><td>1</td></tr><tr><td>Beta</td><td>2</td></tr><tr><td>Unselected</td><td>3</td></tr></tbody></table>');
  const rows = p.document.querySelectorAll('tbody tr');
  const range = p.document.createRange();
  range.setStart(rows[0].cells[0].firstChild, 2);
  range.setEnd(rows[1].cells[1].firstChild, 1);
  p.selection.removeAllRanges(); p.selection.addRange(range);
  assert.equal(selectionToMarkdown(p.selection), '|  |  |\n| --- | --- |\n| pha | 1 |\n| Beta | 2 |');
});
test('a selection wholly inside one table cell does not copy its neighbors', () => {
  const p = page('<table><tr><td>Only this text</td><td>Not selected</td></tr></table>');
  p.select(p.document.querySelector('td'));
  assert.equal(selectionToMarkdown(p.selection), 'Only this text');
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

function selectionToMarkdown(selection) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const nodeElement = (node) => node.nodeType === 1 ? node : node.parentElement;
  const common = nodeElement(range.commonAncestorContainer);
  if (common && common.closest('textarea,input,[contenteditable="true"]')) return null;
  const ancestorMath = common && (common.closest('.katex-display') || common.closest('.katex'));
  const ancestorTable = common && common.closest('table');
  const root = ancestorMath || (ancestorTable && !common.closest('td,th') ? ancestorTable : range.commonAncestorContainer);

  function visit(node) {
    if (!range.intersectsNode(node)) return '';
    if (node.nodeType === 3) {
      const start = range.startContainer === node ? range.startOffset : 0;
      const end = range.endContainer === node ? range.endOffset : node.length;
      return node.nodeValue.slice(start, end);
    }
    if (node.nodeType !== 1 && node.nodeType !== 11 && node.nodeType !== 9) return '';
    if (node.nodeType === 1 && node.matches('.katex-display,.katex')) {
      // Copy partial visual selections as a complete formula, once, from the original DOM.
      const clipped = range.cloneRange();
      if (range.comparePoint(node, 0) === 0) clipped.setStart(node, 0);
      if (range.comparePoint(node, node.childNodes.length) === 0) clipped.setEnd(node, node.childNodes.length);
      if (clipped.collapsed) return '';
      const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
      // OpenCode unwraps annotation/semantics, leaving TeX as direct MathML text.
      const math = node.querySelector('.katex-mathml math');
      const tex = (annotation ? annotation.textContent : Array.from(math?.childNodes || [])
        .filter((child) => child.nodeType === 3).map((child) => child.nodeValue).join('')).trim();
      if (!tex) return clipped.toString();
      return node.matches('.katex-display') ? '\n\n$$\n' + tex + '\n$$\n\n' : '$' + tex + '$';
    }
    if (node.nodeType === 1 && node.matches('script,style,.katex-mathml')) return '';
    if (node.nodeName === 'TABLE') {
      const rows = Array.from(node.rows).filter((row) => {
        if (!range.intersectsNode(row)) return false;
        const clipped = range.cloneRange();
        if (range.comparePoint(row, 0) === 0) clipped.setStart(row, 0);
        if (range.comparePoint(row, row.childNodes.length) === 0) clipped.setEnd(row, row.childNodes.length);
        return !clipped.collapsed;
      });
      if (!rows.length) return '';
      const width = Math.max(...rows.map((row) => row.cells.length));
      const values = rows.map((row) => Array.from({ length: width }, (_, index) => {
        const cell = row.cells[index];
        return cell ? visit(cell).trim().replace(/\|/g, '\\|').replace(/\s*\n+\s*/g, '<br>') : '';
      }));
      const hasHeader = rows[0].parentElement.nodeName === 'THEAD' || Array.from(rows[0].cells).every((cell) => cell.nodeName === 'TH');
      // A body-only selection needs an empty Markdown header, not unselected header text.
      const header = hasHeader ? values.shift() : Array(width).fill('');
      const alignment = Array.from({ length: width }, (_, index) => {
        const cell = node.rows[0]?.cells[index];
        const align = cell?.style.textAlign || cell?.getAttribute('align');
        return align === 'center' ? ':---:' : align === 'right' ? '---:' : align === 'left' ? ':---' : '---';
      });
      return '\n\n' + [header, alignment, ...values].map((cells) => '| ' + cells.join(' | ') + ' |').join('\n') + '\n\n';
    }
    if (node.nodeName === 'BR') return '\n';
    const content = Array.from(node.childNodes, visit).join('');
    if (!content) return '';
    if (node.nodeName === 'PRE') return '\n\n```\n' + content.replace(/\n$/, '') + '\n```\n\n';
    if (node.nodeName === 'CODE' && !node.closest('pre')) {
      const ticks = '`'.repeat(Math.max(1, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length + 1)));
      return ticks + (content.includes('`') ? ' ' + content + ' ' : content) + ticks;
    }
    if (node.nodeName === 'A') {
      const href = node.getAttribute('href');
      return href ? '[' + content + '](' + href + ')' : content;
    }
    if (node.nodeName === 'STRONG' || node.nodeName === 'B') return '**' + content + '**';
    if (node.nodeName === 'EM' || node.nodeName === 'I') return '*' + content + '*';
    if (node.nodeName === 'LI') {
      const ordered = node.parentElement.nodeName === 'OL';
      const index = Array.from(node.parentElement.children).indexOf(node) + Number(node.parentElement.getAttribute('start') || 1);
      return (ordered ? index + '. ' : '- ') + content.trim() + '\n';
    }
    if (/^H[1-6]$/.test(node.nodeName)) return '\n\n' + '#'.repeat(Number(node.nodeName[1])) + ' ' + content + '\n\n';
    if (node.nodeName === 'BLOCKQUOTE') return '\n\n' + content.trim().split('\n').map((line) => '> ' + line).join('\n') + '\n\n';
    if (['P', 'DIV', 'UL', 'OL'].includes(node.nodeName)) return '\n\n' + content.trim() + '\n\n';
    return content;
  }
  return visit(root).replace(/\n{3,}/g, '\n\n').trim();
}

function installCopyFix(win) {
  if (win.__ocSidebarCopy) return;
  win.__ocSidebarCopy = true;
  win.document.addEventListener('copy', (event) => {
    const target = event.target.nodeType === 1 ? event.target : event.target.parentElement;
    if (target && target.closest('input,textarea,[contenteditable="true"]')) return;
    const selection = win.getSelection();
    const element = selection && selection.anchorNode && (selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement);
    if (!element || !element.closest('[data-component="markdown"],.oc-sidebar-markdown')) return;
    let text;
    try { text = selectionToMarkdown(selection); } catch { return; }
    if (!text || !event.clipboardData) return;
    // Rich HTML makes Obsidian paste the rendered KaTeX tree instead of the TeX source.
    event.clipboardData.clearData();
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

module.exports = { selectionToMarkdown, installCopyFix };

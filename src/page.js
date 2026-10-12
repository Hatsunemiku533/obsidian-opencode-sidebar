const { installCopyFix } = require('./copy');

function installPageFixes(win) {
  if (win.__ocSidebarPage) return;
  win.__ocSidebarPage = true;
  installCopyFix(win);
  const doc = win.document;
  const scroll = doc.createElement('style');
  scroll.textContent = '.katex-display{overflow-x:auto;overflow-y:hidden;max-width:100%}pre{overflow-x:auto}';
  doc.head.appendChild(scroll);
  function run() {
    const roots = doc.querySelectorAll('[data-component="markdown"],.oc-sidebar-markdown');
    for (const root of roots) {
      const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return node.nodeValue.includes('$') && !node.parentElement.closest('pre,code,.katex,textarea,input,[contenteditable="true"]')
            ? win.NodeFilter.FILTER_ACCEPT : win.NodeFilter.FILTER_REJECT;
        }
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        const text = node.nodeValue;
        // Match block delimiters before inline ones; never reinterpret $$ as inline math.
        const regex = /(?<![\\$])\$\$([\s\S]+?)\$\$(?!\$)|(?<![\\$])\$([^\n$]+?)\$(?!\$)/g;
        let match; let offset = 0;
        const fragment = doc.createDocumentFragment();
        while ((match = regex.exec(text))) {
          fragment.append(doc.createTextNode(text.slice(offset, match.index)));
          const span = doc.createElement('span');
          // Parse KaTeX output (trust:false) with DOMParser instead of assigning innerHTML.
          const html = win.katex.renderToString(match[1] || match[2], { displayMode: !!match[1], throwOnError: false, strict: 'ignore', trust: false });
          span.append(...new win.DOMParser().parseFromString(html, 'text/html').body.childNodes);
          fragment.append(span);
          offset = regex.lastIndex;
        }
        if (!offset) continue;
        fragment.append(doc.createTextNode(text.slice(offset)));
        node.replaceWith(fragment);
      }
    }
  }
  let timer;
  const observer = new win.MutationObserver(() => {
    win.clearTimeout(timer);
    timer = win.setTimeout(run, 120);
  });
  observer.observe(doc.body, { childList: true, subtree: true, characterData: true });
  win.addEventListener('pagehide', () => { observer.disconnect(); win.clearTimeout(timer); }, { once: true });
  run();
}

module.exports = { installPageFixes };

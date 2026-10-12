const { errorSummary, safeErrorSummary } = require('./error-summary');

function pageSnapshot(win) {
  const doc = win.document;
  const root = doc.querySelector('#root');
  const outsideReply = (element) => !element.closest('[data-component="markdown"],.oc-sidebar-markdown');
  const heading = Array.from(doc.querySelectorAll('h1')).find((el) => outsideReply(el) && /^(Something went wrong|出了点问题)$/.test(el.textContent.trim()));
  const restart = Array.from(doc.querySelectorAll('button,[role="button"]')).some((el) => outsideReply(el) && /^(Restart|重启)$/.test(el.textContent.trim()));
  const card = heading?.parentElement?.parentElement;
  const message = heading && restart ? errorSummary(card?.textContent || '') : undefined;
  const age = Date.now() - win.__ocSidebarLastErrorAt;
  return {
    domState: doc.readyState,
    bodyNodes: doc.body?.childNodes.length || 0,
    rootPresent: !!root,
    rootChildren: root?.children.length || 0,
    ready: !!root?.children.length,
    errorPage: !!(heading && restart),
    ...(message ? { pageError: message } : {}),
    ...(win.__ocSidebarLastError && age >= 0 && age < 60000 ? { runtimeError: safeErrorSummary(win.__ocSidebarLastError), runtimeErrorAgeMs: age } : {}),
    scripts: Array.from(doc.querySelectorAll('script[src]'), (script) => {
      try { return new URL(script.src).pathname.match(/\/assets\/([A-Za-z0-9_.-]+\.js)$/)?.[1]; } catch { return undefined; }
    }).filter(Boolean).slice(0, 20),
    math: !!win.katex,
    copyHook: !!win.__ocSidebarCopy
  };
}

function installPageDiagnostics(win) {
  if (win.__ocSidebarDiag) return;
  win.__ocSidebarDiag = true;
  let last = ''; let when = 0;
  function report(source, error) {
    const summary = errorSummary(error);
    if (summary.kind === 'resize-observer') return;
    const key = JSON.stringify(summary);
    if (key === last && Date.now() - when < 10000) return;
    last = key; when = Date.now();
    win.__ocSidebarLastError = summary;
    win.__ocSidebarLastErrorAt = Date.now();
    win.console.warn('[oc-sidebar-diagnostic]' + JSON.stringify({ source, ...summary }));
  }
  win.addEventListener('error', (event) => report('error', event.error || event.message));
  win.addEventListener('unhandledrejection', (event) => report('unhandledrejection', event.reason));
}

module.exports = { pageSnapshot, installPageDiagnostics };

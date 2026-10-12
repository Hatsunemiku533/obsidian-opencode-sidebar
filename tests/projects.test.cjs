const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { normalizeProjectMemory, captureProjects, restoreProjects } = require('../src/projects');
const { loadSettings, partitionKey } = require('../src/core');
const base = 'http://localhost:4096';
const identity = partitionKey('/a/vault', { serverUrl: base });
const serverKey = 'opencode.global.dat:server';
const layoutKey = 'opencode.global.dat:layout';
const memory = { identity, scope: 'local', projects: [{ worktree: '/project/a', expanded: true }, { worktree: '/project/b', expanded: false }], selectedDirectory: '/project/b', lastProject: '/project/b' };
function page(url = base + '/') { return new JSDOM('', { url }); }

test('capture retains only directories and home selection, never credentials, sessions or drafts', () => {
  const dom = page(); const storage = dom.window.localStorage;
  storage.setItem(serverKey, JSON.stringify({ projects: { local: memory.projects }, lastProject: { local: '/project/b' }, list: [{ password: 'private-server-password' }] }));
  storage.setItem(layoutKey, JSON.stringify({ home: { selection: { server: base, directory: '/project/b' } }, sessionTabs: { private: 'private-session' }, prompt: 'private-draft' }));
  assert.deepEqual(captureProjects(dom.window, identity, base), memory);
  dom.window.close();
});
test('restore selects the remembered project before page startup without navigating to a session', () => {
  const dom = page(); const win = dom.window;
  assert.equal(restoreProjects(win, memory, identity, base), true);
  assert.deepEqual(JSON.parse(win.localStorage.getItem(serverKey)).projects.local, memory.projects);
  assert.deepEqual(JSON.parse(win.localStorage.getItem(layoutKey)), { home: { selection: { server: base, directory: '/project/b' } } });
  assert.equal(win.location.href, base + '/');
  assert.deepEqual(captureProjects(win, identity, base), memory);
  dom.window.close();
});
test('restoration happens only once per private partition and never reopens a project the user closed', () => {
  const dom = page(); const win = dom.window;
  restoreProjects(win, memory, identity, base);
  win.localStorage.setItem(serverKey, JSON.stringify({ projects: { local: [] }, lastProject: { local: '/project/b' } }));
  assert.equal(restoreProjects(win, memory, identity, base), false);
  const closed = captureProjects(win, identity, base);
  assert.deepEqual(closed.projects, []); assert.equal(closed.lastProject, ''); assert.equal(closed.selectedDirectory, '');
  dom.window.close();
});
test('vaults with the same name and different paths cannot restore each other\'s projects', () => {
  const a = page(); const b = page();
  const otherIdentity = partitionKey('/b/vault', { serverUrl: base });
  assert.equal(restoreProjects(b.window, memory, otherIdentity, base), false);
  assert.equal(b.window.localStorage.length, 0);
  assert.equal(restoreProjects(a.window, memory, identity, base), true);
  assert.equal(b.window.localStorage.length, 0);
  a.window.close(); b.window.close();
});
test('remote server scopes use scoped layout storage and cannot leak to a foreign origin or proxy sibling', () => {
  const remote = 'https://example.com/oc';
  const id = partitionKey('/a/vault', { serverUrl: remote });
  const saved = { ...memory, identity: id, scope: remote };
  const dom = page(remote + '/');
  assert(restoreProjects(dom.window, saved, id, remote));
  assert.equal(JSON.parse(dom.window.localStorage.getItem('opencode.global.dat:' + remote + '\0layout')).home.selection.directory, '/project/b');
  assert.deepEqual(captureProjects(dom.window, id, remote), saved);
  for (const url of ['https://other.example/oc/', 'https://example.com/oc-other/']) {
    const foreign = page(url);
    assert.equal(restoreProjects(foreign.window, saved, id, remote), false);
    assert.equal(captureProjects(foreign.window, id, remote), null);
    assert.equal(foreign.window.localStorage.length, 0); foreign.window.close();
  }
  dom.window.close();
});
test('malformed or missing native storage is not treated as an intentionally empty list', () => {
  const dom = page();
  assert.equal(captureProjects(dom.window, identity, base), null);
  dom.window.localStorage.setItem(serverKey, '{');
  assert.equal(captureProjects(dom.window, identity, base), null);
  assert.deepEqual(normalizeProjectMemory(null), {});
  assert.deepEqual(loadSettings({ projectMemory: ['wrong'] }).projectMemory, {});
  dom.window.close();
});
test('memory is bounded, sanitized and strips stale selection and extra payload fields', () => {
  const result = normalizeProjectMemory({ ...memory, password: 'private', selectedDirectory: '/closed', projects: [{ worktree: 'relative' }, { worktree: '/project/a', password: 'private' }, { worktree: '/project/a' }, { worktree: 'C:\\project\\b', expanded: false }] });
  assert.deepEqual(result.projects, [{ worktree: '/project/a', expanded: true }, { worktree: 'C:\\project\\b', expanded: false }]);
  assert.equal(result.selectedDirectory, ''); assert.equal(result.lastProject, ''); assert(!JSON.stringify(result).includes('private'));
  assert.equal(normalizeProjectMemory({ ...memory, projects: Array.from({ length: 100 }, (_, i) => ({ worktree: '/p/' + i })) }).projects.length, 50);
});
test('restore merges only project fields and leaves unrelated native preferences alone', () => {
  const dom = page(); const storage = dom.window.localStorage;
  storage.setItem(serverKey, JSON.stringify({ list: ['existing-server'], projects: { other: [{ worktree: '/other' }] } }));
  storage.setItem(layoutKey, JSON.stringify({ sidebar: { width: 300 }, home: { other: true }, sessionTabs: { existing: [] } }));
  assert(restoreProjects(dom.window, memory, identity, base));
  assert.deepEqual(JSON.parse(storage.getItem(serverKey)).list, ['existing-server']);
  assert.deepEqual(JSON.parse(storage.getItem(serverKey)).projects.other, [{ worktree: '/other' }]);
  assert.deepEqual(JSON.parse(storage.getItem(layoutKey)).sidebar, { width: 300 });
  assert.deepEqual(JSON.parse(storage.getItem(layoutKey)).sessionTabs, { existing: [] });
  dom.window.close();
});
test('the selected project remains remembered even when the project list exceeds the size bound', () => {
  const result = normalizeProjectMemory({ ...memory, projects: Array.from({ length: 100 }, (_, i) => ({ worktree: '/p/' + i })), selectedDirectory: '/p/99', lastProject: '/p/98' });
  assert.equal(result.projects.length, 50);
  assert.equal(result.selectedDirectory, '/p/99'); assert.equal(result.lastProject, '/p/98');
  assert.deepEqual(result.projects.slice(-2).map((item) => item.worktree), ['/p/98', '/p/99']);
});

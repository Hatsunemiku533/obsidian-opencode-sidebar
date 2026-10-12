const SERVER_KEY = 'opencode.global.dat:server';
const RESTORED_KEY = 'oc-sidebar-projects-restored';
const MAX_STORAGE = 256 * 1024;

function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function directory(value) {
  return typeof value === 'string' && value.length <= 2048 && !/[\x00-\x1f]/.test(value) && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
}
function normalizeProjectMemory(value) {
  if (!record(value) || !/^persist:opencode-sidebar-[a-f0-9]{24}$/.test(value.identity) ||
      typeof value.scope !== 'string' || value.scope.length > 2048 || value.scope.includes('\0') || !Array.isArray(value.projects)) return {};
  const seen = new Set();
  const valid = value.projects.flatMap((item) => {
    if (!record(item) || !directory(item.worktree) || seen.has(item.worktree)) return [];
    seen.add(item.worktree);
    return [{ worktree: item.worktree, expanded: item.expanded !== false }];
  });
  const chosen = new Set([value.selectedDirectory, value.lastProject]);
  const retained = new Set([...valid.filter((item) => chosen.has(item.worktree)), ...valid.filter((item) => !chosen.has(item.worktree))].slice(0, 50));
  const projects = valid.filter((item) => retained.has(item));
  return {
    identity: value.identity, scope: value.scope, projects,
    selectedDirectory: seen.has(value.selectedDirectory) ? value.selectedDirectory : '',
    lastProject: seen.has(value.lastProject) ? value.lastProject : ''
  };
}
function read(storage, key) {
  const raw = storage.getItem(key);
  if (!raw || raw.length > MAX_STORAGE) return null;
  try { const value = JSON.parse(raw); return record(value) ? value : null; } catch { return null; }
}
function layoutKey(scope) { return 'opencode.global.dat:' + (scope === 'local' ? '' : scope + '\0') + 'layout'; }
function inScope(win, base) {
  const page = new URL(win.location.href);
  const server = new URL(base);
  return !page.username && !page.password && page.origin === server.origin &&
    (page.pathname === server.pathname || page.pathname.startsWith(server.pathname.replace(/\/$/, '') + '/'));
}
function captureProjects(win, identity, base) {
  try {
    if (!inScope(win, base)) return null;
    const stored = read(win.localStorage, SERVER_KEY);
    if (!record(stored?.projects)) return null;
    const scope = ['local', base].find((key) => Array.isArray(stored.projects[key]));
    if (!scope) return null;
    const selection = read(win.localStorage, layoutKey(scope))?.home?.selection;
    const last = stored.lastProject?.[scope];
    return normalizeProjectMemory({
      identity, scope, projects: stored.projects[scope], lastProject: last,
      selectedDirectory: selection?.server === base ? selection.directory || '' : last || ''
    });
  } catch { return null; }
}
function restoreProjects(win, input, identity, base) {
  try {
    const memory = normalizeProjectMemory(input);
    if (memory.identity !== identity || !['local', base].includes(memory.scope) || !inScope(win, base)) return false;
    const storage = win.localStorage;
    if (storage.getItem(RESTORED_KEY)) return false;
    const stored = read(storage, SERVER_KEY) || {};
    storage.setItem(SERVER_KEY, JSON.stringify({
      ...stored,
      projects: { ...(record(stored.projects) ? stored.projects : {}), [memory.scope]: memory.projects },
      lastProject: { ...(record(stored.lastProject) ? stored.lastProject : {}), [memory.scope]: memory.lastProject }
    }));
    const key = layoutKey(memory.scope);
    const layout = read(storage, key) || {};
    storage.setItem(key, JSON.stringify({
      ...layout, home: { ...(record(layout.home) ? layout.home : {}),
        selection: { server: base, ...(memory.selectedDirectory ? { directory: memory.selectedDirectory } : {}) } }
    }));
    // This marker is temporary with the private browser partition. Later navigations must not
    // replay the initial snapshot over a project the user just selected or closed.
    storage.setItem(RESTORED_KEY, '1');
    return true;
  } catch { return false; }
}

module.exports = { normalizeProjectMemory, captureProjects, restoreProjects };

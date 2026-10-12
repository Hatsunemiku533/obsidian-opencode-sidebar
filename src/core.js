const { createHash } = require('node:crypto');
const { normalizeProjectMemory } = require('./projects');
const { DEFAULT_FONT, DEFAULT_FONT_SIZE, fontKey, fontSize } = require('./theme');

const DEFAULTS = Object.freeze({
  serverUrl: 'http://127.0.0.1:4096',
  readerBase: 'http://127.0.0.1:18924',
  basicAuth: false,
  username: 'opencode',
  password: '',
  directory: '',
  tuiLauncher: '',
  themeOverlay: true,
  fontFamily: DEFAULT_FONT,
  fontSize: DEFAULT_FONT_SIZE,
  rememberProjects: true,
  projectMemory: Object.freeze({}),
  mathFixes: true
});

function loadSettings(data = {}) {
  const result = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    result[key] = typeof data[key] === typeof value ? data[key] : value;
  }
  // Older versions stored the page color toggle as claudeTheme.
  if (typeof data.themeOverlay !== 'boolean' && typeof data.claudeTheme === 'boolean') result.themeOverlay = data.claudeTheme;
  result.fontFamily = fontKey(result.fontFamily);
  result.fontSize = fontSize(result.fontSize);
  result.projectMemory = normalizeProjectMemory(data.projectMemory);
  return result;
}

function serverUrl(value) {
  const url = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS server URL.');
  if (url.username || url.password) throw new Error('Remove credentials from the URL; use the Basic Auth settings.');
  if (url.search || url.hash) throw new Error('Use the server base URL without a query or fragment.');
  return url.href.replace(/\/+$/, '');
}

function authHeaders(settings) {
  if (!settings.basicAuth) return {};
  if (settings.username.includes(':') || /[\r\n]/.test(settings.username + settings.password)) {
    throw new Error('Invalid Basic Auth username or password.');
  }
  return { Authorization: 'Basic ' + Buffer.from(settings.username + ':' + settings.password, 'utf8').toString('base64') };
}

function inServerScope(value, base) {
  try {
    const url = new URL(value);
    const server = new URL(serverUrl(base));
    const path = server.pathname.replace(/\/+$/, '');
    return !url.username && !url.password && url.origin === server.origin &&
      (!path || url.pathname === path || url.pathname.startsWith(path + '/'));
  } catch { return false; }
}

function partitionKey(vaultPath, settings) {
  // Separate auth caches and page storage even for vaults with identical names.
  const identity = JSON.stringify([vaultPath, serverUrl(settings.serverUrl), !!settings.basicAuth, settings.username || '']);
  return 'persist:opencode-sidebar-' + createHash('sha256').update(identity).digest('hex').slice(0, 24);
}

function sessionUrl(base, id) {
  const normalized = serverUrl(base);
  const encoded = Buffer.from(normalized).toString('base64url');
  return normalized + '/server/' + encoded + '/session/' + encodeURIComponent(id);
}

function readerUrl(base, id) {
  if (!/^ses_[A-Za-z0-9]+$/.test(id)) throw new Error('Choose a valid OpenCode session first.');
  return serverUrl(base) + '/read/' + encodeURIComponent(id);
}

function sessionIdFromUrl(value) {
  try { return new URL(value).pathname.match(/\/session\/(ses_[A-Za-z0-9]+)(?:\/|$)/)?.[1] || ''; }
  catch { return ''; }
}

module.exports = { DEFAULTS, loadSettings, serverUrl, authHeaders, inServerScope, partitionKey, sessionUrl, readerUrl, sessionIdFromUrl };

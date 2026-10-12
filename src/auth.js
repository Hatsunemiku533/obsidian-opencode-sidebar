const { authHeaders, inServerScope, serverUrl } = require('./core');

function attachAuth(webContents, settings, report) {
  const base = serverUrl(settings.serverUrl);
  const session = webContents.session;
  const webRequest = session.webRequest;
  const headers = authHeaders(settings);
  // The embedded page must never raise native OS notifications. Every other permission keeps
  // Electron's default: granted, except deprecated-sync-clipboard-read, which Electron denies.
  session.setPermissionCheckHandler((_wc, permission) => permission !== 'notifications' && permission !== 'deprecated-sync-clipboard-read');
  session.setPermissionRequestHandler((_wc, permission, callback) => callback(permission !== 'notifications'));
  // This partition belongs to this vault/server only. Never send credentials to redirects outside it.
  webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    for (const key of Object.keys(requestHeaders)) {
      if (key.toLowerCase() === 'authorization') delete requestHeaders[key];
    }
    if (inServerScope(details.url, base)) Object.assign(requestHeaders, headers);
    callback({ requestHeaders });
  });
  const login = (event, details, info, callback) => {
    if (info.isProxy || !settings.basicAuth || !inServerScope(String(details.url), base)) {
      event.preventDefault();
      callback();
      report('Authentication required. Check the Basic Auth settings.');
      return;
    }
    event.preventDefault();
    if (details.firstAuthAttempt === false) {
      callback();
      report('Basic Auth was rejected. Check the username and password.');
    } else callback(settings.username, settings.password);
  };
  webContents.on('login', login);
  return () => {
    if (webContents.isDestroyed()) return;
    webContents.removeListener('login', login);
    webRequest.onBeforeSendHeaders(null);
    session.setPermissionCheckHandler(null);
    session.setPermissionRequestHandler(null);
  };
}

module.exports = { attachAuth };

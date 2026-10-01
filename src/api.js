const { serverUrl, authHeaders } = require('./core');

function apiGet(settings, pathname, params = {}) {
  const base = serverUrl(settings.serverUrl);
  const url = new URL(base + pathname);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  // Do not automatically follow redirects with an Authorization header.
  const transport = require(url.protocol === 'https:' ? 'node:https' : 'node:http');
  return new Promise((resolve, reject) => {
    const request = transport.get(url, { headers: { ...authHeaders(settings), Accept: 'application/json' } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        const error = new Error(response.statusCode === 401 ? 'Authentication failed.' : 'Server returned HTTP ' + response.statusCode + '.');
        error.status = response.statusCode;
        reject(error);
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 8 * 1024 * 1024) request.destroy(new Error('Response is too large.'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Server response is not valid JSON.')); }
      });
    });
    request.setTimeout(8000, () => request.destroy(new Error('Server request timed out.')));
    request.on('error', reject);
  });
}

module.exports = { apiGet };

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { apiGet } = require('../src/api');

test('real HTTP: no auth, optional auth, directory query and redirect rejection', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url === '/oc/redirect') { res.writeHead(302, { Location: '/other' }).end(); return; }
    if (req.url === '/oc/protected' && req.headers.authorization !== 'Basic dTpw') { res.writeHead(401).end(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const settings = { serverUrl: 'http://127.0.0.1:' + server.address().port + '/oc', basicAuth: false };
  assert.deepEqual(await apiGet(settings, '/global/health'), { ok: true });
  assert.equal(seen[0].authorization, undefined);
  await assert.rejects(apiGet(settings, '/protected'), (error) => error.status === 401);
  const withAuth = { ...settings, basicAuth: true, username: 'u', password: 'p' };
  assert.deepEqual(await apiGet(withAuth, '/protected'), { ok: true });
  await apiGet(settings, '/session', { directory: '/a b/project' });
  assert.equal(new URL('http://test' + seen.at(-1).url).searchParams.get('directory'), '/a b/project');
  const count = seen.length;
  await assert.rejects(apiGet(withAuth, '/redirect'), (error) => error.status === 302);
  assert.equal(seen.length, count + 1);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { withSettingsLock } = require('../src/storage');

test('simultaneous vault saves merge without losing entries and release on failure', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-settings-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const data = path.join(dir, 'data.json'); const lock = data + '.lock';
  await fs.writeFile(data, '{}');
  const save = (key) => withSettingsLock(lock, async () => {
    const state = JSON.parse(await fs.readFile(data, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    state[key] = key;
    await fs.writeFile(data, JSON.stringify(state));
  });
  await Promise.all([save('/vault/a'), save('/vault/b'), save('/vault/c')]);
  assert.equal(Object.keys(JSON.parse(await fs.readFile(data, 'utf8'))).length, 3);
  await assert.rejects(withSettingsLock(lock, async () => { throw Error('test failure'); }));
  await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
});

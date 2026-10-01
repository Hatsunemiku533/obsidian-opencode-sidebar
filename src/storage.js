const fs = require('node:fs/promises');

async function withSettingsLock(file, action) {
  let handle;
  const deadline = Date.now() + 5000;
  while (!handle) {
    try { handle = await fs.open(file, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Settings are locked by another window. Retry after closing it; after a crash, remove data.json.lock from the plugin folder.');
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  try { return await action(); }
  finally { await handle.close(); await fs.unlink(file); }
}

module.exports = { withSettingsLock };

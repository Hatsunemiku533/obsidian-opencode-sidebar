const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

(async () => {
  const katexDir = path.dirname(require.resolve('katex/dist/katex.min.js'));
  const katexScript = fs.readFileSync(path.join(katexDir, 'katex.min.js'), 'utf8');
  const katexCss = fs.readFileSync(path.join(katexDir, 'katex.min.css'), 'utf8').replace(/url\((?:["'])?(fonts\/[^)"']+)(?:["'])?\)/g, (_, file) => {
    const mime = file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.woff') ? 'font/woff' : 'font/ttf';
    return 'url(data:' + mime + ';base64,' + fs.readFileSync(path.join(katexDir, file)).toString('base64') + ')';
  });
  const page = await esbuild.build({ entryPoints: ['src/page.js'], bundle: true, write: false, format: 'iife', globalName: 'OpenCodePage', minify: true, target: 'chrome120' });
  await esbuild.build({
    entryPoints: ['src/main.js'], bundle: true, platform: 'node', format: 'cjs', target: 'chrome120',
    external: ['obsidian', 'electron', '@electron/remote'], outfile: 'main.js',
    define: { KATEX_SCRIPT: JSON.stringify(katexScript), KATEX_CSS: JSON.stringify(katexCss), PAGE_SCRIPT: JSON.stringify(page.outputFiles[0].text) },
    banner: { js: '/*\n' + fs.readFileSync('LICENSE', 'utf8') + '\nBundled KaTeX:\n' + fs.readFileSync(path.join(katexDir, '..', 'LICENSE'), 'utf8') + '\n*/' }
  });
  console.log('Built self-contained main.js (no runtime npm or external KaTeX folder needed).');
})().catch((error) => { console.error(error); process.exitCode = 1; });

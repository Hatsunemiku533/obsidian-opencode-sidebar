const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { createHash } = require('node:crypto');

(async () => {
  const buildId = createHash('sha256').update(['build.cjs', 'styles.css', 'manifest.json', ...fs.readdirSync('src').sort().map((name) => 'src/' + name)].map((file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).join('\n')).digest('hex').slice(0, 12);
  const katexDir = path.dirname(require.resolve('katex/dist/katex.min.js'));
  const katexScript = fs.readFileSync(path.join(katexDir, 'katex.min.js'), 'utf8');
  const katexCss = fs.readFileSync(path.join(katexDir, 'katex.min.css'), 'utf8').replace(/url\((?:["'])?(fonts\/[^)"']+)(?:["'])?\)/g, (_, file) => {
    const mime = file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.woff') ? 'font/woff' : 'font/ttf';
    return 'url(data:' + mime + ';base64,' + fs.readFileSync(path.join(katexDir, file)).toString('base64') + ')';
  });
  const page = await esbuild.build({ entryPoints: ['src/page.js'], bundle: true, write: false, format: 'iife', globalName: 'OpenCodePage', minify: true, target: 'chrome120' });
  const diagnostics = await esbuild.build({ entryPoints: ['src/page-diagnostics.js'], bundle: true, write: false, format: 'iife', globalName: 'OpenCodeDiagnostics', minify: true, target: 'chrome120' });
  const theme = await esbuild.build({ entryPoints: ['src/theme.js'], bundle: true, write: false, format: 'iife', globalName: 'OpenCodeTheme', minify: true, target: 'chrome120' });
  const projects = await esbuild.build({ entryPoints: ['src/projects.js'], bundle: true, write: false, format: 'iife', globalName: 'OpenCodeProjects', minify: true, target: 'chrome120' });
  await esbuild.build({
    entryPoints: ['src/main.js'], bundle: true, platform: 'node', format: 'cjs', target: 'chrome120',
    external: ['obsidian', 'electron', '@electron/remote'], outfile: 'main.js',
    define: { KATEX_SCRIPT: JSON.stringify(katexScript), KATEX_CSS: JSON.stringify(katexCss), PAGE_SCRIPT: JSON.stringify(page.outputFiles[0].text), DIAGNOSTIC_SCRIPT: JSON.stringify(diagnostics.outputFiles[0].text), THEME_SCRIPT: JSON.stringify(theme.outputFiles[0].text), PROJECT_SCRIPT: JSON.stringify(projects.outputFiles[0].text), BUILD_ID: JSON.stringify(buildId) },
    banner: { js: '/*\n' + fs.readFileSync('LICENSE', 'utf8') + '\nBundled KaTeX:\n' + fs.readFileSync(path.join(katexDir, '..', 'LICENSE'), 'utf8') + '\n*/' }
  });
  console.log('Built self-contained main.js (no runtime npm or external KaTeX folder needed).');
})().catch((error) => { console.error(error); process.exitCode = 1; });

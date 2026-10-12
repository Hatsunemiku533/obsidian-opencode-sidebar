const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { inServerScope, serverUrl } = require('./core');

const { errorSummary } = require('./error-summary');

function scrub(value, secrets = []) {
  if (typeof value === 'string') {
    let text = value;
    const forms = secrets.filter(Boolean).flatMap((secret) => [secret, encodeURIComponent(secret)]).sort((a, b) => b.length - a.length);
    for (const secret of forms) text = text.split(secret).join('[redacted]');
    return text.replace(/https?:\/\/[^\s<>"']+/gi, '[url omitted]')
      .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, 'Basic [redacted]')
      .replace(/\bses_[A-Za-z0-9]+\b/g, '[session]')
      .slice(0, 1000);
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => scrub(item, secrets));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:password|token|authorization|cookie|headers|body|html|text|content|message|stack|path|url|href|directory|title)$/i.test(key)) continue;
      result[key] = scrub(item, secrets);
    }
    return result;
  }
  return value;
}

class DiagnosticLog {
  constructor(vaultPath, getSecrets = () => [], options = {}) {
    const id = createHash('sha256').update(vaultPath).digest('hex').slice(0, 16);
    this.file = path.join(options.directory || path.join(os.tmpdir(), 'opencode-sidebar'), id + '.log');
    this.limit = options.limit || 512 * 1024;
    this.getSecrets = getSecrets;
    this.recent = [];
    this.sequence = 0;
    this.diskError = null;
  }
  write(event, data = {}) {
    const entry = scrub({ ...data, time: new Date().toISOString(), event, sequence: ++this.sequence }, this.getSecrets());
    const line = JSON.stringify(entry);
    this.recent.push(line);
    if (this.recent.length > 300) this.recent.shift();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if (fs.existsSync(this.file) && fs.statSync(this.file).size + Buffer.byteLength(line) > this.limit) {
        // Rotation is cross-process exclusive; never let two windows delete each other's backup.
        const lock = fs.openSync(this.file + '.rotation.lock', 'wx');
        try {
          if (fs.existsSync(this.file) && fs.statSync(this.file).size + Buffer.byteLength(line) > this.limit) {
            if (fs.existsSync(this.file + '.1')) fs.unlinkSync(this.file + '.1');
            fs.renameSync(this.file, this.file + '.1');
          }
        } finally { fs.closeSync(lock); fs.unlinkSync(this.file + '.rotation.lock'); }
      }
      fs.appendFileSync(this.file, line + '\n', { encoding: 'utf8', mode: 0o600 });
      this.diskError = null;
    } catch (error) { this.diskError = errorSummary(error); }
  }
  copy() {
    const lines = [];
    try {
      for (const file of [this.file + '.1', this.file]) {
        if (fs.existsSync(file)) lines.push(fs.readFileSync(file, 'utf8'));
      }
    } catch {}
    // Include records that failed to persist even if older disk entries remain or a later write recovered.
    lines.push(this.recent.join('\n'));
    const entries = [...new Set(lines.join('\n').split('\n').filter(Boolean))].flatMap((line) => {
      try { return [scrub(JSON.parse(line), this.getSecrets())]; } catch { return []; }
    }).sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')) || (a.sequence || 0) - (b.sequence || 0));
    return JSON.stringify(scrub({ persistence: this.diskError ? 'failed' : 'ok', error: this.diskError }, this.getSecrets())) + '\n' +
      entries.slice(-300).map((entry) => JSON.stringify(entry)).join('\n');
  }
}

function navigationSummary(value, base) {
  try {
    const url = new URL(value);
    const route = /\/session\//.test(url.pathname) ? 'session' : /\/new-session\b/.test(url.pathname) ? 'new-session' : url.pathname === '/' ? 'home' : 'other';
    return { route, credentialsPresent: !!(url.username || url.password), withinServer: inServerScope(value, base), scheme: url.protocol.replace(':', '') };
  } catch { return { route: 'unknown', withinServer: false }; }
}

function attachNetworkDiagnostics(wc, settings, record) {
  const base = serverUrl(settings.serverUrl);
  const filter = { urls: [new URL(base).origin + '/*'] };
  const summarize = (details) => {
    const url = new URL(details.url);
    const asset = url.pathname.match(/\/assets\/([A-Za-z0-9_.-]+\.(?:js|css|woff2?))$/)?.[1];
    return { resource: details.resourceType, ...(asset ? { asset } : {}), status: details.statusCode, cached: !!details.fromCache };
  };
  const completed = (details) => {
    if (!inServerScope(details.url, base)) return;
    if (details.statusCode >= 400 || ['mainFrame', 'script', 'stylesheet'].includes(details.resourceType)) {
      record('resource-response', summarize(details));
    }
  };
  const failed = (details) => {
    if (details.error === 'net::ERR_ABORTED' || !inServerScope(details.url, base)) return;
    const code = /^net::ERR_[A-Z0-9_]+$/.test(details.error) ? details.error : 'network-error';
    record('resource-failed', { ...summarize(details), code });
  };
  wc.session.webRequest.onCompleted(filter, completed);
  wc.session.webRequest.onErrorOccurred(filter, failed);
  return () => {
    if (wc.isDestroyed()) return;
    wc.session.webRequest.onCompleted(null);
    wc.session.webRequest.onErrorOccurred(null);
  };
}

function classifySnapshot(snapshot) {
  if (snapshot.navigation?.credentialsPresent) return { category: 'credential-url', advice: '页面地址含内嵌凭据：这会触发已知前端问题。保留日志后重新连接到干净地址，用设置中的 Basic Auth。' };
  if (snapshot.documentStatus === 401 || snapshot.health?.status === 401) return { category: 'authentication', advice: '认证失败：核对用户名、密码和 Basic Auth 开关，不要把密码放进 URL。' };
  if (snapshot.documentStatus >= 400) return { category: 'document-http', advice: '网页主文档返回 HTTP 错误：检查该状态对应的服务权限、地址或反向代理路由；不要把它当作正常初始化。' };
  if (snapshot.rendererGone) return { category: 'renderer', advice: '嵌入页渲染进程已退出：先保留日志，再重新加载侧栏。' };
  if (snapshot.health?.ok === false) return { category: 'server-connection', advice: 'API 未连通：先检查服务进程、地址、网络或 TLS；日志里的错误代码可区分。' };
  if (snapshot.resources?.some((item) => ['script', 'stylesheet'].includes(item.resource))) return { category: 'static-resources', advice: '脚本或样式加载失败：检查静态资源、反向代理路径和认证；先不要清缓存。' };
  if (snapshot.page?.errorPage || (snapshot.page?.runtimeError && !snapshot.page.ready)) return { category: 'frontend', advice: '前端异常：查看错误类型和脚本行号；若错误详情未展开，展开后再诊断一次，或打开嵌入页开发者工具。' };
  if (snapshot.size && (!snapshot.size.width || !snapshot.size.height)) return { category: 'layout', advice: '侧栏尺寸为零：先展开面板，再诊断页面。' };
  if (snapshot.page?.ready && snapshot.page.runtimeError) return { category: 'ready-with-recent-error', advice: '页面已有内容，但最近一分钟捕获过前端异常：对照异常时间与当前症状，不把旧错误当作当前整页故障。' };
  if (snapshot.page?.ready) return { category: 'ready', advice: '应用根节点已有内容；若仍有局部功能故障，在复现后复制日志或打开开发者工具。' };
  if (snapshot.health?.ok && snapshot.page) return { category: 'blank-page', advice: '服务在线但页面未初始化：对照文档状态、根节点和资源记录排查，不能仅凭 API 正常判定页面正常。' };
  return { category: 'incomplete', advice: '页面证据不足：查看检查超时或生命周期记录，必要时打开嵌入页开发者工具。' };
}

module.exports = { DiagnosticLog, errorSummary, scrub, navigationSummary, attachNetworkDiagnostics, classifySnapshot };

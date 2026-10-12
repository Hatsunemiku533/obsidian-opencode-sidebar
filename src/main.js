const { Plugin, ItemView, Notice, Setting, PluginSettingTab, SuggestModal, Modal, Menu, setIcon, apiVersion } = require('obsidian');
const { loadSettings, serverUrl, authHeaders, partitionKey, sessionUrl, readerUrl, sessionIdFromUrl } = require('./core');
const { attachAuth } = require('./auth');
const { apiGet } = require('./api');
const { withSettingsLock } = require('./storage');
const { DiagnosticLog, errorSummary, scrub, navigationSummary, attachNetworkDiagnostics, classifySnapshot } = require('./diagnostics');
const { safeErrorSummary } = require('./error-summary');
const { normalizeProjectMemory } = require('./projects');
const { FONTS, FONT_SIZES, DEFAULT_FONT_SIZE } = require('./theme');

const VIEW_TYPE = 'opencode-sidebar-view';

function remoteModule() {
  const electron = require('electron');
  return electron.remote || require('@electron/remote');
}

class ConfirmReload extends Modal {
  constructor(app, reload) { super(app); this.reload = reload; }
  onOpen() {
    this.contentEl.createEl('h3', { text: '重新加载 OpenCode？' });
    this.contentEl.createEl('p', { text: '未发送的草稿可能丢失，已保存的对话不会被删除。' });
    const row = this.contentEl.createDiv({ cls: 'oc-sb-actions' });
    row.createEl('button', { text: '取消' }).onclick = () => this.close();
    const button = row.createEl('button', { text: '重新加载', cls: 'mod-cta' });
    button.onclick = () => { this.close(); this.reload(); };
  }
  onClose() { this.contentEl.empty(); }
}

class SessionPicker extends SuggestModal {
  constructor(app, sessions, choose) { super(app); this.sessions = sessions; this.choose = choose; this.modalEl.addClass('oc-sb-picker'); this.setPlaceholder('搜索当前目录的会话'); }
  getSuggestions(query) { return this.sessions.filter((s) => (s.title || s.id).toLowerCase().includes(query.toLowerCase())); }
  renderSuggestion(session, element) {
    element.createDiv({ text: session.title || session.id });
    if (session.time && session.time.updated) element.createDiv({ cls: 'oc-sb-muted', text: new Date(session.time.updated).toLocaleString() });
  }
  onChooseSuggestion(session) { this.choose(session); }
}

class SidebarView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf); this.plugin = plugin; this.debug = []; this.closed = false;
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'OpenCode'; }
  getIcon() { return 'terminal'; }
  log(event, data = {}) {
    const record = { connection: this.connection, elapsedMs: this.started ? Date.now() - this.started : 0, ...data };
    const secrets = this.plugin.diagnosticSecrets?.() || [];
    this.debug.push(JSON.stringify(scrub({ time: new Date().toISOString(), event, ...record }, secrets)));
    if (this.debug.length > 300) this.debug.shift();
    this.plugin.logger?.write(event, record);
  }
  setStatus(kind, message) {
    if (this.closed || !this.statusEl) return;
    this.statusEl.empty();
    this.statusEl.createSpan({ cls: 'oc-sb-dot ' + kind });
    this.statusEl.createSpan({ text: ' ' + message });
  }
  async onOpen() {
    this.contentEl.empty(); this.contentEl.addClass('oc-sb'); this.closed = false;
    const bar = this.contentEl.createDiv({ cls: 'oc-sb-bar' });
    this.sessionButton = bar.createEl('button', { text: '选择会话', cls: 'oc-sb-session-btn', attr: { title: '选择当前项目目录的会话' } });
    this.sessionButton.onclick = () => this.chooseSession();
    const read = bar.createEl('button', { cls: 'oc-sb-icon-btn', attr: { 'aria-label': '在浏览器打开本会话阅读页', title: '在浏览器打开本会话阅读页' } });
    setIcon(read, 'book-open');
    read.onclick = () => this.openRead();
    const refresh = bar.createEl('button', { cls: 'oc-sb-icon-btn', attr: { 'aria-label': '重新加载嵌入页', title: '重新加载嵌入页' } });
    setIcon(refresh, 'refresh-cw');
    refresh.onclick = () => new ConfirmReload(this.app, () => this.reconnect()).open();
    const type = bar.createEl('button', { cls: 'oc-sb-icon-btn', attr: { 'aria-label': '字体与字号', title: '字体与字号' } });
    setIcon(type, 'type');
    type.onclick = (event) => this.plugin.showTypeMenu(event);
    const more = bar.createEl('button', { cls: 'oc-sb-icon-btn', attr: { 'aria-label': '更多操作', title: '更多操作' } });
    setIcon(more, 'ellipsis');
    more.onclick = (event) => {
      const menu = new Menu();
      menu.addItem((item) => item.setTitle('打开 OpenCode TUI').setIcon('terminal').onClick(() => this.plugin.launchTUI()));
      menu.addItem((item) => item.setTitle('诊断嵌入页').setIcon('activity').onClick(() => this.diagnoseEmbed()));
      menu.addItem((item) => item.setTitle('复制调试日志').setIcon('copy').onClick(() => this.copyDiagnostics()));
      menu.addItem((item) => item.setTitle('打开日志文件').setIcon('file-code').onClick(() => this.openLog()));
      menu.addItem((item) => item.setTitle('打开嵌入页开发者工具').setIcon('bug').onClick(() => {
        if (this.webview) this.webview.openDevTools();
      }));
      menu.addItem((item) => item.setTitle('检查服务连接').setIcon('activity').onClick(() => this.checkConnection()));
      menu.showAtMouseEvent(event);
    };
    this.embedEl = this.contentEl.createDiv({ cls: 'oc-sb-embed' });
    this.statusEl = this.contentEl.createDiv({ cls: 'oc-sb-status' });
    this.watchStatusRow();
    this.createEmbed();
  }
  // The status line shares the bottom row with Obsidian's floating status bar
  // instead of sitting above an empty strip; keep its text clear of that bar.
  watchStatusRow() {
    const doc = this.contentEl.ownerDocument;
    const fit = () => {
      if (this.closed || !this.statusEl) return;
      const own = this.statusEl.getBoundingClientRect();
      const bar = doc.querySelector('.status-bar')?.getBoundingClientRect();
      const covered = bar && bar.width > 0 && bar.top < own.bottom && bar.bottom > own.top && bar.left < own.right && bar.right > own.left;
      this.statusEl.style.paddingRight = covered ? Math.ceil(own.right - bar.left + 12) + 'px' : '';
    };
    this.statusObserver?.disconnect();
    this.statusObserver = new ResizeObserver(() => fit());
    this.statusObserver.observe(this.contentEl);
    const bar = doc.querySelector('.status-bar');
    if (bar) this.statusObserver.observe(bar);
    fit();
  }
  disposeEmbed() {
    if (this.webview) this.log('view-disposed');
    clearTimeout(this.readyTimer); clearInterval(this.recoveryTimer);
    clearInterval(this.projectTimer); this.projectTimer = null;
    this.recoveryTimer = null;
    for (const key of ['detachProjects', 'detachNetwork', 'detachAuth']) {
      try { this[key]?.()?.catch?.(() => {}); } catch (error) { this.log('hook-cleanup-failed', { hook: key, error: errorSummary(error) }); }
      this[key] = null;
    }
    if (this.webview) { this.webview.remove(); this.webview = null; }
  }
  async reconnect() {
    const view = this.webview;
    try { await this.captureDiagnostic('before-reconnect', false); }
    catch (error) { this.log('pre-reconnect-inspection-failed', { error: errorSummary(error) }); }
    if (!this.closed && this.webview === view) {
      await this.projectCapture;
      await this.captureProjects(view);
      if (!this.closed && this.webview === view) this.createEmbed();
    }
  }
  prepareProjectScript(settings) {
    this.projectIdentity = partitionKey(this.plugin.vaultPath, settings);
    const memory = normalizeProjectMemory(settings.projectMemory);
    this.projectSnapshot = memory.identity === this.projectIdentity ? JSON.stringify(memory) : null; this.projectMonitorReady = false;
    this.projectRestoreFailed = false;
    this.projectRestorePending = !!settings.rememberProjects && memory.identity === this.projectIdentity;
    if (!this.projectRestorePending) return '';
    // Obsidian strips webview preloads. Register only a same-origin, main-frame page script.
    return PROJECT_SCRIPT + ';if(window===window.top)OpenCodeProjects.restoreProjects(window,' +
      JSON.stringify(memory) + ',' + JSON.stringify(this.projectIdentity) + ',' + JSON.stringify(this.base) + ');';
  }
  async installProjectRestore(wc, source) {
    if (!source) return;
    const debuggerApi = wc.debugger;
    if (debuggerApi.isAttached()) throw new Error('Guest debugger already attached.');
    debuggerApi.attach('1.3');
    let identifier;
    this.detachProjects = async () => {
      try {
        if (identifier && debuggerApi.isAttached()) await debuggerApi.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier });
      } finally { if (debuggerApi.isAttached()) debuggerApi.detach(); }
    };
    await debuggerApi.sendCommand('Page.enable');
    ({ identifier } = await debuggerApi.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source }));
    this.log('project-restore-registered');
  }
  captureProjects(view = this.webview, closing = false) {
    if (!view || this.webview !== view || (!closing && this.closed) || !this.projectMonitorReady || this.projectRestorePending || this.projectRestoreFailed ||
        !this.plugin.settings.rememberProjects || this.projectCapture) return this.projectCapture || Promise.resolve();
    const identity = this.projectIdentity;
    this.projectCapture = (async () => {
      let timer;
      try {
        const memory = normalizeProjectMemory(await Promise.race([
          view.executeJavaScript(PROJECT_SCRIPT + ';OpenCodeProjects.captureProjects(window,' + JSON.stringify(identity) + ',' + JSON.stringify(this.base) + ');'),
          new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1000); })
        ]));
        if (this.webview !== view || (!closing && this.closed) || !this.plugin.settings.rememberProjects || memory.identity !== identity ||
            partitionKey(this.plugin.vaultPath, this.plugin.settings) !== identity) return;
        const snapshot = JSON.stringify(memory);
        if (snapshot === this.projectSnapshot) return;
        this.plugin.settings.projectMemory = memory;
        const saved = await this.plugin.saveSettings(true);
        if (saved !== false) this.projectSnapshot = snapshot;
      } catch (error) { this.log('project-memory-save-failed', { error: errorSummary(error) }); }
      finally { clearTimeout(timer); }
    })().finally(() => { this.projectCapture = null; });
    return this.projectCapture;
  }
  createEmbed() {
    this.disposeEmbed();
    let base;
    try { base = serverUrl(this.plugin.settings.serverUrl); authHeaders(this.plugin.settings); }
    catch (error) { this.setStatus('err', error.message); return; }
    this.base = base; this.readyAttempts = 0; this.mainStatus = null;
    this.setStatus('checking', '正在连接 OpenCode…');
    const settings = { ...this.plugin.settings };
    const view = document.createElement('webview');
    this.webview = view;
    // Each live webview has a private session, so auth hooks never collide across windows.
    const { randomUUID } = require('node:crypto');
    this.connection = randomUUID().slice(0, 8); this.started = Date.now();
    this.resourceFailures = []; this.rendererGone = false; this.runtimeSignals = new Map();
    this.log('connection-start', { basicAuth: !!settings.basicAuth, mathFixes: !!settings.mathFixes });
    view.setAttribute('partition', partitionKey(this.plugin.vaultPath, settings).replace('persist:', '') + '-' + randomUUID());
    try {
      this.projectSource = this.prepareProjectScript(settings);
    } catch (error) { this.projectRestoreFailed = true; this.log('project-restore-failed', { error: errorSummary(error) }); }
    view.addEventListener('did-attach', async () => {
      if (this.webview !== view || this.closed) return;
      try {
        const wc = remoteModule().webContents.fromId(view.getWebContentsId());
        if (!wc) throw new Error('Guest webContents unavailable.');
        this.detachAuth = attachAuth(wc, settings, (message) => this.setStatus('err', message));
        this.detachNetwork = attachNetworkDiagnostics(wc, settings, (event, data) => {
          if (this.webview !== view || this.closed) return;
          this.log(event, data);
          if (event === 'resource-failed' || data.status >= 400) {
            this.resourceFailures.push({ ...data });
            if (this.resourceFailures.length > 20) this.resourceFailures.shift();
          }
        });
        this.log('Scoped authentication hooks attached.');
        try { await this.installProjectRestore(wc, this.projectSource); }
        catch (error) { this.projectRestoreFailed = true; this.log('project-restore-failed', { error: errorSummary(error) }); }
        if (this.webview !== view || this.closed) return;
        view.setAttribute('src', base + '/');
      } catch (error) {
        this.setStatus('err', 'Cannot initialize the Electron webview. Try updating Obsidian desktop.');
        this.log('auth-hook-failed', { error: errorSummary(error) });
      }
    });
    view.addEventListener('did-navigate', (event) => {
      if (this.webview !== view) return;
      this.log('document-navigation', navigationSummary(event.url, base));
    });
    view.addEventListener('did-frame-navigate', (event) => {
      if (this.webview !== view || event.isMainFrame === false) return;
      this.log('Main document HTTP status: ' + (event.httpResponseCode ?? 'unknown'));
      this.mainStatus = event.httpResponseCode;
      if (event.httpResponseCode === 401) this.setStatus('err', 'Authentication failed. Check Basic Auth settings.');
      else if (event.httpResponseCode >= 400) this.setStatus('err', 'Page returned HTTP ' + event.httpResponseCode + '.');
      if (event.httpResponseCode >= 400) this.captureDiagnostic('document-http-error', false).catch(() => {});
    });
    view.addEventListener('dom-ready', async () => {
      if (this.webview !== view || view.getURL() === 'about:blank') return;
      this.log('dom-ready');
      if (this.projectRestorePending) {
        const detachProjects = this.detachProjects;
        try {
          const restored = await view.executeJavaScript('localStorage.getItem("oc-sidebar-projects-restored") === "1"');
          if (this.webview !== view || this.closed) return;
          this.projectRestoreFailed ||= !restored;
          this.log('project-restore-checked', { restored: !!restored });
        } catch (error) {
          if (this.webview === view) { this.projectRestoreFailed = true; this.log('project-restore-failed', { error: errorSummary(error) }); }
        }
        finally {
          if (this.webview === view) this.projectRestorePending = false;
          try { await detachProjects?.(); } catch (error) { this.log('project-restore-cleanup-failed', { error: errorSummary(error) }); }
          if (this.detachProjects === detachProjects) this.detachProjects = null;
        }
      }
      if (this.webview !== view || this.closed) return;
      this.applyTheme(view);
      view.executeJavaScript(DIAGNOSTIC_SCRIPT + ';OpenCodeDiagnostics.installPageDiagnostics(window);')
        .catch((error) => this.log('page-diagnostics-hook-failed', { error: errorSummary(error) }));
      this.probeReady(view);
      if (settings.mathFixes && this.mainStatus !== 401) this.injectMath(view);
    });
    view.addEventListener('did-fail-load', (event) => {
      if (this.webview !== view || event.errorCode === -3 || event.isMainFrame === false) return;
      this.setStatus('err', 'Page load failed (' + event.errorCode + '). Waiting for the server...');
      this.log('Main document load failed: ' + event.errorCode);
      this.captureDiagnostic('document-load-failed', false).catch(() => {});
      this.startRecovery(view, settings);
    });
    view.addEventListener('render-process-gone', (event) => {
      if (this.webview !== view) return;
      this.rendererGone = true;
      const reason = event.details?.reason || event.reason;
      this.log('renderer-gone', { reason: ['crashed', 'killed', 'oom', 'launch-failed', 'integrity-failure', 'clean-exit'].includes(reason) ? reason : 'unknown' });
      this.setStatus('err', 'The webview renderer stopped. Click Reload.');
      this.captureDiagnostic('renderer-gone', false).catch(() => {});
    });
    view.addEventListener('console-message', (event) => {
      if (this.webview !== view || !([2, 3, 'warning', 'error'].includes(event.level))) return;
      const message = String(event.message || '');
      if (message.startsWith('[oc-sidebar-diagnostic]')) {
        try {
          const payload = JSON.parse(message.slice('[oc-sidebar-diagnostic]'.length));
          this.recordRuntimeError(safeErrorSummary(payload), view);
        } catch {}
      } else if (event.level === 3 || event.level === 'error' || /(?:context must be|Content Security Policy)/.test(message)) {
        this.recordRuntimeError(errorSummary(message + '\n' + String(event.sourceId || '') + ':' + (event.line || 0) + ':0'), view);
      }
    });
    view.addEventListener('did-navigate-in-page', (event) => {
      if (this.webview !== view || this.closed || event.isMainFrame === false) return;
      this.log('in-page-navigation', navigationSummary(event.url, base));
      this.updateSessionTitle(view, event.url);
      this.readyAttempts = 0; this.probeReady(view);
    });
    // Set src last, after all listeners are installed; never put credentials in it.
    view.setAttribute('src', 'about:blank');
    this.embedEl.appendChild(view);
  }
  async inspectPage(view, timeoutMs = 4000) {
    let timeout;
    try {
      return await Promise.race([
        view.executeJavaScript(DIAGNOSTIC_SCRIPT + ';OpenCodeDiagnostics.pageSnapshot(window);'),
        new Promise((resolve, reject) => { timeout = setTimeout(() => {
          const error = new Error('Diagnostic page inspection timed out.'); error.code = 'ERR_DIAGNOSTIC_TIMEOUT'; reject(error);
        }, timeoutMs); })
      ]);
    } finally { clearTimeout(timeout); }
  }
  async probeReady(view) {
    if (this.closed || this.webview !== view || this.mainStatus === 401) return;
    clearTimeout(this.readyTimer);
    try {
      const state = await this.inspectPage(view);
      if (this.webview !== view || this.closed) return;
      if (state.errorPage) {
        this.log('app-error-page', { error: state.pageError });
        this.setStatus('err', 'OpenCode reported a page error. Diagnose before reloading.');
        this.captureDiagnostic('app-error-page', false).catch(() => {}); return;
      }
      if (state.ready) {
        this.log('page-ready', { page: state });
        this.setStatus(this.projectRestoreFailed ? 'warn' : 'ok', this.projectRestoreFailed ? '网页已就绪，但项目恢复失败；请查看诊断日志。' : 'OpenCode 页面已就绪');
        this.updateSessionTitle(view, view.getURL());
        this.projectMonitorReady = !this.projectRestoreFailed && !this.projectRestorePending;
        this.captureProjects(view);
        if (!this.projectTimer) this.projectTimer = setInterval(() => this.captureProjects(view), 1000);
        return;
      }
      if (++this.readyAttempts >= 15) {
        this.setStatus('warn', 'Server page has not initialized. Diagnose before reloading.');
        this.captureDiagnostic('initialization-timeout', false).catch(() => {}); return;
      }
      this.readyTimer = setTimeout(() => this.probeReady(view), 1000);
    } catch (error) {
      if (this.webview === view && !this.closed) {
        this.log('page-probe-failed', { error: errorSummary(error) });
        this.setStatus('warn', 'Cannot inspect the page. Diagnose before reloading.');
        this.captureDiagnostic('page-probe-failed', false).catch(() => {});
      }
    }
  }
  recordRuntimeError(summary, view) {
    if (summary.kind === 'resize-observer' || this.webview !== view) return;
    const signature = JSON.stringify(summary);
    if (Date.now() - (this.runtimeSignals.get(signature) || 0) < 10000) return;
    if (this.runtimeSignals.size > 100) this.runtimeSignals.clear();
    this.runtimeSignals.set(signature, Date.now());
    this.log('page-runtime-error', { error: summary });
    this.captureDiagnostic('page-runtime-error', false).catch(() => {});
  }
  async captureDiagnostic(reason, includeHealth = true) {
    const view = this.webview;
    const connection = this.connection;
    const snapshot = { reason, documentStatus: this.mainStatus, rendererGone: !!this.rendererGone, resources: [...(this.resourceFailures || [])] };
    if (view) {
      const rect = view.getBoundingClientRect();
      snapshot.size = { width: Math.round(rect.width), height: Math.round(rect.height) };
      try { snapshot.navigation = navigationSummary(view.getURL(), this.base); } catch {}
    }
    const start = Date.now();
    const page = view && !this.rendererGone ? this.inspectPage(view)
      .then((data) => { snapshot.page = data; }, (error) => { snapshot.inspectionError = errorSummary(error); }) : Promise.resolve();
    const health = includeHealth ? apiGet(this.plugin.settings, '/global/health').then((data) => {
      snapshot.health = { ok: true, elapsedMs: Date.now() - start, ...(typeof data?.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(data.version) ? { version: data.version } : {}) };
    }, (error) => { snapshot.health = { ok: false, status: error.status, elapsedMs: Date.now() - start, error: errorSummary(error) }; }) : Promise.resolve();
    await Promise.all([page, health]);
    if (this.webview !== view || this.connection !== connection || this.closed) return null;
    snapshot.finding = classifySnapshot(snapshot);
    this.log('diagnostic-snapshot', snapshot);
    return snapshot;
  }
  diagnoseEmbed() {
    if (!this.diagnosing) this.diagnosing = (async () => {
      try {
        const result = await this.captureDiagnostic('manual');
        if (result) new Notice(result.finding.advice + '\n诊断已写入日志，可用“复制调试日志”交给排查者。', 10000);
      } catch (error) { this.log('diagnostic-failed', { error: errorSummary(error) }); new Notice('诊断未完成，检查日志或打开嵌入页开发者工具。'); }
    })().finally(() => { this.diagnosing = null; });
    return this.diagnosing;
  }
  async copyDiagnostics() {
    await this.diagnoseEmbed();
    require('electron').clipboard.writeText(this.plugin.logger?.copy() || this.debug.join('\n'));
    new Notice('调试日志已复制，包含近期记录和当前诊断，不含对话正文或认证密码。');
  }
  async openLog() {
    this.log('log-opened');
    if (!this.plugin.logger || this.plugin.logger.diskError) { new Notice('日志文件写入失败，请用“复制调试日志”获取内存记录。'); return; }
    try {
      const shell = require('electron').shell || remoteModule().shell;
      const result = await shell.openPath(this.plugin.logger.file);
      if (result) throw new Error('Open log failed.');
    } catch {
      require('electron').clipboard.writeText(this.plugin.logger.file);
      new Notice('无法打开日志文件，文件路径已复制。');
    }
  }
  startRecovery(view, settings) {
    if (this.recoveryTimer) return;
    this.recoveryTimer = setInterval(async () => {
      try {
        await apiGet(settings, '/global/health');
        if (this.webview !== view || this.closed) return;
        clearInterval(this.recoveryTimer); this.recoveryTimer = null;
        this.mainStatus = null; this.readyAttempts = 0;
        view.loadURL(this.base + '/').catch(() => {});
      } catch (error) {
        if (error.status === 401 && this.webview === view && !this.closed) {
          clearInterval(this.recoveryTimer); this.recoveryTimer = null;
          this.setStatus('err', 'Authentication failed. Check Basic Auth settings.');
        }
      }
    }, 10000);
  }
  async injectMath(view) {
    try {
      const script = KATEX_SCRIPT + '\n;' + PAGE_SCRIPT + '\n' +
        'if(!document.getElementById("oc-sidebar-katex")){const style=document.createElement("style");style.id="oc-sidebar-katex";style.textContent=' + JSON.stringify(KATEX_CSS) + ';document.head.appendChild(style);}OpenCodePage.installPageFixes(window);';
      await view.executeJavaScript(script);
      this.log('Bundled math/copy fixes installed.');
    } catch { this.log('Math/copy injection failed.'); }
  }
  async applyTheme(view = this.webview) {
    if (!view || view !== this.webview || this.closed) return;
    try {
      const { themeOverlay, fontFamily, fontSize } = this.plugin.settings;
      await view.executeJavaScript(THEME_SCRIPT + ';OpenCodeTheme.applyAppearance(document,' + JSON.stringify({ theme: !!themeOverlay, font: fontFamily, size: fontSize }) + ');');
    } catch (error) {
      if (view === this.webview && !this.closed) this.log('theme-apply-failed', { error: errorSummary(error) });
    }
  }
  async checkConnection() {
    try {
      await apiGet(this.plugin.settings, '/global/health');
      new Notice('OpenCode 服务在线；这不代表嵌入网页已经完成加载。');
      this.log('Health check passed.');
    } catch (error) { this.setStatus('err', error.message); }
  }
  async chooseSession() {
    try {
      const sessions = await apiGet(this.plugin.settings, '/session', { directory: this.plugin.settings.directory });
      if (!Array.isArray(sessions)) throw new Error('Unexpected session response.');
      sessions.sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));
      if (!sessions.length) { new Notice('当前目录下没有会话；请检查插件设置中的项目目录。'); return; }
      new SessionPicker(this.app, sessions, (session) => {
        if (!this.webview) return;
        this.sessionButton.textContent = (session.title || session.id).slice(0, 32);
        this.webview.loadURL(sessionUrl(this.base, session.id)).catch(() => {});
      }).open();
    } catch (error) { new Notice('无法加载会话：' + error.message); }
  }
  async updateSessionTitle(view, url) {
    const id = sessionIdFromUrl(url);
    this.currentSessionId = id;
    if (!id) { this.sessionButton.textContent = '选择会话'; return; }
    try {
      const session = await apiGet(this.plugin.settings, '/session/' + encodeURIComponent(id));
      if (this.webview === view && !this.closed && this.currentSessionId === id) {
        this.sessionButton.textContent = (session.title || '选择会话').slice(0, 32);
      }
    } catch { /* Keep the current title if the session endpoint is temporarily unavailable. */ }
  }
  async openRead() {
    try {
      // Resolve from the live page, not an old picker selection: the native UI can switch sessions.
      const id = this.webview ? sessionIdFromUrl(this.webview.getURL()) : '';
      const open = (sessionId) => window.open(readerUrl(this.plugin.settings.readerBase, sessionId), '_blank');
      serverUrl(this.plugin.settings.readerBase);
      if (id) { open(id); return; }
      const sessions = await apiGet(this.plugin.settings, '/session', { directory: this.plugin.settings.directory });
      if (!Array.isArray(sessions)) throw new Error('Unexpected session response.');
      if (!sessions.length) { new Notice('当前项目没有可阅读的会话。'); return; }
      if (this.closed) return;
      new SessionPicker(this.app, sessions, (session) => {
        if (!this.closed) open(session.id);
      }).open();
    } catch (error) { new Notice('无法打开阅读页：' + error.message); }
  }
  async onClose() {
    this.closed = true;
    clearInterval(this.projectTimer); this.projectTimer = null;
    if (this.projectCapture) await this.projectCapture;
    if (this.projectMonitorReady && this.plugin.settings.rememberProjects) await this.captureProjects(this.webview, true);
    this.statusObserver?.disconnect(); this.statusObserver = null;
    this.disposeEmbed(); this.contentEl.empty();
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'OpenCode Sidebar' });
    containerEl.createEl('p', { text: 'Settings belong to this vault. After editing, use Apply and reconnect below. OpenCode must already be running.' });
    const text = (key, name, description, secret = false) => {
      new Setting(containerEl).setName(name).setDesc(description).addText((field) => {
        field.setValue(this.plugin.settings[key]);
        if (secret) { field.inputEl.type = 'password'; field.inputEl.autocomplete = 'new-password'; }
        field.onChange(async (value) => { this.plugin.settings[key] = key === 'password' ? value : value.trim(); await this.plugin.saveSettings(); });
      });
    };
    text('serverUrl', 'OpenCode Web URL', 'An HTTP or HTTPS base URL, optionally with a reverse-proxy subpath. Never include user:password in the URL.');
    text('readerBase', '阅读服务地址', '默认 http://127.0.0.1:18924。阅读按钮打开 /read/<会话ID>；可改成自己的阅读服务地址。该服务需独立运行。');
    text('directory', '项目目录', '服务端的绝对路径，仅筛选顶栏“选择会话”；原生网页首页使用它自己打开的项目目录。');
    new Setting(containerEl).setName('记住项目目录').setDesc('按当前 vault 保存网页已添加的项目和最后选中的目录，下次打开自动恢复。不自动打开旧会话，也不保存草稿。关闭后停止记忆，下次重建侧栏使用空白项目列表。').addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.rememberProjects).onChange(async (value) => {
        this.plugin.settings.rememberProjects = value;
        if (!value) this.plugin.settings.projectMemory = {};
        await this.plugin.saveSettings(!value);
        if (value) for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
          leaf.view.projectSnapshot = null;
          leaf.view.captureProjects();
        }
      });
    });
    text('tuiLauncher', 'TUI 启动脚本（可选）', '本机 .bat/.cmd 文件的绝对路径。留空时尝试项目目录下的“启动opencode-TUI.bat”；远程服务不会自动在本机启动 TUI。');
    new Setting(containerEl).setName('北欧蓝网页外观').setDesc('嵌入页浅色模式改用北欧雾灰蓝配色，并加入圆角与平滑动画；深色模式、代码语法和 diff 保持原生配色。即时生效，关闭即可恢复，不刷新对话。').addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.themeOverlay).onChange(async (value) => {
        await this.plugin.updateAppearance({ themeOverlay: value });
      });
    });
    new Setting(containerEl).setName('正文字体').setDesc('回复与消息正文使用的字体；仅限本机已安装字体。代码与公式保持原字体。').addDropdown((dropdown) => {
      for (const [key, font] of Object.entries(FONTS)) dropdown.addOption(key, font.label);
      dropdown.setValue(this.plugin.settings.fontFamily).onChange(async (value) => {
        await this.plugin.updateAppearance({ fontFamily: value });
      });
    });
    new Setting(containerEl).setName('正文字号').setDesc('回复与消息正文的字号，默认 14px。').addDropdown((dropdown) => {
      for (const size of FONT_SIZES) dropdown.addOption(String(size), size + ' px');
      dropdown.setValue(String(this.plugin.settings.fontSize)).onChange(async (value) => {
        await this.plugin.updateAppearance({ fontSize: Number(value) });
      });
    });
    new Setting(containerEl).setName('Basic Auth').setDesc('Off by default. Only enable for a server that requires HTTP Basic Auth.').addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.basicAuth).onChange(async (value) => { this.plugin.settings.basicAuth = value; await this.plugin.saveSettings(); });
    });
    text('username', 'Username', 'Default OpenCode username: opencode.');
    text('password', 'Password', 'Stored in plaintext in this vault\'s plugin data.json. Exclude that file from Git and untrusted sync. Use HTTPS for remote servers.', true);
    new Setting(containerEl).setName('Math rendering and Markdown copy').setDesc('Bundle KaTeX, render missing dollar-delimited math, and copy selected replies as Markdown. Partial formula selections copy the complete formula.').addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.mathFixes).onChange(async (value) => { this.plugin.settings.mathFixes = value; await this.plugin.saveSettings(); });
    });
    new Setting(containerEl).setName('应用并重新连接').setDesc('可能丢失未发送的草稿，不会删除已保存的对话。').addButton((button) => {
      button.setButtonText('应用').setCta().onClick(() => {
        try { serverUrl(this.plugin.settings.serverUrl); authHeaders(this.plugin.settings); }
        catch (error) { new Notice(error.message); return; }
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.reconnect();
      });
    });
  }
}

module.exports = class OpenCodeSidebarPlugin extends Plugin {
  async onload() {
    this.vaultPath = this.app.vault.adapter.getBasePath();
    const data = await this.loadData();
    this.settings = loadSettings(data?.vaults?.[this.vaultPath]);
    this.logger = new DiagnosticLog(this.vaultPath, () => this.diagnosticSecrets());
    const versions = typeof process === 'undefined' ? {} : process.versions;
    this.logger.write('plugin-loaded', { pluginVersion: this.manifest?.version || 'unknown', build: typeof BUILD_ID === 'undefined' ? 'source' : BUILD_ID, obsidianVersion: apiVersion || 'unknown', electronVersion: versions.electron || 'unknown', chromeVersion: versions.chrome || 'unknown', platform: typeof process === 'undefined' ? 'unknown' : process.platform });
    this.registerView(VIEW_TYPE, (leaf) => new SidebarView(leaf, this));
    this.addRibbonIcon('terminal', 'Open OpenCode sidebar', () => this.activateView());
    this.addCommand({ id: 'open-opencode-sidebar', name: 'Open sidebar', callback: () => this.activateView() });
    this.addSettingTab(new SettingsTab(this.app, this));
  }
  diagnosticSecrets() {
    const password = this.settings.password;
    return password ? [password, Buffer.from(this.settings.username + ':' + password, 'utf8').toString('base64')] : [];
  }
  launchTUI() {
    if (process.platform !== 'win32') { new Notice('TUI 启动脚本目前仅支持 Windows；请从本机终端启动。'); return; }
    const fs = require('node:fs');
    const path = require('node:path');
    let local;
    try { local = new URL(serverUrl(this.settings.serverUrl)).hostname; }
    catch { new Notice('先在插件设置中填写有效的 OpenCode Web 地址。'); return; }
    const launcher = this.settings.tuiLauncher || (['127.0.0.1', 'localhost', '::1'].includes(local) && this.settings.directory
      ? path.join(this.settings.directory, '启动opencode-TUI.bat') : '');
    if (!launcher) { new Notice('请在插件设置中填写本机 TUI 启动脚本路径。'); return; }
    if (!path.isAbsolute(launcher) || !/\.(?:bat|cmd)$/i.test(launcher) || /["%!&|<>^\r\n]/.test(launcher)) {
      new Notice('TUI 启动脚本须为本机 .bat/.cmd 绝对路径，不得包含命令行特殊字符。'); return;
    }
    if (!fs.existsSync(launcher) || !fs.statSync(launcher).isFile()) { new Notice('未找到 TUI 启动脚本，请检查插件设置中的路径。'); return; }
    try {
      const child = require('node:child_process').spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${launcher}"`], {
        cwd: path.dirname(launcher), detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true
      });
      let failed = false;
      child.on('error', () => { failed = true; new Notice('TUI 启动失败，请检查脚本路径。'); });
      child.on('exit', (code, signal) => {
        if (failed) return;
        this.logger?.write('tui-launch-result', { code, signal });
        if (code === 0) new Notice('TUI 启动脚本已打开；连接结果请看终端窗口。');
        else new Notice('TUI 启动命令失败，请检查脚本路径。');
      });
      child.unref();
    } catch { new Notice('TUI 启动失败，请检查脚本路径。'); }
  }
  async updateAppearance(changes) {
    // Normalize through loadSettings so menu, settings tab and saved data stay consistent.
    Object.assign(this.settings, loadSettings({ ...this.settings, ...changes }));
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.applyTheme();
    await this.saveSettings();
  }
  showTypeMenu(event) {
    const menu = new Menu();
    for (const [key, font] of Object.entries(FONTS)) {
      menu.addItem((item) => item.setTitle(font.label).setChecked(this.settings.fontFamily === key)
        .onClick(() => this.updateAppearance({ fontFamily: key })));
    }
    menu.addSeparator();
    for (const size of FONT_SIZES) {
      menu.addItem((item) => item.setTitle('字号 ' + size + (size === DEFAULT_FONT_SIZE ? '（默认）' : ''))
        .setChecked(this.settings.fontSize === size).onClick(() => this.updateAppearance({ fontSize: size })));
    }
    menu.showAtMouseEvent(event);
  }
  async saveSettings(updateProjectMemory = false) {
    // Serialize read/merge/write across windows, including symlinked installs.
    const path = require('node:path');
    const dir = this.manifest.dir || this.app.vault.configDir + '/plugins/' + this.manifest.id;
    const file = path.resolve(this.vaultPath, dir, 'data.json.lock');
    const snapshot = loadSettings(this.settings);
    const save = (this._saveQueue || Promise.resolve()).then(() => withSettingsLock(file, async () => {
      const data = await this.loadData() || {};
      const current = { ...snapshot, projectMemory: updateProjectMemory ? snapshot.projectMemory : normalizeProjectMemory(data.vaults?.[this.vaultPath]?.projectMemory) };
      const vaults = { ...data.vaults, [this.vaultPath]: current };
      await this.saveData({ vaults });
    }));
    this._saveQueue = save.catch((error) => {
      new Notice('Cannot save OpenCode settings: ' + error.message);
    });
    return save.then(() => true, () => false);
  }
  async activateView() {
    const workspace = this.app.workspace;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
};

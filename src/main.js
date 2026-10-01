const { Plugin, ItemView, Notice, Setting, PluginSettingTab, SuggestModal, Modal, Menu } = require('obsidian');
const { loadSettings, serverUrl, authHeaders, partitionKey, sessionUrl } = require('./core');
const { attachAuth } = require('./auth');
const { apiGet } = require('./api');
const { withSettingsLock } = require('./storage');

const VIEW_TYPE = 'opencode-sidebar-view';

function remoteModule() {
  const electron = require('electron');
  return electron.remote || require('@electron/remote');
}

class ConfirmReload extends Modal {
  constructor(app, reload) { super(app); this.reload = reload; }
  onOpen() {
    this.contentEl.createEl('h3', { text: 'Reload OpenCode?' });
    this.contentEl.createEl('p', { text: 'An unsent draft may be lost. This does not delete saved conversations.' });
    const row = this.contentEl.createDiv({ cls: 'oc-sb-actions' });
    row.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
    const button = row.createEl('button', { text: 'Reload', cls: 'mod-cta' });
    button.onclick = () => { this.close(); this.reload(); };
  }
  onClose() { this.contentEl.empty(); }
}

class SessionPicker extends SuggestModal {
  constructor(app, sessions, choose) { super(app); this.sessions = sessions; this.choose = choose; this.setPlaceholder('Search OpenCode sessions'); }
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
  log(message) {
    // Never log chat content, URLs, response bodies or credential values.
    this.debug.push(new Date().toISOString() + ' ' + message);
    if (this.debug.length > 100) this.debug.shift();
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
    this.sessionButton = bar.createEl('button', { text: 'Choose session', cls: 'oc-sb-session-btn' });
    this.sessionButton.onclick = () => this.chooseSession();
    const refresh = bar.createEl('button', { text: 'Reload', attr: { 'aria-label': 'Reload OpenCode' } });
    refresh.onclick = () => new ConfirmReload(this.app, () => this.createEmbed()).open();
    const more = bar.createEl('button', { text: '...', attr: { 'aria-label': 'More actions' } });
    more.onclick = (event) => {
      const menu = new Menu();
      menu.addItem((item) => item.setTitle('Copy diagnostics').setIcon('copy').onClick(() => {
        require('electron').clipboard.writeText(this.debug.join('\n'));
        new Notice('Diagnostics copied (no conversation text or credentials).');
      }));
      menu.addItem((item) => item.setTitle('Check connection').setIcon('activity').onClick(() => this.checkConnection()));
      menu.showAtMouseEvent(event);
    };
    this.embedEl = this.contentEl.createDiv({ cls: 'oc-sb-embed' });
    this.statusEl = this.contentEl.createDiv({ cls: 'oc-sb-status' });
    this.createEmbed();
  }
  disposeEmbed() {
    clearTimeout(this.readyTimer); clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
    if (this.detachAuth) { this.detachAuth(); this.detachAuth = null; }
    if (this.webview) { this.webview.remove(); this.webview = null; }
  }
  createEmbed() {
    this.disposeEmbed();
    let base;
    try { base = serverUrl(this.plugin.settings.serverUrl); authHeaders(this.plugin.settings); }
    catch (error) { this.setStatus('err', error.message); return; }
    this.base = base; this.readyAttempts = 0; this.mainStatus = null;
    this.setStatus('checking', 'Connecting to OpenCode...');
    const settings = { ...this.plugin.settings };
    const view = document.createElement('webview');
    this.webview = view;
    // Each live webview has a private session, so auth hooks never collide across windows.
    const { randomUUID } = require('node:crypto');
    view.setAttribute('partition', partitionKey(this.plugin.vaultPath, settings).replace('persist:', '') + '-' + randomUUID());
    view.addEventListener('did-attach', () => {
      if (this.webview !== view || this.closed) return;
      try {
        const wc = remoteModule().webContents.fromId(view.getWebContentsId());
        if (!wc) throw new Error('Guest webContents unavailable.');
        this.detachAuth = attachAuth(wc, settings, (message) => this.setStatus('err', message));
        this.log('Scoped authentication hooks attached.');
        view.setAttribute('src', base + '/');
      } catch {
        this.setStatus('err', 'Cannot initialize the Electron webview. Try updating Obsidian desktop.');
        this.log('Failed to attach authentication hooks.');
      }
    });
    view.addEventListener('did-navigate', () => {
      if (this.webview !== view) return;
      this.log('Main document navigated.');
    });
    view.addEventListener('did-frame-navigate', (event) => {
      if (this.webview !== view || event.isMainFrame === false) return;
      this.log('Main document HTTP status: ' + (event.httpResponseCode ?? 'unknown'));
      this.mainStatus = event.httpResponseCode;
      if (event.httpResponseCode === 401) this.setStatus('err', 'Authentication failed. Check Basic Auth settings.');
      else if (event.httpResponseCode >= 400) this.setStatus('err', 'Page returned HTTP ' + event.httpResponseCode + '.');
    });
    view.addEventListener('dom-ready', () => {
      if (this.webview !== view || view.getURL() === 'about:blank') return;
      this.probeReady(view);
      if (settings.mathFixes && this.mainStatus !== 401) this.injectMath(view);
    });
    view.addEventListener('did-fail-load', (event) => {
      if (this.webview !== view || event.errorCode === -3 || event.isMainFrame === false) return;
      this.setStatus('err', 'Page load failed (' + event.errorCode + '). Waiting for the server...');
      this.log('Main document load failed: ' + event.errorCode);
      this.startRecovery(view, settings);
    });
    view.addEventListener('render-process-gone', () => this.setStatus('err', 'The webview renderer stopped. Click Reload.'));
    view.addEventListener('did-navigate-in-page', (event) => {
      if (event.isMainFrame === false) return;
      this.readyAttempts = 0; this.probeReady(view);
    });
    // Set src last, after all listeners are installed; never put credentials in it.
    view.setAttribute('src', 'about:blank');
    this.embedEl.appendChild(view);
  }
  async probeReady(view) {
    clearTimeout(this.readyTimer);
    if (this.closed || this.webview !== view || this.mainStatus === 401) return;
    try {
      const state = await view.executeJavaScript(`({ready:!!document.querySelector('#root > *'),error:!!Array.from(document.querySelectorAll('h1')).find(el=>/^(Something went wrong|出了点问题)$/.test(el.textContent.trim()))})`);
      if (this.webview !== view || this.closed) return;
      if (state.error) { this.setStatus('err', 'OpenCode reported a page error. Click Reload to retry.'); return; }
      if (state.ready) { this.setStatus('ok', 'OpenCode page ready'); return; }
      if (++this.readyAttempts >= 15) { this.setStatus('warn', 'Server page has not initialized. Check settings or click Reload.'); return; }
      this.readyTimer = setTimeout(() => this.probeReady(view), 1000);
    } catch {
      if (this.webview === view && !this.closed) this.setStatus('warn', 'Cannot inspect the page. Click Reload to retry.');
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
  async checkConnection() {
    try {
      await apiGet(this.plugin.settings, '/global/health');
      new Notice('OpenCode API is online. This does not guarantee the web page has initialized.');
      this.log('Health check passed.');
    } catch (error) { this.setStatus('err', error.message); }
  }
  async chooseSession() {
    try {
      const sessions = await apiGet(this.plugin.settings, '/session', { directory: this.plugin.settings.directory });
      if (!Array.isArray(sessions)) throw new Error('Unexpected session response.');
      sessions.sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0));
      if (!sessions.length) { new Notice('No sessions found for this directory.'); return; }
      new SessionPicker(this.app, sessions, (session) => {
        if (!this.webview) return;
        this.sessionButton.textContent = (session.title || session.id).slice(0, 32);
        this.webview.loadURL(sessionUrl(this.base, session.id)).catch(() => {});
      }).open();
    } catch (error) { new Notice('Cannot load sessions: ' + error.message); }
  }
  onClose() { this.closed = true; this.disposeEmbed(); this.contentEl.empty(); }
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
    text('directory', 'Project directory', 'Optional absolute path on the OpenCode server. Blank lists all available sessions. This filters the picker, not the entire native web UI.');
    new Setting(containerEl).setName('Basic Auth').setDesc('Off by default. Only enable for a server that requires HTTP Basic Auth.').addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.basicAuth).onChange(async (value) => { this.plugin.settings.basicAuth = value; await this.plugin.saveSettings(); });
    });
    text('username', 'Username', 'Default OpenCode username: opencode.');
    text('password', 'Password', 'Stored in plaintext in this vault\'s plugin data.json. Exclude that file from Git and untrusted sync. Use HTTPS for remote servers.', true);
    new Setting(containerEl).setName('Math rendering and Markdown copy').setDesc('Bundle KaTeX, render missing dollar-delimited math, and copy selected replies as Markdown. Partial formula selections copy the complete formula.').addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.mathFixes).onChange(async (value) => { this.plugin.settings.mathFixes = value; await this.plugin.saveSettings(); });
    });
    new Setting(containerEl).setName('Apply and reconnect').setDesc('May discard an unsent draft. Saved conversations are not deleted.').addButton((button) => {
      button.setButtonText('Apply').setCta().onClick(() => {
        try { serverUrl(this.plugin.settings.serverUrl); authHeaders(this.plugin.settings); }
        catch (error) { new Notice(error.message); return; }
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) leaf.view.createEmbed();
      });
    });
  }
}

module.exports = class OpenCodeSidebarPlugin extends Plugin {
  async onload() {
    this.vaultPath = this.app.vault.adapter.getBasePath();
    const data = await this.loadData();
    this.settings = loadSettings(data?.vaults?.[this.vaultPath]);
    this.registerView(VIEW_TYPE, (leaf) => new SidebarView(leaf, this));
    this.addRibbonIcon('terminal', 'Open OpenCode sidebar', () => this.activateView());
    this.addCommand({ id: 'open-opencode-sidebar', name: 'Open sidebar', callback: () => this.activateView() });
    this.addSettingTab(new SettingsTab(this.app, this));
  }
  async saveSettings() {
    // Serialize read/merge/write across windows, including symlinked installs.
    const path = require('node:path');
    const dir = this.manifest.dir || this.app.vault.configDir + '/plugins/' + this.manifest.id;
    const file = path.resolve(this.vaultPath, dir, 'data.json.lock');
    const snapshot = loadSettings(this.settings);
    const save = (this._saveQueue || Promise.resolve()).then(() => withSettingsLock(file, async () => {
      const data = await this.loadData() || {};
      const vaults = { ...data.vaults, [this.vaultPath]: snapshot };
      await this.saveData({ vaults });
    }));
    this._saveQueue = save.catch((error) => {
      new Notice('Cannot save OpenCode settings: ' + error.message);
    });
    return this._saveQueue;
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

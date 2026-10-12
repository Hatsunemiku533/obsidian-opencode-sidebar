// Appearance layer injected into the embedded OpenCode page.
// Two independent <style> elements:
//   - COLOR_STYLE_ID: optional Nordic Mist colors, rounded corners and motion (the "theme" toggle).
//   - TYPE_STYLE_ID: always-on reading fixes: chosen font/size, visible bold, Obsidian-like line breaks.
const COLOR_STYLE_ID = 'oc-sidebar-theme';
const TYPE_STYLE_ID = 'oc-sidebar-type';
const LEGACY_STYLE_IDS = ['oc-sidebar-claude-theme'];

// Only locally installed fonts work: the page CSP blocks external font files.
// Weights stay at regular or above; thin strokes are tiring for long Chinese text.
const FONTS = Object.freeze({
  clear: Object.freeze({ label: '清晰 · 微软雅黑', family: '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif', weight: 400, strong: 700 }),
  soft: Object.freeze({ label: '柔和 · 思源黑体', family: '"Noto Sans SC", "Microsoft YaHei UI", sans-serif', weight: 450, strong: 650 }),
  book: Object.freeze({ label: '书卷 · 思源宋体', family: '"Noto Serif SC", "Microsoft YaHei UI", serif', weight: 500, strong: 700 })
});
const DEFAULT_FONT = 'clear';
const FONT_SIZES = Object.freeze([13, 14, 15, 16, 17]);
const DEFAULT_FONT_SIZE = 14;

const fontKey = (value) => Object.prototype.hasOwnProperty.call(FONTS, value) ? value : DEFAULT_FONT;
const fontSize = (value) => FONT_SIZES.includes(value) ? value : DEFAULT_FONT_SIZE;

// Nordic Mist palette from 主题风格/themes/nordic-mist.css, mapped onto OpenCode's v2 tokens.
// Scheme-scoped selector plus !important wins over the app's later-generated :root theme.
const COLOR_CSS = `html:not([data-color-scheme="dark"]) {
  --v2-background-bg-deep: #eef1f4 !important;
  --v2-background-bg-base: #fbfcfd !important;
  --v2-background-bg-layer-01: #fbfcfd !important;
  --v2-background-bg-layer-02: #e1e9f0 !important;
  --v2-background-bg-layer-03: #d8dee5 !important;
  --v2-background-bg-layer-04: #b9c2cb !important;
  --v2-background-bg-button-neutral: #fbfcfd !important;
  --v2-background-bg-accent: #3f6684 !important;
  --v2-background-bg-contrast: #3f6684 !important;
  --v2-background-bg-inverse: #22303c !important;
  --v2-text-text-base: #22303c !important;
  --v2-text-text-muted: #6b7a88 !important;
  --v2-text-text-faint: #8693a0 !important;
  --v2-text-text-accent: #3f6684 !important;
  --v2-text-text-accent-hover: #2f5270 !important;
  --v2-text-text-code-accent: #2f5270 !important;
  --v2-icon-icon-base: #3a4855 !important;
  --v2-icon-icon-muted: #6b7a88 !important;
  --v2-icon-icon-accent: #3f6684 !important;
  --v2-icon-icon-accent-hover: #2f5270 !important;
  --v2-border-border-muted: #e4e9ee !important;
  --v2-border-border-base: #d8dee5 !important;
  --v2-border-border-strong: #b9c2cb !important;
  --v2-border-border-focus: #3f6684 !important;
  --v2-overlay-simple-overlay-hover: rgba(63, 102, 132, .07) !important;
  --v2-overlay-simple-overlay-pressed: rgba(63, 102, 132, .13) !important;
  --v2-state-bg-info: #e1e9f0 !important;
  --v2-state-fg-info: #2f5270 !important;
  --v2-state-border-info: #b9c2cb !important;
  background-color: #eef1f4 !important;
}
html:not([data-color-scheme="dark"]) ::selection { background: rgba(63, 102, 132, .22); }
html:not([data-color-scheme="dark"]) [data-component="prompt-input-v2"]:focus-within { box-shadow: 0 0 0 3px #e1e9f0, 0 1px 2px rgba(34, 48, 60, .06) !important; }
/* shape and motion */
:root {
  --radius-md: 8px !important;
  --radius-lg: 10px !important;
  --radius-xl: 12px !important;
  /* Apple-like curves: quick start, long soft landing. */
  --oc-ease: cubic-bezier(.32, .72, 0, 1);
  --oc-ease-out: cubic-bezier(.22, 1, .36, 1);
}
[data-slot="user-message-text"], [data-component="prompt-input-v2"] { border-radius: 12px !important; }
:is([data-component="button-v2"], [data-component="icon-button-v2"], [data-component="icon-button"], [data-slot="titlebar-tab-item"]) { border-radius: 8px !important; }
[data-component="markdown"] pre { border-radius: 10px !important; }
@media (prefers-reduced-motion: no-preference) {
  :is([data-component="button-v2"], [data-component="icon-button-v2"], [data-component="icon-button"], [data-slot="titlebar-tab-item"], [data-slot="tabs-trigger"], [data-slot="collapsible-trigger"], [data-slot="markdown-copy-button"]) {
    transition: background-color .22s var(--oc-ease), color .22s var(--oc-ease), box-shadow .22s var(--oc-ease), opacity .22s var(--oc-ease), transform .2s var(--oc-ease) !important;
  }
  :is([data-component="button-v2"], [data-component="icon-button-v2"], [data-component="icon-button"], [data-slot="titlebar-tab-item"]):active:not([disabled]):not([data-disabled]) { transform: scale(.96); }
  [data-component="prompt-input-v2"] { transition: box-shadow .3s var(--oc-ease), background-color .3s var(--oc-ease) !important; }
  /* Each turn is the sole child of its own wrapper, so this runs once per newly mounted turn. */
  [data-component="session-turn"] { animation: oc-turn-in .4s var(--oc-ease-out) both; }
  [data-slot="collapsible-content"] { overflow: hidden; }
  [data-slot="collapsible-content"][data-expanded] { animation: oc-expand .32s var(--oc-ease); }
  [data-slot="collapsible-content"][data-closed] { animation: oc-collapse .24s var(--oc-ease); }
  [data-slot="collapsible-arrow-icon"] { transition: transform .32s var(--oc-ease) !important; }
  :is([data-component="popover-content"], [data-component="dropdown-menu-content"], [data-component="dropdown-menu-sub-content"], [data-component="select-content"], [data-component="hover-card-content"], [data-component="context-menu-content"], [data-component="toast"], [data-component="dialog"] [data-slot="dialog-content"]) {
    animation-duration: .26s !important;
    animation-timing-function: var(--oc-ease) !important;
  }
}
@keyframes oc-turn-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes oc-expand { from { height: 0; opacity: 0; } to { height: var(--kb-collapsible-content-height); opacity: 1; } }
@keyframes oc-collapse { from { height: var(--kb-collapsible-content-height); opacity: 1; } to { height: 0; opacity: 0; } }`;

function typeCss(font, size) {
  const chosen = FONTS[fontKey(font)];
  return `:root {
  --oc-font: ${chosen.family};
  --oc-font-size: ${fontSize(size)}px;
  --oc-font-weight: ${chosen.weight};
  --oc-strong-weight: ${chosen.strong};
}
[data-component="markdown"], [data-slot="user-message-text"] {
  font-family: var(--oc-font) !important;
  font-size: var(--oc-font-size) !important;
  font-weight: var(--oc-font-weight) !important;
}
[data-component="markdown"] { line-height: 1.7 !important; }
[data-component="prompt-input"] { font-family: var(--oc-font) !important; }
/* OpenCode uses weight 500 for bold; Chinese fonts render 440 and 500 identically. */
:is([data-component="markdown"], [data-slot="user-message-text"]) :is(strong, b, h1, h2, h3, h4, h5, h6) { font-weight: var(--oc-strong-weight) !important; }
/* Show a single newline as a line break, like Obsidian; copied Markdown is unchanged. */
[data-component="markdown"] :is(p, li) { white-space: pre-line; }`;
}

function ensureStyle(doc, id) {
  let style = doc.getElementById(id);
  if (!style) {
    style = doc.createElement('style'); style.id = id;
    (doc.head || doc.documentElement).appendChild(style);
  }
  return style;
}

function applyAppearance(doc, options = {}) {
  for (const id of LEGACY_STYLE_IDS) doc.getElementById(id)?.remove();
  if (options.theme) ensureStyle(doc, COLOR_STYLE_ID).textContent = COLOR_CSS;
  else doc.getElementById(COLOR_STYLE_ID)?.remove();
  ensureStyle(doc, TYPE_STYLE_ID).textContent = typeCss(options.font, options.size);
}

module.exports = { applyAppearance, typeCss, COLOR_CSS, COLOR_STYLE_ID, TYPE_STYLE_ID, FONTS, FONT_SIZES, DEFAULT_FONT, DEFAULT_FONT_SIZE, fontKey, fontSize };

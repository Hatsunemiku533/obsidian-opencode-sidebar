# OpenCode Sidebar

Use [OpenCode Web](https://opencode.ai/) next to your notes in Obsidian desktop.
This is an unofficial plugin, not affiliated with Obsidian or OpenCode.

[中文说明](README.zh-CN.md)

## Features

- Embed the native OpenCode Web UI in a sidebar.
- Configure a separate server URL and project directory for each vault.
- Connect to local or remote HTTP/HTTPS servers, with optional Basic Auth.
- Search sessions using an optional directory path on the server.
- Render missing inline/block math with bundled KaTeX; no extra local service required.
- Copy selected replies as Markdown, restoring formulas to `$...$` and `$$...$$`.
- Isolate live webview sessions across vaults and windows; recover when an offline server returns.

The plugin does **not** launch OpenCode, read its database, run a shell, generate
conversation snapshots, or require a separate reader service.

## Install

This plugin is not yet in the Obsidian community plugin directory. Installing it
does not install or start an OpenCode server.

### BRAT (convenient for multiple vaults)

Install and enable the [BRAT](https://github.com/TfTHacker/obsidian42-brat) community
plugin in a vault, then add this GitHub repository as a beta plugin:

`Hatsunemiku533/obsidian-opencode-sidebar`

Repeat the installation in each vault. BRAT can update it from GitHub releases;
settings stay local to the vault. There is no global Obsidian plugin installation.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from
[Releases](https://github.com/Hatsunemiku533/obsidian-opencode-sidebar/releases).
Put them in `<vault>/.obsidian/plugins/opencode-sidebar/`, reload Obsidian, then
enable OpenCode Sidebar in **Settings > Community plugins**.

## Configure

1. Start your OpenCode Web server separately (for example, `opencode web --port 4096`).
2. Set **OpenCode Web URL** to its base URL; the default is `http://127.0.0.1:4096`.
3. Leave **Basic Auth** off for a server without HTTP authentication. For an
   authenticated server, enable it and enter its username and password.
4. Optionally set **Project directory** to an absolute path **on the server**.
   For a local service it can be your vault path. For a remote service, do not use
   your local vault path unless the server uses that exact same path.
5. Use **Apply and reconnect**, then the terminal ribbon icon or **OpenCode
   Sidebar: Open sidebar** command.

The project directory filters **Choose session**, not every project shown inside
the native web UI. Leaving it empty lists all sessions returned by the server.

URLs with embedded credentials, queries, fragments, or unsupported schemes are
rejected. A reverse-proxy subpath is accepted, but your OpenCode/proxy deployment
must also serve its assets and routing correctly at that path.

## Security And Privacy

- **Basic Auth passwords are stored in plaintext** in the plugin's `data.json`.
  Masking the settings field does not encrypt it. Exclude that file from Git,
  public backups and untrusted synchronization.
- Use **HTTPS for remote servers**. HTTP Basic Auth is only Base64 encoding, not encryption.
- Credentials are attached only to the configured origin and path, never to a
  credential-bearing URL. API requests do not automatically follow redirects.
- OpenCode is an agent that may access files and run tools on its server. Connect
  only to trusted services and review OpenCode's own permissions.
- There is no analytics, telemetry, or extra backend. The plugin connects to your
  configured server; the native web application controls its own network traffic.
- Diagnostics omit conversation bodies, URLs and credential values.
- Each webview uses a private, non-persistent Electron session to avoid
  authentication-hook conflicts. Web UI local preferences and unsent drafts do
  not survive closing/recreating the view. Saved conversations remain on the server.

Settings are keyed by the full vault path, not just its name, so same-named vaults
do not collide. Moving a vault to a different path requires configuring it again.
Settings writes use a short file lock to merge safely across windows. If Obsidian
crashes during a save and reports a stale lock later, close all windows using the
plugin and remove only `data.json.lock` from the plugin folder, then reopen it.

## Math Copy

With math fixes enabled, select text inside a rendered reply and use normal Copy.
The selection is serialized to plain Markdown, not KaTeX HTML. Paragraph breaks,
common lists, links, emphasis, and code are retained; this is not a full Markdown
round-trip exporter (complex tables/nested structures may need editing).

A selection touching part of a formula copies the **complete formula once**.
Editor/input copying is left alone. OpenCode's own message-copy button may bypass
the selection handler and use its original source instead.

## Troubleshooting

- **Blank view / HTTP 401:** check the URL and Basic Auth settings, then Apply.
  Credentials in URLs are deliberately unsupported.
- **Offline:** start the server separately; the view retries an offline service
  every ten seconds. Wrong credentials are not retried indefinitely.
- **Changed settings:** Apply reconnects with new credentials and may discard an unsent draft.
- **After a manual plugin update:** toggle the plugin off/on or restart Obsidian.
- Use **More > Check connection** for API health and **Copy diagnostics** for
  limited lifecycle messages. API health alone is not proof that the page loaded.

## Compatibility

Desktop only, using Electron webview and its authentication APIs. Initial checks
use Obsidian 1.12.7 on Windows and OpenCode Web 1.18.17. Other platforms and
OpenCode versions have not yet been tested. Changes in upstream DOM, session
routes or APIs may require an update. The manifest's minimum API baseline is
1.5.0, not a claim of a full test matrix.

## Development

Node.js 22.12+ and npm:

```sh
npm ci
npm run check
```

Source lives in `src/`. `npm run build` bundles the plugin, page fixes and KaTeX
resources into root `main.js`, so installed users need no Node/npm or font folder.
Tests cover DOM selections, math delimiters, clipboard MIME data, URL validation,
auth isolation, API behavior and per-vault settings. Release assets are the three
Obsidian files plus license notices. Do not commit `data.json` or local notes.

## License

[MIT](LICENSE). Bundled KaTeX is also MIT; see [third-party notices](THIRD_PARTY_LICENSES.md).

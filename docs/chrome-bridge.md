# Chrome Bridge — drive the real running Chrome, provider independent

The PAI browser bridge is our own `claude-in-chrome` replacement. It lets any
MCP-capable provider (Claude Code, GLM, Gemini CLI, anything that speaks MCP)
list tabs, snapshot a page's DOM, click, type, read text, evaluate JavaScript,
screenshot and read console output — in the user's **real running Chrome**,
with their logged-in sessions, extensions and cookies.

- No `--remote-debugging-port`
- No headless Chrome, no Playwright
- No Anthropic dependency — the MCP server is plain stdio MCP

## Architecture

```
provider (any MCP client)
    │ stdio MCP
pai-browser-mcp  (dist/browser-mcp/index.mjs)
    │ WebSocket  ws://127.0.0.1:8756
native host  (src/browser-bridge/host/host.mjs, spawned by Chrome)
    │ native messaging (4-byte length-prefixed JSON on stdin/stdout)
extension background service worker  (extensions/browser-bridge)
    │ chrome.tabs  +  chrome.scripting (injected DOM functions)
the real running Chrome
```

The extension is the only part that touches Chrome. It uses `chrome.tabs` for
tab operations and `chrome.scripting` for DOM operations — functions injected
into the page (snapshot walks, clicks, typing), so there is no debugger
attachment and no "started debugging this browser" banner. The native host
bridges the extension's native messaging port to a localhost WebSocket; the
MCP server connects there. The WebSocket server is hand-rolled (RFC 6455,
text frames only) because Node's global `WebSocket` is client-only and PAI
adds no new runtime dependencies.

## Install

One-time setup, four steps:

1. **Build** (if not already done): `bun run build`

2. **Load the extension** — in Chrome open `chrome://extensions`, enable
   *Developer mode*, click *Load unpacked*, and select the repo's
   `extensions/browser-bridge/` directory. Copy the extension ID shown on its
   card (32 characters).

3. **Register the native host** — from the repo root:

   ```sh
   node src/browser-bridge/host/install.mjs --extension-id <the-32-char-id>
   ```

   This writes `com.pai.browser_bridge.json` into Chrome's user-level
   `NativeMessagingHosts` directory (macOS default), pointing at
   `src/browser-bridge/host/host.mjs` with `allowed_origins` locked to that
   one extension ID. `--dest <dir>` redirects the manifest (tests), `--chrome-dir
   <dir>` targets a non-default Chrome, `--uninstall` removes it again.

4. **Restart Chrome**, then register the MCP server for your provider:

   ```sh
   pai mcp install   # registers both "pai" and "pai-browser"
   ```

   In Claude Code the entry lands in `~/.claude.json` as
   `"pai-browser": { "command": "node", "args": ["<repo>/dist/browser-mcp/index.mjs"] }`.

The extension and the host keep each other alive: the host pings the
extension every 20 s over the native port, which resets the MV3 service
worker's idle timer.

## Usage

Eleven tools, all named after what they do:

| Tool | What it does |
|------|--------------|
| `tabs_list` | List tabs: id, title, url, active |
| `tab_open {url, active?}` | Open a tab |
| `tab_select {tab}` | Bring a tab to the front |
| `tab_close {tab}` | Close a tab |
| `dom_snapshot {tab}` | A11y-tree YAML of the page, with `[ref=sN]` ids |
| `dom_click {tab, ref}` | Click an element (scrolls into view first) |
| `dom_type {tab, ref, text}` | Focus an element and type into it |
| `page_text {tab}` | Read `document.body.innerText` |
| `eval_js {tab, code}` | Evaluate JavaScript (awaits promises) |
| `tab_screenshot {tab}` | PNG screenshot of the visible tab, base64 |
| `console_logs {tab}` | Console output captured since the last snapshot |

### The ref workflow

DOM interaction goes through snapshot refs:

1. `dom_snapshot {tab: 42}` returns YAML like:

   ```
   - document "Example Domain":
     - heading "Example Domain" [level=1]
     - link "More information..." [ref=s1]
     - textbox "Search" [ref=s2]
     - button "Go" [ref=s3]
   ```

2. `dom_type {tab: 42, ref: "s2", text: "pai browser bridge"}` fills the
   search box, `dom_click {tab: 42, ref: "s3"}` submits.

Refs are assigned per snapshot in DOM order (`s1, s2, …`). They stay valid
until the next `dom_snapshot` on that tab or a navigation; using a stale or
unknown ref returns `unknown ref sN — take a new snapshot`.

## Troubleshooting

- **"Chrome bridge not connected — start Chrome (the PAI browser-bridge
  extension must be running) and try again."** — Chrome is not running, the
  extension is not loaded, or the native host manifest is missing/stale (e.g.
  the repo moved; re-run install.mjs). The MCP server stays alive and
  reconnects on the next call, so fixing Chrome is enough — no restart needed.
- **Yellow "PAI Browser Bridge started debugging this browser" banner** —
  gone: DOM tools run through `chrome.scripting`, which attaches nothing.
  Reload the unpacked extension (chrome://extensions → reload icon) after
  updating it, so Chrome drops the old `debugger` permission.
- **No reply to a command** — every command frame now answers, ok or a loud
  error (`missing command key`, `unknown command`, ...). If nothing comes
  back at all, the host log tells the story: `/tmp/pai-browser-bridge.log`
  (override with `PAI_BROWSER_BRIDGE_LOG`). The extension reconnects to the
  host with backoff after a host death and respawns it from disk.
- **Big screenshots** — the native messaging channel caps message size; very
  large viewports can exceed it. Scroll or shrink the window and retry.
- **Port conflict** — the bridge uses `ws://127.0.0.1:8756`; override with
  `PAI_BROWSER_BRIDGE_PORT` (picked up by both host and MCP server).
- **node < 22** — the MCP server needs the global `WebSocket` client; on
  older runtimes it exits with a clear message instead of crashing.

## Scope

macOS first (the installer's default Chrome directory). `--dest`/`--chrome-dir`
keep nothing blocked elsewhere, but Linux/Chrome and Chromium/Edge install
paths are not implemented yet.

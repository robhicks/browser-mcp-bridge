# Browser MCP Bridge

Give Claude Code direct access to your browser. Inspect pages, read console errors, monitor network requests, capture screenshots, and execute JavaScript — all through natural language.

## What This Does

Browser MCP Bridge connects your Chrome browser to Claude Code through the [Model Context Protocol (MCP)](https://modelcontextprotocol.io). It consists of two parts:

1. **A Chrome extension** that captures browser data (page content, DOM, console, network, performance, accessibility)
2. **An MCP server** that exposes that data to Claude Code through 11 specialized tools

Once connected, you can ask Claude Code things like:
- "Check this page for accessibility issues"
- "What console errors are on this page?"
- "Show me the failed API requests"
- "Analyze the performance of this page"
- "Execute `document.querySelectorAll('a')` on the current page"

## Quick Start

Get running in under 5 minutes:

### 1. Install the Server

```bash
git clone https://github.com/anthropics/browser-mcp-bridge.git
cd browser-mcp-bridge
npm run install-server
```

### 2. Install the Browser Extension

1. Open `chrome://extensions/` (or `edge://extensions/`)
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` directory from this repo

You should see the "Browser MCP Bridge" icon in your toolbar.

### 3. Configure Claude Code

```bash
claude mcp add --scope user --transport http browser-mcp http://127.0.0.1:6009/mcp
```

### 4. Start the Server and Connect

```bash
npm start
```

Then click the Browser MCP Bridge extension icon and click **Connect**. The status indicator should turn green.

That's it — Claude Code now has access to your browser.

## Project Structure

```
browser-mcp-bridge/
├── extension/                 # Chrome extension
│   ├── manifest.json          # Manifest V3 configuration
│   ├── background.js          # Service worker (WebSocket, tab management)
│   ├── content.js             # Content script (page data extraction)
│   ├── inject.js              # Injected script (console/network interception)
│   ├── popup.html/js          # Extension popup (connection management)
│   ├── devtools.html/js       # DevTools integration entry point
│   ├── panel.html/js          # Custom DevTools panel UI
│   └── icons/                 # Extension icons
├── server/                    # Node.js MCP server
│   ├── server.js              # HTTP MCP server + WebSocket server
│   └── package.json           # Server dependencies
├── rust-server/               # Rust MCP server (experimental)
│   ├── src/                   # Rust source code
│   ├── Cargo.toml             # Rust dependencies
│   └── config.toml            # Server configuration
├── ecosystem.config.cjs       # PM2 process manager config
├── ARCHITECTURE.md            # System architecture documentation
├── API_REFERENCE.md           # Complete MCP tools reference
├── DATA_OPTIMIZATION.md       # Data filtering and pagination guide
└── package.json               # Root scripts and orchestration
```

## How It Works

```
┌─────────────────┐     WebSocket      ┌──────────────────┐      HTTP/MCP      ┌─────────────────┐
│ Chrome Extension │ ◄──────────────── │  MCP Server      │ ◄──────────────── │  Claude Code     │
│                  │   ws://localhost   │  (port 6009)     │   http://localhost │  (one or more    │
│  • content.js    │      :6009/ws     │                  │      :6009/mcp    │   instances)     │
│  • background.js │ ─────────────────►│  • 11 MCP tools  │ ─────────────────►│                  │
│  • inject.js     │                   │  • Resources     │                   │                  │
│  • DevTools      │                   │  • Data filtering│                   │                  │
└─────────────────┘                    └──────────────────┘                    └─────────────────┘
```

1. The **extension** captures browser data via content scripts and Chrome APIs
2. A **WebSocket** connection sends data to the MCP server on port 6009
3. **Claude Code** connects to the server via HTTP transport at `/mcp`
4. Multiple Claude Code instances can share the same server

## Available Tools

| Tool | Description |
|------|-------------|
| `get_page_content` | Extract page text, HTML, and metadata |
| `get_dom_snapshot` | Get structured DOM tree (filterable by CSS selector) |
| `execute_javascript` | Run JavaScript in the page context |
| `get_console_messages` | Read console logs, errors, and warnings |
| `get_network_requests` | Inspect HTTP requests and responses |
| `capture_screenshot` | Take a visual snapshot of the tab |
| `get_performance_metrics` | Get load times and Core Web Vitals |
| `get_accessibility_tree` | Get the accessibility tree |
| `get_browser_tabs` | List all open browser tabs |
| `attach_debugger` | Attach Chrome DevTools debugger to a tab |
| `detach_debugger` | Detach the debugger from a tab |

All tools support an optional `tabId` parameter to target a specific tab. See [API_REFERENCE.md](API_REFERENCE.md) for full parameter documentation.

## Example Workflows

### Debugging Console Errors

Ask Claude Code: *"What errors are showing in the browser console?"*

Claude Code will use `get_console_messages` to retrieve errors and warnings, then analyze them and suggest fixes.

### Analyzing Failed API Calls

Ask: *"Show me the failed network requests and help me debug them"*

Claude Code uses `get_network_requests` with failed-only filtering to find 4xx/5xx responses, then inspects request/response bodies for clues.

### Accessibility Audit

Ask: *"Check this page for accessibility issues"*

Claude Code calls `get_accessibility_tree` and `get_page_content` to analyze ARIA attributes, heading structure, alt text, and semantic HTML.

### Performance Analysis

Ask: *"How's the performance of this page? Any issues?"*

Uses `get_performance_metrics` and `get_network_requests` to identify slow resources, large payloads, and Core Web Vitals issues.

### Visual Inspection

Ask: *"Take a screenshot of the current page"*

`capture_screenshot` returns a PNG or JPEG snapshot of the visible tab.

## Configuration

### Server Port

The server defaults to port **6009**. To use a different port:

```bash
MCP_SERVER_PORT=8080 npm start
```

If you change the port, update the extension's WebSocket URL in the popup (`ws://localhost:8080/ws`) and your Claude Code MCP configuration.

### Extension Settings

Click the extension icon to:
- View connection status
- Change the WebSocket server URL
- Manually trigger data capture
- View message statistics

### Running with PM2 (Production)

```bash
# Start with PM2
npm run pm2:start

# Other PM2 commands
npm run pm2:status    # Check status
npm run pm2:logs      # View logs
npm run pm2:restart   # Restart
npm run pm2:stop      # Stop
```

See [PM2_GUIDE.md](PM2_GUIDE.md) for auto-start on boot and advanced configuration.

### MCP Configuration for Other Clients

For MCP clients that use JSON configuration:

```json
{
  "mcpServers": {
    "browser-mcp": {
      "url": "http://localhost:6009/mcp"
    }
  }
}
```

## Development

### Server Development

```bash
npm run dev          # Start with --watch (auto-restart on changes)
DEBUG=* npm start    # Verbose logging
```

### Extension Development

1. Make changes to files in `extension/`
2. Go to `chrome://extensions/`
3. Click the reload button on the Browser MCP Bridge extension

### Health Check

```bash
npm run health-check
# or: curl http://localhost:6009/health
```

### Adding New Tools

1. Add tool definition in `server.js` → `ListToolsRequestSchema` handler
2. Implement tool logic in `server.js` → `CallToolRequestSchema` handler
3. Add browser-side handler in `extension/background.js`
4. Test with Claude Code

## Data Optimization

The server implements intelligent defaults to keep responses manageable for AI agents:

- **HTML**: Truncated at 50KB (text at 30KB)
- **DOM**: Limited to 500 nodes, scripts/styles excluded
- **Console**: Returns errors and warnings by default
- **Network**: 50 requests, failed requests sorted first, bodies excluded

All limits are configurable per-request. See [DATA_OPTIMIZATION.md](DATA_OPTIMIZATION.md) for the full filtering, pagination, and optimization guide.

## Troubleshooting

### Extension won't connect

1. Verify the server is running: `curl http://localhost:6009/health`
2. Check the WebSocket URL in the extension popup matches the server port
3. Look for errors in the browser console (`chrome://extensions/` → errors link)

### Claude Code can't find the tools

1. Verify MCP configuration: `claude mcp list`
2. Check the server is running and healthy
3. Re-add the server: `claude mcp remove browser-mcp && claude mcp add --scope user --transport http browser-mcp http://127.0.0.1:6009/mcp`

### No data returned from tools

1. Make sure the extension is connected (green status in popup)
2. Navigate to a page in the browser — the extension needs an active page
3. Check if the tab ID is correct (use `get_browser_tabs` first)

### Server won't start

1. Check Node.js version: `node --version` (requires 18.0.0+)
2. Install dependencies: `npm run install-server`
3. Check if port 6009 is in use: `lsof -i :6009`

## Further Reading

- [ARCHITECTURE.md](ARCHITECTURE.md) — System design, data flow, and component details
- [API_REFERENCE.md](API_REFERENCE.md) — Complete MCP tools reference with all parameters
- [DATA_OPTIMIZATION.md](DATA_OPTIMIZATION.md) — Filtering, pagination, and performance tuning

## Requirements

- Node.js 18.0.0+
- Chrome, Edge, or Chromium-based browser
- Claude Code CLI (or any MCP-compatible client)

## License

MIT

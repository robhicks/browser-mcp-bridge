# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Architecture

This is a **Browser MCP Bridge** - a two-part system that connects browser extension data with Claude Code through the Model Context Protocol (MCP):

1. **Browser Extension** (`extension/` directory) - Chrome extension that captures browser data, DOM snapshots, console messages, network activity, and developer tools information
2. **MCP Server** (`server/` directory) - Node.js server that exposes browser data to Claude Code through 11 specialized MCP tools and dynamic resources

### Core Communication Flow
- Extension captures browser data via content scripts, background workers, and DevTools APIs
- WebSocket connection (port 3000) bridges extension and MCP server 
- MCP server exposes tools to Claude Code via stdio transport
- Multi-tab support with tabId-based tool targeting

### Key Components

**Extension Architecture:**
- `manifest.json` - Manifest v3 with extensive permissions (tabs, debugger, scripting, webRequest)
- `background.js` - Service worker handling WebSocket communication and tab management
- `content.js` - Content script for page data extraction and DOM manipulation
- `inject.js` - Injected script for deep page context access
- `devtools.html/js` + `panel.html/js` - Custom DevTools panel for advanced inspection
- `popup.html/js` - Extension popup for connection management

**Server Architecture:**
- `index.js` - Main MCP server with WebSocket server and Express HTTP server
- Implements 11 MCP tools: `get_page_content`, `get_dom_snapshot`, `execute_javascript`, `get_console_messages`, `get_network_requests`, `capture_screenshot`, `get_performance_metrics`, `get_accessibility_tree`, `get_browser_tabs`, `attach_debugger`, `detach_debugger`
- Dynamic resources for real-time browser data access
- Connection management for multiple browser tabs

## Common Development Commands

**Install and Setup:**
```bash
# Install server dependencies
npm run install-server
# or: cd server && npm install

# Install all dependencies
npm run install-all
```

**Development:**
```bash
# Start MCP server in development mode (with --watch)
npm run dev
# or: cd server && npm run dev

# Start MCP server in production mode  
npm start
# or: cd server && npm start
```

**Testing and Verification:**
```bash
# Check server health
npm run health-check
# or: curl http://localhost:3000/health

# Server logs and debugging
DEBUG=* npm start
```

**Maintenance:**
```bash
# Clean server dependencies
npm run clean

# Extension development (after changes)
# 1. Go to chrome://extensions/
# 2. Click reload on Browser MCP Bridge extension
```

## MCP Server Configuration

The server must be added to Claude Code's MCP configuration:

```json
{
  "mcpServers": {
    "browser-mcp": {
      "command": "node",
      "args": ["/path/to/browser-mcp/server/index.js"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

## Development Workflow

1. **Extension Changes:** Modify extension files, then reload extension in `chrome://extensions/`
2. **Server Changes:** Server auto-restarts in dev mode (`npm run dev`), or manually restart
3. **Testing:** Use DevTools panel or Claude Code tools to verify functionality
4. **Connection:** Extension popup shows WebSocket connection status to server

## Architecture Notes

- **Security:** Localhost-only server, minimal extension permissions requested
- **Performance:** Efficient WebSocket messaging with structured data format  
- **Extensibility:** Tool definitions and handlers clearly separated for easy expansion
- **Multi-tab:** All tools support optional `tabId` parameter for tab-specific operations
- **Error Handling:** Comprehensive error responses in WebSocket message format

## Environment Requirements

- Node.js 18.0.0+
- Chrome/Chromium/Edge browser
- Claude Code CLI with MCP server configuration
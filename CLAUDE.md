# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Architecture

This is a **Browser MCP Bridge** - a two-part system that connects browser extension data with Claude Code through the Model Context Protocol (MCP):

1. **Browser Extension** (`extension/` directory) - Chrome extension that captures browser data, DOM snapshots, console messages, network activity, and developer tools information
2. **HTTP MCP Server** (`server/` directory) - Node.js server that exposes browser data to Claude Code through 11 specialized MCP tools and dynamic resources

### Core Communication Flow
- Extension captures browser data via content scripts, background workers, and DevTools APIs
- WebSocket connection (port 6009) bridges extension and MCP server 
- **HTTP MCP Server** allows multiple Claude Code instances to connect to the same server
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
- `server.js` - HTTP MCP server with WebSocket server for browser connections
- **HTTP Transport**: Multiple Claude Code instances can connect to the same server
- **WebSocket Transport**: Browser extensions connect via WebSocket to `/ws`
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

# Use custom port (default: 6009)
MCP_SERVER_PORT=8080 npm start
```

**Production with PM2:**
```bash
# Install PM2 globally
npm install -g pm2

# Start server with PM2
cd server && pm2 start server.js --name browser-mcp-server

# Start with custom port
cd server && pm2 start server.js --name browser-mcp-server --env MCP_SERVER_PORT=8080

# PM2 management commands
pm2 status                    # Check server status
pm2 logs browser-mcp-server  # View server logs
pm2 restart browser-mcp-server # Restart server
pm2 stop browser-mcp-server   # Stop server
pm2 delete browser-mcp-server # Remove from PM2

# Auto-start on system boot
pm2 startup
pm2 save

# Using PM2 ecosystem file (optional)
# Create ecosystem.config.js:
# module.exports = {
#   apps: [{
#     name: 'browser-mcp-server',
#     script: 'server.js',
#     env: {
#       MCP_SERVER_PORT: 6009,
#       NODE_ENV: 'production'
#     },
#     instances: 1,
#     autorestart: true,
#     watch: false,
#     max_memory_restart: '1G'
#   }]
# };

# Start with ecosystem file
pm2 start ecosystem.config.js
```

**Testing and Verification:**
```bash
# Check server health
npm run health-check
# or: curl http://localhost:6009/health

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

**HTTP MCP Server**: The server uses HTTP transport, allowing multiple Claude Code instances to connect to the same server process.

### For Claude Code (Recommended)
```bash
# Add HTTP MCP server via Claude Code CLI
claude mcp add --scope user --transport http browser-mcp http://127.0.0.1:6009/mcp

# Verify configuration
claude mcp list

# Remove if needed
claude mcp remove browser-mcp
```

### For Other MCP Clients
```json
{
  "mcpServers": {
    "browser-mcp": {
      "url": "http://localhost:6009/mcp"
    }
  }
}
```

### Standalone Process (Any MCP Client)
```json
{
  "mcpServers": {
    "browser-mcp": {
      "command": "node",
      "args": ["/path/to/browser-mcp/server/server.js"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

**Benefits of HTTP Transport:**
- **Single Server Instance**: One server handles all Claude Code sessions
- **No Port Conflicts**: Multiple connections to the same endpoint  
- **Better Performance**: Shared server resources and connections
- **Service Discovery**: Known endpoint eliminates port conflicts

## Port Configuration and HTTP Server

**HTTP MCP Server Benefits:**
- **Single Server Instance**: One server handles all Claude Code sessions 
- **Fixed Port**: Always runs on port 6009 (or `MCP_SERVER_PORT` if configured)
- **No Port Conflicts**: Multiple Claude Code instances connect to the same server
- **Service Discovery**: Extensions know exactly where to connect

**Server Configuration:**
```bash
# Default port 6009
npm start

# Custom port
MCP_SERVER_PORT=8080 npm start

# With PM2
pm2 start server.js --name browser-mcp-server --env MCP_SERVER_PORT=8080
```

**Extension Connection:**
- Browser extension connects to WebSocket: `ws://localhost:6009/ws`
- Claude Code connects to HTTP: `http://localhost:6009/mcp`
- If using custom port, update extension popup with new WebSocket URL
- Extensions can save custom URLs for future connections

**Multiple Claude Code Sessions:**
- All instances connect to the same HTTP server
- No port conflicts or discovery issues
- Shared server resources and browser connections
- Consistent performance across sessions

## Development Workflow

1. **Extension Changes:** Modify extension files, then reload extension in `chrome://extensions/`
2. **Server Changes:** Server auto-restarts in dev mode (`npm run dev`), or manually restart
3. **Testing:** Use DevTools panel or Claude Code tools to verify functionality
4. **Connection:** Extension popup shows WebSocket connection status to server

## Architecture Notes

- **HTTP Transport:** Modern MCP server supporting multiple simultaneous Claude Code connections
- **Single Server Instance:** One process serves all clients, eliminating port conflicts
- **Security:** Localhost-only server, minimal extension permissions requested  
- **Performance:** Efficient HTTP MCP protocol with WebSocket browser connections
- **Extensibility:** Tool definitions and handlers clearly separated for easy expansion
- **Multi-tab:** All tools support optional `tabId` parameter for tab-specific operations
- **Error Handling:** Comprehensive JSON-RPC error responses with detailed debugging

## Environment Requirements

- Node.js 18.0.0+
- Chrome/Chromium/Edge browser
- Claude Code CLI with MCP server configuration
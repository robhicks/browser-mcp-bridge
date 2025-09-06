# Browser MCP Bridge

A comprehensive browser extension and MCP server solution that bridges browser content, developer tools data, and web page interactions with Claude Code through the Model Context Protocol (MCP).

## Overview

This project consists of two main components:

1. **Browser Extension** - Captures browser content, DOM data, console messages, network activity, and developer tools information
2. **MCP Server** - Exposes browser data to Claude Code through standardized MCP tools and resources

## Features

### Browser Extension
- **Page Content Extraction** - Full HTML, text content, metadata, and page structure
- **DOM Inspection** - Complete DOM tree snapshots with computed styles
- **Console Monitoring** - Real-time console logs, errors, and warnings
- **Network Activity** - HTTP requests, responses, and performance metrics
- **Developer Tools Integration** - Custom DevTools panel for advanced inspection
- **JavaScript Execution** - Execute arbitrary JavaScript in page context
- **Screenshot Capture** - Visual snapshots of browser tabs
- **Accessibility Data** - Accessibility tree and ARIA attributes
- **Performance Metrics** - Load times, resource usage, and Core Web Vitals

### MCP Server
- **11 Specialized Tools** - Comprehensive browser automation and inspection tools
- **Dynamic Resources** - Real-time access to page content, DOM, and console data
- **WebSocket Communication** - Real-time bidirectional communication with browser
- **Multi-tab Support** - Manage and inspect multiple browser tabs simultaneously

## Installation

### Prerequisites

- Node.js 18.0.0 or higher
- Chrome, Edge, or Chromium-based browser
- Claude Code CLI

### 1. Install the MCP Server

```bash
# Clone or navigate to the project directory
cd /path/to/browser-mcp

# Install server dependencies
cd server
npm install

# Make the server executable
chmod +x index.js
```

### 2. Install the Browser Extension

#### Chrome/Chromium/Edge Installation

1. **Open Extension Management**
   - Navigate to `chrome://extensions/` (Chrome)
   - Or `edge://extensions/` (Edge)

2. **Enable Developer Mode**
   - Toggle "Developer mode" in the top-right corner

3. **Load the Extension**
   - Click "Load unpacked"
   - Select the `/path/to/browser-mcp/extension` directory
   - The extension should appear in your extensions list

4. **Verify Installation**
   - Look for the "Browser MCP Bridge" extension icon in your toolbar
   - The extension should show as "Enabled"

#### Alternative: Create Extension Package

```bash
# Navigate to extension directory
cd extension

# Create a zip package for distribution
zip -r browser-mcp-extension.zip . -x "*.DS_Store" "node_modules/*"
```

### 3. Configure Claude Code

Add the MCP server to your Claude Code configuration:

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

**macOS/Linux:**
Edit `~/.config/claude-desktop/claude_desktop_config.json`

**Windows:**
Edit `%APPDATA%/Claude/claude_desktop_config.json`

## Usage

### 1. Start the MCP Server

The server starts automatically when Claude Code launches, or manually:

```bash
cd server
npm start
```

The server will:
- Listen on port 3000 for WebSocket connections
- Provide health check endpoint at `http://localhost:3000/health`
- Connect to Claude Code via stdio

### 2. Connect Browser Extension

1. **Open the Extension Popup**
   - Click the Browser MCP Bridge icon in your toolbar

2. **Configure Connection**
   - Server URL should default to `ws://localhost:3000/mcp`
   - Click "Connect to Server"
   - Status should change to "Connected"

3. **Verify Connection**
   - Green status indicator shows successful connection
   - Extension will automatically reconnect if disconnected

### 3. Use Claude Code Tools

Once connected, Claude Code has access to these tools:

#### Page Inspection Tools

```bash
# Get complete page content and metadata
get_page_content

# Get structured DOM snapshot
get_dom_snapshot

# Execute JavaScript in page context
execute_javascript --code "document.title"

# Capture screenshot
capture_screenshot
```

#### Developer Tools

```bash
# Get console messages
get_console_messages

# Get network requests
get_network_requests

# Get performance metrics
get_performance_metrics

# Get accessibility tree
get_accessibility_tree
```

#### Browser Management

```bash
# List all open tabs
get_browser_tabs

# Attach debugger for advanced inspection
attach_debugger --tabId 123

# Detach debugger
detach_debugger --tabId 123
```

### 4. DevTools Panel

1. **Open Chrome DevTools**
   - Right-click on any page → "Inspect"
   - Or press `F12`

2. **Find MCP Bridge Panel**
   - Look for "MCP Bridge" tab alongside Console, Network, etc.
   - Click to open the custom panel

3. **Use Panel Features**
   - Quick capture buttons for different data types
   - Real-time connection status
   - Message logging and debugging
   - Visual data display

## Example Workflows

### Web Development Debugging

1. **Inspect Page Issues**
   ```bash
   # In Claude Code
   "Analyze this page for accessibility issues"
   # Uses get_accessibility_tree and get_page_content
   ```

2. **Performance Analysis**
   ```bash
   "Check this page's performance metrics and suggest optimizations"
   # Uses get_performance_metrics and get_network_requests
   ```

3. **Console Error Analysis**
   ```bash
   "Review the console errors and help me fix them"
   # Uses get_console_messages
   ```

### Automated Testing Support

1. **Form Testing**
   ```bash
   execute_javascript --code "
     const form = document.querySelector('form');
     const inputs = form.querySelectorAll('input');
     return Array.from(inputs).map(i => ({name: i.name, type: i.type}));
   "
   ```

2. **Visual Regression**
   ```bash
   capture_screenshot
   # Compare with baseline screenshots
   ```

### Content Analysis

1. **SEO Analysis**
   ```bash
   get_page_content --includeMetadata true
   # Analyze meta tags, headings, content structure
   ```

2. **Content Extraction**
   ```bash
   execute_javascript --code "
     return Array.from(document.querySelectorAll('article')).map(a => a.innerText);
   "
   ```

## Configuration

### Extension Settings

The extension popup allows you to:
- Change WebSocket server URL
- View connection statistics
- Manually trigger data capture
- Access DevTools panel

### Server Configuration

Environment variables:

```bash
# WebSocket port (default: 3000)
PORT=3000

# Enable debug logging
DEBUG=true

# Maximum message size (bytes)
MAX_MESSAGE_SIZE=10485760
```

### Security Considerations

- **Local Connection Only** - Server only accepts connections from localhost
- **Same-Origin Policy** - Extension respects browser security policies
- **No Password Storage** - No sensitive data is stored or transmitted
- **Minimal Permissions** - Extension requests only necessary permissions

## Troubleshooting

### Extension Issues

**Extension not loading:**
```bash
# Check browser console for errors
# Verify all files are present in extension directory
# Ensure manifest.json is valid
```

**Connection failures:**
```bash
# Verify MCP server is running on port 3000
# Check WebSocket URL in extension popup
# Look for firewall blocking localhost:3000
```

### Server Issues

**Server won't start:**
```bash
# Check Node.js version (18.0.0+)
npm list  # Verify dependencies installed
node --version
```

**MCP connection fails:**
```bash
# Verify Claude Code configuration
# Check server logs for errors
# Ensure stdio communication is working
```

### Common Fixes

1. **Restart Everything**
   ```bash
   # Stop Claude Code
   # Kill server process
   # Disable/re-enable extension
   # Restart browser
   # Start server and Claude Code
   ```

2. **Clear Extension Storage**
   ```bash
   # In Chrome: chrome://extensions/
   # Find extension → Details → Extension options
   # Clear stored data
   ```

3. **Reset Server Connection**
   ```bash
   cd server
   npm run dev  # Use with --watch for debugging
   ```

## Development

### Extension Development

```bash
cd extension

# Watch for changes (if using build tools)
npm run dev

# Test in browser
# Make changes and reload extension
```

### Server Development

```bash
cd server

# Development mode with auto-restart
npm run dev

# Debug mode with verbose logging
DEBUG=* npm start
```

### Adding New Tools

1. **Add tool definition** to server `ListToolsRequestSchema` handler
2. **Implement tool logic** in server `CallToolRequestSchema` handler
3. **Add browser-side handler** in extension background.js
4. **Test with Claude Code**

## API Reference

### MCP Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_page_content` | Extract page HTML, text, metadata | `tabId?`, `includeMetadata?` |
| `get_dom_snapshot` | Get structured DOM tree | `tabId?`, `maxDepth?`, `includeStyles?` |
| `execute_javascript` | Run JS in page context | `tabId?`, `code` |
| `get_console_messages` | Retrieve console logs | `tabId?`, `types?`, `limit?` |
| `get_network_requests` | Get network activity | `tabId?`, `limit?` |
| `capture_screenshot` | Take visual snapshot | `tabId?`, `format?`, `quality?` |
| `get_performance_metrics` | Performance data | `tabId?` |
| `get_accessibility_tree` | A11y tree structure | `tabId?` |
| `get_browser_tabs` | List all tabs | None |
| `attach_debugger` | Enable advanced inspection | `tabId` |
| `detach_debugger` | Disable debugger | `tabId` |

### WebSocket Messages

The extension communicates with the server using structured WebSocket messages:

```javascript
// Page content data
{
  type: "browser-data",
  source: "content-script",
  tabId: 123,
  url: "https://example.com",
  data: { /* page content */ }
}

// Tool responses
{
  type: "response",
  action: "getPageContent",
  tabId: 123,
  data: { /* response data */ }
}

// Error messages
{
  type: "error",
  action: "getPageContent",
  tabId: 123,
  error: "Error message"
}
```

## License

MIT License - See LICENSE file for details.

## Contributing

1. Fork the repository
2. Create feature branch
3. Make changes with tests
4. Submit pull request

## Support

For issues and questions:
- Check troubleshooting section above
- Review browser console and server logs
- Create GitHub issue with detailed information
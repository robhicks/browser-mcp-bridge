# Installation Guide

Complete step-by-step installation instructions for the Browser MCP Bridge.

## Quick Start

1. **Install MCP Server**: `cd server && npm install`
2. **Install Browser Extension**: Load `/extension` folder in Chrome
3. **Configure Claude Code**: Add server to MCP configuration
4. **Connect**: Click extension icon and connect to server

## Detailed Installation

### Step 1: Install the MCP Server

#### Prerequisites Check

```bash
# Verify Node.js version (18.0.0+)
node --version

# Should output: v18.0.0 or higher
# If not installed: https://nodejs.org/
```

#### Install Server

```bash
# Navigate to server directory
cd browser-mcp/server

# Install dependencies
npm install

# Verify installation
npm list

# Make executable (Unix/macOS)
chmod +x index.js
```

#### Test Server Installation

```bash
# Start server in test mode
npm start

# Should see: "Browser MCP Bridge Server running on stdio"
# Press Ctrl+C to stop

# Test WebSocket server
curl http://localhost:3000/health
# Should return: {"status":"ok","connections":0,"timestamp":"..."}
```

### Step 2: Install Browser Extension

#### For Chrome/Chromium/Edge

1. **Open Browser Extension Management**
   - **Chrome**: Navigate to `chrome://extensions/`
   - **Edge**: Navigate to `edge://extensions/`
   - **Brave**: Navigate to `brave://extensions/`
   - **Opera**: Navigate to `opera://extensions/`

2. **Enable Developer Mode**
   - Look for "Developer mode" toggle in top-right corner
   - Click to enable (switch should turn blue/green)

3. **Load Extension**
   - Click "Load unpacked" button
   - Navigate to and select the `browser-mcp/extension` folder
   - Click "Select Folder" or "Open"

4. **Verify Extension Installation**
   - Extension should appear in the list as "Browser MCP Bridge"
   - Status should show "Enabled"
   - Icon should appear in browser toolbar (puzzle piece area)

#### For Firefox (Alternative Installation)

Firefox requires a different approach for permanent installation:

1. **Temporary Installation**
   - Navigate to `about:debugging#/runtime/this-firefox`
   - Click "Load Temporary Add-on"
   - Select `manifest.json` in the extension folder

2. **Permanent Installation** (Requires signing)
   ```bash
   # Install web-ext tool
   npm install -g web-ext
   
   # Package extension
   cd extension
   web-ext build
   
   # Sign with Mozilla (requires developer account)
   web-ext sign --api-key=YOUR_KEY --api-secret=YOUR_SECRET
   ```

#### Extension Permissions

The extension will request these permissions:
- **tabs**: Access tab information and URLs
- **activeTab**: Access content of active tab when clicked
- **scripting**: Inject content scripts for data extraction
- **debugger**: Advanced developer tools integration
- **webNavigation**: Track page navigation events
- **storage**: Store user preferences and connection settings
- **webRequest**: Monitor network requests
- **contextMenus**: Add right-click menu options

Click "Allow" for all requested permissions.

### Step 3: Configure Claude Code

#### Locate Configuration File

**macOS:**
```bash
~/.config/claude-desktop/claude_desktop_config.json
```

**Linux:**
```bash
~/.config/claude-desktop/claude_desktop_config.json
```

**Windows:**
```bash
%APPDATA%/Claude/claude_desktop_config.json
```

#### Add MCP Server Configuration

Create or edit the configuration file:

```json
{
  "mcpServers": {
    "browser-mcp": {
      "command": "node",
      "args": ["/full/path/to/browser-mcp/server/index.js"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

**Important**: Replace `/full/path/to/browser-mcp/server/index.js` with the actual absolute path to your installation.

#### Find Absolute Path

```bash
# Unix/macOS/Linux
cd browser-mcp/server
pwd
# Copy the output and append /index.js

# Windows
cd browser-mcp\server
cd
# Copy the output and append \index.js
```

#### Alternative Configuration (Development)

For development with auto-restart:

```json
{
  "mcpServers": {
    "browser-mcp": {
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": "/full/path/to/browser-mcp/server",
      "env": {
        "NODE_ENV": "development",
        "DEBUG": "true"
      }
    }
  }
}
```

### Step 4: Start and Connect

#### Start Claude Code

```bash
# Launch Claude Code
claude-code

# Or if installed globally
claude

# Verify MCP server is loaded
# Look for "browser-mcp" in available servers
```

#### Connect Browser Extension

1. **Open Extension**
   - Click the Browser MCP Bridge icon in your browser toolbar
   - Extension popup should open

2. **Configure Connection**
   - Server URL should default to: `ws://localhost:3000/mcp`
   - Port should be: `3000`
   - Connection type: `WebSocket`

3. **Connect to Server**
   - Click "Connect to Server" button
   - Status should change from red "Disconnected" to green "Connected"
   - Connection indicator should show active connection

4. **Verify Connection**
   - Message counter should show sent/received messages
   - Server health endpoint should show active connections: `curl http://localhost:3000/health`

## Platform-Specific Instructions

### macOS Installation

```bash
# Install Node.js via Homebrew (recommended)
brew install node

# Or download from nodejs.org

# Install server
cd browser-mcp/server
npm install

# Configure Claude Code
vi ~/.config/claude-desktop/claude_desktop_config.json
```

### Windows Installation

```powershell
# Install Node.js from nodejs.org
# Or via Chocolatey
choco install nodejs

# Install server
cd browser-mcp\server
npm install

# Configure Claude Code (PowerShell)
notepad $env:APPDATA\Claude\claude_desktop_config.json
```

### Linux Installation

```bash
# Install Node.js via package manager
# Ubuntu/Debian:
sudo apt update
sudo apt install nodejs npm

# CentOS/RHEL/Fedora:
sudo dnf install nodejs npm

# Install server
cd browser-mcp/server
npm install

# Configure Claude Code
nano ~/.config/claude-desktop/claude_desktop_config.json
```

## Docker Installation (Optional)

For containerized deployment:

```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app
COPY server/package*.json ./
RUN npm ci --only=production

COPY server/ ./
EXPOSE 3000

CMD ["node", "index.js"]
```

```bash
# Build and run
docker build -t browser-mcp-server .
docker run -p 3000:3000 browser-mcp-server
```

## Verification Steps

### 1. Test MCP Server

```bash
# Check if server starts without errors
cd browser-mcp/server
npm start

# Should see:
# "MCP Bridge server listening on port 3000"
# "Browser MCP Bridge Server running on stdio"
```

### 2. Test Browser Extension

1. Open any webpage
2. Click extension icon
3. Should see popup with connection controls
4. Status should show current connection state

### 3. Test Claude Code Integration

In Claude Code, try:

```bash
# List available tools
/tools

# Should include browser-mcp tools like:
# - get_page_content
# - get_dom_snapshot
# - execute_javascript
# etc.
```

### 4. Test End-to-End Connection

1. Open a webpage (e.g., https://example.com)
2. Connect extension to server
3. In Claude Code, run: `get_page_content`
4. Should return webpage content and metadata

## Troubleshooting Installation

### Server Issues

**Node.js version error:**
```bash
# Update Node.js to 18.0.0+
nvm install 18
nvm use 18
```

**Port already in use:**
```bash
# Find process using port 3000
lsof -i :3000
# or
netstat -tulpn | grep :3000

# Kill process or change port in server/index.js
```

**Dependencies not installing:**
```bash
# Clear npm cache
npm cache clean --force

# Delete node_modules and reinstall
rm -rf node_modules package-lock.json
npm install
```

### Extension Issues

**Extension not loading:**
- Verify all files are present in `/extension` folder
- Check browser console for JavaScript errors
- Ensure `manifest.json` is valid JSON

**Permissions denied:**
- Grant all requested permissions during installation
- Check browser security settings
- Try incognito/private mode to test

**Extension icon not appearing:**
- Check if extension is enabled in `chrome://extensions/`
- Pin extension icon to toolbar
- Restart browser after installation

### Claude Code Configuration

**MCP server not starting:**
- Verify absolute path in configuration file
- Check file permissions on `index.js`
- Ensure Claude Code has permission to execute Node.js

**Configuration file not found:**
- Create directory structure if missing:
  ```bash
  mkdir -p ~/.config/claude-desktop/
  touch ~/.config/claude-desktop/claude_desktop_config.json
  ```

### Connection Issues

**WebSocket connection fails:**
- Verify server is running on correct port
- Check firewall settings for localhost:3000
- Try different browser or incognito mode
- Restart both server and browser

**Extension can't reach server:**
- Confirm WebSocket URL in extension popup
- Test server health: `curl http://localhost:3000/health`
- Check browser network tab for WebSocket errors

## Next Steps

After successful installation:

1. **Read Usage Guide** - See README.md for detailed usage instructions
2. **Try Example Workflows** - Test basic functionality with provided examples
3. **Open DevTools Panel** - Access advanced features through browser DevTools
4. **Explore Claude Code Integration** - Use MCP tools within Claude Code sessions

## Getting Help

If installation fails:

1. **Check Prerequisites** - Verify Node.js version and browser compatibility
2. **Review Error Messages** - Look at console output and error logs
3. **Test Components Individually** - Isolate server, extension, and Claude Code issues
4. **Check Permissions** - Ensure proper file and execution permissions
5. **Create GitHub Issue** - Include error messages and system information
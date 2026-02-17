# Architecture

This document describes the system design, component relationships, and key design decisions of Browser MCP Bridge.

## System Overview

Browser MCP Bridge is a three-layer system that exposes browser data to AI coding agents through the Model Context Protocol:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Claude Code (MCP Client)                        │
│                                                                             │
│  Connects via HTTP POST to http://localhost:6009/mcp                       │
│  Multiple instances can share the same server                              │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │ HTTP (MCP JSON-RPC)
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          MCP Server (Node.js)                              │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  HTTP/MCP     │  │  WebSocket   │  │  Tool        │  │  Data         │  │
│  │  Transport    │  │  Server      │  │  Handlers    │  │  Management   │  │
│  │  (/mcp)       │  │  (/ws)       │  │  (11 tools)  │  │  & Filtering  │  │
│  └──────────────┘  └──────┬───────┘  └──────────────┘  └───────────────┘  │
│                           │                                                 │
└───────────────────────────┼─────────────────────────────────────────────────┘
                            │ WebSocket (ws://localhost:6009/ws)
                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Chrome Extension (Manifest V3)                      │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  background   │  │  content.js   │  │  inject.js   │  │  DevTools     │  │
│  │  (service     │  │  (DOM access, │  │  (console,   │  │  Panel        │  │
│  │   worker)     │  │   page data)  │  │   network)   │  │  (manual      │  │
│  │              │  │              │  │              │  │   capture)    │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └───────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Component Details

### Chrome Extension

The extension runs as a Manifest V3 Chrome extension with four execution contexts:

#### `background.js` — Service Worker

The central coordinator. Manages:

- **WebSocket connection** to the MCP server (connect, reconnect, health monitoring)
- **Tab tracking** — maintains a map of active tabs and their data
- **Message routing** — bridges communication between content scripts, inject scripts, DevTools panel, popup, and the server
- **Network monitoring** — intercepts HTTP requests via `chrome.webRequest` API (max 200 per tab)
- **Debugger management** — attach/detach Chrome DevTools Protocol via `chrome.debugger`
- **Health checks** — 10-second ping/pong cycle, auto-reconnect on 3 consecutive failures

Key data structures:
```
MCPBridge {
  ws: WebSocket                    // Server connection
  tabData: Map<tabId, TabData>     // Per-tab browser data
  networkRequests: Map<tabId, []>  // Per-tab network requests
  pendingRequests: Map<id, cb>     // Request-response correlation
}
```

#### `content.js` — Content Script

Runs on every page at `document_idle`. Contains the `PageDataExtractor` class:

- **Page content** — extracts HTML, text, title, URL, metadata
- **DOM snapshots** — builds structured DOM tree with configurable depth
- **Form data** — extracts form fields and their values
- **Links, images, scripts** — enumerates page resources
- **Computed styles** — retrieves CSS computed styles for elements
- **Performance metrics** — reads `window.performance` API data
- **Accessibility tree** — builds a11y tree from DOM elements and ARIA attributes
- **JavaScript execution** — runs arbitrary code in page context via `eval()`

#### `inject.js` — Injected Page Script

Injected into the page's own JavaScript context (not the content script sandbox). Non-invasively intercepts:

- **Console messages** — wraps `console.log/error/warn/info/debug` (preserves originals, max 1,000 captured)
- **Network requests** — intercepts `fetch()` and `XMLHttpRequest` to capture request/response details with timing
- **Errors** — captures `window.onerror` and unhandled promise rejections

Data is forwarded to the content script via `window.postMessage`.

#### DevTools Panel (`devtools.js`, `panel.js`)

A custom Chrome DevTools panel ("MCP Bridge" tab) for manual data capture:

- Quick-capture buttons for each data type
- Real-time connection status display
- Access to HAR data and inspected window context
- Message logging for debugging

#### Popup (`popup.js`)

Extension toolbar popup for connection management:

- Connect/disconnect toggle
- Server URL configuration (persisted via `chrome.storage.sync`)
- Live message count (sent/received)
- Connection state display (connected, disconnected, reconnecting)

### MCP Server (`server/server.js`)

A single Node.js process serving two protocols on port 6009:

#### HTTP Transport (`/mcp`)

Implements MCP JSON-RPC over HTTP using `@modelcontextprotocol/sdk`. Handles:

- `tools/list` — returns definitions for all 11 tools
- `tools/call` — executes tool logic and returns results
- `resources/list` — lists available browser data resources
- `resources/read` — reads resource content by URI

Multiple Claude Code instances connect to the same endpoint with no port conflicts.

#### WebSocket Server (`/ws`)

Accepts connections from browser extensions. Protocol:

```
Server → Extension:  { type: "request", requestId, action, tabId, params }
Extension → Server:  { type: "response", requestId, action, data }
Extension → Server:  { type: "notification", event: { type, source, tabId, data } }
```

Requests use UUID-based correlation (`requestId`) with timeout-based cleanup.

#### Data Processing Pipeline

All tool responses pass through a processing pipeline:

```
Raw browser data
    → Filtering (by type, status, domain, CSS selector, search term)
    → Truncation (enforced size limits per data type)
    → Pagination (cursor-based, 5-minute TTL)
    → Response formatting (count, total, hasMore, nextCursor)
```

Default size limits:
| Data Type | Default Limit |
|-----------|--------------|
| HTML content | 50 KB |
| Text content | 30 KB |
| DOM nodes | 500 |
| Console messages | 50 per page |
| Network requests | 50 per page |
| Request/response bodies | 10 KB each |
| Total response | 100 KB |

### Rust Server (Experimental)

An alternative server implementation in `rust-server/` targeting higher performance. Uses:

- **Axum** for HTTP/WebSocket serving
- **DashMap** for lock-free concurrent data storage
- **SIMD JSON** for fast parsing
- **Tokio** for async runtime

Current status: WebSocket server and caching layer work; full MCP protocol integration is pending `rmcp` SDK compatibility.

## Data Flow

### Tool Call Lifecycle

```
1. Claude Code sends MCP tool call
       │
       ▼
2. Server receives HTTP POST at /mcp
       │
       ▼
3. Server identifies target tab (explicit tabId or most recent)
       │
       ▼
4. Server sends WebSocket request to extension
       { type: "request", requestId: "uuid", action: "getPageContent", tabId: 123 }
       │
       ▼
5. background.js routes to content.js via chrome.tabs.sendMessage
       │
       ▼
6. content.js / inject.js collects data from page
       │
       ▼
7. Data flows back: content.js → background.js → WebSocket → server
       { type: "response", requestId: "uuid", data: { ... } }
       │
       ▼
8. Server applies filtering, truncation, pagination
       │
       ▼
9. MCP response returned to Claude Code
```

### Extension Data Collection

```
Page loads in browser tab
       │
       ├──► content.js extracts page content, DOM, metadata
       │         └──► Sent to background.js via chrome.runtime.sendMessage
       │
       ├──► inject.js intercepts console.log, fetch, XHR
       │         └──► Sent to content.js via window.postMessage
       │              └──► Forwarded to background.js
       │
       └──► background.js monitors network via chrome.webRequest
                  └──► Stored in tabData map
```

## Design Decisions

### HTTP Transport Instead of Stdio

**Decision:** Use HTTP streamable transport for MCP instead of stdio.

**Why:** Stdio requires each Claude Code session to spawn its own server process. HTTP transport allows a single long-running server to serve multiple Claude Code sessions simultaneously, eliminating port conflicts and reducing resource usage.

**Trade-off:** Requires the server to be started separately (or via PM2), rather than auto-launching when Claude Code starts.

### Single Port for Both Protocols

**Decision:** HTTP and WebSocket both run on port 6009.

**Why:** Simplifies configuration — one port to remember, one port to open. WebSocket upgrades happen on the `/ws` path while MCP uses `/mcp`.

### Extension Inject Script (`inject.js`)

**Decision:** Use a separate injected script running in the page's JavaScript context.

**Why:** Content scripts run in an isolated world and cannot intercept `console.log` or monkey-patch `fetch`/`XHR`. The inject script runs in the page's own context, enabling non-invasive interception of console output and network requests.

**Trade-off:** Requires `web_accessible_resources` in the manifest and `window.postMessage` for cross-context communication.

### Data Truncation and Smart Defaults

**Decision:** Aggressively limit response sizes with AI-friendly defaults.

**Why:** Full page DOM trees and complete network logs can exceed 1MB, which overwhelms AI context windows and wastes tokens. Default limits (500 DOM nodes, 50 console messages, errors-only filtering) provide the most relevant data in a compact format.

**Trade-off:** Users may need to make multiple requests with different filters to find specific data. Pagination cursors address this.

### Cursor-Based Pagination

**Decision:** Use UUID-based cursor pagination with 5-minute TTL instead of offset-based.

**Why:** Offset pagination breaks when the underlying data changes between requests. Cursor pagination stores the full filtered dataset at query time, ensuring consistent results across pages.

**Trade-off:** Server holds pagination state in memory. The 5-minute TTL prevents unbounded growth.

## Extension Permissions

The extension requests these Chrome permissions:

| Permission | Why |
|-----------|-----|
| `tabs` | List and query browser tabs |
| `activeTab` | Access the current tab's content |
| `scripting` | Inject content scripts dynamically |
| `debugger` | Attach Chrome DevTools Protocol for advanced inspection |
| `webNavigation` | Track page navigations for data freshness |
| `storage` | Persist extension settings (server URL) |
| `webRequest` | Monitor network requests per tab |
| `contextMenus` | Right-click menu integration |
| `windows` | Window management for tab operations |
| `<all_urls>` | Access content on any website |

## Security Model

- **Localhost only** — the server binds to `127.0.0.1` and does not accept remote connections
- **No authentication** — relies on localhost trust model (only local processes can connect)
- **No data persistence** — browser data is held in memory only, cleared on server restart
- **Extension sandboxing** — content scripts run in Chrome's isolated world; inject script uses `postMessage` boundaries
- **No eval in server** — JavaScript execution happens in the browser, not the server

## File Reference

| File | Lines | Purpose |
|------|-------|---------|
| `server/server.js` | ~1,200 | MCP server, WebSocket server, all tool handlers |
| `extension/background.js` | ~900 | Service worker, connection management, message routing |
| `extension/content.js` | ~500 | Page data extraction (DOM, content, a11y, performance) |
| `extension/inject.js` | ~150 | Console/network interception in page context |
| `extension/popup.js` | ~200 | Extension popup UI logic |
| `extension/panel.js` | ~300 | DevTools panel UI and capture logic |

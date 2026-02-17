# API Reference

Complete reference for all 11 MCP tools exposed by Browser MCP Bridge.

## Common Parameters

All tools except `get_browser_tabs` accept an optional `tabId` parameter:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tabId` | `number` | Active tab | Browser tab ID. Use `get_browser_tabs` to list available tabs. If omitted, the server targets the most recently active tab. |

## Tools

---

### `get_page_content`

Extract the text content, HTML, and metadata of a web page.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tabId` | `number` | Active tab | Target tab |
| `includeMetadata` | `boolean` | `true` | Include page title, meta tags, Open Graph data |
| `includeHtml` | `boolean` | `false` | Include raw HTML (truncated at 50KB) |
| `maxTextLength` | `number` | `30000` | Maximum characters of text content to return |

**Response:**

```json
{
  "url": "https://example.com",
  "title": "Example Page",
  "text": "Page text content...",
  "metadata": {
    "title": "Example Page",
    "description": "A sample page",
    "keywords": "example, sample",
    "ogTitle": "Example Page",
    "ogDescription": "...",
    "ogImage": "https://..."
  },
  "html": "<!DOCTYPE html>...",
  "truncated": {
    "text": false,
    "html": true,
    "originalHtmlSize": 125000
  }
}
```

**Examples:**

```javascript
// Get text content only (fast, small response)
get_page_content()

// Get text + HTML
get_page_content({ includeHtml: true })

// Get metadata for SEO analysis
get_page_content({ includeMetadata: true, maxTextLength: 5000 })
```

---

### `get_dom_snapshot`

Get a structured snapshot of the page's DOM tree. Useful for understanding page structure, finding elements, and inspecting attributes.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tabId` | `number` | Active tab | Target tab |
| `maxDepth` | `number` | `5` | Maximum tree depth (max: 15) |
| `maxNodes` | `number` | `500` | Maximum nodes to return (max: 2000) |
| `includeStyles` | `boolean` | `false` | Include computed CSS styles (significantly increases size) |

**Response:**

```json
{
  "root": {
    "tag": "html",
    "attributes": { "lang": "en" },
    "children": [
      {
        "tag": "head",
        "children": [...]
      },
      {
        "tag": "body",
        "attributes": { "class": "main-page" },
        "children": [...]
      }
    ]
  },
  "nodeCount": 487,
  "originalNodeCount": 5234,
  "truncated": true,
  "message": "DOM tree truncated to 500 nodes (original: 5234 nodes)."
}
```

**Examples:**

```javascript
// Default snapshot (500 nodes, depth 5)
get_dom_snapshot()

// Detailed snapshot of a larger section
get_dom_snapshot({ maxNodes: 1000, maxDepth: 10 })

// Include computed styles for CSS debugging
get_dom_snapshot({ maxNodes: 200, includeStyles: true })
```

---

### `execute_javascript`

Execute JavaScript code in the browser page context and return the result.

**Parameters:**

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `tabId` | `number` | Active tab | No | Target tab |
| `code` | `string` | — | **Yes** | JavaScript code to execute |

**Response:**

The return value of the executed code, serialized as JSON.

**Examples:**

```javascript
// Get the page title
execute_javascript({ code: "document.title" })

// Count elements
execute_javascript({ code: "document.querySelectorAll('a').length" })

// Extract structured data
execute_javascript({
  code: `
    Array.from(document.querySelectorAll('h2')).map(h => ({
      text: h.textContent.trim(),
      id: h.id
    }))
  `
})

// Check form values
execute_javascript({
  code: `
    const form = document.querySelector('form');
    const data = new FormData(form);
    Object.fromEntries(data.entries())
  `
})

// Interact with the page
execute_javascript({
  code: "document.querySelector('#submit-btn').click()"
})
```

**Security note:** Code executes in the full page context with access to the page's JavaScript scope, DOM, cookies, and localStorage.

---

### `get_console_messages`

Retrieve console messages (logs, errors, warnings) from the browser.

**Smart default:** Returns only `error` and `warn` messages, which are most relevant for debugging.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tabId` | `number` | Active tab | Target tab |
| `types` | `string[]` | `["error", "warn"]` | Message types to include. Options: `log`, `error`, `warn`, `info`, `debug` |
| `limit` | `number` | `100` | Maximum messages to return |

**Response:**

```json
{
  "messages": [
    {
      "level": "error",
      "message": "Uncaught TypeError: Cannot read property 'x' of undefined",
      "timestamp": 1708123456789,
      "source": "https://example.com/app.js",
      "line": 42,
      "column": 15,
      "stack": "TypeError: Cannot read property 'x' of undefined\n    at App.render (app.js:42:15)"
    },
    {
      "level": "warn",
      "message": "Deprecation warning: componentWillMount has been renamed",
      "timestamp": 1708123456800
    }
  ],
  "count": 2,
  "total": 2
}
```

**Examples:**

```javascript
// Get errors and warnings (default)
get_console_messages()

// Get all console output
get_console_messages({ types: ["log", "error", "warn", "info", "debug"] })

// Get only errors
get_console_messages({ types: ["error"], limit: 20 })
```

---

### `get_network_requests`

Inspect HTTP requests made by the page. Failed requests (4xx, 5xx) are sorted first.

**Smart defaults:** Request and response bodies are excluded to keep responses small. Failed requests appear first.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tabId` | `number` | Active tab | Target tab |
| `limit` | `number` | `50` | Maximum requests to return (max: 200) |
| `includeResponseBodies` | `boolean` | `false` | Include response bodies (truncated at 10KB each) |
| `includeRequestBodies` | `boolean` | `false` | Include request bodies (truncated at 10KB each) |

**Response:**

```json
{
  "requests": [
    {
      "url": "https://api.example.com/users",
      "method": "GET",
      "status": 500,
      "statusText": "Internal Server Error",
      "type": "xhr",
      "duration": 234,
      "size": 1523,
      "timestamp": 1708123456789,
      "requestHeaders": { "Authorization": "Bearer ..." },
      "responseHeaders": { "content-type": "application/json" }
    }
  ],
  "count": 15,
  "total": 342,
  "message": "Showing 15 of 342 requests. Failed requests sorted first."
}
```

**Examples:**

```javascript
// Get recent requests (failed first)
get_network_requests()

// Get requests with response bodies for debugging
get_network_requests({
  limit: 10,
  includeResponseBodies: true,
  includeRequestBodies: true
})

// Get more requests
get_network_requests({ limit: 200 })
```

---

### `capture_screenshot`

Take a visual snapshot of the current browser tab.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tabId` | `number` | Active tab | Target tab |
| `format` | `string` | `"png"` | Image format: `"png"` or `"jpeg"` |
| `quality` | `number` | `90` | JPEG quality (0-100). Ignored for PNG. |

**Response:**

Returns a base64-encoded image as an MCP image content block.

**Examples:**

```javascript
// PNG screenshot (default)
capture_screenshot()

// JPEG for smaller file size
capture_screenshot({ format: "jpeg", quality: 75 })
```

---

### `get_performance_metrics`

Get performance timing data and Core Web Vitals from the browser.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tabId` | `number` | Active tab | Target tab |

**Response:**

```json
{
  "timing": {
    "navigationStart": 1708123456000,
    "domContentLoaded": 1708123456500,
    "loadComplete": 1708123457200,
    "firstPaint": 1708123456300,
    "firstContentfulPaint": 1708123456400,
    "domInteractive": 1708123456450,
    "ttfb": 120
  },
  "resources": [
    {
      "name": "https://example.com/style.css",
      "type": "css",
      "duration": 45,
      "size": 12340
    }
  ],
  "memory": {
    "usedJSHeapSize": 12500000,
    "totalJSHeapSize": 25000000
  }
}
```

---

### `get_accessibility_tree`

Get the accessibility tree structure of the page, including ARIA roles, labels, and states.

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tabId` | `number` | Active tab | Target tab |

**Response:**

```json
{
  "tree": {
    "role": "document",
    "name": "Example Page",
    "children": [
      {
        "role": "navigation",
        "name": "Main Navigation",
        "children": [
          { "role": "link", "name": "Home", "href": "/" },
          { "role": "link", "name": "About", "href": "/about" }
        ]
      },
      {
        "role": "main",
        "children": [
          { "role": "heading", "name": "Welcome", "level": 1 },
          { "role": "img", "name": "", "missingAlt": true }
        ]
      }
    ]
  }
}
```

---

### `get_browser_tabs`

List all open browser tabs with their IDs, URLs, and titles.

**Parameters:** None

**Response:**

```json
{
  "tabs": [
    {
      "id": 123,
      "url": "https://example.com",
      "title": "Example Page",
      "active": true,
      "windowId": 1
    },
    {
      "id": 456,
      "url": "https://docs.example.com",
      "title": "Documentation",
      "active": false,
      "windowId": 1
    }
  ]
}
```

Use the `id` values from this response as the `tabId` parameter in other tools.

---

### `attach_debugger`

Attach the Chrome DevTools Protocol debugger to a tab. Required for some advanced inspection features.

**Parameters:**

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `tabId` | `number` | — | **Yes** | Tab to attach debugger to |

**Response:**

```json
{
  "success": true,
  "message": "Debugger attached to tab 123"
}
```

**Note:** The browser will show a "debugging this tab" infobar. Only one debugger can be attached per tab.

---

### `detach_debugger`

Detach the Chrome DevTools Protocol debugger from a tab.

**Parameters:**

| Parameter | Type | Default | Required | Description |
|-----------|------|---------|----------|-------------|
| `tabId` | `number` | — | **Yes** | Tab to detach debugger from |

**Response:**

```json
{
  "success": true,
  "message": "Debugger detached from tab 123"
}
```

---

## Dynamic Resources

The server also exposes MCP resources for direct data access:

| Resource URI | Description | MIME Type |
|-------------|-------------|-----------|
| `browser://tab/{id}/content` | Page HTML content | `text/html` |
| `browser://tab/{id}/dom` | DOM tree snapshot | `application/json` |
| `browser://tab/{id}/console` | Console messages | `application/json` |

Resources are populated as the extension sends data to the server. Use `get_browser_tabs` to find valid tab IDs.

## Data Optimization

### Size Limits

All responses enforce size limits to keep data manageable:

| Data Type | Limit | Configurable Via |
|-----------|-------|-----------------|
| HTML | 50 KB | `maxTextLength` on `get_page_content` |
| Text | 30 KB | `maxTextLength` on `get_page_content` |
| DOM nodes | 500 | `maxNodes` on `get_dom_snapshot` |
| DOM depth | 5 levels | `maxDepth` on `get_dom_snapshot` |
| Console messages | 100 | `limit` on `get_console_messages` |
| Network requests | 50 | `limit` on `get_network_requests` |
| Request bodies | 10 KB | Automatic truncation |
| Response bodies | 10 KB | Automatic truncation |

Truncated data includes indicators showing the original size.

### Filtering Tips

- **Console:** Default returns only errors/warnings. Pass `types: ["log", "info", "debug"]` to see everything.
- **Network:** Failed requests (4xx, 5xx) are sorted first. Use `limit` to control volume.
- **DOM:** Use a smaller `maxDepth` for overview, larger for detail. Increase `maxNodes` for complex pages.

For advanced filtering with cursor-based pagination, see [DATA_OPTIMIZATION.md](DATA_OPTIMIZATION.md).

## Error Handling

All tools return structured errors:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Error: No browser extension connected. Please connect the Browser MCP Bridge extension."
    }
  ],
  "isError": true
}
```

Common errors:

| Error | Cause | Fix |
|-------|-------|-----|
| No browser extension connected | Extension not connected to server | Open extension popup, click Connect |
| No data available for tab | Tab hasn't sent data yet | Navigate to a page, or use correct `tabId` |
| Request timed out | Extension didn't respond in time | Check extension is loaded, try reloading the page |
| Invalid tab ID | Tab doesn't exist | Use `get_browser_tabs` to find valid IDs |
